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
    .orderBy(desc(seenPosts.seenAt))
    .limit(300);

  const [counted] = (await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(seenPosts)
    .innerJoin(sources, eq(sources.id, seenPosts.sourceId))
    .innerJoin(groups, and(eq(groups.userId, user.id), eq(groups.status, "watching"), MATCHES))) as {
    n: number;
  }[];

  return Response.json({
    ok: true,
    posts: rows,
    total: Number(counted?.n ?? 0),
    keptDays: 14,
  });
}
