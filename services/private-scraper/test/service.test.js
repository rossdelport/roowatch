import test from "node:test";
import assert from "node:assert/strict";
import { PrivateScraperService } from "../src/service.js";

function config() {
  return {
    dailyHealthIntervalMs: 86_400_000,
    proxyCostMicrosPerGb: 1_500_000,
    proxyCostCurrency: "AUD",
    proxyFixedMicrosPerCheck: 0,
    reservationTransferBytes: 3_000_000,
    vpsCostAudMicrosPerCheck: 2_000,
    bandwidthTargetBytes: 1_000_000,
    maxTransferBytes: 2_000_000,
    maxResultPayloadBytes: 500_000,
    heartbeatIntervalMs: 60_000
  };
}

test("reports unknown startup health as degraded, never green", async () => {
  const heartbeats = [];
  let accounts = [{
    id: "account-1",
    label: "Account 1",
    status: "error",
    sessionStatus: "stale",
    proxyStatus: "unknown"
  }];
  const service = new PrivateScraperService(
    config(),
    { async sendHeartbeat(value) { heartbeats.push(value); } },
    {}, {},
    { heartbeatAccounts() { return accounts; } },
    {},
    { warn() {}, error() {}, info() {} }
  );
  await service.heartbeat();
  assert.equal(heartbeats[0].status, "degraded");
  assert.equal(heartbeats[0].proxyStatus, "unknown");
  assert.equal(heartbeats[0].accounts[0].healthValidationDue, true);

  accounts = [{
    id: "account-1",
    label: "Account 1",
    status: "healthy",
    sessionStatus: "healthy",
    proxyStatus: "healthy",
    lastHealthCheckAtMs: Date.now()
  }];
  await service.heartbeat();
  assert.equal(heartbeats[1].status, "healthy");
  assert.equal(heartbeats[1].proxyStatus, "healthy");
});

test("a due daily validation stays healthy while a mixed account pool is degraded", async () => {
  const heartbeats = [];
  const now = Date.now();
  let accounts = [{
    id: "account-1",
    label: "Account 1",
    status: "healthy",
    sessionStatus: "healthy",
    proxyStatus: "healthy",
    lastHealthCheckAtMs: now - 90_000_000
  }];
  const service = new PrivateScraperService(
    config(),
    { async sendHeartbeat(value) { heartbeats.push(value); } },
    {}, {},
    { heartbeatAccounts() { return accounts; } },
    {},
    { warn() {}, error() {}, info() {} }
  );
  await service.heartbeat();
  assert.equal(heartbeats[0].status, "healthy");
  assert.equal(heartbeats[0].accounts[0].healthValidationDue, true);

  accounts = [accounts[0], {
    id: "account-2",
    label: "Account 2",
    status: "blocked",
    sessionStatus: "challenge",
    proxyStatus: "failed",
    lastHealthCheckAtMs: now
  }];
  await service.heartbeat();
  assert.equal(heartbeats[1].status, "degraded");
  assert.equal(heartbeats[1].proxyStatus, "degraded");
});

test("turns an oversized successful result into a small explicit failure before outboxing", async () => {
  const queued = [];
  const localConfig = { ...config(), maxResultPayloadBytes: 1_000 };
  const service = new PrivateScraperService(
    localConfig,
    {}, {},
    {
      async enqueue(result) { queued.push(result); },
      async flush() {}
    },
    { heartbeatAccounts() { return []; } },
    {},
    { warn() {}, error() {}, info() {} }
  );
  await service.deliver({
    runId: "run-1",
    workerId: "worker-1",
    sourceId: 1,
    accountId: "account-1",
    status: "success",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    bytesTransferred: 1,
    bandwidthTargetBytes: 1_000_000,
    bandwidthTargetExceeded: false,
    proxyCost: { amountMicros: 1, currency: "AUD", trafficAmountMicros: 1, fixedAmountMicros: 0 },
    vpsCostAudMicros: 1,
    costAttempted: true,
    accountStatus: "healthy",
    sessionStatus: "healthy",
    proxyStatus: "healthy",
    groupStatus: "healthy",
    posts: [{ text: "private".repeat(1_000) }]
  });
  assert.equal(queued[0].status, "failed");
  assert.equal(queued[0].errorCode, "RESULT_PAYLOAD_TOO_LARGE");
  assert.deepEqual(queued[0].posts, []);
  assert.equal(queued[0].proxyCost.amountMicros, 1);
  assert.equal(queued[0].costAttempted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(queued[0]), "utf8") <= localConfig.maxResultPayloadBytes);
});
