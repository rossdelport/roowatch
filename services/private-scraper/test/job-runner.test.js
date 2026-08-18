import test from "node:test";
import assert from "node:assert/strict";
import { JobRunner } from "../src/job-runner.js";
import { ScraperError } from "../src/errors.js";

function config() {
  const account = { id: "account-1", storageKey: "account-1" };
  return {
    workerId: "worker-1",
    accountsById: new Map([[account.id, account]]),
    bandwidthTargetBytes: 1_000_000,
    reservationTransferBytes: 3_000_000,
    proxyCostMicrosPerGb: 1_500_000,
    proxyCostCurrency: "AUD",
    proxyFixedMicrosPerCheck: 0,
    vpsCostAudMicrosPerCheck: 2_000
  };
}

function job(maxCostAudMicros) {
  return {
    kind: "scan_group",
    runId: "run-1",
    sourceId: 42,
    url: "https://www.facebook.com/groups/test/",
    accountId: "account-1",
    maxCostAudMicros,
    deadlineAtMs: Date.now() + 60_000
  };
}

const logger = { info() {}, error() {} };

test("refuses a low reservation before opening the browser", async () => {
  let browserCalls = 0;
  const browserManager = {
    async get() { browserCalls += 1; throw new Error("must not run"); },
    async closeAccount() {}
  };
  const accountStates = { async update() {} };
  const runner = new JobRunner(config(), browserManager, {}, accountStates, logger);
  const result = await runner.run(job(1));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "RESERVATION_TOO_LOW");
  assert.equal(browserCalls, 0);
  assert.equal(result.proxyCost.amountMicros, 0);
  assert.equal(result.vpsCostAudMicros, 0);
  assert.equal(result.costAttempted, false);
});

test("an authorised missing-session attempt reports zero proxy and configured VPS cost", async () => {
  const browserManager = {
    async get() { throw new ScraperError("SESSION_MISSING", "No encrypted session"); },
    async closeAccount() {}
  };
  const runner = new JobRunner(config(), browserManager, {}, { async update() {} }, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "SESSION_MISSING");
  assert.equal(result.proxyCost.amountMicros, 0);
  assert.equal(result.vpsCostAudMicros, 2_000);
  assert.equal(result.costAttempted, true);
});

test("saves an authenticated session and reports measured cost", async () => {
  let saveCalls = 0;
  const entry = { context: {}, account: { id: "account-1" } };
  const browserManager = {
    async get() { return entry; },
    takeBootstrapBytes() { return 100; },
    async save() { saveCalls += 1; return { savedAtMs: 123_456, expiresAtMs: 999_999 }; },
    async closeAccount() {}
  };
  const scanner = {
    async scanGroup() {
      return {
        authenticated: true,
        accountStatus: "healthy",
        sessionStatus: "healthy",
        groupStatus: "healthy",
        chronologicalVerified: true,
        boundaryReached: true,
        feedEndReached: false,
        posts: [{ id: "post-1", text: "Need a plumber", url: "https://www.facebook.com/groups/test/posts/post-1", author: "A", postedAt: new Date().toISOString() }],
        bytesTransferred: 900_000,
        bandwidthTargetExceeded: false
      };
    }
  };
  const updates = [];
  const accountStates = { async update(id, patch) { updates.push({ id, patch }); } };
  const runner = new JobRunner(config(), browserManager, scanner, accountStates, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.status, "success");
  assert.equal(result.bytesTransferred, 900_000);
  assert.deepEqual(result.proxyCost, {
    amountMicros: 1350,
    currency: "AUD",
    trafficAmountMicros: 1350,
    fixedAmountMicros: 0
  });
  assert.equal(result.vpsCostAudMicros, 2_000);
  assert.equal(result.costAttempted, true);
  assert.equal(result.sessionRefreshedAtMs, 123_456);
  assert.equal(saveCalls, 1);
  assert.equal(updates.at(-1).patch.sessionStatus, "healthy");
});

test("keeps measured cost when the encrypted session save fails", async () => {
  const entry = { context: {}, account: { id: "account-1" } };
  const browserManager = {
    async get() { return entry; },
    takeBootstrapBytes() { return 0; },
    async save() { throw new Error("disk write failed"); },
    async closeAccount() {}
  };
  const scanner = {
    async scanGroup() {
      return {
        authenticated: true,
        accountStatus: "healthy",
        sessionStatus: "healthy",
        proxyStatus: "healthy",
        groupStatus: "healthy",
        chronologicalVerified: true,
        boundaryReached: true,
        posts: [{ id: "post-1", text: "Need a plumber" }],
        bytesTransferred: 800_000,
        bandwidthTargetExceeded: false
      };
    }
  };
  const runner = new JobRunner(config(), browserManager, scanner, { async update() {} }, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "SESSION_SAVE_FAILED");
  assert.equal(result.bytesTransferred, 800_000);
  assert.equal(result.proxyCost.amountMicros, 1200);
  assert.equal(result.accountStatus, "healthy");
  assert.equal(result.sessionStatus, "stale");
  assert.equal(result.proxyStatus, "healthy");
  assert.equal(result.groupStatus, "healthy");
  assert.deepEqual(result.posts, []);
});

