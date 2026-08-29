import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { bdCollect, bdProgress, bdTrigger, dueSources, processSource, type GroupFacts } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";
import { collectCatalogue, topUpShortMembers } from "../../../../db/catalogue";
import { groups, scanJobs, sources } from "../../../../db/schema";

/**
 * The scanner.
 *
 * Bright Data is asynchronous, so one pass is two steps that usually land in
 * different ticks:
 *
 *   collect  any snapshot that is ready, read the posts, alert, mark done
 *   trigger  new snapshots for groups that are due
 *
 * Groups are split into small batches and every batch gets its own snapshot,
 * all running at the same time. Measured on 16 August 2026: 15 snapshots fired
 * at one instant finished in 110 seconds. Run one after the other they would
 * have taken 951 seconds. Concurrency is 8.6x faster and costs nothing extra,
 * because Bright Data has no run fee and an empty check is free.
 *
 * That is what lets this hold at 500 groups. One giant snapshot would not.
 *
 * Two properties to preserve if you change this:
 *
 *  - A source in a running snapshot is never triggered again. lastChecked does
 *    not move until posts are processed, so without the exclusion below every
 *    tick would re-trigger the same groups and we would pay for each of them
 *    over and over.
 *  - lastChecked only moves once posts are processed. So an abandoned snapshot
 *    costs the records it fetched but can never lose a post: the next trigger
 *    simply asks for a wider window.
 */

/** Groups in one snapshot. Small on purpose: how a single snapshot scales with
 *  group count has never been measured, but running many at once has. When in
 *  doubt, more snapshots rather than bigger ones. */
const GROUPS_PER_BATCH = 12;
/** Snapshots allowed in flight at once. Tested clean at 15. This is the brake
 *  that stops a backlog turning into hundreds of open collections. */
const MAX_INFLIGHT = 12;
/** Most groups we will pick up in a single tick. */
const SOURCES_PER_TICK = 500;
/**
 * Do not look at a group again until this long after the last look. The cron
 * interval is the real floor, so this only stops a group missing its turn when
 * a collection finishes just after a tick.
 */
const MIN_GAP_MINUTES = 1;
const BUFFER_MINUTES = 1;
/**
 * The narrowest look-back we will ever ask for.
 *
 * This is the money dial, not the cron interval. We are billed per post
 * delivered, so a post sitting inside the window gets bought again on every
 * scan that still covers it:
 *
 *   duplicate factor = window minutes / minutes between scans
 *
 * It is also the safety margin against Facebook publishing a post late. Posts
 * have been seen arriving anywhere from 36 seconds to about 4 minutes after
 * their own timestamp. Narrow this and late posts vanish with no error at all.
 */
const MIN_WINDOW_MINUTES = 3;

/** Temporary: run the watchlist top up on every tick, to fill the backlog of
 *  members who were set up before the group finder existed. Back to false
 *  once they are full. */
const TOP_UP_EVERY_TICK = false;

/**
 * Temporary. Stops the scan so the watchlist top up gets the whole CPU budget
 * for itself, which is the only way to run five rings of searching for a
 * member without the tick being killed. Nobody gets leads while this is on,
 * so it goes back to false the moment the backfill is done.
 */
const SCAN_PAUSED = false;
/** Poll briefly after triggering so a fast snapshot is collected now rather
 *  than a minute from now. Median collection is about 60 seconds. */
/**
 * Zero, on purpose.
 *
 * This used to wait 45 seconds after triggering, sweeping every 5 seconds, so
 * one tick could parse the same snapshots nine times over. Cloudflare kills a
 * cron that overruns its CPU budget, and the whole tick died before anything
 * was written down: the scanner was off for twenty hours and nobody noticed
 * because the failure is invisible from inside the worker.
 *
 * Collection belongs to the next tick's sweep, which is what the two step
 * design at the top of this file describes anyway. Snapshots land a minute
 * later instead of seconds. That is a fair price for a scanner that runs.
 */
const INLINE_WAIT_MS = 0;
const POLL_EVERY_MS = 5_000;
/** A collection still running after this is treated as dead and dropped. */
const JOB_STALE_MINUTES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Job = { id: number; snapshotId: string; sourceIds: string; startedAt: number };

