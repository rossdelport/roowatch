import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { events, users, waitlist } from "../../../../db/schema";
import { isLeadStatus } from "../../../../db/leadstatus";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    days?: number;
    action?: "status";
    email?: string;
    status?: string;
  };
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const db0 = getDb();
  // Ross marking where he got to with a lead. Same endpoint, since the table
  // it changes is rendered right here.
  if (body.action === "status" && body.email && body.status) {
    if (!isLeadStatus(body.status)) {
      return Response.json({ error: "bad_status" }, { status: 400 });
    }
    await db0
      .update(waitlist)
      .set({ status: body.status })
      .where(eq(waitlist.email, body.email.trim().toLowerCase()));
  }

  const days = Math.min(Math.max(Number(body.days ?? 7), 1), 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const db = getDb();
  const rows = (await db
    .select({
      name: events.name,
      device: events.device,
      n: sql<number>`count(*)`,
    })
    .from(events)
    .where(sql`${events.ts} >= ${since}`)
    .groupBy(events.name, events.device)) as {
    name: string;
    device: string;
    n: number;
  }[];

  const totals: Record<string, number> = {};
  const byDevice: Record<string, { mobile: number; desktop: number }> = {};
  for (const r of rows) {
    totals[r.name] = (totals[r.name] ?? 0) + Number(r.n);
    byDevice[r.name] ??= { mobile: 0, desktop: 0 };
    if (r.device === "mobile") byDevice[r.name].mobile += Number(r.n);
    else byDevice[r.name].desktop += Number(r.n);
  }

  const step = (n: string) => totals[n] ?? 0;
  const pct = (a: number, b: number) =>
    b > 0 ? Math.round((a / b) * 1000) / 10 : 0;

  const landing = step("view_landing");
  const cta = step("click_cta");
  const reserve = step("view_reserve");
  const done = step("view_onlist");

  const signups = await db
    .select({
      email: waitlist.email,
      name: waitlist.name,
      phone: waitlist.phone,
      trade: waitlist.trade,
      status: waitlist.status,
      createdAt: waitlist.createdAt,
    })
    .from(waitlist)
    .where(sql`${waitlist.createdAt} >= datetime(${since}, 'unixepoch')`)
    .orderBy(desc(waitlist.createdAt))
    .limit(200);

  const [completedSignupRow] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(waitlist)
    .where(
      sql`${waitlist.createdAt} >= datetime(${since}, 'unixepoch') AND ${waitlist.phone} <> ''`
    )) as { n: number }[];
  const completedSignups = Number(completedSignupRow?.n ?? 0);

  const TRADE_BY_PATH: Record<string, string> = {
    plumbers: "plumber", electricians: "electrician", handymen: "handyman",
    painters: "painter", "air-con": "air con installer",
    "gutter-cleaning": "gutter cleaner", cleaners: "cleaner",
    "pest-control": "pest controller", removalists: "removalist",
    landscapers: "landscaper",
  };

  const viewRows = (await db
    .select({ path: events.path, n: sql<number>`count(*)` })
    .from(events)
    .where(sql`${events.name} = 'view_reserve' AND ${events.ts} >= ${since}`)
    .groupBy(events.path)) as { path: string; n: number }[];

  const signupRows = (await db
    .select({ trade: waitlist.trade, n: sql<number>`count(*)` })
    .from(waitlist)
    .where(
      sql`${waitlist.createdAt} >= datetime(${since}, 'unixepoch') AND ${waitlist.phone} <> ''`
    )
    .groupBy(waitlist.trade)) as { trade: string; n: number }[];

  const signupByTrade: Record<string, number> = {};
  for (const r of signupRows) signupByTrade[r.trade] = Number(r.n);

  const trades = Object.entries(TRADE_BY_PATH).map(([slug, noun]) => {
    const views = viewRows
      .filter((v) => v.path === `/reserve/${slug}`)
      .reduce((a, v) => a + Number(v.n), 0);
    const joined = signupByTrade[noun] ?? 0;
    return {
      slug,
      views,
      signups: joined,
      rate: views > 0 ? Math.round((joined / views) * 1000) / 10 : 0,
    };
  });
  const genericViews = viewRows
    .filter((v) => v.path === "/reserve" || v.path === "/reserve/")
    .reduce((a, v) => a + Number(v.n), 0);
  trades.push({
    slug: "generic",
    views: genericViews,
    signups: signupByTrade[""] ?? 0,
    rate: genericViews > 0 ? Math.round(((signupByTrade[""] ?? 0) / genericViews) * 1000) / 10 : 0,
  });
  trades.sort((a, b) => b.signups - a.signups || b.views - a.views);

  // The home page now sends people to /signup, while the ads still land on the
  // trade reserve pages. Two journeys, so two charts. Accounts are counted from
  // the users table rather than a browser event, which cannot be lost.
  const signupViews = step("view_signup");
  const [accountRow] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(sql`${users.createdAt} >= datetime(${since}, 'unixepoch')`)) as { n: number }[];
  const accounts = Number(accountRow?.n ?? 0);

  return Response.json({
    ok: true,
    days,
    signups,
    trades,
    funnel: [
      { label: "Landed on site", count: landing, rate: 100 },
      { label: "Clicked a CTA", count: cta, rate: pct(cta, landing) },
      { label: "Saw reserve page", count: reserve, rate: pct(reserve, landing) },
      { label: "Joined waitlist", count: completedSignups, rate: pct(completedSignups, landing) },
      { label: "Saw confirmation", count: done, rate: pct(done, landing) },
    ],
    signupFunnel: [
      { label: "Saw signup page", count: signupViews, rate: 100 },
      { label: "Created an account", count: accounts, rate: pct(accounts, signupViews) },
    ],
    byDevice,
  });
}
