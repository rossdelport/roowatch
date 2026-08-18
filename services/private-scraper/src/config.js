import { readFile } from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, ScraperError } from "./errors.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `${name} is required`);
  return value;
}

function integer(env, name, options = {}) {
  const raw = options.defaultValue === undefined ? required(env, name) : (env[name]?.trim() || String(options.defaultValue));
  if (!/^\d+$/.test(raw)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `${name} is outside its allowed range`);
  }
  return value;
}

function boolean(env, name, defaultValue) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `${name} must be true or false`);
}

function validateBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "PRIVATE_SCRAPER_API_BASE_URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The scraper API must use HTTPS outside local development");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function validateHealthcheckUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "PROXY_HEALTHCHECK_URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The proxy health endpoint must use HTTPS outside local development");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (hostname === "facebook.com" || hostname.endsWith(".facebook.com") || url.username || url.password) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The proxy health endpoint must be independent and contain no credentials");
  }
  url.hash = "";
  return url.toString();
}

function assertSafeCostRange({
  reservationTransferBytes,
  proxyCostMicrosPerGb,
  proxyFixedMicrosPerCheck,
  proxyCostCurrency,
  audMicrosPerUsd,
  vpsCostAudMicrosPerCheck
}) {
  const bytesPerGb = 1_000_000_000n;
  const micros = 1_000_000n;
  const traffic = (BigInt(reservationTransferBytes) * BigInt(proxyCostMicrosPerGb) + bytesPerGb - 1n) / bytesPerGb;
  const supplier = traffic + BigInt(proxyFixedMicrosPerCheck);
  const proxyAud = proxyCostCurrency === "USD"
    ? (supplier * BigInt(audMicrosPerUsd) + micros - 1n) / micros
    : supplier;
  const totalAud = proxyAud + BigInt(vpsCostAudMicrosPerCheck);
  if (supplier > BigInt(Number.MAX_SAFE_INTEGER) || totalAud > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The configured maximum cost exceeds exact integer range");
  }
}

function validateProxyTemplates(env) {
  const serverTemplate = required(env, "RESIDENTIAL_PROXY_SERVER_TEMPLATE");
  const usernameTemplate = env.RESIDENTIAL_PROXY_USERNAME_TEMPLATE?.trim() || "";
  const passwordTemplate = env.RESIDENTIAL_PROXY_PASSWORD_TEMPLATE?.trim() || "";
  if (![serverTemplate, usernameTemplate, passwordTemplate].some((value) => value.includes("{sessionId}"))) {
    throw new ScraperError(
      ERROR_CODES.CONFIG_INVALID,
      "A residential proxy template must include {sessionId} for stable per-account sessions"
    );
  }
  return { serverTemplate, usernameTemplate, passwordTemplate };
}

function validateKey(raw) {
  let decoded;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "SESSION_ENCRYPTION_KEY must be base64 encoded");
  }
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "SESSION_ENCRYPTION_KEY must contain exactly 32 random bytes");
  }
  return decoded;
}

export function validateAccount(raw, index) {
  if (!raw || typeof raw !== "object") throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Account ${index + 1} is invalid`);
  const account = {
    id: String(raw.id || "").trim(),
    label: String(raw.label || "").trim(),
    storageKey: String(raw.storageKey || "").trim(),
    proxySessionId: String(raw.proxySessionId || "").trim()
  };
  for (const [key, value] of Object.entries(account)) {
    if (key === "label") continue;
    if (!SAFE_ID.test(value)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Account ${index + 1} has an invalid ${key}`);
  }
  if (!account.label || account.label.length > 120) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Account ${index + 1} needs a short label`);
  }
  return Object.freeze(account);
}

export async function loadAccounts(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Could not read the accounts file: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The accounts file must contain at least one account");
  }
  const accounts = parsed.map(validateAccount);
  const ids = new Set();
  const storageKeys = new Set();
  const proxySessions = new Set();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Duplicate account id: ${account.id}`);
    if (storageKeys.has(account.storageKey)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Duplicate storage key: ${account.storageKey}`);
    if (proxySessions.has(account.proxySessionId)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Duplicate proxy session: ${account.proxySessionId}`);
    ids.add(account.id);
    storageKeys.add(account.storageKey);
    proxySessions.add(account.proxySessionId);
  }
  return Object.freeze(accounts);
}

