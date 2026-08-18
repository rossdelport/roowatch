import { loadLocalEnv } from "./bootstrap-env.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { EncryptedJsonStore } from "./crypto-store.js";
import { AccountStateStore } from "./account-state.js";
import { BrowserManager } from "./browser-manager.js";
import { FacebookScanner } from "./facebook-scanner.js";
import { ApiClient } from "./api-client.js";
import { ResultOutbox } from "./outbox.js";
import { JobRunner } from "./job-runner.js";
import { PrivateScraperService } from "./service.js";
import { acquireProcessLock } from "./process-lock.js";

loadLocalEnv();
const logger = createLogger();

async function main() {
  const once = process.argv.includes("--once");
  const config = await loadConfig();
  const releaseLock = await acquireProcessLock(config.lockFile);
  const sessionStore = new EncryptedJsonStore(config.sessionsDir, config.encryptionKey, "facebook-session");
  const outboxStore = new EncryptedJsonStore(config.outboxDir, config.encryptionKey, "result-outbox");
  const accountStates = await new AccountStateStore(config.accountStateFile, config.accounts).load();
  const browserManager = await new BrowserManager(config, sessionStore, logger, accountStates).start();
  const apiClient = new ApiClient(config, logger);
  const outbox = new ResultOutbox(outboxStore, apiClient, logger);
  const scanner = new FacebookScanner(config, logger);
  const runner = new JobRunner(config, browserManager, scanner, accountStates, logger);
  const service = new PrivateScraperService(config, apiClient, runner, outbox, accountStates, browserManager, logger);
  let cleaningUp = false;

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    service.stop();
    await browserManager.close().catch((error) => logger.warn("browser_close_failed", { error }));
    await releaseLock().catch((error) => logger.warn("lock_release_failed", { error }));
  };

  process.once("SIGTERM", () => {
    logger.info("shutdown_requested", { signal: "SIGTERM" });
    service.stop();
  });
  process.once("SIGINT", () => {
    logger.info("shutdown_requested", { signal: "SIGINT" });
    service.stop();
  });

  logger.info("worker_started", {
    workerId: config.workerId,
    accounts: config.accounts.length,
    mode: once ? "once" : "daemon",
    bandwidthTargetBytes: config.bandwidthTargetBytes,
    hardTransferLimitBytes: config.maxTransferBytes
  });
  try {
    if (once) await service.runOnce();
    else await service.start();
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  logger.error("worker_stopped", { error });
  process.exitCode = 1;
});
