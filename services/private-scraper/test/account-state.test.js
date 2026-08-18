import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountStateStore } from "../src/account-state.js";

test("persists only the hashed proxy identity and keeps it out of heartbeats", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-account-state-"));
  const file = path.join(directory, "account-state.json");
  const accounts = [{ id: "account-1", label: "Account 1" }];
  const firstProcess = await new AccountStateStore(file, accounts).load();
  await firstProcess.update("account-1", {
    status: "healthy",
    sessionStatus: "healthy",
    proxyStatus: "healthy",
    proxyFingerprint: "12ab34cd56ef"
  });

  const restartedProcess = await new AccountStateStore(file, accounts).load();
  assert.equal(restartedProcess.get("account-1").proxyFingerprint, "12ab34cd56ef");
  assert.equal(Object.hasOwn(restartedProcess.heartbeatAccounts()[0], "proxyFingerprint"), false);
});
