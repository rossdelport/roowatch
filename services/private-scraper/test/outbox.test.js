import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedJsonStore } from "../src/crypto-store.js";
import { ResultOutbox } from "../src/outbox.js";

test("keeps a failed submission encrypted and retries the same run id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-outbox-"));
  const store = new EncryptedJsonStore(directory, Buffer.alloc(32, 3), "result-outbox");
  let attempts = 0;
  const delivered = [];
  const apiClient = {
    async submitResult(result) {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary API outage");
      delivered.push(result.runId);
    }
  };
  const outbox = new ResultOutbox(store, apiClient, { info() {} });
  const result = { runId: "run-1", status: "failed", errorCode: "FIRST", posts: [{ text: "private text" }] };
  await outbox.enqueue(result);
  await outbox.enqueue({ ...result, errorCode: "SECOND" });
  assert.deepEqual(await store.keys(), ["run-1"]);
  assert.equal((await store.read("run-1")).errorCode, "FIRST");
  await assert.rejects(() => outbox.flush(), /temporary API outage/);
  assert.deepEqual(await store.keys(), ["run-1"]);
  await outbox.flush();
  assert.deepEqual(delivered, ["run-1"]);
  assert.deepEqual(await store.keys(), []);
});
