import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { alerts } from "../../../db/schema";

/**
 * roowatch.com.au/l/xxxxxx sends the member straight to the Facebook post.
 *
 * This exists because of text messages. A Facebook permalink runs about 70
 * characters, which would push an alert past one billable segment and roughly
 * double the cost of every text. Six characters here instead.
 *
 * These links do not expire. They read from `alerts`, which is never cleaned
 * up, unlike `seen_posts` which is trimmed to 14 days. A tradie can be up a
 * roof all week and tap a Saturday text about a Monday lead.
 */

/** A link we cannot resolve. Never bounce them to a login screen for this. */
function gone() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found</title><style>body{align-items:center;background:#fff9f1;color:#172038;display:flex;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;justify-content:center;margin:0;min-height:100vh;padding:20px}.card{background:#fff;border:1px solid #ece5da;border-radius:18px;box-shadow:0 20px 50px rgba(23,32,56,.12);max-width:380px;padding:32px;text-align:center;width:100%}h1{font-size:22px;margin:0 0 10px}p{color:#6b7385;line-height:1.55;margin:0 0 22px}a{background:#ff6a4d;border-radius:99px;color:#fff;display:block;font-weight:700;padding:13px 24px;text-decoration:none}</style></head><body><main class="card"><h1>We cannot find that post</h1><p>This link is not one of ours, or the lead it pointed to has been removed from your account.</p><a href="/dashboard">Open my leads</a></main></body></html>`,
    {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const clean = String(code ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
  if (!clean) return gone();

  const [row] = await getDb()
    .select({ postUrl: alerts.postUrl })
    .from(alerts)
    .where(eq(alerts.shortCode, clean))
    .limit(1);

  if (!row?.postUrl) return gone();

  return new Response(null, {
    status: 302,
    headers: { Location: row.postUrl, "Cache-Control": "no-store" },
  });
}
