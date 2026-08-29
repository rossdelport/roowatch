import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { catalogueJobs, droppedGroups, foundGroups, groups, profiles, sources } from "./schema";
import { findGroups, looksAustralian } from "./groupsearch";
import { postcodesFor, postcodesInState } from "./gazetteer";
import { bdCollect, bdProgress, bdTrigger } from "./pipeline";
import { groupSlug } from "./fbgroups";
import { groupLimit } from "./plans";

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
        // GLOB, not LIKE: a real group called "Group Buy Perth" must survive.
        // Only "Group " followed by digits is our own placeholder, made by
        // labelFromSlug when Facebook put nothing but a number in the address
        // bar. Facebook hands us the real name with the group's first post, so
        // a group still wearing a number is one we have never read. Nobody
        // should be offered a watchlist row that says Group 589657251411693.
        .where(
          sql`${sources.active} = 1
            AND ${sources.lastError} NOT LIKE '%rivate%'
            AND ${sources.groupName} NOT GLOB 'Group [0-9]*'`
        )
    : [];

  // checked = 1 only. A search result proves nothing about whether a group is
  // public: a private group's listing looks identical. Bright Data is the only
  // thing that knows, and this flag is where it writes the answer down.
  const known = await db
    .select()
    .from(foundGroups)
    .where(eq(foundGroups.checked, 1))
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
    // Same rule for catalogued rows: a number is not a name.
    if (/^Group \d+$/.test(g.name)) continue;
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
): Promise<{ groups: Candidate[]; searched: boolean; pending: string[] }> {
  const held = await fromCatalogue(suburbs, state);
  if (held.length >= FILL_TARGET) {
    return { groups: rank(held, suburbs).slice(0, FILL_TARGET), searched: false, pending: [] };
  }

  let found: Awaited<ReturnType<typeof findGroups>> = [];
  try {
    const [postcodeOf, statePostcodes] = await Promise.all([
      postcodesFor(suburbs, state),
      postcodesInState(state),
    ]);
    found = await findGroups(suburbs, state, 30, postcodeOf, statePostcodes);
  } catch (err) {
    // A search outage must never stop somebody finishing setup, but silence
    // here once cost hours of guessing at an empty result.
    console.error("group search failed", state, err);
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

  // Deliberately not merged into the answer. Whatever the search just turned
  // up is unverified, and a member who sees a private group in setup has been
  // sold something we cannot deliver. It is filed above, checked by
  // sizeUnknown below, and offered to the next person who asks.
  const seen = new Set(held.map((c) => c.slug));
  const fresh = found.filter((g) => !seen.has(g.slug)).map((g) => g.slug);
  return {
    groups: rank(held, suburbs).slice(0, FILL_TARGET),
    searched: true,
    pending: fresh,
  };
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
    .select({ slug: foundGroups.slug, url: foundGroups.url, checked: foundGroups.checked })
    .from(foundGroups)
    .where(inArray(foundGroups.slug, slugs.slice(0, 20)));

  // Unchecked, not unsized. A quiet public group is verified but will never
  // report members, and filtering on members alone would re-snapshot it on
  // every single setup, forever.
  const need = rows.filter((r) => !r.checked);
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
        // The snapshot was ready and this group was not flagged private, so
        // Bright Data got in. That is the same standard the live scanner uses
        // and it is what makes the row safe to offer somebody.
        patch.checked = 1;
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

/**
 * Keep filling a member's watchlist until it is full.
 *
 * Setup hands out whatever the catalogue has verified at that moment, which in
 * a new area can be very little. Nobody is going back through the wizard, so
 * the filling has to carry on without them. This runs from the cron and tops
 * one member up to their plan's limit using groups we have proven readable.
 *
 * Three rules it must keep:
 *  - only checked groups, so a private one never lands in somebody's account
 *  - never a group they deleted, or we would put it straight back every hour
 *  - never past the plan limit, because every group is a group we pay to scan
 */
export async function topUpMember(userId: string, allowSearch = false): Promise<number> {
  const db = getDb();

  const [profile] = await db
    .select({ state: profiles.state, location: profiles.location, plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!profile) return 0;

  const limit = groupLimit(profile.plan);
  const mine = await db
    .select({ name: groups.name, sourceId: groups.sourceId })
    .from(groups)
    .where(and(eq(groups.userId, userId), eq(groups.status, "watching")));
  const room = limit - mine.length;
  if (room <= 0) return 0;

  const suburbs = profile.location.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!suburbs.length || !profile.state) return 0;

  let held = await fromCatalogue(suburbs, profile.state);

  // Searching costs forty Brave queries, so it is rationed: only for somebody
  // whose watchlist is nearly empty, and only one member per tick. Without it
  // a member in a state nobody has set up in yet would sit on zero forever,
  // because the catalogue only grows when somebody searches it.
  if (allowSearch && held.length < room) {
    const found = await candidatesFor(suburbs, profile.state);
    // Nothing found is offered yet. It is filed, verified below, and picked up
    // by the next top up once Bright Data says it is readable.
    if (found.pending.length) await sizeUnknown(found.pending);
    held = found.groups;
  }
  if (!held.length) return 0;

  const dropped = new Set(
    (
      await db
        .select({ slug: droppedGroups.slug })
        .from(droppedGroups)
        .where(eq(droppedGroups.userId, userId))
    ).map((d) => d.slug)
  );

  // Their own rows carry a name, not a url, so the slug comes off the source.
  const sourceIds = mine.map((g) => g.sourceId).filter((id): id is number => id != null);
  const haveSlugs = new Set<string>();
  if (sourceIds.length) {
    const rows = await db
      .select({ url: sources.url })
      .from(sources)
      .where(inArray(sources.id, sourceIds));
    for (const r of rows) haveSlugs.add(groupSlug(r.url));
  }
  const haveNames = new Set(mine.map((g) => g.name.trim().toLowerCase()));

  const wanted = rank(held, suburbs)
    .filter((c) => !haveSlugs.has(c.slug) && !dropped.has(c.slug))
    .filter((c) => !haveNames.has(c.name.trim().toLowerCase()))
    .slice(0, room);
  if (!wanted.length) return 0;

  const all = await db.select({ id: sources.id, url: sources.url, active: sources.active }).from(sources);
  let added = 0;

  for (const c of wanted) {
    const existing = all.find((s) => groupSlug(s.url) === c.slug);
    let sourceId = existing?.id;

    if (sourceId && !existing?.active) {
      await db.update(sources).set({ active: 1, lastError: "" }).where(eq(sources.id, sourceId));
    }
    if (!sourceId) {
      const [created] = await db
        .insert(sources)
        // Backdated the same hour setup uses, so their first window is wide
        // enough to arrive with real posts rather than an empty list.
        .values({ groupName: c.name, url: c.url, lastChecked: Date.now() - 60 * 60 * 1000 })
        .returning({ id: sources.id });
      sourceId = created?.id;
      if (sourceId) all.push({ id: sourceId, url: c.url, active: 1 });
    }
    if (!sourceId) continue;

    await db.insert(groups).values({ userId, name: c.name, sourceId, status: "watching" });
    added += 1;
  }

  return added;
}

/** How long before we look at the same member again. */
const TOP_UP_GAP_MS = 6 * 60 * 60 * 1000;
/** Members touched in one tick, so a big list never stalls the scanner. */
const TOP_UP_PER_TICK = 5;

/**
 * Find members whose watchlist is short and fill it.
 *
 * Only paying members, because an unfinished signup has no watchlist to fill
 * and adding sources for one would have us scanning for somebody who never
 * paid.
 */
export async function topUpShortMembers(): Promise<number> {
  const db = getDb();
  const now = Date.now();

  // Two plain queries rather than a correlated subquery inside select(). The
  // clever version compiled to SQL D1 rejected, and the whole call sits inside
  // a catch in the cron, so it failed every tick without saying a word.
  const rows = await db
    .select({ userId: profiles.userId, plan: profiles.plan })
    .from(profiles)
    .where(
      sql`${profiles.onboardedAt} IS NOT NULL
        AND ${profiles.subscriptionStatus} IN ('active','trialing')
        AND ${profiles.lastTopUp} < ${now - TOP_UP_GAP_MS}`
    )
    .limit(TOP_UP_PER_TICK * 4);

  let filled = 0;
  let touched = 0;
  // One search per tick across all members, whoever needs it most.
  let searchLeft = 1;
  for (const row of rows) {
    if (touched >= TOP_UP_PER_TICK) break;

    const mine = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.userId, row.userId), eq(groups.status, "watching")));
    if (mine.length >= groupLimit(row.plan)) continue;

    // The emptiest watchlists get the search. Somebody on nothing at all is
    // a member paying for silence; somebody on eighteen of twenty is fine.
    const needsSearch = mine.length < 5;
    // Left unstamped on purpose. A catalogue-only pass for somebody on zero
    // does nothing at all, and stamping would spend their six hour window on
    // it. They come back at the front of the next tick instead.
    if (needsSearch && searchLeft <= 0) continue;
    if (needsSearch) searchLeft -= 1;

    touched += 1;
    // Stamped before the work, not after. A member whose top up throws must
    // not be retried on every single tick.
    await db.update(profiles).set({ lastTopUp: now }).where(eq(profiles.userId, row.userId));
    try {
      const added = await topUpMember(row.userId, needsSearch);
      filled += added;
      // A search files groups but cannot hand them over in the same pass:
      // Bright Data has to read each one first, which lands a minute or two
      // later. Without this the member would sit on an empty watchlist for
      // six hours waiting for a verdict that arrived almost immediately.
      if (!added && needsSearch) {
        await db
          .update(profiles)
          .set({ lastTopUp: now - TOP_UP_GAP_MS + 10 * 60 * 1000 })
          .where(eq(profiles.userId, row.userId));
      }
    } catch (err) {
      // One member's bad data must never stop the scanner, but it must not be
      // invisible either. A silent catch here hid a broken query for hours.
      console.error("topUp failed", row.userId, err);
    }
  }
  return filled;
}
