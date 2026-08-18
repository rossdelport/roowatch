import { readFile } from "node:fs/promises";
import { loadLocalEnv } from "../bootstrap-env.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { EncryptedJsonStore } from "../crypto-store.js";
import { AccountStateStore } from "../account-state.js";
import { BrowserManager, validateStorageState, sessionExpiryMs } from "../browser-manager.js";
import { FacebookScanner } from "../facebook-scanner.js";
import { serialiseCost } from "../cost.js";
import { acquireProcessLock } from "../process-lock.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  return "Usage: npm run cookies:import -- --account <account-id> --file <playwright-state.json>";
}

loadLocalEnv();
const logger = createLogger();

async function main() {
  const accountId = argument("--account");
  const file = argument("--file");
  if (!accountId || !file || process.argv.includes("--help")) throw new Error(usage());
  const config = await loadConfig();
  const account = config.accountsById.get(accountId);
  if (!account) throw new Error(`Unknown account id: ${accountId}`);

  let imported;
  try {
    imported = validateStorageState(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    throw new Error(`The session file could not be read or validated: ${error.message}`);
  }

  const sessionStore = new EncryptedJsonStore(config.sessionsDir, config.encryptionKey, "facebook-session");
  const accountStates = await new AccountStateStore(config.accountStateFile, config.accounts).load();
  const releaseLock = await acquireProcessLock(config.lockFile);
  let browserManager;
  let temporary;
  try {
    browserManager = await new BrowserManager(config, sessionStore, logger, accountStates).start();
    temporary = await browserManager.createTemporary(account, imported);
    const bootstrapBytes = browserManager.takeBootstrapBytes(temporary);
    const scanner = new FacebookScanner(config, logger);
    const health = await scanner.validateSession(temporary, bootstrapBytes);
    const refreshed = validateStorageState(await temporary.context.storageState({ indexedDB: true }));
    const savedAtMs = await sessionStore.write(account.storageKey, refreshed);
    const expiresAtMs = sessionExpiryMs(refreshed);
    await accountStates.update(account.id, {
      status: "healthy",
      sessionStatus: "healthy",
      proxyStatus: "healthy",
      cookieSavedAtMs: Math.floor(savedAtMs),
      lastHealthCheckAtMs: Date.now(),
      ...(expiresAtMs ? { sessionExpiresAtMs: expiresAtMs } : {}),
      latestErrorCode: "",
      latestError: ""
    });
    logger.info("session_imported", {
      accountId: account.id,
      bytesTransferred: health.bytesTransferred,
      proxyCost: serialiseCost(config, health.bytesTransferred),
      savedAtMs: Math.floor(savedAtMs),
      plaintextFileStillExists: true
    });
  } finally {
    await temporary?.context.close().catch(() => {});
    await browserManager?.close();
    await releaseLock();
  }
}

main().catch((error) => {
  logger.error("session_import_failed", { error });
  process.exitCode = 1;
});
