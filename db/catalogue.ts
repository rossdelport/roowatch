import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { catalogueJobs, foundGroups, groups, profiles, sources } from "./schema";
import { findGroups, looksAustralian } from "./groupsearch";
import { bdCollect, bdProgress, bdTrigger } from "./pipeline";
import { groupSlug } from "./fbgroups";

/**
 * RooWatch's own catalogue of Australian Facebook groups.
 *
 * The point is that a tradie should never hunt around Facebook copying URLs.
 * They tell us their suburbs, we hand them a list.
 *
 * The catalogue fills itself. The first plumber in Joondalup costs a few
 * searches; the electrician who signs up next week gets the same list back
 * instantly and for nothing. Sizes arrive the same way: a group is scanned
 * once to learn how big it is, and every member after that reads the answer.
 *
 * Nothing here writes to `sources`. A row in sources is scanned every minute
 * and costs money, so discovery must never create one. A group becomes a
 * source only when a member actually picks it.
 */

export type Candidate = {
  slug: string;
  url: string;
  name: string;
  members: number;
  /** True when we already read this group for somebody, so we know it works. */
  proven: boolean;
};

/** Enough to fill a plan without asking the member to think. */
export const FILL_TARGET = 20;

/** What we already hold for these suburbs, no searching, no cost. */
async function fromCatalogue(suburbs: string[], state: string): Promise<Candidate[]> {
  const db = getDb();
  const places = suburbs.map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Groups already being watched are the best answer we have: we know they
  // are public, we know they work, and we know their size.
  //
  // Restricted to groups watched by somebody in the same state. Without that,
  // a tradie in Perth was handed thirty Cairns groups, and because thirty
  // looks like plenty we never bothered searching for anything near them.
  const watched = state
    ? await db
        .selectDistinct({ url: sources.url, name: sources.groupName, members: sources.members })
        .from(sources)
        .innerJoin(groups, and(eq(groups.sourceId, sources.id), eq(groups.status, "watching")))
        .innerJoin(profiles, and(eq(profiles.userId, groups.userId), eq(profiles.state, state)))
        .where(sql`${sources.active} = 1 AND ${sources.lastError} NOT LIKE '%rivate%'`)
    : [];

  const known = await db
    .select()
    .from(foundGroups)
    .orderBy(desc(foundGroups.members))
    .limit(200);

  const out = new Map<string, Candidate>();
  for (const w of watched) {
    const slug = groupSlug(w.url);
    if (!slug) continue;
    out.set(slug, { slug, url: w.url, name: w.name, members: w.members, proven: true });
  }
  for (const g of known) {
    if (out.has(g.slug)) continue;
    // Only offer a catalogued group when it belongs to their patch.
    const hay = `${g.suburb} ${g.state} ${g.name}`.toLowerCase();
    const near = places.some((p) => hay.includes(p)) || (state && g.state === state);
    if (!near) continue;
    // The same test the search applies. Rows filed before these rules existed
    // are still in here, and a Richmond Hill in Ontario would be scanned every
    // minute at our expense if it slipped back out.
    if (!looksAustralian(g.name)) continue;
    out.set(g.slug, { slug: g.slug, url: g.url, name: g.name, members: g.members, proven: false });
  }
  return [...out.values()];
}

/** Rank the way a member would: local and proven first, then by size. */
function rank(list: Candidate[], suburbs: string[]): Candidate[] {
  const places = suburbs.map((s) => s.toLowerCase()).filter(Boolean);
  return list
    .map((c) => ({ c, local: places.some((p) => c.name.toLowerCase().includes(p)) }))
    .sort(
      (a, b) =>
        Number(b.local) - Number(a.local) ||
        Number(b.c.proven) - Number(a.c.proven) ||
        b.c.members - a.c.members
    )
    .map((x) => x.c);
}

/**
 * The list a member sees. Catalogue first, search only to top up.
 */
