import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { bdCollect, bdProgress, bdTrigger, dueSources, processSource, type GroupFacts } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";
import { collectCatalogue, topUpShortMembers } from "../../../../db/catalogue";
import { groups, scanJobs, sources } from "../../../../db/schema";
import { claimLease, releaseLease } from "../../../../db/lease";
import {
  collectionClaim,
  collectionFailureAction,
  jobExpiryReason,
  parseJobState,
  parseSourceIds,
} from "../../../../db/scanqueue";

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

/**
 * One group per snapshot keeps collection below the Free Worker CPU ceiling.
 * A larger snapshot used to be claimed as one unit, get killed part way
 * through, then hold its queue slot until the stale claim expired.
 */
const GROUPS_PER_BATCH = 1;
/** Keep progress polling and queue repair bounded as well as supplier work. */
const MAX_INFLIGHT = 6;
/** One ready group is the most useful work one 10 ms invocation can finish. */
const MAX_READY_COLLECTIONS_PER_TICK = 1;
/** Most groups we will pick up in a single tick. */
const SOURCES_PER_TICK = 60;
/**
 * Do not look at a group again until this long after the last look. The cron
 * interval is the real floor, so this only stops a group missing its turn when
 * a collection finishes just after a tick.
 */
const MIN_GAP_MINUTES = 3;
/**
 * How much wider than the gap to ask.
 *
 * This is the safety margin against Facebook publishing a post late. Posts
 * have been seen arriving anywhere from 36 seconds to about 4 minutes after
 * their own timestamp, so the window has to cover the gap plus that lateness
 * or a post vanishes with no error at all.
 */
const BUFFER_MINUTES = 3;
/**
 * The narrowest look-back we will ever ask for.
 *
 * This is the money dial, not the cron interval. We are billed per post
 * delivered, so a post sitting inside the window gets bought again on every
 * scan that still covers it:
 *
 *   duplicate factor = window minutes / minutes between scans
 *
 * At a one minute gap and a three minute window that factor was three: every
 * post was bought three times. A three minute gap with a six minute window
 * keeps the same three minute margin for late posts and buys each one twice,
 * which is a third off the Bright Data bill, about ten dollars a member a
 * month. The cost is speed: worst case a lead now waits three minutes to be
 * noticed rather than one.
 *
 * It is also the safety margin against Facebook publishing a post late. Posts
 * have been seen arriving anywhere from 36 seconds to about 4 minutes after
 * their own timestamp. Narrow this and late posts vanish with no error at all.
 */
const MIN_WINDOW_MINUTES = 6;

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
/** Only one cron invocation may choose and trigger due sources at a time. */
const TRIGGER_LEASE_ID = "scan_trigger_lease";
/** Longer than Cloudflare's 15-minute scheduled invocation limit. */
const TRIGGER_LEASE_MS = 16 * 60 * 1000;

type StoredJob = {
  id: number;
  snapshotId: string;
  sourceIds: string;
  startedAt: number;
  status: string;
};

type Job = Omit<StoredJob, "sourceIds"> & { sourceIds: number[] };

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

type CollectionResult = {
  collected: number;
  completed: boolean;
  next: Job | null;
};

/** Finish one claimed group and release any remainder for the next cron. */
async function finishClaim(
  job: Job,
  claimMarker: string,
  remaining: number[],
  collected: number
): Promise<CollectionResult> {
  const db = getDb();
  if (!remaining.length) {
    const removed = await db
      .delete(scanJobs)
      .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claimMarker)))
      .returning({ id: scanJobs.id });
    if (!removed.length) throw new Error("scanner_claim_lost");
    return { collected, completed: true, next: null };
  }

  const startedAt = Date.now();
  const [checkpointed] = await db
    .update(scanJobs)
    .set({ sourceIds: JSON.stringify(remaining), status: "running", startedAt })
    .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claimMarker)))
    .returning({ id: scanJobs.id });
  if (!checkpointed) throw new Error("scanner_claim_lost");
  return {
    collected,
    completed: false,
    next: { ...job, sourceIds: remaining, status: "running", startedAt },
  };
}