/**
 * How far back to ask. A little wider than the real gap so a skipped tick
 * cannot lose a post, and never narrower than MIN_WINDOW_MINUTES.
 */
function sinceFor(rows: { lastChecked: number }[]): Date {
  const oldest = Math.min(...rows.map((s) => s.lastChecked || 0));
  const minutesSince = oldest ? (Date.now() - oldest) / 60000 : 60;
  const minutes = Math.min(
    Math.max(minutesSince + BUFFER_MINUTES, MIN_WINDOW_MINUTES),
    360
  );
  return new Date(Date.now() - minutes * 60_000);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Read a finished snapshot, alert on anything new, and close the job off. */
async function collectJob(job: Job) {
  const db = getDb();
  const ids: number[] = JSON.parse(job.sourceIds);
  const rows = ids.length
    ? await db.select().from(sources).where(inArray(sources.id, ids))
    : [];

  if (!rows.length) {
    await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
    return 0;
  }

  const { posts: byGroup, facts } = await bdCollect(
    job.snapshotId,
    rows.map((s) => s.url)
  );
  for (const source of rows) {
    const slug = groupSlug(source.url);
    const posts = byGroup.get(slug) ?? [];
    await processSource(source.id, posts);
    // After, never before. processSource writes its own lastError at the end
    // of every pass, so learning first would have the reason wiped a moment
    // after we wrote it down.
    await learnAbout(source, facts.get(slug), posts.length > 0);
  }

  await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
  return rows.length;
}

/**
 * Write down what the snapshot told us about a group.
 *
 * Two things a member should never have to sort out themselves:
 *
 * A group link is often just a number, because that is all Facebook puts in
 * the address bar. "Group 589657251411693" is a terrible thing to read in a
 * dashboard. Facebook hands us the real name with every post, so the first
 * post a group produces is enough to fix its name for good.
 *
 * And a private group can never be read, no matter how long we watch it.
 * Saying so beats leaving somebody to wonder why that one is always quiet.
 */
async function learnAbout(
  source: { id: number; groupName: string; url: string; lastError: string; members: number },
  fact: GroupFacts | undefined,
  sawPosts: boolean
) {
  if (!fact) return;
  const db = getDb();

  // Kept fresh on every pass. A group's size drifts, and a stale number is
  // worse than none when somebody is choosing between groups.
  if (fact.members && fact.members !== source.members) {
    await db.update(sources).set({ members: fact.members }).where(eq(sources.id, source.id));
  }

  if (fact.name && fact.name !== source.groupName) {
    await db.update(sources).set({ groupName: fact.name }).where(eq(sources.id, source.id));

    // Members keep their own label for a group, so only the ugly ones are
    // replaced. A name holding the raw id is one nobody chose. Anything a
    // person typed, or Ross fixed by hand, is left exactly as it is.
    const slug = groupSlug(source.url);
    if (slug) {
      const mine = await db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.sourceId, source.id));
      for (const row of mine) {
        if (!row.name.includes(slug)) continue;
        await db.update(groups).set({ name: fact.name }).where(eq(groups.id, row.id));
      }
    }
  }

  // A snapshot that says nothing at all about a group is not evidence that it
  // became readable, so the old reason is carried forward rather than blanked.
  const next = fact.error ? fact.error : sawPosts ? "" : source.lastError;

  // Written every time, with no "has it changed" shortcut. source.lastError
  // was read before processSource ran, and processSource clears the column at
  // the end of every pass. So when nothing had changed, the guard skipped the
  // write and the flag stayed cleared. That is how three private groups
  // quietly went back to looking fine.
  await db.update(sources).set({ lastError: next }).where(eq(sources.id, source.id));
}

/**
 * Check every open snapshot once. Ready ones are collected, dead ones dropped.
 * Returns the jobs that are still going.
 */
