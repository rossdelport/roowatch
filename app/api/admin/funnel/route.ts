import { desc, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { events, waitlist } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    days?: number;
  };
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return Response.json({ error: "admin_not_configured" }, { status: 500 });
  }
  if (!body.password || body.password !== adminPassword) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
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
  const pay = step("click_pay");
  const done = step("view_onlist");

  const signups = await db
    .select({
      email: waitlist.email,
      name: waitlist.name,
      phone: waitlist.phone,
      createdAt: waitlist.createdAt,
    })
    .from(waitlist)
    .orderBy(desc(waitlist.createdAt))
    .limit(200);

  return Response.json({
    ok: true,
    days,
    signups,
    funnel: [
      { label: "Landed on site", count: landing, rate: 100 },
      { label: "Clicked a CTA", count: cta, rate: pct(cta, landing) },
      { label: "Saw reserve page", count: reserve, rate: pct(reserve, landing) },
      { label: "Joined waitlist", count: pay, rate: pct(pay, landing) },
      { label: "Saw confirmation", count: done, rate: pct(done, landing) },
    ],
    byDevice,
  });
}
