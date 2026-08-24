import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groups, profiles, sources } from "../../../../db/schema";
import { findGroups, searchConfigured } from "../../../../db/groupsearch";
import { groupSlug } from "../../../../db/fbgroups";

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

  // Everything a member already watches, so a search result we are already
  // reading can be marked as proven rather than guessed at.
  const known = new Set(rows.map((r) => groupSlug(r.url)));

  // Search the public index for groups near them. Nothing here touches
  // Facebook: it reads a search engine, the same as anyone with a browser.
  let searched: { name: string; url: string; watchers: number; proven: boolean }[] = [];
  if (searchConfigured()) {
    try {
      const found = await findGroups(body.suburbs ?? [], state);
      searched = found
        .filter((g) => !known.has(g.slug))
        .map((g) => ({ name: g.name, url: g.url, watchers: 0, proven: false }));
    } catch {
      // A search outage must never stop somebody finishing setup.
    }
  }

  const all = [
    ...rows.map((r) => ({ ...r, proven: true })),
    ...searched,
  ];

  // Their own suburb in the name beats everything. After that, a group we
  // already read beats one we have only found.
  const ranked = all
    .map((r) => {
      const name = (r.name ?? "").toLowerCase();
      const local = suburbs.some((sub) => sub && name.includes(sub));
      return { ...r, local };
    })
    .sort(
      (a, b) =>
        Number(b.local) - Number(a.local) ||
        Number(b.proven) - Number(a.proven) ||
        b.watchers - a.watchers
    )
    .slice(0, 12);

  return Response.json({ ok: true, groups: ranked, searched: searchConfigured() });
}
