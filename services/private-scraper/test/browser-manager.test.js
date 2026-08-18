import test from "node:test";
import assert from "node:assert/strict";
import { BrowserManager, sessionExpiryMs, validateStorageState } from "../src/browser-manager.js";

test("requires an active Facebook c_user cookie", () => {
  const valid = {
    cookies: [{ name: "c_user", value: "123", domain: ".facebook.com", expires: -1 }],
    origins: []
  };
  assert.equal(validateStorageState(valid), valid);
  assert.throws(() => validateStorageState({ cookies: [], origins: [] }), /no active Facebook account cookie/);
});

test("reports a persistent Facebook session expiry when present", () => {
  const state = {
    cookies: [{ name: "c_user", value: "123", domain: ".facebook.com", expires: 2_000_000_000 }],
    origins: []
  };
  assert.equal(sessionExpiryMs(state), 2_000_000_000_000);
});

test("fails closed when a live account proxy changes its exit fingerprint", async () => {
  const manager = new BrowserManager({}, {}, { info() {}, warn() {}, error() {} });
  manager.checkProxy = async () => ({ bytes: 321, fingerprint: "new-exit" });
  const entry = { account: { id: "account-1" }, context: {}, proxyFingerprint: "known-exit" };

  await assert.rejects(
    () => manager.recheckProxy(entry),
    (error) => {
      assert.equal(error.code, "PROXY_ROTATED");
      assert.equal(error.details.bytesTransferred, 321);
      assert.equal(error.details.proxyStatus, "failed");
      assert.equal(error.details.accountStatus, "healthy");
      assert.equal(error.details.sessionStatus, "healthy");
      return true;
    }
  );
  assert.equal(entry.proxyFingerprint, "known-exit");
});

test("records the first verified proxy fingerprint", async () => {
  const saved = [];
  const accountStates = {
    get() { return { status: "healthy", sessionStatus: "healthy", proxyStatus: "unknown", proxyFingerprint: "" }; },
    async update(accountId, patch) { saved.push({ accountId, patch }); }
  };
  const manager = new BrowserManager({}, {}, { info() {}, warn() {}, error() {} }, accountStates);
  manager.checkProxy = async () => ({ bytes: 123, fingerprint: "first-exit" });
  const entry = { account: { id: "account-1" }, context: {} };

  const result = await manager.recheckProxy(entry);
  assert.equal(result.fingerprint, "first-exit");
  assert.equal(entry.proxyFingerprint, "first-exit");
  assert.deepEqual(saved, [{ accountId: "account-1", patch: { proxyFingerprint: "first-exit" } }]);
});

test("rejects a changed proxy fingerprint from persisted state after restart", async () => {
  const accountStates = {
    get() {
      return {
        status: "healthy",
        sessionStatus: "healthy",
        proxyStatus: "healthy",
        proxyFingerprint: "known-exit"
      };
    },
    async update() { throw new Error("must not replace the expected fingerprint"); }
  };
  const manager = new BrowserManager({}, {}, { info() {}, warn() {}, error() {} }, accountStates);

  await assert.rejects(
    () => manager.acceptProxyFingerprint({ id: "account-1" }, { bytes: 456, fingerprint: "changed-exit" }),
    (error) => {
      assert.equal(error.code, "PROXY_ROTATED");
      assert.equal(error.details.bytesTransferred, 456);
      assert.equal(error.details.proxyStatus, "failed");
      return true;
    }
  );
});

test("fails the proxy path when its first verified fingerprint cannot be persisted", async () => {
  const accountStates = {
    get() { return { status: "healthy", sessionStatus: "healthy", proxyStatus: "unknown", proxyFingerprint: "" }; },
    async update() { throw new Error("disk unavailable"); }
  };
  const manager = new BrowserManager({}, {}, { info() {}, warn() {}, error() {} }, accountStates);
  await assert.rejects(
    () => manager.acceptProxyFingerprint({ id: "account-1" }, { bytes: 99, fingerprint: "first-exit" }),
    (error) => {
      assert.equal(error.code, "PROXY_IDENTITY_SAVE_FAILED");
      assert.equal(error.details.bytesTransferred, 99);
      assert.equal(error.details.proxyStatus, "failed");
      return true;
    }
  );
});
