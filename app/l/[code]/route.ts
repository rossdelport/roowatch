import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { alerts } from "../../../db/schema";

/**
 * roowatch.com.au/l/xxxxxx sends the member straight to the Facebook post.
 *
 * This exists because of text messages. A Facebook permalink runs about 70
 * characters, which would push an alert past one billable segment and roughly
 * double the cost of every text. Six characters here instead.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const clean = String(code ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 24);

  if (clean) {
    const [row] = await getDb()
      .select({ postUrl: alerts.postUrl })
      .from(alerts)
      .where(eq(alerts.shortCode, clean))
      .limit(1);

    if (row?.postUrl) {
      return new Response(null, {
        status: 302,
        headers: { Location: row.postUrl, "Cache-Control": "no-store" },
      });
    }
  }

  // An expired or mistyped code should land somewhere useful, not on an error.
  return new Response(null, {
    status: 302,
    headers: { Location: "/dashboard", "Cache-Control": "no-store" },
  });
}
