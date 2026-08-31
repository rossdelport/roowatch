/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { POST as runScan } from "../app/api/cron/scan/route";
import { POST as runHealth } from "../app/api/cron/health/route";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CRON_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.CRON_SECRET) return;

    const request = () =>
      new Request("https://roowatch.com.au/api/cron/scan", {
        method: "POST",
        headers: { "x-cron-secret": env.CRON_SECRET! },
      });

    // Calling the route through Vinext made every tick initialise the full
    // app router before it reached the scanner. The cron has a much smaller
    // CPU budget than a normal request, so call the handlers directly.
    ctx.waitUntil(runScan(request()));

    // Both tasks share one scheduled invocation budget even when registered
    // with waitUntil. Keep the watchdog off the hot path while retaining a
    // fifteen-minute heartbeat for a stalled scanner.
    const scheduledTime =
      typeof event === "object" && event !== null && "scheduledTime" in event
        ? Number((event as { scheduledTime?: unknown }).scheduledTime)
        : 0;
    if (scheduledTime && new Date(scheduledTime).getUTCMinutes() % 15 === 0) {
      ctx.waitUntil(runHealth(request()));
    }
  },
};

export default worker;
