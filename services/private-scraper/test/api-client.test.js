import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient, validateJob, validateResult } from "../src/api-client.js";

test("accepts numeric source ids and rejects string source ids", () => {
  const raw = {
    kind: "scan_group",
    runId: "run-1",
    sourceId: 42,
    url: "https://www.facebook.com/groups/test/",
    accountId: "account-1",
    maxCostAudMicros: 1000,
    deadlineAtMs: Date.now() + 60_000
  };
  assert.equal(validateJob(raw).sourceId, 42);
  assert.throws(() => validateJob({ ...raw, sourceId: "42" }), /sourceId is invalid/);
});

test("uses bearer auth and requires the server's exact 65-minute window", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      ok: true,
      serverTimeMs: Date.now(),
      lookbackMinutes: 65,
      jobs: []
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new ApiClient({
    apiBaseUrl: "https://roowatch.example",
    apiSecret: "private-secret",
    workerId: "worker-1",
    apiTimeoutMs: 1_000
  }, {}, fetchImpl);
  const result = await client.pullJobs();
  assert.equal(result.lookbackMinutes, 65);
  assert.equal(requests[0].options.headers.authorization, "Bearer private-secret");
});

test("refuses an oversized result before it can enter a permanent 413 retry", async () => {
  let requests = 0;
  const client = new ApiClient({
    apiBaseUrl: "https://roowatch.example",
    apiSecret: "private-secret",
    workerId: "worker-1",
    apiTimeoutMs: 1_000,
    maxResultPayloadBytes: 200
  }, {}, async () => { requests += 1; return new Response("{}"); });
  await assert.rejects(() => client.submitResult({
    runId: "run-1",
    workerId: "worker-1",
    sourceId: 1,
    accountId: "account-1",
    status: "success",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    bytesTransferred: 1,
    proxyCost: {
      amountMicros: 1,
      currency: "AUD",
      trafficAmountMicros: 1,
      fixedAmountMicros: 0
    },
    vpsCostAudMicros: 1,
    costAttempted: true,
    posts: [{ text: "x".repeat(500) }]
  }), /too large/);
  assert.equal(requests, 0);
});

test("requires exact zero-cost semantics for an untouched result", () => {
  const result = {
    runId: "run-1",
    workerId: "worker-1",
    sourceId: 1,
    accountId: "account-1",
    status: "failed",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    bytesTransferred: 0,
    proxyCost: {
      amountMicros: 0,
      currency: "AUD",
      trafficAmountMicros: 0,
      fixedAmountMicros: 0
    },
    vpsCostAudMicros: 0,
    costAttempted: false,
    posts: []
  };
  assert.equal(validateResult(result), result);
  assert.throws(() => validateResult({ ...result, vpsCostAudMicros: 1 }), /untouched result/);
  assert.throws(() => validateResult({
    ...result,
    proxyCost: { ...result.proxyCost, amountMicros: 2, trafficAmountMicros: 1 }
  }), /does not reconcile/);
});
