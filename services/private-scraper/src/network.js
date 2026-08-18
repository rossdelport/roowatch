import { createHash } from "node:crypto";
import { ERROR_CODES, ScraperError } from "./errors.js";

const BLOCKED_RESOURCE_TYPES = new Set(["eventsource", "image", "media", "font", "stylesheet"]);
const BLOCKED_HOST_PARTS = [
  "doubleclick.net",
  "googletagmanager.com",
  "google-analytics.com"
];
const BLOCKED_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jpe?g|m4a|m4v|mov|mp3|mp4|mpeg|ogg|png|svg|webm|webp|woff2?)(?:\?|$)/i;

export async function installResourceBlocking(page) {
  await page.routeWebSocket?.("**/*", (socket) => socket.close({ code: 1000, reason: "blocked" }));
  await page.route("**/*", async (route) => {
    const request = route.request();
    let hostname = "";
    try {
      hostname = new URL(request.url()).hostname.toLowerCase();
    } catch {
      return route.abort("blockedbyclient");
    }
    const blocked = BLOCKED_RESOURCE_TYPES.has(request.resourceType())
      || BLOCKED_EXTENSIONS.test(request.url())
      || BLOCKED_HOST_PARTS.some((part) => hostname === part || hostname.endsWith(`.${part}`));
    return blocked ? route.abort("blockedbyclient") : route.continue();
  });
}

export class NetworkByteTracker {
  constructor(page, maxBytes, onLimit) {
    this.page = page;
    this.maxBytes = maxBytes;
    this.onLimit = onLimit;
    this.bytes = 0;
    this.exceeded = false;
    this.limitHandled = false;
    this.requestBytes = new Map();
  }

  async start() {
    this.session = await this.page.context().newCDPSession(this.page);
    await this.session.send("Network.enable");
    const addBytes = (amount) => {
      this.bytes += Math.max(0, Math.ceil(Number(amount) || 0));
      if (this.bytes > this.maxBytes && !this.limitHandled) {
        this.exceeded = true;
        this.limitHandled = true;
        Promise.resolve(this.onLimit?.()).catch(() => {});
      }
    };
    this.session.on("Network.dataReceived", (event) => {
      const amount = Math.max(0, Math.ceil(Number(event.encodedDataLength) || 0));
      this.requestBytes.set(event.requestId, (this.requestBytes.get(event.requestId) || 0) + amount);
      addBytes(amount);
    });
    this.session.on("Network.loadingFinished", (event) => {
      const alreadyCounted = this.requestBytes.get(event.requestId) || 0;
      const total = Math.max(0, Math.ceil(Number(event.encodedDataLength) || 0));
      addBytes(Math.max(0, total - alreadyCounted));
      this.requestBytes.delete(event.requestId);
    });
    this.session.on("Network.loadingFailed", (event) => {
      this.requestBytes.delete(event.requestId);
    });
    return this;
  }

  assertWithinLimit() {
    if (this.exceeded || this.bytes > this.maxBytes) {
      throw new ScraperError(ERROR_CODES.TRANSFER_LIMIT_EXCEEDED, "The check exceeded its transfer limit", {
        bytesTransferred: this.bytes,
        maxBytes: this.maxBytes
      });
    }
  }

  async stop() {
    if (!this.session) return;
    try {
      await this.session.detach();
    } catch {
      // The page may already be closed to stop transfer at the boundary.
    }
  }
}

export function proxyFingerprint(body) {
  return createHash("sha256").update(String(body)).digest("hex").slice(0, 12);
}

export function classifyProxyError(error) {
  if (error instanceof ScraperError) return error;
  const message = String(error?.message || error);
  if (/ERR_PROXY_AUTH_REQUESTED|407|proxy authentication/i.test(message)) {
    return new ScraperError(ERROR_CODES.PROXY_AUTH_FAILED, "The residential proxy rejected its credentials");
  }
  return new ScraperError(ERROR_CODES.PROXY_FAILED, "The residential proxy connection failed");
}
