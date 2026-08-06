import { getDb } from "../../../db";
import { events } from "../../../db/schema";

const ALLOWED = new Set([
  "view_landing",
  "click_cta",
  "view_reserve",
  "click_pay",
  "view_onlist",
]);

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      path?: string;
    };
    const name = String(body.name ?? "");
    if (!ALLOWED.has(name)) {
      return new Response(null, { status: 204 });
    }

    const ua = request.headers.get("user-agent") ?? "";
    const device = /Mobile|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop";
    const ref = (request.headers.get("referer") ?? "").slice(0, 200);

    const db = getDb();
    await db.insert(events).values({
      name,
      path: String(body.path ?? "").slice(0, 120),
      ref,
      device,
      ts: Math.floor(Date.now() / 1000),
    });
  } catch {
    // tracking must never break a page
  }
  return new Response(null, { status: 204 });
}