async function sweep(jobs: Job[]) {
  const db = getDb();
  const stillRunning: Job[] = [];
  let collected = 0;

  const states = await Promise.all(
    jobs.map(async (job) => {
      try {
        return { job, status: (await bdProgress(job.snapshotId)).status };
      } catch {
        return { job, status: "unknown" };
      }
    })
  );

  for (const { job, status } of states) {
    const ageMinutes = (Date.now() - job.startedAt) / 60000;
    if (status === "ready") {
      try {
        collected += await collectJob(job);
      } catch {
        // Leave the row alone. The next tick tries again, and the stale check
        // below eventually drops it if the snapshot is genuinely broken.
        stillRunning.push(job);
      }
      continue;
    }
    if (status === "failed" || ageMinutes > JOB_STALE_MINUTES) {
      await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
      continue;
    }
    stillRunning.push(job);
  }

  return { stillRunning, collected };
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.BRIGHTDATA_API_KEY) {
    return Response.json({ ok: true, skipped: "brightdata_not_configured" });
  }

  if (SCAN_PAUSED) {
    let toppedUp = 0;
    try {
      await collectCatalogue();
      toppedUp = await topUpShortMembers();
    } catch (err) {
      console.error("paused tick", err);
    }
    return Response.json({ ok: true, scanPaused: true, toppedUp });
  }

  const db = getDb();
  const open = (await db.select().from(scanJobs)) as Job[];
  const { stillRunning, collected } = await sweep(open);

  // Sizing up newly discovered groups, kept beside the real scan rather than
  // inside it. It alerts nobody and writes only to the catalogue, so a failure
  // here can never cost a member a lead.
  try {
    await collectCatalogue();
  } catch {
    // Never let catalogue work break a scan.
  }

  // Groups already inside a running snapshot must not be asked for again.
  // Their lastChecked has not moved yet, so they still look due.
  const busy = new Set<number>();
  for (const job of stillRunning) {
    for (const id of JSON.parse(job.sourceIds) as number[]) busy.add(id);
  }

  const slots = MAX_INFLIGHT - stillRunning.length;
  if (slots <= 0) {
    return Response.json({ ok: true, collected, inflight: stillRunning.length, triggered: 0 });
  }

  const due = (await dueSources(SOURCES_PER_TICK)).filter(
    (s) => !busy.has(s.id) && Date.now() - s.lastChecked > MIN_GAP_MINUTES * 60 * 1000
  );
  if (!due.length) {
    return Response.json({ ok: true, collected, inflight: stillRunning.length, triggered: 0 });
  }

  const batches = chunk(due, GROUPS_PER_BATCH).slice(0, slots);
  const started: Job[] = [];

  await Promise.all(
    batches.map(async (batch) => {
      const since = sinceFor(batch);
      try {
        const snapshotId = await bdTrigger(
          batch.map((s) => s.url),
          since
        );
        const [row] = await db
          .insert(scanJobs)
          .values({
            snapshotId,
            sourceIds: JSON.stringify(batch.map((s) => s.id)),
            startedAt: Date.now(),
          })
          .returning({
            id: scanJobs.id,
            snapshotId: scanJobs.snapshotId,
            sourceIds: scanJobs.sourceIds,
            startedAt: scanJobs.startedAt,
          });
        if (row) started.push(row as Job);
      } catch {
        // One failed trigger must not stop the other batches. These groups keep
        // their old lastChecked, so the next tick picks them up with a wider
        // window and nothing is lost.
      }
    })
  );

  // Give the quick ones a chance to land now instead of next tick.
  let inlineCollected = 0;
  const deadline = Date.now() + INLINE_WAIT_MS;
  let waiting = started;
  while (waiting.length && Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    const result = await sweep(waiting);
    inlineCollected += result.collected;
    waiting = result.stillRunning;
  }

  // Last, and rarely. Topping somebody up can run forty searches and read the
  // whole catalogue, which is far too much to do beside a scan every minute:
  // sharing a tick with it exceeded the worker's CPU limit and stopped the
  // scanner outright. It runs after every source has been triggered, so even
  // if this blows up the scan has already happened.
  let toppedUp = 0;
  if (TOP_UP_EVERY_TICK || new Date().getMinutes() % 10 === 0) {
    try {
      toppedUp = await topUpShortMembers();
    } catch {
      // A top up must never cost anybody a lead.
    }
  }

  return Response.json({
    ok: true,
    toppedUp,
    collected: collected + inlineCollected,
    triggered: started.length,
    groups: due.length,
    batches: batches.length,
    inflight: stillRunning.length + waiting.length,
  });
}
