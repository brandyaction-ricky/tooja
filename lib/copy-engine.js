import crypto from "node:crypto";
import {
  capPositionRatio,
  evaluateRiskState,
  isOrderAllowed,
} from "./risk-engine.js";

const EPSILON = 1e-10;

const finite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
const sameDirection = (a, b) => sign(a) !== 0 && sign(a) === sign(b);

function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function quantizeTowardZero(value, step = 1) {
  const numeric = finite(value);
  const increment = Math.abs(finite(step, 1)) || 1;
  const units = numeric / increment;
  const quantizedUnits = units >= 0
    ? Math.floor(units + EPSILON)
    : Math.ceil(units - EPSILON);
  const precision = Math.min(12, decimalPlaces(increment));
  return Number((quantizedUnits * increment).toFixed(precision));
}

export function contractValue({ markPrice, quantoMultiplier }) {
  const price = finite(markPrice);
  const multiplier = finite(quantoMultiplier);
  if (price <= 0 || multiplier <= 0) {
    throw new RangeError("markPrice and quantoMultiplier must be positive");
  }
  return price * multiplier;
}

export function signedPositionNotional(position = {}, spec = {}) {
  const size = finite(position.size);
  if (!size) return 0;
  const explicit = position.notional ?? position.value;
  const absoluteNotional = explicit == null
    ? Math.abs(size) * contractValue(spec)
    : Math.abs(finite(explicit));
  return sign(size) * absoluteNotional;
}

export function createGateOrderText(parts = {}) {
  const payload = [
    parts.memberId ?? "member",
    parts.eventId ?? "snapshot",
    parts.contract ?? "contract",
    parts.sequence ?? 0,
    parts.currentSize ?? 0,
    parts.targetSize ?? 0,
    parts.orderSize ?? 0,
  ].join("|");
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  // Gate custom text: `t-` prefix + max 28 bytes after prefix.
  return `t-ct_${digest.slice(0, 24)}`;
}

function buildRawOrders({ currentSize, targetSize }) {
  if (Math.abs(targetSize - currentSize) <= EPSILON) return [];

  if (currentSize !== 0 && targetSize !== 0 && !sameDirection(currentSize, targetSize)) {
    return [
      {
        action: "flip_close",
        size: -currentSize,
        reduceOnly: true,
        waitForPreviousFill: false,
      },
      {
        action: "flip_open",
        size: targetSize,
        reduceOnly: false,
        waitForPreviousFill: true,
      },
    ];
  }

  const delta = targetSize - currentSize;
  const reducing = currentSize !== 0
    && (targetSize === 0 || (sameDirection(currentSize, targetSize) && Math.abs(targetSize) < Math.abs(currentSize)));

  let action = "open";
  if (targetSize === 0) action = "close";
  else if (currentSize === 0) action = "open";
  else if (reducing) action = "reduce";
  else action = "add";

  return [{
    action,
    size: delta,
    reduceOnly: reducing,
    waitForPreviousFill: false,
  }];
}

/**
 * Builds a deterministic target-state copy plan. It never sends an exchange order.
 * Percentages are decimal ratios: 50% = 0.5, 200% = 2.
 */
