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
 * Only 14 days exist. See SEEN_TTL_DAYS in db/pipeline.ts.
 */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

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
    .innerJoin(
      groups,
      and(eq(groups.sourceId, seenPosts.sourceId), eq(groups.userId, user.id))
    )
    .innerJoin(sources, eq(sources.id, seenPosts.sourceId))
    .where(eq(groups.status, "watching"))
    .orderBy(desc(seenPosts.seenAt))
    .limit(300);

  const [counted] = (await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(seenPosts)
    .innerJoin(
      groups,
      and(eq(groups.sourceId, seenPosts.sourceId), eq(groups.userId, user.id))
    )
    .where(eq(groups.status, "watching"))) as { n: number }[];

  return Response.json({
    ok: true,
    posts: rows,
    total: Number(counted?.n ?? 0),
    keptDays: 14,
  });
}
