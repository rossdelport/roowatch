import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groups, seenPosts, sources } from "../../../../db/schema";

/**
 * Every post we have read in the groups this member watches, newest first.
 *
 * seen_posts is shared across everyone watching the same public group, so
 * selecting straight from it would show one tradie another tradie's leads.
 * The member's own groups are looked up first, then only those sources are
 * read. It used to be one three way join, and D1 bills every row a query
 * touches: that join read the whole posts table for each poll and was the
 * single biggest reason the database hit its daily limit.
 *
 * A member's group points at a source by id, or by name on older rows. That
 * is the same rule processSource uses to find watchers, so the dashboard and
 * the alerts always agree about which groups are theirs.
 *
 * Only 14 days exist. See SEEN_TTL_DAYS in db/pipeline.ts.
 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The overview ticker polls this, so it asks for a short list. The Posts
  // tab still asks for the lot.
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get("limit") ?? 300);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 300, 1), 300);

  /**
   * The ticker asks for today only. Yesterday's posts are not proof that
   * anything is running now, and holding 14 days in memory to show five rows
   * is waste.
   *
   * "Today" has to mean the member's today, not the server's. This runs on
   * Cloudflare, which is UTC, and UTC midnight lands at 10am in Queensland.
   * So between midnight and 10am a Queensland tradie saw an almost empty
   * ticker, and at 10am their day silently reset and wiped the morning.
   *
   * The browser is the only thing that knows their real timezone, so it sends
   * its own midnight. The UTC fallback covers a caller that sends none.
   */
  const todayOnly = url.searchParams.get("today") === "1";
  const sent = Number(url.searchParams.get("since") ?? 0);
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);
  const since =
    Number.isFinite(sent) && sent > Date.now() - 15 * 864e5 && sent <= Date.now()
      ? sent
      : utcMidnight.getTime();

  const db = getDb();
  const mine = await db
    .select({ sourceId: groups.sourceId, name: groups.name })
    .from(groups)
    .where(and(eq(groups.userId, user.id), eq(groups.status, "watching")));

  const ids = mine.map((g) => g.sourceId).filter((id): id is number => id !== null);
  const names = mine.filter((g) => g.sourceId === null).map((g) => g.name.toLowerCase());
  const byId = ids.length ? inArray(sources.id, ids) : undefined;
  const byName = names.length ? inArray(sql`lower(${sources.groupName})`, names) : undefined;
  const watched =
    byId || byName
      ? await db
          .select({ id: sources.id, groupName: sources.groupName })
          .from(sources)
          .where(byId && byName ? or(byId, byName) : (byId ?? byName))
      : [];

  if (!watched.length) {
    return Response.json({ ok: true, posts: [], total: 0, today: 0, keptDays: 14 });
  }

  const nameOf = new Map(watched.map((s) => [s.id, s.groupName]));
  const sourceIds = [...nameOf.keys()];
  const theirs = inArray(seenPosts.sourceId, sourceIds);
  const fromToday = gte(seenPosts.seenAt, since);

  const rows = await db
    .select({
      id: seenPosts.id,
      seenAt: seenPosts.seenAt,
      text: seenPosts.text,
      url: seenPosts.url,
      author: seenPosts.author,
      sourceId: seenPosts.sourceId,
    })
    .from(seenPosts)
    .where(todayOnly ? and(theirs, fromToday) : theirs)
    .orderBy(desc(seenPosts.seenAt))
    .limit(limit);

  // Counted from the same boundary as the list above, or the headline would
  // disagree with the rows underneath it.
  const [todayRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(seenPosts)
    .where(and(theirs, fromToday));

  // The ticker never shows the 14 day total, so it does not pay for it.
  let total = Number(todayRow?.n ?? 0);
  if (!todayOnly) {
    const [counted] = await db.select({ n: sql<number>`count(*)` }).from(seenPosts).where(theirs);
    total = Number(counted?.n ?? 0);
  }

  return Response.json({
    ok: true,
    posts: rows.map(({ sourceId, ...post }) => ({
      ...post,
      groupName: nameOf.get(sourceId) ?? "",
    })),
    total,
    today: Number(todayRow?.n ?? 0),
    keptDays: 14,
  });
}
