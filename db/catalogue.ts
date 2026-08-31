import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import { catalogueJobs, droppedGroups, foundGroups, groups, profiles, sources } from "./schema";
import { findGroups, looksAustralian, looksForeign } from "./groupsearch";
import { MAX_RING, nearbySuburbs, postcodesFor, postcodesInState } from "./gazetteer";
import { bdCollect, bdProgress, bdTrigger } from "./pipeline";
import { groupSlug } from "./fbgroups";
import { groupLimit } from "./plans";
import { claimLease, releaseLease } from "./lease";
import { JOB_STALE_MS, parseSlugs } from "./scanqueue";

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

/**
 * Suburbs a search will spread itself across.
 *
 * findGroups divides a fixed query budget by the number of places, so this is
 * really a floor on coverage rather than a ceiling: below it, a search wastes
 * its breadth on one town, and a member ends up with three groups.
 */
const SEARCH_PLACES = 6;
const CATALOGUE_JOBS_CHECKED_PER_TICK = 5;
const CATALOGUE_READY_PER_TICK = 1;
const CATALOGUE_TRIGGER_LEASE_ID = "catalogue_trigger_lease";
/** Longer than Cloudflare's 15-minute scheduled invocation limit. */
const CATALOGUE_TRIGGER_LEASE_MS = 16 * 60 * 1000;
const CATALOGUE_LEASE_ID = "catalogue_collection_lease";
const CATALOGUE_LEASE_MS = 20 * 60 * 1000;

/**
 * A test for "is this group in the patch they actually work in".
 *
 * Matching on state alone put a Penrith plumber on Central Coast groups and a
 * Cairns plumber on the Sunshine Coast. Their own suburbs plus the ones next
 * door is the real test.
 */
async function patchMatcher(suburbs: string[], state: string): Promise<(name: string) => boolean> {
  const near = new Set(suburbs.map((s) => s.trim().toLowerCase()).filter(Boolean));
  try {
    for (const n of await nearbySuburbs(suburbs, state, 12, 0)) near.add(n.toLowerCase());
  } catch {
    // No neighbours is fine. Their own suburbs still work.
  }
  const places = [...near].filter((p) => p.length > 2);
  return (name: string) => {
    const low = name.toLowerCase();
    return places.some((p) => low.includes(p));
  };
}

/** What we already hold for these suburbs, no searching, no cost. */
async function fromCatalogue(suburbs: string[], state: string): Promise<Candidate[]> {
  const db = getDb();
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

  // A group has to name somewhere they actually work.
  //
  // Matching on state alone put a Penrith plumber on Central Coast groups,
  // a hundred kilometres away, because another New South Wales member watched
  // them. Queensland was worse: a Cairns plumber was handed the Sunshine
  // Coast, seventeen hundred kilometres down the road. Their own suburbs plus
  // the ones next door is the real test.
  const mentionsTheirPatch = await patchMatcher(suburbs, state);

  const out = new Map<string, Candidate>();
  for (const w of watched) {
    const slug = groupSlug(w.url);
    if (!slug) continue;
    if (!mentionsTheirPatch(w.name)) continue;
    out.set(slug, { slug, url: w.url, name: w.name, members: w.members, proven: true });
  }
  for (const g of known) {
    if (out.has(g.slug)) continue;
    // Only offer a catalogued group when it belongs to their patch.
    // Same test. The old one accepted any row from the same state, which is
    // how somebody ended up watching the other end of it.
    if (!mentionsTheirPatch(`${g.suburb} ${g.name}`)) continue;
    // The same test the search applies. Rows filed before these rules existed
    // are still in here, and a Richmond Hill in Ontario would be scanned every
    // minute at our expense if it slipped back out.
    // Only the foreign test here. The row is already pinned to their state and
    // matched to their suburbs above, and demanding a postcode or the word
    // Australia in the name on top of that threw away real local groups.
    // Filing is where the strict test now lives.
    if (looksForeign(g.name)) continue;
    // A number is not a name.
    if (/^Group \d+$/.test(g.name)) continue;
    out.set(g.slug, { slug: g.slug, url: g.url, name: g.name, members: g.members, proven: false });
  }
  return [...out.values()];
}

