import { estimatedMaxCostAudMicros } from "./cost.js";
import { ERROR_CODES, ScraperError } from "./errors.js";

export class PrivateScraperService {
  constructor(config, apiClient, runner, outbox, accountStates, browserManager, logger) {
    this.config = config;
    this.apiClient = apiClient;
    this.runner = runner;
    this.outbox = outbox;
    this.accountStates = accountStates;
    this.browserManager = browserManager;
    this.logger = logger;
    this.running = false;
    this.draining = false;
    this.lastTickError = "";
  }

  heartbeatAccounts(nowMs) {
    return this.accountStates.heartbeatAccounts().map((account) => ({
      ...account,
      healthValidationDue: !account.lastHealthCheckAtMs
        || nowMs - account.lastHealthCheckAtMs >= this.config.dailyHealthIntervalMs
    }));
  }

  async heartbeat(statusOverride) {
    const nowMs = Date.now();
    const accounts = this.heartbeatAccounts(nowMs);
    const healthyProxyCount = accounts.filter((account) => account.proxyStatus === "healthy").length;
    const failedProxyCount = accounts.filter((account) => account.proxyStatus === "failed").length;
    const proxyStatus = healthyProxyCount === accounts.length
      ? "healthy"
      : healthyProxyCount > 0 ? "degraded"
        : failedProxyCount > 0 ? "failed" : "unknown";
    const accountProblem = accounts.some((account) =>
      account.status !== "healthy"
      || account.sessionStatus !== "healthy"
      || account.proxyStatus !== "healthy"
    );
    const status = statusOverride || (this.lastTickError || accountProblem ? "degraded" : "healthy");
    await this.apiClient.sendHeartbeat({
      atMs: nowMs,
      status,
      version: "0.1.0",
      proxyStatus,
      accounts,
      estimatedMaxCostAudMicros: Number(estimatedMaxCostAudMicros(this.config)),
      bandwidthTargetBytes: this.config.bandwidthTargetBytes,
      hardTransferLimitBytes: this.config.maxTransferBytes,
      reservationTransferBytes: this.config.reservationTransferBytes,
      ...(this.lastTickError ? { message: this.lastTickError } : {})
    });
  }

  async deliver(result) {
    let deliverable = result;
    const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (resultBytes > this.config.maxResultPayloadBytes) {
      deliverable = {
        runId: result.runId,
        workerId: result.workerId,
        ...(result.sourceId === undefined ? {} : { sourceId: result.sourceId }),
        accountId: result.accountId,
        status: "failed",
        startedAtMs: result.startedAtMs,
        finishedAtMs: result.finishedAtMs,
        chronologicalVerified: false,
        boundaryReached: false,
        feedEndReached: false,
        posts: [],
        bytesTransferred: result.bytesTransferred,
        bandwidthTargetBytes: result.bandwidthTargetBytes,
        bandwidthTargetExceeded: result.bandwidthTargetExceeded,
        proxyCost: result.proxyCost,
        vpsCostAudMicros: result.vpsCostAudMicros,
        costAttempted: result.costAttempted,
        ...(result.sessionRefreshedAtMs ? { sessionRefreshedAtMs: result.sessionRefreshedAtMs } : {}),
        ...(result.sessionExpiresAtMs ? { sessionExpiresAtMs: result.sessionExpiresAtMs } : {}),
        accountStatus: result.accountStatus,
        sessionStatus: result.sessionStatus,
        proxyStatus: result.proxyStatus,
        ...(result.groupStatus ? { groupStatus: result.groupStatus } : {}),
        errorCode: ERROR_CODES.RESULT_PAYLOAD_TOO_LARGE,
        errorMessage: "The collected result exceeded the secure ingestion size limit",
        resultPayloadBytes: resultBytes
      };
      this.logger.error("result_payload_too_large", {
        runId: result.runId,
        sourceId: result.sourceId,
        resultPayloadBytes: resultBytes,
        maxResultPayloadBytes: this.config.maxResultPayloadBytes
      });
    }
    if (Buffer.byteLength(JSON.stringify(deliverable), "utf8") > this.config.maxResultPayloadBytes) {
      throw new ScraperError(ERROR_CODES.RESULT_PAYLOAD_TOO_LARGE, "The compact result exceeds the ingestion size limit");
    }
    await this.outbox.enqueue(deliverable);
    await this.outbox.flush();
  }

  async tick() {
    if (this.draining) {
      this.logger.warn("overlapping_tick_skipped", { errorCode: ERROR_CODES.OVERLAPPING_RUN });
      return;
    }
    this.draining = true;
    try {
      const pending = await this.outbox.flush();
      if (pending) this.logger.info("outbox_flushed", { results: pending });
      const pulled = await this.apiClient.pullJobs();
      const clockOffsetMs = pulled.serverTimeMs - Date.now();
      const sourceIds = new Set();
      const runIds = new Set();

      for (const job of pulled.jobs) {
        if (runIds.has(job.runId)) continue;
        runIds.add(job.runId);
        if (job.kind === "scan_group" && sourceIds.has(job.sourceId)) {
          const result = await this.runner.failWithoutRunning(
            job,
            new ScraperError(ERROR_CODES.DUPLICATE_SOURCE_JOB, "The server queued the same shared source more than once"),
            Date.now() + clockOffsetMs
          );
          await this.deliver(result);
          continue;
        }
        if (job.kind === "scan_group") sourceIds.add(job.sourceId);
        const result = await this.runner.run(job, Date.now() + clockOffsetMs);
        await this.deliver(result);
      }
      this.lastTickError = "";
    } catch (error) {
      this.lastTickError = String(error?.message || error).slice(0, 300);
      this.logger.error("worker_tick_failed", { error });
      throw error;
    } finally {
      this.draining = false;
    }
  }

  async runOnce() {
    await this.heartbeat().catch((error) => this.logger.warn("heartbeat_failed", { error }));
    await this.tick();
    await this.heartbeat().catch((error) => this.logger.warn("heartbeat_failed", { error }));
  }

  async start() {
    this.running = true;
    await this.heartbeat().catch((error) => this.logger.warn("heartbeat_failed", { error }));
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatRunning) return;
      this.heartbeatRunning = true;
      this.heartbeat()
        .catch((error) => this.logger.warn("heartbeat_failed", { error }))
        .finally(() => { this.heartbeatRunning = false; });
    }, this.config.heartbeatIntervalMs);
    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.tick();
      } catch {
        // The heartbeat exposes the degraded state and the next pull retries.
      }
      const elapsed = Date.now() - startedAt;
      await new Promise((resolve) => {
        this.sleepResolve = resolve;
        this.sleepTimer = setTimeout(resolve, Math.max(1_000, this.config.pollIntervalMs - elapsed));
      });
      this.sleepResolve = undefined;
    }
    clearInterval(this.heartbeatTimer);
  }

  stop() {
    this.running = false;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepResolve?.();
    clearInterval(this.heartbeatTimer);
  }
}
