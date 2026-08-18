import { setTimeout as delay } from "node:timers/promises";
import { ERROR_CODES, ScraperError } from "./errors.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESULT_STATUSES = new Set(["success", "failed"]);

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ScraperError(ERROR_CODES.JOB_INVALID, `${name} is invalid`);
  return value;
}

function stringId(value, name) {
  const result = String(value || "");
  if (!SAFE_ID.test(result)) throw new ScraperError(ERROR_CODES.JOB_INVALID, `${name} is invalid`);
  return result;
}

export function validateJob(raw) {
  if (!raw || typeof raw !== "object") throw new ScraperError(ERROR_CODES.JOB_INVALID, "The server returned an invalid job");
  const kind = raw.kind;
  if (!new Set(["scan_group", "validate_session"]).has(kind)) {
    throw new ScraperError(ERROR_CODES.JOB_INVALID, "The server returned an unknown job kind");
  }
  const job = {
    kind,
    runId: stringId(raw.runId, "runId"),
    accountId: stringId(raw.accountId, "accountId"),
    maxCostAudMicros: safeInteger(raw.maxCostAudMicros, "maxCostAudMicros"),
    deadlineAtMs: safeInteger(raw.deadlineAtMs, "deadlineAtMs")
  };
  if (kind === "scan_group") {
    job.sourceId = safeInteger(raw.sourceId, "sourceId");
    job.url = String(raw.url || "");
    if (job.url.length > 2_000) throw new ScraperError(ERROR_CODES.JOB_INVALID, "url is too long");
    job.groupName = String(raw.groupName || "").slice(0, 200);
  }
  return Object.freeze(job);
}

function validatePullResponse(raw) {
  if (!raw || raw.ok !== true || !Array.isArray(raw.jobs)) {
    throw new ScraperError(ERROR_CODES.API_FAILED, "The jobs endpoint returned an invalid response");
  }
  const serverTimeMs = safeInteger(raw.serverTimeMs, "serverTimeMs");
  if (raw.lookbackMinutes !== 65) {
    throw new ScraperError(ERROR_CODES.API_FAILED, "The server lookback must be exactly 65 minutes");
  }
  return {
    serverTimeMs,
    lookbackMinutes: 65,
    jobs: raw.jobs.map(validateJob)
  };
}

export function validateResult(result) {
  if (!result || typeof result !== "object" || !RESULT_STATUSES.has(result.status)) {
    throw new TypeError("Invalid result payload");
  }
  stringId(result.runId, "runId");
  stringId(result.workerId, "workerId");
  stringId(result.accountId, "accountId");
  if (result.sourceId !== undefined) safeInteger(result.sourceId, "sourceId");
  safeInteger(result.startedAtMs, "startedAtMs");
  safeInteger(result.finishedAtMs, "finishedAtMs");
  const bytesTransferred = safeInteger(result.bytesTransferred, "bytesTransferred");
  if (!Array.isArray(result.posts) || result.posts.length > 100) throw new TypeError("Result posts are invalid");
  if (typeof result.costAttempted !== "boolean") throw new TypeError("Result costAttempted is invalid");
  if (!result.proxyCost || typeof result.proxyCost !== "object") throw new TypeError("Result proxyCost is invalid");
  const proxyAmount = safeInteger(result.proxyCost.amountMicros, "proxyCost.amountMicros");
  const trafficAmount = safeInteger(result.proxyCost.trafficAmountMicros, "proxyCost.trafficAmountMicros");
  const fixedAmount = safeInteger(result.proxyCost.fixedAmountMicros, "proxyCost.fixedAmountMicros");
  if (proxyAmount !== trafficAmount + fixedAmount || !Number.isSafeInteger(trafficAmount + fixedAmount)) {
    throw new TypeError("Result proxyCost does not reconcile");
  }
  if (!new Set(["AUD", "USD"]).has(result.proxyCost.currency)) throw new TypeError("Result proxyCost currency is invalid");
  if (result.proxyCost.currency === "USD") safeInteger(result.proxyCost.audRateMicros, "proxyCost.audRateMicros");
  const vpsCost = safeInteger(result.vpsCostAudMicros, "vpsCostAudMicros");
  if (!result.costAttempted && (bytesTransferred !== 0 || proxyAmount !== 0 || vpsCost !== 0)) {
    throw new TypeError("An untouched result cannot report attempted cost");
  }
  return result;
}

export class ApiClient {
  constructor(config, logger, fetchImpl = fetch) {
    this.baseUrl = config.apiBaseUrl;
    this.secret = config.apiSecret;
    this.workerId = config.workerId;
    this.timeoutMs = config.apiTimeoutMs;
    this.maxResultPayloadBytes = config.maxResultPayloadBytes || 500_000;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}, attempts = 3) {
    let latestError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...options,
          headers: {
            authorization: `Bearer ${this.secret}`,
            accept: "application/json",
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...options.headers
          },
          signal: controller.signal
        });
        const bodyText = await response.text();
        let body;
        try {
          body = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          throw new ScraperError(ERROR_CODES.API_FAILED, `The scraper API returned non-JSON data with status ${response.status}`);
        }
        if (!response.ok) {
          const message = typeof body.error === "string" ? body.error : `The scraper API returned status ${response.status}`;
          const error = new ScraperError(ERROR_CODES.API_FAILED, message, { status: response.status });
          if (response.status < 500 && response.status !== 429) throw error;
          latestError = error;
        } else {
          return body;
        }
      } catch (error) {
        latestError = error instanceof ScraperError
          ? error
          : new ScraperError(ERROR_CODES.API_FAILED, error.name === "AbortError" ? "The scraper API timed out" : error.message);
        if (latestError.details?.status && latestError.details.status < 500 && latestError.details.status !== 429) throw latestError;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < attempts) await delay(250 * (2 ** (attempt - 1)));
    }
    throw latestError;
  }

  async pullJobs() {
    const body = await this.request(`/api/internal/private-scraper/jobs?workerId=${encodeURIComponent(this.workerId)}`);
    return validatePullResponse(body);
  }

  async submitResult(result) {
    validateResult(result);
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body, "utf8") > this.maxResultPayloadBytes) {
      throw new ScraperError(ERROR_CODES.RESULT_PAYLOAD_TOO_LARGE, "The result is too large for the secure ingestion endpoint");
    }
    return this.request("/api/internal/private-scraper/results", {
      method: "POST",
      body
    });
  }

  async sendHeartbeat(heartbeat) {
    return this.request("/api/internal/private-scraper/heartbeat", {
      method: "POST",
      body: JSON.stringify({ workerId: this.workerId, ...heartbeat })
    }, 2);
  }
}
