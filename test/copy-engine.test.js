import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCopyPlan,
  createGateOrderText,
  quantizeTowardZero,
} from "../lib/copy-engine.js";

const base = {
  memberId: "member-a",
  event: { id: "master-snapshot-100" },
  master: {
    equity: 10_000,
    position: { contract: "BTC_USDT", size: 1000, value: 6_000 },
  },
  follower: {
    equity: 30_000,
    startOfDayEquity: 30_000,
    highWatermarkEquity: 31_000,
    availableMargin: 25_000,
    configuredLeverage: 5,
    positionMode: "single",
    position: { contract: "BTC_USDT", size: 0 },
  },
  contract: {
    name: "BTC_USDT",
    markPrice: 60_000,
    quantoMultiplier: 0.0001,
    sizeStep: 1,
    minSize: 1,
    maxSize: 1_000_000,
  },
  settings: {
    copyRatio: 0.5,
    maxPositionRatio: 1,
    driftToleranceRatio: 0,
    maxDailyLossRatio: 0.05,
    maxDrawdownRatio: 0.15,
    maxLeverage: 10,
  },
  system: { mode: "active" },
};

test("copies master target exposure by follower equity and copy ratio", () => {
  const plan = buildCopyPlan(base);
  assert.equal(plan.status, "READY");
  assert.equal(plan.master.exposureRatio, 0.6);
  assert.equal(plan.target.positionRatio, 0.3);
  assert.equal(plan.target.notional, 9_000);
  assert.equal(plan.target.size, 1_500);
  assert.equal(plan.orders[0].action, "open");
  assert.equal(plan.orders[0].size, "1500");
  assert.equal(plan.orders[0].reduceOnly, false);
});

test("caps target at member maximum position ratio", () => {
  const plan = buildCopyPlan({
    ...base,
    settings: { ...base.settings, copyRatio: 2, maxPositionRatio: 0.4 },
  });
  assert.equal(plan.target.positionRatio, 0.4);
  assert.equal(plan.target.notional, 12_000);
  assert.equal(plan.target.capped, true);
});

test("zero maximum position ratio forces an existing position flat", () => {
  const plan = buildCopyPlan({
    ...base,
    follower: { ...base.follower, position: { contract: "BTC_USDT", size: 500 } },
    settings: { ...base.settings, maxPositionRatio: 0 },
  });
  assert.equal(plan.target.positionRatio, 0);
  assert.equal(plan.target.size, 0);
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].action, "close");
  assert.equal(plan.orders[0].size, "-500");
  assert.equal(plan.orders[0].reduceOnly, true);
});

test("rejects copy ratios above the configured 200 percent ceiling", () => {
  assert.throws(
    () => buildCopyPlan({
      ...base,
      settings: { ...base.settings, copyRatio: 2.01 },
    }),
    /copyRatio must be between 0 and 2/,
  );
});

test("allows reduction while member emergency stop blocks new exposure", () => {
  const plan = buildCopyPlan({
    ...base,
    follower: { ...base.follower, position: { contract: "BTC_USDT", size: 2_000 } },
    settings: { ...base.settings, emergencyStop: true },
  });
  assert.equal(plan.status, "READY");
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].action, "reduce");
  assert.equal(plan.orders[0].size, "-500");
  assert.equal(plan.orders[0].reduceOnly, true);
});

test("splits a direction flip into close then open and can block only the open leg", () => {
  const plan = buildCopyPlan({
    ...base,
    master: { ...base.master, position: { contract: "BTC_USDT", size: -1000, value: 6_000 } },
    follower: { ...base.follower, position: { contract: "BTC_USDT", size: 500 } },
    system: { mode: "reduce_only" },
  });
  assert.equal(plan.status, "PARTIAL_READY");
  assert.equal(plan.orders.length, 1);
  assert.equal(plan.orders[0].action, "flip_close");
  assert.equal(plan.orders[0].size, "-500");
  assert.equal(plan.blockedOrders.length, 1);
  assert.equal(plan.blockedOrders[0].action, "flip_open");
});

test("returns NOOP when drift is below configured tolerance", () => {
  const plan = buildCopyPlan({
    ...base,
    follower: { ...base.follower, position: { contract: "BTC_USDT", size: 1499 } },
    settings: { ...base.settings, driftToleranceRatio: 0.001 },
  });
  assert.equal(plan.status, "NOOP");
  assert.deepEqual(plan.orders, []);
});

test("Gate order text is stable and valid", () => {
  const input = {
    memberId: "abc",
    eventId: "event-1",
    contract: "BTC_USDT",
    sequence: 1,
    currentSize: 0,
    targetSize: 100,
    orderSize: 100,
  };
  const first = createGateOrderText(input);
  const second = createGateOrderText(input);
  assert.equal(first, second);
  assert.match(first, /^t-[0-9A-Za-z_.-]{1,28}$/);
});

test("quantizes decimal contract sizes toward zero", () => {
  assert.equal(quantizeTowardZero(1.29, 0.1), 1.2);
  assert.equal(quantizeTowardZero(-1.29, 0.1), -1.2);
});