/**
 * Does this name really mention this place, rather than merely contain the
 * letters?
 *
 * A plain includes() matched Kew inside AISKEW and handed a Melbourne tradie
 * "BEDALE NORTHALLERTON AISKEW THIRSK BUY SELL", which is four towns in North
 * Yorkshire.
 */
function namesPlace(haystack: string, place: string): boolean {
  if (!place) return false;
  const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(haystack);
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
  state: string,
  ring = 0
): Promise<{ groups: Candidate[]; searched: boolean; pending: string[] }> {
  const held = await fromCatalogue(suburbs, state);
  if (held.length >= FILL_TARGET) {
    return { groups: rank(held, suburbs).slice(0, FILL_TARGET), searched: false, pending: [] };
  }

  let found: Awaited<ReturnType<typeof findGroups>> = [];
  try {
    // A short list gets padded with the suburbs next door. One suburb does not
    // have twenty Facebook groups in it, and a tradie in Templestowe works in
    // Bulleen and Doncaster whether or not he thought to type them. Their own
    // suburbs stay at the front, so the search spends its best queries there,
    // and ranking still uses only what they actually gave us.
    // Ring 0 only pads a thin list. Every ring after it is a deliberate look
    // further out for somebody we still cannot fill, so it always pads.
    const padWith = ring === 0 ? Math.max(0, SEARCH_PLACES - suburbs.length) : SEARCH_PLACES;
    const wide = padWith
      ? [...suburbs, ...(await nearbySuburbs(suburbs, state, padWith, ring))]
      : suburbs;

    const [postcodeOf, statePostcodes] = await Promise.all([
      postcodesFor(wide, state),
      postcodesInState(state),
    ]);
    found = await findGroups(wide, state, 30, postcodeOf, statePostcodes);

    // A padded suburb is a guess, and some of them are shared with the other
    // side of the world. Padding with Doncaster brought back Doncaster in
    // South Yorkshire: a UK community page, a Morrisons on York Road, and a
    // Saturday football league. None of them said Yorkshire, so nothing in the
    // foreign list caught them.
    //
    // So anything found through a suburb they did not give us has to earn its
    // place: it must either name one of their real suburbs, or prove it is
    // Australian on its own. Their own suburbs are trusted as before.
    if (wide.length > suburbs.length) {
      const own = suburbs.map((s) => s.trim().toLowerCase()).filter(Boolean);
      const added = wide.slice(suburbs.length).map((s) => s.trim().toLowerCase());
      found = found.filter((g) => {
        const name = g.name.toLowerCase();
        // Their own suburbs are trusted, as they always were.
        if (own.some((p) => namesPlace(name, p))) return true;
        // Proof on its own face is enough too: a postcode, a state, "council".
        if (looksAustralian(g.name)) return true;
        // Otherwise it has to actually be about the suburb we guessed, and not
        // read as somewhere else. Requiring the name to carry the guessed
        // suburb is what stops a search for Doncaster returning a football
        // league; the foreign list is what stops the ones that do say
        // Doncaster but mean the English one.
        return added.some((p) => namesPlace(name, p)) && !looksForeign(g.name);
      });
    }
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
  let leaseToken: number | null = null;
  try {
    leaseToken = await claimLease(CATALOGUE_TRIGGER_LEASE_ID, CATALOGUE_TRIGGER_LEASE_MS);
    if (!leaseToken) return;

    // Setup polls while verification is in flight. Do not buy the same check
    // on every poll just because the catalogue row is still unchecked.
    const queuedRows = await db.select({ slugs: catalogueJobs.slugs }).from(catalogueJobs);
    const queued = new Set<string>();
    for (const job of queuedRows) {
      for (const slug of parseSlugs(job.slugs) ?? []) queued.add(slug);
    }

    const rows = await db
      .select({ slug: foundGroups.slug, url: foundGroups.url, checked: foundGroups.checked })
      .from(foundGroups)
      .where(inArray(foundGroups.slug, slugs.slice(0, 20)));

    // Unchecked, not unsized. A quiet public group is verified but will never
    // report members, and filtering on members alone would re-snapshot it on
    // every single setup, forever.
    const need = rows.filter((r) => !r.checked && !queued.has(r.slug));
    if (!need.length) return;

    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const snapshotId = await bdTrigger(need.map((r) => r.url), since);
    await db.insert(catalogueJobs).values({
      snapshotId,
      slugs: JSON.stringify(need.map((r) => r.slug)),
      startedAt: Date.now(),
    });
  } catch (error) {
    // Sizing is a nicety. Setup carries on without it.
    console.error("catalogue_trigger_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (leaseToken) {
      await releaseLease(CATALOGUE_TRIGGER_LEASE_ID, leaseToken).catch((error) => {
        console.error("catalogue_trigger_lease_release_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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
  const leaseToken = await claimLease(CATALOGUE_LEASE_ID, CATALOGUE_LEASE_MS);
  if (!leaseToken) return 0;

  try {
    const jobs = await db
      .select()
      .from(catalogueJobs)
      .orderBy(asc(catalogueJobs.startedAt))
      .limit(CATALOGUE_JOBS_CHECKED_PER_TICK);
    if (!jobs.length) return 0;

    let done = 0;
    let readyAttempted = 0;
    for (const job of jobs) {
      const slugs = parseSlugs(job.slugs);
      const tooOld = Date.now() - job.startedAt > JOB_STALE_MS;
      if (!slugs || tooOld) {
        await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
        console.error("catalogue_job_removed", {
          jobId: job.id,
          snapshotId: job.snapshotId,
          reason: slugs ? "stale_snapshot" : "malformed_slugs",
        });
        continue;
      }

      let status = "unknown";
      try {
        status = (await bdProgress(job.snapshotId)).status;
      } catch {
        status = "unknown";
      }

      if (status === "failed") {
        await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
        continue;
      }
      if (status !== "ready" || readyAttempted >= CATALOGUE_READY_PER_TICK) continue;

      readyAttempted += 1;
      const rows = slugs.length
        ? await db
            .select({ slug: foundGroups.slug, url: foundGroups.url })
            .from(foundGroups)
            .where(inArray(foundGroups.slug, slugs))
        : [];

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
      } catch (error) {
        console.error("catalogue_job_failed", {
          jobId: job.id,
          snapshotId: job.snapshotId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Catalogue work is optional and runs again from the unchecked row.
        // One broken snapshot must not own the only collection slot for 20 min.
        await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
        continue;
      }

      await db.delete(catalogueJobs).where(eq(catalogueJobs.id, job.id));
    }
    return done;
  } finally {
    await releaseLease(CATALOGUE_LEASE_ID, leaseToken).catch((error) => {
      console.error("catalogue_lease_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
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
    .select({
      state: profiles.state,
      location: profiles.location,
      plan: profiles.plan,
      ring: profiles.searchRing,
    })
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

  // Counted against what they do not already have, not against everything the
  // catalogue holds. Scott sat on eleven groups with eleven held, so held was
  // never below room and the search never ran again: the catalogue was full of
  // groups he was already watching.
  const isNew = (c: Candidate) => !haveSlugs.has(c.slug) && !dropped.has(c.slug);

  if (allowSearch && held.filter(isNew).length < room && profile.ring <= MAX_RING) {
    const found = await candidatesFor(suburbs, profile.state, profile.ring);
    // Nothing found is offered yet. It is filed, verified below, and picked up
    // by the next top up once Bright Data says it is readable.
    if (found.pending.length) await sizeUnknown(found.pending);
    held = found.groups;

    // Step out one ring. The next look covers suburbs this one did not, and
    // once the list is full topUpShortMembers stops calling here at all, so
    // the widening stops on its own.
    await db
      .update(profiles)
      .set({ searchRing: profile.ring + 1 })
      .where(eq(profiles.userId, userId));
  }
  // Verification is not tied to searching. A member whose rings are used up
  // could have dozens of groups already found for their town and no way to get
  // them checked, so they sat in the catalogue for good. Andrew had twenty
  // seven Cairns groups waiting behind that.
  if (held.filter(isNew).length < room) {
    try {
      const mentionsTheirPatch = await patchMatcher(suburbs, profile.state);
      const waiting = await db
        .select({ slug: foundGroups.slug, name: foundGroups.name, suburb: foundGroups.suburb })
        .from(foundGroups)
        .where(and(eq(foundGroups.state, profile.state), eq(foundGroups.checked, 0)))
        .limit(60);
      const mine = waiting
        .filter((g) => mentionsTheirPatch(`${g.suburb} ${g.name}`))
        .map((g) => g.slug);
      if (mine.length) await sizeUnknown(mine);
    } catch {
      // Verification is a nicety here. The top up carries on without it.
    }
  }

  if (!held.length) return 0;

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
    .select({ userId: profiles.userId, plan: profiles.plan, lastTopUp: profiles.lastTopUp })
    .from(profiles)
    .where(
      sql`${profiles.onboardedAt} IS NOT NULL
        AND ${profiles.subscriptionStatus} IN ('active','trialing')
        AND ${profiles.lastTopUp} < ${now - TOP_UP_GAP_MS}`
    )
    .limit(TOP_UP_PER_TICK * 4);

  // Who is short, and by how much.
  const short: { userId: string; have: number; lastTopUp: number }[] = [];
  for (const row of rows) {
    const mine = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.userId, row.userId), eq(groups.status, "watching")));
    if (mine.length < groupLimit(row.plan)) {
      short.push({ userId: row.userId, have: mine.length, lastTopUp: row.lastTopUp });
    }
  }
  // Longest waiting first, not emptiest first.
  //
  // Emptiest first starved everybody else. One member sat on zero groups
  // because his state had nothing verified yet, so he won the single search
  // slot on every tick forever, and a member on three groups never got a turn
  // at all. Whoever has gone longest without a look goes next.
  short.sort((a, b) => a.lastTopUp - b.lastTopUp);

  let filled = 0;
  // One a tick while the scanner is running, because a search is forty
  // queries and the tick has posts to read. The backfill ran three at a time
  // with the scan paused, because a single slot made members leapfrog each
  // other: whoever added nothing had their clock set back, which made them the
  // longest waiting, which won them the next slot, forever.
  let searchLeft = 1;
  for (const row of short.slice(0, TOP_UP_PER_TICK)) {
    const searching = searchLeft > 0;
    if (searching) searchLeft -= 1;

    // Stamped before the work, not after. A member whose top up throws must
    // not be retried on every single tick.
    await db.update(profiles).set({ lastTopUp: now }).where(eq(profiles.userId, row.userId));
    try {
      const added = await topUpMember(row.userId, searching);
      filled += added;
      // A search files groups but cannot hand them over in the same pass:
      // Bright Data has to read each one first, which lands a minute or two
      // later. Without this the member would sit on an empty watchlist for
      // six hours waiting for a verdict that arrived almost immediately.
      // Includes the member we could not search for this tick. Somebody on
      // zero groups who got a catalogue-only pass learned nothing, and making
      // them wait six hours for the search slot left two paying members
      // watching nothing for a day.
      if (!added) {
        await db
          .update(profiles)
          .set({ lastTopUp: now - TOP_UP_GAP_MS + 60 * 1000 })
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
