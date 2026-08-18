import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groups, seenPosts, sources } from "../../../../db/schema";

/**
 * Every post we have read in the groups this member watches, newest first.
 *
 * The join through `groups` is what keeps a member inside their own account.
 * seen_posts is shared across everyone watching the same public group, so
 * selecting straight from it would show one tradie another tradie's leads.
 *
 * The match condition is deliberately the same one processSource uses to find
 * watchers: source id when it is set, group name when it is not. Older rows
 * have a null source id, and matching on the id alone returned nothing at all
 * while still looking like a healthy empty list.
 *
 * Only 14 days exist. See SEEN_TTL_DAYS in db/pipeline.ts.
 */
/** A member's group points at a source by id, or by name on older rows. */
const MATCHES = sql`(${groups.sourceId} = ${sources.id} OR (${groups.sourceId} IS NULL AND lower(${groups.name}) = lower(${sources.groupName})))`;

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The overview ticker polls this every few seconds, so it asks for a short
  // list. The Posts tab still asks for the lot.
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

  const rows = await getDb()
    .select({
      id: seenPosts.id,
      seenAt: seenPosts.seenAt,
      text: seenPosts.text,
      url: seenPosts.url,
      author: seenPosts.author,
      groupName: sources.groupName,
    })
    .from(seenPosts)
    .innerJoin(sources, eq(sources.id, seenPosts.sourceId))
    .innerJoin(groups, and(eq(groups.userId, user.id), eq(groups.status, "watching"), MATCHES))
    .where(todayOnly ? sql`${seenPosts.seenAt} >= ${since}` : sql`1 = 1`)
    .orderBy(desc(seenPosts.seenAt))
    .limit(limit);

  const [counted] = (await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(seenPosts)
    .innerJoin(sources, eq(sources.id, seenPosts.sourceId))
    .innerJoin(groups, and(eq(groups.userId, user.id), eq(groups.status, "watching"), MATCHES))) as {
    n: number;
  }[];

  // Counted from the same boundary as the list above, or the headline would
  // disagree with the rows underneath it.
  const [todayRow] = (await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(seenPosts)
    .innerJoin(sources, eq(sources.id, seenPosts.sourceId))
    .innerJoin(groups, and(eq(groups.userId, user.id), eq(groups.status, "watching"), MATCHES))
    .where(sql`${seenPosts.seenAt} >= ${since}`)) as { n: number }[];

  return Response.json({
    ok: true,
    posts: rows,
    total: Number(counted?.n ?? 0),
    today: Number(todayRow?.n ?? 0),
    keptDays: 14,
  });
}
