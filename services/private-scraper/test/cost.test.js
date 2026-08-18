import test from "node:test";
import assert from "node:assert/strict";
import { assertReservation, costForBytes, estimatedMaxCostAudMicros, proxyCostForBytes } from "../src/cost.js";

test("uses exact integer micros and rounds supplier cost up", () => {
  assert.equal(proxyCostForBytes(1, 1_500_000), 1n);
  assert.equal(proxyCostForBytes(1_000_000_000, 1_500_000), 1_500_000n);
});

test("converts configured USD cost to AUD without floating point", () => {
  const config = {
    proxyCostMicrosPerGb: 2_000_000,
    proxyCostCurrency: "USD",
    proxyFixedMicrosPerCheck: 100_000,
    audMicrosPerUsd: 1_410_000,
    reservationTransferBytes: 1_000_000_000,
    vpsCostAudMicrosPerCheck: 100_000
  };
  const cost = costForBytes(config, 1_000_000_000);
  assert.equal(cost.trafficMicros, 2_000_000n);
  assert.equal(cost.fixedMicros, 100_000n);
  assert.equal(cost.audMicros, 2_961_000n);
  assert.equal(estimatedMaxCostAudMicros(config), 3_061_000n);
  assert.throws(() => assertReservation({ maxCostAudMicros: 3_060_999 }, config), /below the worker cost guard/);
  assert.equal(assertReservation({ maxCostAudMicros: 3_061_000 }, config), 3_061_000n);
});