test("refreshes cookies after an authenticated group-access failure", async () => {
  let saveCalls = 0;
  const browserManager = {
    async get() { return { context: {}, account: { id: "account-1" } }; },
    takeBootstrapBytes() { return 0; },
    async save() { saveCalls += 1; return { savedAtMs: 321_000 }; },
    async closeAccount() {}
  };
  const scanner = {
    async scanGroup() {
      throw new ScraperError("GROUP_ACCESS_LOST", "Access was removed", {
        authenticated: true,
        accountStatus: "healthy",
        sessionStatus: "healthy",
        proxyStatus: "healthy",
        groupStatus: "access_lost",
        bytesTransferred: 400_000
      });
    }
  };
  const runner = new JobRunner(config(), browserManager, scanner, { async update() {} }, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "GROUP_ACCESS_LOST");
  assert.equal(result.groupStatus, "access_lost");
  assert.equal(result.accountStatus, "healthy");
  assert.equal(result.proxyStatus, "healthy");
  assert.equal(result.sessionRefreshedAtMs, 321_000);
  assert.equal(saveCalls, 1);
});

test("treats an unhealthy-account gate as untouched work with zero cost", async () => {
  let browserCalls = 0;
  const browserManager = {
    async get() { browserCalls += 1; throw new Error("must not open"); },
    async closeAccount() {}
  };
  const state = { status: "blocked", sessionStatus: "challenge", proxyStatus: "healthy" };
  const accountStates = { get() { return state; }, async update() { throw new Error("must not update"); } };
  const runner = new JobRunner(config(), browserManager, {}, accountStates, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.errorCode, "ACCOUNT_NOT_HEALTHY");
  assert.equal(result.costAttempted, false);
  assert.equal(result.proxyCost.amountMicros, 0);
  assert.equal(result.vpsCostAudMicros, 0);
  assert.equal(result.accountStatus, "blocked");
  assert.equal(browserCalls, 0);
});

test("rejects an invalid group URL before charging or opening the browser", async () => {
  let browserCalls = 0;
  const browserManager = {
    async get() { browserCalls += 1; throw new Error("must not open"); },
    async closeAccount() {}
  };
  const runner = new JobRunner(config(), browserManager, {}, { async update() {} }, logger);
  const result = await runner.run({ ...job(10_000), url: "https://example.com/groups/test" });
  assert.equal(result.errorCode, "JOB_INVALID");
  assert.equal(result.costAttempted, false);
  assert.equal(result.vpsCostAudMicros, 0);
  assert.equal(browserCalls, 0);
});

test("keeps a healthy account usable after a source-only scan failure", async () => {
  const entry = { context: {}, account: { id: "account-1" } };
  const browserManager = {
    async get() { return entry; },
    takeBootstrapBytes() { return 0; },
    async save() { return { savedAtMs: 321_000 }; },
    async closeAccount() {}
  };
  const scanner = {
    async scanGroup() {
      throw new ScraperError("CHRONOLOGY_UNVERIFIED", "This group did not prove chronological order", {
        authenticated: true,
        networkStarted: true,
        bytesTransferred: 400_000,
        groupStatus: "error"
      });
    }
  };
  const updates = [];
  const healthy = { status: "healthy", sessionStatus: "healthy", proxyStatus: "healthy" };
  const accountStates = {
    get() { return healthy; },
    async update(id, patch) { updates.push({ id, patch }); }
  };
  const runner = new JobRunner(config(), browserManager, scanner, accountStates, logger);
  const result = await runner.run(job(10_000));
  assert.equal(result.errorCode, "CHRONOLOGY_UNVERIFIED");
  assert.equal(result.accountStatus, "healthy");
  assert.equal(result.sessionStatus, "healthy");
  assert.equal(result.proxyStatus, "healthy");
  assert.equal(result.costAttempted, true);
  assert.equal(updates.at(-1).patch.status, "healthy");
  assert.equal(Object.hasOwn(updates.at(-1).patch, "latestErrorCode"), false);
});
