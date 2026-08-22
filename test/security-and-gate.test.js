import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptCredential, encryptCredential } from "../lib/credential-crypto.js";
import { createGateSignature, createGateTradingClient, GateApiError } from "../lib/gate-trading-client.js";

test("credential envelope round-trips with authenticated additional data", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptCredential("secret-value", key, { aad: "exchange-account-1:v1" });
  assert.notEqual(encrypted, "secret-value");
  assert.equal(decryptCredential(encrypted, key, { aad: "exchange-account-1:v1" }), "secret-value");
  assert.throws(
    () => decryptCredential(encrypted, key, { aad: "exchange-account-2:v1" }),
    /authenticate|Unsupported state|unable/i,
  );
});

test("Gate signature is deterministic for the same canonical request", () => {
  const input = {
    method: "POST",
    path: "/futures/usdt/orders",
    query: "",
    body: JSON.stringify({ contract: "BTC_USDT", size: "1", price: "0", tif: "ioc" }),
    timestamp: "1700000000",
    secret: "test-secret",
  };
  assert.equal(createGateSignature(input), createGateSignature(input));
  assert.equal(createGateSignature(input).length, 128);
});

test("live order placement is denied unless explicitly enabled", async () => {
  const client = createGateTradingClient({
    key: "key",
    secret: "secret",
    environment: "live",
    allowOrderPlacement: true,
    allowLiveTrading: false,
    fetchImpl: async () => { throw new Error("network should not be reached"); },
  });

  await assert.rejects(
    () => client.placeFuturesOrder({ contract: "BTC_USDT", size: "1", price: "0", tif: "ioc" }),
    (error) => error instanceof GateApiError && error.label === "LIVE_TRADING_DISABLED",
  );
});
