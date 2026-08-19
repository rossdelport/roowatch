import { sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import {
  BRIGHT_DATA_PER_RECORD_USD,
  CLAUDE_PER_POST_USD,
  PLATFORM_PER_MONTH_USD,
  aud,
} from "../../../../db/costs";
import { profiles, seenPosts } from "../../../../db/schema";

/**
 * Every expense, by day, in AUD.
 *
 * Bright Data and ClickSend are read from their own APIs, so those are real
 * numbers. Claude is estimated from how many posts we read, because Anthropic
 * does not expose per key usage. The response marks which is which and the tab
 * shows it, so a guess is never mistaken for a bill.
 *
 * A supplier being unreachable returns zeroes for that supplier rather than
 * failing the whole page. Half a cost picture beats none.
 */

const DAY = 86400000;

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Records delivered per day, straight from Bright Data. */
async function brightDataByDay(since: number): Promise<Record<string, number>> {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) return {};
  try {
    const res = await fetch(
      "https://api.brightdata.com/datasets/v3/snapshots?dataset_id=gd_lz11l67o2cb3r0lkj3&limit=500",
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(9000) }
    );
    if (!res.ok) return {};
    const rows = (await res.json()) as { created?: string; dataset_size?: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (!r.created) continue;
      const ms = Date.parse(r.created);
      if (!Number.isFinite(ms) || ms < since) continue;
      const k = dayKey(ms);
      out[k] = (out[k] ?? 0) + (r.dataset_size ?? 0);
    }
    return out;
  } catch {
    return {};
  }
}

/** Message prices per day, straight from ClickSend. Already AUD. */
async function smsByDay(since: number) {
  const user = process.env.CLICKSEND_USERNAME;
  const key = process.env.CLICKSEND_API_KEY;
  const empty = {
    spend: {} as Record<string, number>,
    count: {} as Record<string, number>,
    balance: null as number | null,
  };
  if (!user || !key) return empty;

  const auth = `Basic ${btoa(`${user}:${key}`)}`;
  const spend: Record<string, number> = {};
  const count: Record<string, number> = {};
  let balance: number | null = null;

  try {
    const from = Math.floor(since / 1000);
    const to = Math.floor(Date.now() / 1000);
    const res = await fetch(
      `https://rest.clicksend.com/v3/sms/history?date_from=${from}&date_to=${to}&limit=1000`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(9000) }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        data?: { data?: { date?: number; message_price?: string }[] };
      };
      for (const m of data.data?.data ?? []) {
        if (!m.date) continue;
        const k = dayKey(m.date * 1000);
        spend[k] = (spend[k] ?? 0) + Number(m.message_price ?? 0);
        count[k] = (count[k] ?? 0) + 1;
      }
    }
  } catch {
    // leave it empty rather than fail the page
  }

  try {
    const res = await fetch("https://rest.clicksend.com/v3/account", {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { balance?: string } };
      balance = Number(data.data?.balance ?? 0);
    }
  } catch {
    // balance is a nice to have
  }

  return { spend, count, balance };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { days?: number };
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const days = Math.min(Math.max(Number(body.days ?? 14), 1), 60);
  const since = Date.now() - days * DAY;

  // Posts we read, which is what we paid Claude to classify.
  const db = getDb();
  const postRows = (await db
    .select({
      day: sql<string>`date(${seenPosts.seenAt} / 1000, 'unixepoch')`,
      n: sql<number>`count(*)`,
    })
    .from(seenPosts)
    .where(sql`${seenPosts.seenAt} >= ${since}`)
    .groupBy(sql`date(${seenPosts.seenAt} / 1000, 'unixepoch')`)) as { day: string; n: number }[];

  const posts: Record<string, number> = {};
  for (const r of postRows) posts[r.day] = Number(r.n);

  const [bright, sms] = await Promise.all([brightDataByDay(since), smsByDay(since)]);

  const rows = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayKey(Date.now() - i * DAY);
    const records = bright[day] ?? 0;
    const read = posts[day] ?? 0;
    const scraping = aud(records * BRIGHT_DATA_PER_RECORD_USD);
    const reading = aud(read * CLAUDE_PER_POST_USD);
    const texting = sms.spend[day] ?? 0;
    const round = (n: number) => Math.round(n * 10000) / 10000;
    rows.push({
      day,
      records,
      posts: read,
      texts: sms.count[day] ?? 0,
      scraping: round(scraping),
      reading: round(reading),
      texting: round(texting),
      total: round(scraping + reading + texting),
    });
  }

  // The exact number of classifications this month, from the same counter the
  // fair use cap uses. More reliable than summing the daily estimate.
  const month = new Date().toISOString().slice(0, 7);
  const [used] = (await db
    .select({ n: sql<number>`coalesce(sum(${profiles.postsUsed}), 0)` })
    .from(profiles)
    .where(sql`${profiles.usageMonth} = ${month}`)) as { n: number }[];

  const sum = (k: "scraping" | "reading" | "texting" | "total") =>
    Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;

  return Response.json({
    ok: true,
    days,
    rows,
    totals: {
      scraping: sum("scraping"),
      reading: sum("reading"),
      texting: sum("texting"),
      spend: sum("total"),
      platform: Math.round(aud(PLATFORM_PER_MONTH_USD) * 100) / 100,
      records: rows.reduce((a, r) => a + r.records, 0),
      posts: rows.reduce((a, r) => a + r.posts, 0),
      texts: rows.reduce((a, r) => a + r.texts, 0),
      postsThisMonth: Number(used?.n ?? 0),
    },
    smsBalance: sms.balance,
    measured: { scraping: true, texting: true, reading: false },
  });
}
