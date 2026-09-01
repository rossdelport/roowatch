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

interface ScheduledController {
  cron: string;
}

const SCAN_CRON = "* * * * *";
const HEALTH_CRON = "0 * * * *";

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

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.CRON_SECRET) return;

    const request = (path: string) =>
      new Request(`https://roowatch.com.au${path}`, {
        method: "POST",
        headers: { "x-cron-secret": env.CRON_SECRET! },
      });

    // Separate cron expressions create separate Worker invocations. The
    // watchdog must keep its CPU budget when a heavy scan invocation is killed.
    if (event.cron === HEALTH_CRON) {
      ctx.waitUntil(runHealth(request("/api/cron/health")));
      return;
    }

    // Calling the route through Vinext made every tick initialise the full app
    // router before it reached the scanner, so cron calls the handler directly.
    if (event.cron === SCAN_CRON) {
      ctx.waitUntil(runScan(request("/api/cron/scan")));
      return;
    }

    console.error("unknown_cron_ignored", { cron: event.cron });
  },
};

export default worker;