export async function candidatesFor(
  suburbs: string[],
  state: string
): Promise<{ groups: Candidate[]; searched: boolean }> {
  const held = await fromCatalogue(suburbs, state);
  if (held.length >= FILL_TARGET) {
    return { groups: rank(held, suburbs).slice(0, FILL_TARGET), searched: false };
  }

  let found: Awaited<ReturnType<typeof findGroups>> = [];
  try {
    found = await findGroups(suburbs, state, 30);
  } catch {
    // A search outage must never stop somebody finishing setup.
  }

  if (found.length) {
    const db = getDb();
    const now = Date.now();
    const suburb = (suburbs[0] ?? "").trim();
    for (const g of found) {
      // onConflictDoNothing: whoever found it first keeps the row, and its
      // member count with it.
      await db
        .insert(foundGroups)
        .values({
          slug: g.slug,
          url: g.url,
          name: g.name,
          state,
          suburb,
          score: g.score,
          foundAt: now,
        })
        .onConflictDoNothing();
    }
  }

  const seen = new Set(held.map((h) => h.slug));
  const merged = [
    ...held,
    ...found
      .filter((g) => !seen.has(g.slug))
      .map((g) => ({ slug: g.slug, url: g.url, name: g.name, members: 0, proven: false })),
  ];
  return { groups: rank(merged, suburbs).slice(0, FILL_TARGET), searched: true };
}

/**
 * Open one Bright Data snapshot to size up groups we have never read.
 *
 * A two hour window, because a group has to produce at least one post for
 * Facebook to tell us how many members it has. Empty answers cost nothing, so
 * the quiet ones are free and the busy ones cost a fraction of a cent each.
 */
export async function sizeUnknown(slugs: string[]): Promise<void> {
  if (!slugs.length) return;
  const db = getDb();

  const rows = await db
    .select({ slug: foundGroups.slug, url: foundGroups.url, members: foundGroups.members })
    .from(foundGroups)
    .where(inArray(foundGroups.slug, slugs.slice(0, 20)));

  const need = rows.filter((r) => !r.members);
  if (!need.length) return;

  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const snapshotId = await bdTrigger(need.map((r) => r.url), since);
    await db.insert(catalogueJobs).values({
      snapshotId,
      slugs: JSON.stringify(need.map((r) => r.slug)),
      startedAt: Date.now(),
    });
  } catch {
    // Sizing is a nicety. Setup carries on without it.
  }
}

/**
 * Read any finished sizing snapshots and write the numbers down.
 *
 * Called from the cron beside the real scanner. Deliberately writes only to
 * the catalogue: no alerts, no seen posts, no member ever hears about it.
 */
export async function collectCatalogue(): Promise<number> {
  const db = getDb();
  const jobs = await db.select().from(catalogueJobs);
  if (!jobs.length) return 0;

  let done = 0;
  for (const job of jobs) {
    let status = "unknown";
    try {
      status = (await bdProgress(job.snapshotId)).status;
    } catch {
      status = "unknown";
    }

    const tooOld = Date.now() - job.startedAt > 20 * 60 * 1000;
    if (status !== "ready") {
      if (status === "failed" || tooOld) {
        await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
      }
      continue;
    }

    const slugs = JSON.parse(job.slugs) as string[];
    const rows = await db
      .select({ slug: foundGroups.slug, url: foundGroups.url })
      .from(foundGroups)
      .where(inArray(foundGroups.slug, slugs));

    try {
      const { facts } = await bdCollect(job.snapshotId, rows.map((r) => r.url));
      for (const row of rows) {
        const fact = facts.get(row.slug);
        if (!fact) continue;
        const patch: Record<string, unknown> = {};
        if (fact.members) patch.members = fact.members;
        if (fact.name) patch.name = fact.name;
        // A private group can never be watched, so drop it from the catalogue
        // rather than keep offering it to people.
        if (fact.private) {
          await db.delete(foundGroups).where(eq(foundGroups.slug, row.slug));
          continue;
        }
        if (Object.keys(patch).length) {
          await db.update(foundGroups).set(patch).where(eq(foundGroups.slug, row.slug));
        }
      }
      done += rows.length;
    } catch {
      // Leave the job for the next tick; the stale check drops it eventually.
      continue;
    }

    await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
  }
  return done;
}
