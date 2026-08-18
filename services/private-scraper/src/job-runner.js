import { assertReservation, serialiseCost, serialiseZeroCost } from "./cost.js";
import { ERROR_CODES, ScraperError, asScraperError } from "./errors.js";
import { buildChronologicalUrl } from "./facebook-feed.js";
import { sanitiseText } from "./logger.js";

const RECYCLE_CONTEXT_ERRORS = new Set([
  ERROR_CODES.ACCOUNT_BLOCKED,
  ERROR_CODES.ACCOUNT_DISABLED,
  ERROR_CODES.CHALLENGE_REQUIRED,
  ERROR_CODES.LOGIN_REQUIRED,
  ERROR_CODES.PROXY_AUTH_FAILED,
  ERROR_CODES.PROXY_FAILED,
  ERROR_CODES.PROXY_IDENTITY_SAVE_FAILED,
  ERROR_CODES.SESSION_MISSING
]);

const ACCOUNT_HEALTH_ERRORS = new Set([
  ERROR_CODES.ACCOUNT_BLOCKED,
  ERROR_CODES.ACCOUNT_DISABLED,
  ERROR_CODES.ACCOUNT_NOT_HEALTHY,
  ERROR_CODES.CHALLENGE_REQUIRED,
  ERROR_CODES.LOGIN_REQUIRED,
  ERROR_CODES.PROXY_AUTH_FAILED,
  ERROR_CODES.PROXY_FAILED,
  ERROR_CODES.PROXY_IDENTITY_SAVE_FAILED,
  ERROR_CODES.PROXY_ROTATED,
  ERROR_CODES.SESSION_MISSING,
  ERROR_CODES.SESSION_SAVE_FAILED
]);

function failureStatuses(error, jobKind, previousState) {
  const proxyFailure = new Set([
    ERROR_CODES.PROXY_AUTH_FAILED,
    ERROR_CODES.PROXY_FAILED,
    ERROR_CODES.PROXY_IDENTITY_SAVE_FAILED,
    ERROR_CODES.PROXY_ROTATED
  ]).has(error.code);
  const sessionFailure = new Set([
    ERROR_CODES.ACCOUNT_BLOCKED,
    ERROR_CODES.ACCOUNT_DISABLED,
    ERROR_CODES.CHALLENGE_REQUIRED,
    ERROR_CODES.LOGIN_REQUIRED,
    ERROR_CODES.SESSION_MISSING
  ]).has(error.code);
  if (jobKind === "scan_group" && previousState && !ACCOUNT_HEALTH_ERRORS.has(error.code)) {
    return {
      accountStatus: previousState.status,
      sessionStatus: previousState.sessionStatus,
      proxyStatus: previousState.proxyStatus,
      groupStatus: error.details?.groupStatus || "error"
    };
  }
  return {
    accountStatus: error.details?.accountStatus || (sessionFailure ? "login_required" : "error"),
    sessionStatus: error.details?.sessionStatus || (sessionFailure ? "login_required" : "stale"),
    proxyStatus: proxyFailure ? "failed" : (error.details?.proxyStatus || "unknown"),
    groupStatus: error.details?.groupStatus || "error"
  };
}

export class JobRunner {
  constructor(config, browserManager, scanner, accountStates, logger) {
    this.config = config;
    this.browserManager = browserManager;
    this.scanner = scanner;
    this.accountStates = accountStates;
    this.logger = logger;
  }

  baseResult(job, startedAtMs, finishedAtMs = Date.now()) {
    return {
      runId: job.runId,
      workerId: this.config.workerId,
      ...(job.sourceId === undefined ? {} : { sourceId: job.sourceId }),
      accountId: job.accountId,
      startedAtMs,
      finishedAtMs,
      chronologicalVerified: false,
      boundaryReached: false,
      feedEndReached: false,
      posts: [],
      bytesTransferred: 0
    };
  }

  async saveAuthenticatedSession(entry) {
    try {
      return await this.browserManager.save(entry);
    } catch (error) {
      throw new ScraperError(ERROR_CODES.SESSION_SAVE_FAILED, `Could not safely save the renewed Facebook session: ${error.message}`);
    }
  }