/** Read and finish one group from a ready snapshot. */
async function collectJob(job: Job, claimMarker: string): Promise<CollectionResult> {
  const sourceId = job.sourceIds[0];
  if (!sourceId) return finishClaim(job, claimMarker, [], 0);

  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  const remaining = job.sourceIds.slice(1);
  if (!source) return finishClaim(job, claimMarker, remaining, 0);

  const { posts: byGroup, facts } = await bdCollect(
    job.snapshotId,
    [source.url]
  );
  const slug = groupSlug(source.url);
  const posts = byGroup.get(slug) ?? [];
  await processSource(source.id, posts);
  // After, never before. processSource writes its own lastError at the end
  // of every pass, so learning first would have the reason wiped a moment
  // after we wrote it down.
  await learnAbout(source, facts.get(slug), posts.length > 0);

  // The claim is released in the same write as the checkpoint. A killed tick
  // can strand at most this one group, never a five-group batch.
  return finishClaim(job, claimMarker, remaining, 1);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate local state and discard work that can no longer finish. */
async function loadOpenJobs() {
  const db = getDb();
  const rows = (await db
    .select({
      id: scanJobs.id,
      snapshotId: scanJobs.snapshotId,
      sourceIds: scanJobs.sourceIds,
      startedAt: scanJobs.startedAt,
      status: scanJobs.status,
    })
    .from(scanJobs)
    .orderBy(asc(scanJobs.startedAt))) as StoredJob[];

  const jobs: Job[] = [];
  let malformed = 0;
  let recovered = 0;
  let resumed = 0;
  const now = Date.now();

  for (const row of rows) {
    const sourceIds = parseSourceIds(row.sourceIds);
    const expiry =
      sourceIds === null ? "malformed_source_ids" : jobExpiryReason({ ...row, sourceIds }, now);
    if (sourceIds !== null && !expiry) {
      jobs.push({ ...row, sourceIds });
      continue;
    }

    if (sourceIds !== null && expiry === "stale_first_claim") {
      const retryStatus = `retry:${Date.now()}`;
      const [reset] = await db
        .update(scanJobs)
        .set({ status: retryStatus })
        .where(and(eq(scanJobs.id, row.id), eq(scanJobs.status, row.status)))
        .returning({ id: scanJobs.id });
      if (reset) {
        resumed += 1;
        jobs.push({ ...row, sourceIds, status: retryStatus });
        console.error("scanner_job_resumed", {
          jobId: row.id,
          snapshotId: row.snapshotId,
          reason: expiry,
        });
        continue;
      }

      // Another invocation changed the claim after our read. Keep the sources
      // busy for this tick so recovery cannot trigger a duplicate snapshot.
      jobs.push({ ...row, sourceIds });
      continue;
    }

    const deleted = await db
      .delete(scanJobs)
      .where(and(eq(scanJobs.id, row.id), eq(scanJobs.status, row.status)))
      .returning({ id: scanJobs.id });
    if (!deleted.length) {
      // Another invocation changed the job after our read. Keep its sources
      // busy for this tick so recovery cannot trigger a duplicate snapshot.
      if (sourceIds !== null) jobs.push({ ...row, sourceIds });
      continue;
    }

    if (sourceIds === null) malformed += 1;
    else recovered += 1;
    console.error("scanner_job_removed", {
      jobId: row.id,
      snapshotId: row.snapshotId,
      reason: expiry,
    });
  }

  return { jobs, malformed, recovered, resumed };
}

/** Check open snapshots and collect only a bounded number of ready ones. */
async function sweep(jobs: Job[]) {
  const db = getDb();
  const stillRunning: Job[] = [];
  let collected = 0;
  let completed = 0;
  let retried = 0;
  let recovered = 0;
  let readyClaims = 0;

  const states = await Promise.all(
    jobs.map(async (job) => {
      if (parseJobState(job.status)?.kind === "collecting") {
        return { job, status: "collecting" };
      }
      try {
        return { job, status: (await bdProgress(job.snapshotId)).status };
      } catch {
        return { job, status: "unknown" };
      }
    })
  );

  for (const { job, status } of states) {
    if (status === "collecting") {
      stillRunning.push(job);
      continue;
    }

    if (status === "failed") {
      const deleted = await db
        .delete(scanJobs)
        .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, job.status)))
        .returning({ id: scanJobs.id });
      if (deleted.length) recovered += 1;
      else stillRunning.push(job);
      continue;
    }

    if (status === "ready") {
      if (readyClaims >= MAX_READY_COLLECTIONS_PER_TICK) {
        stillRunning.push(job);
        continue;
      }

      const claim = collectionClaim(job.status, Date.now());
      if (!claim) {
        stillRunning.push(job);
        continue;
      }
      const [claimed] = await db
        .update(scanJobs)
        .set({ status: claim.marker })
        .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claim.expected)))
        .returning({ id: scanJobs.id });
      if (!claimed) {
        stillRunning.push(job);
        continue;
      }

      readyClaims += 1;
      try {
        const result = await collectJob({ ...job, status: claim.marker }, claim.marker);
        collected += result.collected;
        if (result.completed) completed += 1;
        if (result.next) stillRunning.push(result.next);
      } catch (error) {
        console.error("scanner_collection_failed", {
          jobId: job.id,
          snapshotId: job.snapshotId,
          attempt: claim.attempt,
          error: errorMessage(error),
        });
        const failure = collectionFailureAction(claim.attempt, Date.now());
        if (failure.kind === "retry") {
          const [reset] = await db
            .update(scanJobs)
            .set({ status: failure.status })
            .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claim.marker)))
            .returning({ id: scanJobs.id });
          if (reset) {
            retried += 1;
            stillRunning.push({ ...job, status: failure.status });
          }
        } else {
          const deleted = await db
            .delete(scanJobs)
            .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claim.marker)))
            .returning({ id: scanJobs.id });
          if (deleted.length) recovered += 1;
        }
      }
      continue;
    }

    stillRunning.push(job);
  }

  return { stillRunning, collected, completed, retried, recovered };
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
  let leaseToken: number | null = null;
  try {
    leaseToken = await claimLease(TRIGGER_LEASE_ID, TRIGGER_LEASE_MS);
  } catch (error) {
    console.error("scanner_trigger_lease_failed", { error: errorMessage(error) });
  }

  let loaded: Awaited<ReturnType<typeof loadOpenJobs>>;
  let open: Job[];
  const started: Job[] = [];
  let dueCount = 0;
  let batchCount = 0;

  try {
    loaded = await loadOpenJobs();
    open = loaded.jobs;

    // Trigger first. If collection later exhausts CPU, the next paid work is
    // already recorded and can finish on another tick.
    if (leaseToken) {
      const busy = new Set(open.flatMap((job) => job.sourceIds));
      const slots = Math.max(0, MAX_INFLIGHT - open.length);
      if (slots > 0) {
        const due = (await dueSources(SOURCES_PER_TICK)).filter(
          (source) =>
            !busy.has(source.id) &&
            Date.now() - source.lastChecked > MIN_GAP_MINUTES * 60 * 1000
        );
        const batches = chunk(due, GROUPS_PER_BATCH).slice(0, slots);
        dueCount = batches.reduce((total, batch) => total + batch.length, 0);
        batchCount = batches.length;

        await Promise.all(
          batches.map(async (batch) => {
            const sourceIds = batch.map((source) => source.id);
            try {
              const snapshotId = await bdTrigger(
                batch.map((source) => source.url),
                sinceFor(batch)
              );
              const [row] = await db
                .insert(scanJobs)
                .values({
                  snapshotId,
                  sourceIds: JSON.stringify(sourceIds),
                  startedAt: Date.now(),
                  status: "running",
                })
                .returning({
                  id: scanJobs.id,
                  snapshotId: scanJobs.snapshotId,
                  startedAt: scanJobs.startedAt,
                  status: scanJobs.status,
                });
              if (row) started.push({ ...row, sourceIds });
            } catch (error) {
              console.error("scanner_trigger_failed", {
                sourceIds,
                error: errorMessage(error),
              });
            }
          })
        );
      }
    }
  } finally {
    if (leaseToken) {
      await releaseLease(TRIGGER_LEASE_ID, leaseToken).catch((error) => {
        console.error("scanner_trigger_lease_release_failed", { error: errorMessage(error) });
      });
    }
  }

  const swept = await sweep(open);

  // Catalogue work is last. A finder failure can no longer block live scan
  // triggering or collection in the same tick.
  let catalogued = 0;
  try {
    catalogued = await collectCatalogue();
  } catch (error) {
    console.error("catalogue_collection_failed", { error: errorMessage(error) });
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
    } catch (error) {
      console.error("catalogue_top_up_failed", { error: errorMessage(error) });
    }
  }

  return Response.json({
    ok: true,
    toppedUp,
    catalogued,
    collected: swept.collected,
    completedJobs: swept.completed,
    retriedJobs: swept.retried,
    recoveredJobs: loaded.recovered + swept.recovered,
    resumedJobs: loaded.resumed,
    malformedJobs: loaded.malformed,
    triggered: started.length,
    groups: dueCount,
    batches: batchCount,
    inflight: swept.stillRunning.length + started.length,
    triggerSkipped: !leaseToken,
  });
}
