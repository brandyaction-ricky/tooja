const finite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const positiveRatio = (value) => Math.max(0, finite(value));
const optionalFinite = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const TRADING_MODES = Object.freeze({
  ACTIVE: "active",
  REDUCE_ONLY: "reduce_only",
  HALTED: "halted",
});

export function lossRatio(referenceEquity, currentEquity) {
  const reference = finite(referenceEquity);
  const current = finite(currentEquity);
  if (reference <= 0) return 0;
  return Math.max(0, (reference - current) / reference);
}

export function capPositionRatio(requestedRatio, maximumRatio) {
  const requested = positiveRatio(requestedRatio);
  if (maximumRatio == null || maximumRatio === "") return requested;
  return Math.min(requested, positiveRatio(maximumRatio));
}

/**
 * Produces one risk decision for a follower account snapshot.
 *
 * REDUCE_ONLY is intentionally different from HALTED:
 * - reduce_only: new exposure is blocked, but reductions/closures remain available.
 * - halted: every automated order is blocked. Use only for exchange/API incidents.
 */
export function evaluateRiskState({ system = {}, settings = {}, account = {} } = {}) {
  const reasons = new Set();
  const warnings = new Set();
  const mode = Object.values(TRADING_MODES).includes(system.mode)
    ? system.mode
    : TRADING_MODES.ACTIVE;

  let allowNewExposure = true;
  let allowReduction = true;

  if (mode === TRADING_MODES.HALTED) {
    allowNewExposure = false;
    allowReduction = false;
    reasons.add("SYSTEM_HALTED");
  } else if (mode === TRADING_MODES.REDUCE_ONLY) {
    allowNewExposure = false;
    reasons.add("SYSTEM_REDUCE_ONLY");
  }

  if (system.memberPaused) {
    allowNewExposure = false;
    reasons.add("MEMBER_PAUSED");
  }

  if (system.contractBlocked) {
    allowNewExposure = false;
    reasons.add("CONTRACT_BLOCKED");
  }

  if (settings.emergencyStop) {
    allowNewExposure = false;
    reasons.add("MEMBER_EMERGENCY_STOP");
  }

  const equity = finite(account.equity);
  if (equity <= 0) {
    allowNewExposure = false;
    reasons.add("NON_POSITIVE_EQUITY");
  }

  const dailyLoss = lossRatio(account.startOfDayEquity, equity);
  const maxDailyLoss = positiveRatio(settings.maxDailyLossRatio);
  if (maxDailyLoss > 0 && dailyLoss >= maxDailyLoss) {
    allowNewExposure = false;
    reasons.add("MAX_DAILY_LOSS_REACHED");
  }

  const drawdown = lossRatio(account.highWatermarkEquity, equity);
  const maxDrawdown = positiveRatio(settings.maxDrawdownRatio);
  if (maxDrawdown > 0 && drawdown >= maxDrawdown) {
    allowNewExposure = false;
    reasons.add("MAX_DRAWDOWN_REACHED");
  }

  const configuredLeverage = Math.max(0, finite(account.configuredLeverage));
  const maxLeverage = Math.max(0, finite(settings.maxLeverage));
  if (maxLeverage > 0 && configuredLeverage > maxLeverage) {
    allowNewExposure = false;
    reasons.add("MAX_LEVERAGE_EXCEEDED");
  }

  const availableMargin = optionalFinite(account.availableMargin);
  if (availableMargin != null) {
    if (availableMargin < 0) {
      allowNewExposure = false;
      reasons.add("NEGATIVE_AVAILABLE_MARGIN");
    } else if (equity > 0 && availableMargin / equity < 0.03) {
      warnings.add("LOW_AVAILABLE_MARGIN");
    }
  }

  return {
    mode,
    allowNewExposure,
    allowReduction,
    dailyLossRatio: dailyLoss,
    drawdownRatio: drawdown,
    reasons: [...reasons],
    warnings: [...warnings],
  };
}

export function isOrderAllowed(order, riskState) {
  if (!order || !riskState) return false;
  return order.reduceOnly
    ? Boolean(riskState.allowReduction)
    : Boolean(riskState.allowNewExposure);
}