export async function loadConfig(env = process.env, cwd = process.cwd()) {
  const stateDir = path.resolve(cwd, env.STATE_DIR?.trim() || "./var");
  const accountsFile = path.resolve(cwd, env.ACCOUNTS_FILE?.trim() || "./accounts.json");
  const proxyTemplates = validateProxyTemplates(env);
  const proxyCostCurrency = required(env, "PROXY_COST_CURRENCY").toUpperCase();
  if (!new Set(["AUD", "USD"]).has(proxyCostCurrency)) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "PROXY_COST_CURRENCY must be AUD or USD");
  }
  const maxTransferBytes = integer(env, "MAX_TRANSFER_BYTES_PER_CHECK", { defaultValue: 2_000_000, min: 100_000 });
  const bandwidthTargetBytes = integer(env, "NORMAL_BANDWIDTH_TARGET_BYTES", { defaultValue: 1_000_000, min: 100_000 });
  if (bandwidthTargetBytes > maxTransferBytes) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "The normal bandwidth target cannot exceed the hard transfer limit");
  }
  const reservationTransferBytes = integer(env, "RESERVATION_TRANSFER_BYTES_PER_CHECK", { defaultValue: 3_000_000, min: maxTransferBytes });
  if (reservationTransferBytes < maxTransferBytes) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "Reservation transfer bytes must be at least the hard transfer limit");
  }

  const workerId = required(env, "PRIVATE_SCRAPER_WORKER_ID");
  if (!SAFE_ID.test(workerId)) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "PRIVATE_SCRAPER_WORKER_ID is invalid");
  const secret = required(env, "PRIVATE_SCRAPER_SECRET");
  if (secret.length < 32) throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "PRIVATE_SCRAPER_SECRET must be at least 32 characters");

  const proxyCostMicrosPerGb = integer(env, "PROXY_COST_MICROS_PER_GB");
  const proxyFixedMicrosPerCheck = integer(env, "PROXY_FIXED_MICROS_PER_CHECK", { defaultValue: 0 });
  if (proxyCostMicrosPerGb === 0 && proxyFixedMicrosPerCheck === 0) {
    throw new ScraperError(
      ERROR_CODES.CONFIG_INVALID,
      "At least one proxy cost component must be greater than zero"
    );
  }
  const audMicrosPerUsd = proxyCostCurrency === "USD" ? integer(env, "AUD_MICROS_PER_USD", { min: 1 }) : undefined;
  const vpsCostAudMicrosPerCheck = integer(env, "VPS_COST_AUD_MICROS_PER_CHECK", { min: 1 });
  assertSafeCostRange({
    reservationTransferBytes,
    proxyCostMicrosPerGb,
    proxyFixedMicrosPerCheck,
    proxyCostCurrency,
    audMicrosPerUsd,
    vpsCostAudMicrosPerCheck
  });
  const chronologicalLabels = (env.FACEBOOK_CHRONOLOGICAL_LABELS || "New posts")
    .split(",").map((item) => item.trim()).filter(Boolean);
  if (chronologicalLabels.length === 0) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "FACEBOOK_CHRONOLOGICAL_LABELS must contain at least one exact label");
  }
  const facebookTimezone = env.FACEBOOK_TIMEZONE?.trim() || "Australia/Perth";
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: facebookTimezone }).format();
  } catch {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "FACEBOOK_TIMEZONE is invalid");
  }

  const config = {
    apiBaseUrl: validateBaseUrl(required(env, "PRIVATE_SCRAPER_API_BASE_URL")),
    apiSecret: secret,
    workerId,
    encryptionKey: validateKey(required(env, "SESSION_ENCRYPTION_KEY")),
    accountsFile,
    stateDir,
    sessionsDir: path.join(stateDir, "sessions"),
    outboxDir: path.join(stateDir, "outbox"),
    accountStateFile: path.join(stateDir, "account-state.json"),
    lockFile: path.join(stateDir, "worker.lock"),
    residentialProxyProvider: required(env, "RESIDENTIAL_PROXY_PROVIDER"),
    ...proxyTemplates,
    proxyHealthcheckUrl: validateHealthcheckUrl(required(env, "PROXY_HEALTHCHECK_URL")),
    proxyCostCurrency,
    proxyCostMicrosPerGb,
    proxyFixedMicrosPerCheck,
    audMicrosPerUsd,
    vpsCostAudMicrosPerCheck,
    bandwidthTargetBytes,
    maxTransferBytes,
    reservationTransferBytes,
    pollIntervalMs: integer(env, "POLL_INTERVAL_MS", { defaultValue: 60_000, min: 10_000 }),
    heartbeatIntervalMs: integer(env, "HEARTBEAT_INTERVAL_MS", { defaultValue: 60_000, min: 10_000 }),
    dailyHealthIntervalMs: integer(env, "DAILY_HEALTH_INTERVAL_MS", { defaultValue: 86_400_000, min: 3_600_000 }),
    maxScrolls: integer(env, "MAX_SCROLLS_PER_CHECK", { defaultValue: 12, min: 1, max: 100 }),
    navigationTimeoutMs: integer(env, "NAVIGATION_TIMEOUT_MS", { defaultValue: 45_000, min: 5_000 }),
    feedWaitTimeoutMs: integer(env, "FEED_WAIT_TIMEOUT_MS", { defaultValue: 15_000, min: 1_000 }),
    apiTimeoutMs: integer(env, "API_TIMEOUT_MS", { defaultValue: 20_000, min: 1_000 }),
    maxResultPayloadBytes: integer(env, "MAX_RESULT_PAYLOAD_BYTES", { defaultValue: 500_000, min: 64_000, max: 500_000 }),
    facebookLocale: env.FACEBOOK_LOCALE?.trim() || "en-AU",
    facebookTimezone,
    chronologicalLabels,
    headless: boolean(env, "HEADLESS", true),
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH?.trim() || undefined
  };
  config.accounts = await loadAccounts(accountsFile);
  config.accountsById = new Map(config.accounts.map((account) => [account.id, account]));
  return Object.freeze(config);
}

export function applyTemplate(template, account) {
  return template
    .replaceAll("{accountId}", account.id)
    .replaceAll("{sessionId}", account.proxySessionId);
}

export function proxyForAccount(config, account) {
  const server = applyTemplate(config.serverTemplate, account);
  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, `Proxy server template is invalid for account ${account.id}`);
  }
  if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol)) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "Proxy server must use HTTP, HTTPS or SOCKS5");
  }
  if (parsed.username || parsed.password) {
    throw new ScraperError(ERROR_CODES.CONFIG_INVALID, "Put proxy credentials in their own templates, not in the server URL");
  }
  return {
    server,
    ...(config.usernameTemplate ? { username: applyTemplate(config.usernameTemplate, account) } : {}),
    ...(config.passwordTemplate ? { password: applyTemplate(config.passwordTemplate, account) } : {})
  };
}
