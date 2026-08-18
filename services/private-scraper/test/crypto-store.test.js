import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedJsonStore } from "../src/crypto-store.js";

test("encrypts storage state and replaces it atomically", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-crypto-"));
  const store = new EncryptedJsonStore(directory, Buffer.alloc(32, 9), "test-session");
  const state = { cookies: [{ name: "c_user", value: "private-cookie" }], origins: [] };
  await store.write("account-1", state);
  const raw = await readFile(store.filePath("account-1"), "utf8");
  assert.equal(raw.includes("private-cookie"), false);
  assert.deepEqual(await store.read("account-1"), state);

  const next = { cookies: [{ name: "c_user", value: "rotated-cookie" }], origins: [] };
  await store.write("account-1", next);
  assert.deepEqual(await store.read("account-1"), next);
  assert.deepEqual(await store.keys(), ["account-1"]);
});

test("detects encrypted file tampering", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "roowatch-tamper-"));
  const store = new EncryptedJsonStore(directory, Buffer.alloc(32, 4), "test-session");
  await store.write("account-1", { cookies: [], origins: [] });
  const file = store.filePath("account-1");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 1;
  envelope.ciphertext = bytes.toString("base64");
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(() => store.read("account-1"));
});
