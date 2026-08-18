import { chromium } from "playwright";
import { ERROR_CODES, ScraperError } from "./errors.js";
import { proxyForAccount } from "./config.js";
import { installResourceBlocking, NetworkByteTracker, classifyProxyError, proxyFingerprint } from "./network.js";

export function validateStorageState(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new ScraperError(ERROR_CODES.SESSION_MISSING, "The Playwright storage state file is invalid");
  }
  const nowSeconds = Date.now() / 1000;
  const userCookie = state.cookies.find((cookie) =>
    cookie?.name === "c_user"
    && typeof cookie.value === "string"
    && cookie.value.length > 0
    && /(^|\.)facebook\.com$/i.test(cookie.domain || "")
    && (!cookie.expires || cookie.expires === -1 || cookie.expires > nowSeconds)
  );
  if (!userCookie) throw new ScraperError(ERROR_CODES.LOGIN_REQUIRED, "The storage state has no active Facebook account cookie");
  return state;
}

export function sessionExpiryMs(state) {
  const expiries = state.cookies
    .filter((cookie) => cookie.name === "c_user" && Number(cookie.expires) > 0)
    .map((cookie) => Math.floor(Number(cookie.expires) * 1000));
  return expiries.length ? Math.min(...expiries) : undefined;
}

export class BrowserManager {
  constructor(config, sessionStore, logger, accountStates) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.logger = logger;
    this.accountStates = accountStates;
    this.entries = new Map();
  }

  async start() {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      ...(this.config.chromiumExecutablePath ? { executablePath: this.config.chromiumExecutablePath } : {}),
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--no-first-run"
      ]
    });
    return this;
  }

  async createContext(account, storageState) {
    const proxy = proxyForAccount(this.config, account);
    return this.browser.newContext({
      storageState,
      proxy,
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: this.config.facebookLocale,
      timezoneId: this.config.facebookTimezone,
      viewport: { width: 1280, height: 900 }
    });
  }

  async checkProxy(context) {
    const page = await context.newPage();
    let tracker;
    try {
      await installResourceBlocking(page);
      tracker = await new NetworkByteTracker(page, this.config.maxTransferBytes, () => page.close()).start();
      const response = await page.goto(this.config.proxyHealthcheckUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs
      });
      tracker.assertWithinLimit();
      if (!response?.ok()) throw new Error(`Proxy health endpoint returned ${response?.status() || "no response"}`);
      const body = (await page.locator("body").innerText()).trim();
      if (!body || body.length > 2_000) throw new Error("Proxy health endpoint returned invalid data");
      return { bytes: tracker.bytes, fingerprint: proxyFingerprint(body) };
    } catch (error) {
      let failure;
      try {
        tracker?.assertWithinLimit();
        failure = error instanceof ScraperError ? error : classifyProxyError(error);
      } catch (limitError) {
        failure = limitError;
      }
      failure.details = {
        ...failure.details,
        networkStarted: true,
        bytesTransferred: tracker?.bytes || 0,
        proxyStatus: "failed"
      };
      throw failure;
    } finally {
      await tracker?.stop();
      await page.close().catch(() => {});
    }
  }

  async acceptProxyFingerprint(account, proxy, activeFingerprint) {
    const saved = this.accountStates?.get?.(account.id);
    const expected = activeFingerprint || saved?.proxyFingerprint;
    if (expected && proxy.fingerprint !== expected) {
      throw new ScraperError(
        ERROR_CODES.PROXY_ROTATED,
        "The residential proxy exit changed for an active Facebook session",
        {
          networkStarted: true,
          bytesTransferred: proxy.bytes,
          accountStatus: saved?.status || "healthy",
          sessionStatus: saved?.sessionStatus || "healthy",
          proxyStatus: "failed"
        }
      );
    }
    if (!saved?.proxyFingerprint && this.accountStates?.update) {
      try {
        await this.accountStates.update(account.id, { proxyFingerprint: proxy.fingerprint });
      } catch {
        throw new ScraperError(ERROR_CODES.PROXY_IDENTITY_SAVE_FAILED, "Could not persist the verified proxy identity", {
          networkStarted: true,
          bytesTransferred: proxy.bytes,
          accountStatus: saved?.status || "healthy",
          sessionStatus: saved?.sessionStatus || "healthy",
          proxyStatus: "failed"
        });
      }
    }
  }

  async get(account) {
    const existing = this.entries.get(account.id);
    if (existing) return existing;
    if (!await this.sessionStore.has(account.storageKey)) {
      throw new ScraperError(ERROR_CODES.SESSION_MISSING, `No encrypted session is installed for account ${account.id}`);
    }
    const storageState = validateStorageState(await this.sessionStore.read(account.storageKey));
    const context = await this.createContext(account, storageState);
    try {
      const proxy = await this.checkProxy(context);
      await this.acceptProxyFingerprint(account, proxy);
      const entry = { account, context, bootstrapBytes: proxy.bytes, proxyFingerprint: proxy.fingerprint };
      this.entries.set(account.id, entry);
      return entry;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  takeBootstrapBytes(entry) {
    const bytes = entry.bootstrapBytes || 0;
    entry.bootstrapBytes = 0;
    return bytes;
  }

  async recheckProxy(entry) {
    const proxy = await this.checkProxy(entry.context);
    await this.acceptProxyFingerprint(entry.account, proxy, entry.proxyFingerprint);
    entry.proxyFingerprint = proxy.fingerprint;
    return proxy;
  }

  async save(entry) {
    const storageState = validateStorageState(await entry.context.storageState({ indexedDB: true }));
    const savedAtMs = await this.sessionStore.write(entry.account.storageKey, storageState);
    return { savedAtMs, expiresAtMs: sessionExpiryMs(storageState) };
  }

  async createTemporary(account, storageState) {
    validateStorageState(storageState);
    const context = await this.createContext(account, storageState);
    try {
      const proxy = await this.checkProxy(context);
      await this.acceptProxyFingerprint(account, proxy);
      return { account, context, bootstrapBytes: proxy.bytes, proxyFingerprint: proxy.fingerprint, temporary: true };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  async closeAccount(accountId) {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    this.entries.delete(accountId);
    await entry.context.close();
  }

  async close() {
    for (const entry of this.entries.values()) await entry.context.close().catch(() => {});
    this.entries.clear();
    await this.browser?.close();
  }
}