export function buildCopyPlan({
  memberId,
  event = {},
  master = {},
  follower = {},
  contract = {},
  settings = {},
  system = {},
} = {}) {
  const contractName = String(contract.name || master.position?.contract || follower.position?.contract || "");
  if (!contractName) throw new TypeError("contract.name is required");

  const masterEquity = finite(master.equity);
  const followerEquity = finite(follower.equity);
  if (masterEquity <= 0) throw new RangeError("master.equity must be positive");
  if (followerEquity <= 0) throw new RangeError("follower.equity must be positive");
  if (follower.positionMode && follower.positionMode !== "single") {
    throw new RangeError("MVP copy engine supports Gate.io single-position mode only");
  }

  const valuePerContract = contractValue(contract);
  const sizeStep = Math.abs(finite(contract.sizeStep, 1)) || 1;
  const minimumSize = Math.abs(finite(contract.minSize, sizeStep)) || sizeStep;
  const maximumSize = Math.abs(finite(contract.maxSize, Number.MAX_SAFE_INTEGER));

  const masterNotional = signedPositionNotional(master.position, contract);
  const masterExposureRatio = Math.abs(masterNotional) / masterEquity;
  const copyRatio = finite(settings.copyRatio, 1);
  if (copyRatio < 0 || copyRatio > 2) {
    throw new RangeError("settings.copyRatio must be between 0 and 2");
  }
  const requestedPositionRatio = masterExposureRatio * copyRatio;
  const targetPositionRatio = capPositionRatio(
    requestedPositionRatio,
    settings.maxPositionRatio,
  );

  const requestedTargetNotional = sign(masterNotional) * followerEquity * targetPositionRatio;
  let targetSize = quantizeTowardZero(requestedTargetNotional / valuePerContract, sizeStep);
  if (Math.abs(targetSize) > maximumSize) {
    targetSize = sign(targetSize) * maximumSize;
    targetSize = quantizeTowardZero(targetSize, sizeStep);
  }
  if (Math.abs(targetSize) < minimumSize) targetSize = 0;

  const currentSize = quantizeTowardZero(finite(follower.position?.size), sizeStep);
  const targetNotional = targetSize * valuePerContract;
  const currentNotional = currentSize * valuePerContract;
  const deltaSize = quantizeTowardZero(targetSize - currentSize, sizeStep);
  const deltaNotional = deltaSize * valuePerContract;
  const driftRatio = Math.abs(deltaNotional) / followerEquity;
  const toleranceRatio = Math.max(0, finite(settings.driftToleranceRatio, 0.0005));

  const riskState = evaluateRiskState({
    system,
    settings,
    account: {
      equity: followerEquity,
      startOfDayEquity: follower.startOfDayEquity,
      highWatermarkEquity: follower.highWatermarkEquity,
      availableMargin: follower.availableMargin,
      configuredLeverage: follower.configuredLeverage,
    },
  });

  if (Math.abs(deltaSize) < minimumSize || driftRatio <= toleranceRatio) {
    return {
      status: "NOOP",
      dryRun: true,
      contract: contractName,
      risk: riskState,
      master: { equity: masterEquity, signedNotional: masterNotional, exposureRatio: masterExposureRatio },
      follower: { equity: followerEquity, currentSize, currentNotional },
      target: { requestedPositionRatio, positionRatio: targetPositionRatio, size: targetSize, notional: targetNotional },
      delta: { size: deltaSize, notional: deltaNotional, driftRatio },
      orders: [],
      blockedOrders: [],
    };
  }

  const rawOrders = buildRawOrders({ currentSize, targetSize });
  const eventId = event.id || event.snapshotId || event.version || "snapshot";
  const normalizedOrders = rawOrders.map((order, index) => ({
    sequence: index + 1,
    action: order.action,
    contract: contractName,
    size: String(quantizeTowardZero(order.size, sizeStep)),
    price: "0",
    tif: "ioc",
    reduceOnly: order.reduceOnly,
    waitForPreviousFill: order.waitForPreviousFill,
    text: createGateOrderText({
      memberId,
      eventId,
      contract: contractName,
      sequence: index + 1,
      currentSize,
      targetSize,
      orderSize: order.size,
    }),
  }));

  const orders = normalizedOrders.filter((order) => isOrderAllowed(order, riskState));
  const blockedOrders = normalizedOrders
    .filter((order) => !isOrderAllowed(order, riskState))
    .map((order) => ({ ...order, blockedBy: riskState.reasons }));

  let status = "READY";
  if (!orders.length) status = "BLOCKED";
  else if (blockedOrders.length) status = "PARTIAL_READY";

  return {
    status,
    dryRun: true,
    contract: contractName,
    risk: riskState,
    master: {
      equity: masterEquity,
      signedNotional: masterNotional,
      exposureRatio: masterExposureRatio,
    },
    follower: {
      equity: followerEquity,
      currentSize,
      currentNotional,
    },
    target: {
      requestedPositionRatio,
      positionRatio: targetPositionRatio,
      size: targetSize,
      notional: targetNotional,
      capped: targetPositionRatio + EPSILON < requestedPositionRatio,
    },
    delta: {
      size: deltaSize,
      notional: deltaNotional,
      driftRatio,
    },
    orders,
    blockedOrders,
  };
}
