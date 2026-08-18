import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireProcessLock } from "../src/process-lock.js";

test("rejects a second live scraper process lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-lock-"));
  const file = path.join(directory, "worker.lock");
  const release = await acquireProcessLock(file);
  await assert.rejects(() => acquireProcessLock(file), /already running/);
  await release();
  const releaseAgain = await acquireProcessLock(file);
  await releaseAgain();
});