  async run(job, clockNowMs = Date.now()) {
    const localStartedAtMs = Date.now();
    const clockOffsetMs = clockNowMs - localStartedAtMs;
    const startedAtMs = clockNowMs;
    let networkStarted = false;
    let attemptAuthorised = false;
    let entry;
    let sessionSaved;
    let outcome;
    try {
      if (!this.config.accountsById.has(job.accountId)) {
        throw new ScraperError(ERROR_CODES.JOB_INVALID, `The job names an account that is not configured: ${job.accountId}`);
      }
      const configuredAccount = this.config.accountsById.get(job.accountId);
      if (job.deadlineAtMs <= clockNowMs) throw new ScraperError(ERROR_CODES.JOB_EXPIRED, "The scraper job expired before it could start");
      assertReservation(job, this.config);
      if (job.kind === "scan_group") buildChronologicalUrl(job.url);
      if (job.kind === "scan_group" && typeof this.accountStates.get === "function") {
        const state = this.accountStates.get(job.accountId);
        if (state.status !== "healthy" || state.sessionStatus !== "healthy" || state.proxyStatus !== "healthy") {
          throw new ScraperError(ERROR_CODES.ACCOUNT_NOT_HEALTHY, "The assigned Facebook account is not healthy enough for a paid group scan", {
            accountStatus: state.status,
            sessionStatus: state.sessionStatus,
            proxyStatus: state.proxyStatus
          });
        }
      }
      attemptAuthorised = true;
      const account = configuredAccount;
      try {
        entry = await this.browserManager.get(account);
      } catch (error) {
        networkStarted = Boolean(error?.details?.networkStarted);
        throw error;
      }
      const bootstrapBytes = this.browserManager.takeBootstrapBytes(entry);
      networkStarted = networkStarted || bootstrapBytes > 0;

      if (job.kind === "scan_group") {
        outcome = await this.scanner.scanGroup(entry, job, clockNowMs, bootstrapBytes);
      } else {
        outcome = await this.scanner.validateSession(
          entry,
          bootstrapBytes,
          bootstrapBytes > 0 ? undefined : () => this.browserManager.recheckProxy(entry)
        );
      }
      networkStarted = networkStarted || Boolean(outcome.networkStarted ?? outcome.bytesTransferred > 0);
      sessionSaved = await this.saveAuthenticatedSession(entry);
      const finishedAtMs = Date.now() + clockOffsetMs;
      const result = {
        ...this.baseResult(job, startedAtMs),
        status: "success",
        finishedAtMs,
        chronologicalVerified: outcome.chronologicalVerified || false,
        boundaryReached: outcome.boundaryReached || false,
        feedEndReached: outcome.feedEndReached || false,
        posts: outcome.posts || [],
        bytesTransferred: outcome.bytesTransferred,
        bandwidthTargetBytes: this.config.bandwidthTargetBytes,
        bandwidthTargetExceeded: outcome.bandwidthTargetExceeded,
        ignoredPinnedPosts: outcome.ignoredPinnedPosts || 0,
        postsSkippedNoText: outcome.postsSkippedNoText || 0,
        duplicatePostsSkipped: outcome.duplicatePostsSkipped || 0,
        normalPostsInspected: outcome.normalPostsInspected || 0,
        proxyCost: serialiseCost(this.config, outcome.bytesTransferred),
        vpsCostAudMicros: this.config.vpsCostAudMicrosPerCheck,
        costAttempted: true,
        sessionRefreshedAtMs: Math.floor(sessionSaved.savedAtMs),
        ...(sessionSaved.expiresAtMs ? { sessionExpiresAtMs: sessionSaved.expiresAtMs } : {}),
        accountStatus: outcome.accountStatus,
        sessionStatus: outcome.sessionStatus,
        proxyStatus: outcome.proxyStatus || "healthy",
        ...(job.kind === "scan_group" ? { groupStatus: outcome.groupStatus } : {})
      };
      await this.accountStates.update(job.accountId, {
        status: "healthy",
        sessionStatus: "healthy",
        proxyStatus: "healthy",
        cookieSavedAtMs: Math.floor(sessionSaved.savedAtMs),
        ...(sessionSaved.expiresAtMs ? { sessionExpiresAtMs: sessionSaved.expiresAtMs } : {}),
        ...(job.kind === "validate_session" ? { lastHealthCheckAtMs: finishedAtMs } : { lastScanAtMs: finishedAtMs }),
        latestErrorCode: "",
        latestError: ""
      });
      this.logger.info("job_succeeded", {
        runId: job.runId,
        kind: job.kind,
        sourceId: job.sourceId,
        accountId: job.accountId,
        bytesTransferred: outcome.bytesTransferred,
        bandwidthTargetExceeded: outcome.bandwidthTargetExceeded,
        postsCollected: result.posts.length,
        boundaryReached: result.boundaryReached,
        feedEndReached: result.feedEndReached
      });
      return result;
    } catch (rawError) {
      let error = asScraperError(rawError);
      if (error.details?.networkStarted !== undefined) {
        networkStarted = Boolean(error.details.networkStarted);
      }
      if (outcome) {
        error.details = {
          accountStatus: outcome.accountStatus,
          sessionStatus: error.code === ERROR_CODES.SESSION_SAVE_FAILED ? "stale" : outcome.sessionStatus,
          proxyStatus: outcome.proxyStatus || "healthy",
          groupStatus: outcome.groupStatus,
          bytesTransferred: outcome.bytesTransferred,
          bandwidthTargetExceeded: outcome.bandwidthTargetExceeded,
          ...error.details
        };
      }
      const bytesTransferred = Number(outcome?.bytesTransferred ?? error.details?.bytesTransferred ?? 0);
      if (error.details?.networkStarted === undefined && bytesTransferred > 0) networkStarted = true;
      if (entry && error.details?.authenticated) {
        try {
          sessionSaved = await this.saveAuthenticatedSession(entry);
        } catch (saveError) {
          const saveFailure = asScraperError(saveError);
          saveFailure.details = {
            ...error.details,
            sessionStatus: "stale",
            causeErrorCode: error.code
          };
          error = saveFailure;
        }
      }
      const previousState = typeof this.accountStates.get === "function"
        ? this.accountStates.get(job.accountId)
        : undefined;
      const statuses = !attemptAuthorised
        ? {
            ...(previousState ? {
              accountStatus: previousState.status,
              sessionStatus: previousState.sessionStatus,
              proxyStatus: previousState.proxyStatus
            } : {}),
            groupStatus: "error"
          }
        : failureStatuses(error, job.kind, previousState);
      const finishedAtMs = Date.now() + clockOffsetMs;
      if (attemptAuthorised) {
        const accountPatch = {
          status: statuses.accountStatus,
          sessionStatus: statuses.sessionStatus,
          proxyStatus: statuses.proxyStatus,
          ...(sessionSaved ? { cookieSavedAtMs: Math.floor(sessionSaved.savedAtMs) } : {}),
          ...(sessionSaved?.expiresAtMs ? { sessionExpiresAtMs: sessionSaved.expiresAtMs } : {}),
          ...(job.kind === "validate_session" ? { lastHealthCheckAtMs: finishedAtMs } : { lastScanAtMs: finishedAtMs })
        };
        if (job.kind === "validate_session" || ACCOUNT_HEALTH_ERRORS.has(error.code)) {
          accountPatch.latestErrorCode = error.code;
          accountPatch.latestError = sanitiseText(error.message);
        }
        await this.accountStates.update(job.accountId, accountPatch).catch(() => {});
      }
      if (entry && RECYCLE_CONTEXT_ERRORS.has(error.code)) await this.browserManager.closeAccount(job.accountId).catch(() => {});
      const result = {
        ...this.baseResult(job, startedAtMs),
        status: "failed",
        finishedAtMs,
        bytesTransferred,
        bandwidthTargetBytes: this.config.bandwidthTargetBytes,
        bandwidthTargetExceeded: error.details?.bandwidthTargetExceeded === undefined
          ? bytesTransferred > this.config.bandwidthTargetBytes
          : Boolean(error.details.bandwidthTargetExceeded),
        proxyCost: networkStarted
          ? serialiseCost(this.config, bytesTransferred)
          : serialiseZeroCost(this.config),
        vpsCostAudMicros: attemptAuthorised ? this.config.vpsCostAudMicrosPerCheck : 0,
        costAttempted: attemptAuthorised,
        ...(sessionSaved ? { sessionRefreshedAtMs: Math.floor(sessionSaved.savedAtMs) } : {}),
        ...(sessionSaved?.expiresAtMs ? { sessionExpiresAtMs: sessionSaved.expiresAtMs } : {}),
        ...statuses,
        errorCode: error.code,
        errorMessage: sanitiseText(error.message)
      };
      this.logger.error("job_failed", {
        runId: job.runId,
        kind: job.kind,
        sourceId: job.sourceId,
        accountId: job.accountId,
        errorCode: error.code,
        errorMessage: error.message,
        bytesTransferred
      });
      return result;
    }
  }

  async failWithoutRunning(job, error, clockNowMs = Date.now()) {
    const startedAtMs = clockNowMs;
    const failure = asScraperError(error);
    const previousState = typeof this.accountStates.get === "function"
      ? this.accountStates.get(job.accountId)
      : undefined;
    return {
      ...this.baseResult(job, startedAtMs, clockNowMs),
      status: "failed",
      errorCode: failure.code,
      errorMessage: sanitiseText(failure.message),
      ...(previousState ? {
        accountStatus: previousState.status,
        sessionStatus: previousState.sessionStatus,
        proxyStatus: previousState.proxyStatus
      } : {}),
      proxyCost: serialiseZeroCost(this.config),
      vpsCostAudMicros: 0,
      costAttempted: false,
      ...(job.kind === "scan_group" ? { groupStatus: "error" } : {})
    };
  }
}
