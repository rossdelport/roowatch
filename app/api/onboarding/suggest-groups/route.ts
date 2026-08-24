import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groups, profiles, sources } from "../../../../db/schema";

/**
 * Public groups other tradies in the same state already watch.
 *
 * Setup now refuses to finish with no groups, which is right: a member
 * watching nothing gets nothing and cancels. But refusing on its own would
 * just move the problem, because somebody who cannot think of a group would
 * abandon setup and never reach the card. So the same screen offers a list to
 * tap instead of a blank box.
 *
 * Only groups we already scan, so a suggestion is always one we know is
 * public and working. Nobody is told who watches what.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    state?: string;
    suburbs?: string[];
  };
  const state = String(body.state ?? "").trim();
  const suburbs = (body.suburbs ?? []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);

  const db = getDb();
  const rows = await db
    .select({
      name: sources.groupName,
      url: sources.url,
      watchers: sql<number>`count(distinct ${groups.userId})`,
    })
    .from(sources)
    .innerJoin(groups, and(eq(groups.sourceId, sources.id), eq(groups.status, "watching")))
    .innerJoin(profiles, eq(profiles.userId, groups.userId))
    .where(
      and(
        eq(sources.active, 1),
        ne(groups.userId, user.id),
        // A private group is never worth suggesting: we cannot read it.
        sql`${sources.lastError} NOT LIKE '%rivate%'`,
        state ? eq(profiles.state, state) : sql`1 = 1`
      )
    )
    .groupBy(sources.id)
    .orderBy(sql`count(distinct ${groups.userId}) desc`)
    .limit(12);

  // A group with their own suburb in its name is worth far more than a busy
  // one on the other side of the state, so those float to the top.
  const ranked = rows
    .map((r) => {
      const name = (r.name ?? "").toLowerCase();
      const local = suburbs.some((sub) => sub && name.includes(sub));
      return { ...r, local };
    })
    .sort((a, b) => Number(b.local) - Number(a.local) || b.watchers - a.watchers);

  return Response.json({ ok: true, groups: ranked });
}
