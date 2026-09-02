import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  bdCollect,
  bdProgress,
  bdTrigger,
  dueSources,
  expireSeenPosts,
  finishScanRun,
  processSource,
  startScanRun,
  type GroupFacts,
  type ScanRun,
} from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";
import { collectCatalogue, topUpShortMembers } from "../../../../db/catalogue";
import { groups, scanJobs, sources } from "../../../../db/schema";
import { claimLease, releaseLease, renewLease } from "../../../../db/lease";
import {
  collectionClaim,
  collectionFailureAction,
  jobExpiryReason,
  parseJobState,
  parseSourceIds,
} from "../../../../db/scanqueue";

/**
 * The scanner. One run every five minutes, and never two at once.
 *
 * A run is the whole job, start to finish:
 *
 *   1. take the lease, or leave if another run still holds it
 *   2. trigger a Bright Data snapshot for every group that is due
 *   3. wait for the snapshots, reading each one the moment it is ready
 *   4. write down what every group said, then look after the group finder
 *   5. give the lease back
 *
 * The old scanner spread this over many one-minute ticks, each doing a sliver
 * of work, because the Free plan kills any invocation that uses more than ten
 * milliseconds of CPU. That design was the reason it kept stopping: a tick
 * killed part way left claims and leases behind, and the next twenty ticks
 * waited for them to expire. It needs the Workers Paid plan to run whole.
 *
 * Two properties to preserve if you change this:
 *
 *  - A group in an open snapshot is never triggered again. lastChecked does
 *    not move until posts are processed, so without that exclusion every run
 *    would re-trigger the same groups and we would pay for each of them twice.
 *  - lastChecked only moves once posts are processed. So an abandoned snapshot
 *    costs the records it fetched but can never lose a post: the next trigger
 *    simply asks for a wider window.
 */

/** Must match the scan cron in vite.config.ts and worker/index.ts. */
export const SCAN_EVERY_MINUTES = 5;
/**
 * Groups in one snapshot. Bigger snapshots mean fewer progress checks, and
 * every check is a subrequest against the invocation's budget. Smaller ones
 * finish sooner. Twenty five is the middle of that.
 */
const GROUPS_PER_SNAPSHOT = 25;
/** Snapshots one run will start. Past this the most overdue go first and the
 *  rest wait for the next run. */
const MAX_SNAPSHOTS_PER_RUN = 12;
/**
 * How long one run waits for Bright Data. Snapshots that are still running
 * at the end are left in the queue, and the next run reads them first. The
 * lease holds the next run off until this one is done, so this plus the
 * collection time is the longest gap between two runs.
 */
const WAIT_FOR_SNAPSHOTS_MS = 4 * 60 * 1000;
const POLL_EVERY_MS = 20_000;
/**
 * The safety margin against Facebook publishing a post late. Posts have been
 * seen arriving anywhere from 36 seconds to about 4 minutes after their own
 * timestamp, so the window has to cover the gap since the last look plus that
 * lateness, or a post vanishes with no error at all.
 */
const BUFFER_MINUTES = 3;
/**
 * The narrowest look-back we will ever ask for: one scan gap plus the buffer.
 *
 * This is the money dial. We are billed per post delivered, so a post sitting
 * inside the window gets bought again on every scan that still covers it:
 *
 *   duplicate factor = window minutes / minutes between scans
 *
 * Eight over five buys each post about one and a half times.
 */
const MIN_WINDOW_MINUTES = SCAN_EVERY_MINUTES + BUFFER_MINUTES;
/** Widest catch up after an outage. Older than this and the post is gone. */
const MAX_WINDOW_MINUTES = 360;

/** Only one run at a time. */
const SCAN_LEASE_ID = "scan_run_lease";
/**
 * Renewed on every poll, so this is how long a killed run keeps the scanner
 * off. Three minutes means at most one cron fires into a dead lease.
 */
const SCAN_LEASE_MS = 3 * 60 * 1000;

/** Kill switch. Nobody gets leads while this is on. */
const SCAN_PAUSED = false;

type StoredJob = {
  id: number;
  snapshotId: string;
  sourceIds: string;
  startedAt: number;
  status: string;
};

type Job = Omit<StoredJob, "sourceIds"> & { sourceIds: number[] };

/**
 * How far back to ask for one group. A little wider than the real gap so a
 * missed run cannot lose a post, and never narrower than MIN_WINDOW_MINUTES.
 */
function sinceFor(lastChecked: number): Date {
  const minutesSince = lastChecked ? (Date.now() - lastChecked) / 60000 : 60;
  const minutes = Math.min(
    Math.max(minutesSince + BUFFER_MINUTES, MIN_WINDOW_MINUTES),
    MAX_WINDOW_MINUTES
  );
  return new Date(Date.now() - minutes * 60_000);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read every group in a ready snapshot, then let the job go. */
async function collectJob(job: Job, claimMarker: string, run: ScanRun): Promise<number> {
  const db = getDb();
  const rows = job.sourceIds
    .map((id) => run.sources.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  let collected = 0;
  if (rows.length) {
    const { posts: byGroup, facts } = await bdCollect(
      job.snapshotId,
      rows.map((row) => row.url)
    );
    for (const source of rows) {
      const slug = groupSlug(source.url);
      const posts = byGroup.get(slug) ?? [];
      const fact = facts.get(slug);
      await processSource(source.id, posts, { run, fact });
      await learnAbout(source, fact);
      collected += 1;
    }
  }

  const removed = await db
    .delete(scanJobs)
    .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, claimMarker)))
    .returning({ id: scanJobs.id });
  if (!removed.length) throw new Error("scanner_claim_lost");
  return collected;
}

/**
 * Write down what the snapshot told us about a group.
 *
 * A group link is often just a number, because that is all Facebook puts in
 * the address bar. "Group 589657251411693" is a terrible thing to read in a
 * dashboard. Facebook hands us the real name with every post, so the first
 * post a group produces is enough to fix its name for good.
 *
 * Whether the group can be read at all is recorded by processSource, in the
 * same write as the rest of the pass.
 */
async function learnAbout(
  source: { id: number; groupName: string; url: string; members: number },
  fact: GroupFacts | undefined
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
}

/**
 * Snapshots left behind by the last run, minus anything that can no longer
 * finish. Because the lease allows one run at a time, a claim we find here
 * belongs to a run that died. A first attempt gets one more go.
 */
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
    // Zero: we hold the lease, so any claim here was left by a dead run.
    const expiry =
      sourceIds === null
        ? "malformed_source_ids"
        : jobExpiryReason({ ...row, sourceIds }, now, 0);
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
      jobs.push({ ...row, sourceIds });
      continue;
    }

    const deleted = await db
      .delete(scanJobs)
      .where(and(eq(scanJobs.id, row.id), eq(scanJobs.status, row.status)))
      .returning({ id: scanJobs.id });
    if (!deleted.length) {
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

/** Check every open snapshot once and read all of the ready ones. */
async function sweep(jobs: Job[], run: ScanRun, keepAlive: () => Promise<void>) {
  const db = getDb();
  const stillRunning: Job[] = [];
  let collected = 0;
  let completed = 0;
  let retried = 0;
  let recovered = 0;

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
    if (status === "failed") {
      const deleted = await db
        .delete(scanJobs)
        .where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, job.status)))
        .returning({ id: scanJobs.id });
      if (deleted.length) recovered += 1;
      else stillRunning.push(job);
      continue;
    }

    if (status !== "ready") {
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

    // Reading a busy snapshot can take a while. Keep the lease alive so the
    // next cron does not start a second run under us.
    await keepAlive();
    try {
      collected += await collectJob({ ...job, status: claim.marker }, claim.marker, run);
      completed += 1;
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

  let lease: number | null = null;
  try {
    lease = await claimLease(SCAN_LEASE_ID, SCAN_LEASE_MS);
  } catch (error) {
    console.error("scanner_lease_failed", { error: errorMessage(error) });
    return Response.json({ ok: false, error: "lease_failed" }, { status: 500 });
  }
  if (!lease) return Response.json({ ok: true, skipped: "scan_in_progress" });

  const keepAlive = async () => {
    const renewed = await renewLease(SCAN_LEASE_ID, lease!, SCAN_LEASE_MS);
    // Somebody else holds it, which can only happen if we went quiet for
    // longer than a lease. Stop rather than run beside them.
    if (!renewed) throw new Error("scanner_lease_lost");
    lease = renewed;
  };

  const db = getDb();
  const startedAt = Date.now();
  const stats = {
    triggered: 0,
    groups: 0,
    collected: 0,
    completedJobs: 0,
    retriedJobs: 0,
    recoveredJobs: 0,
    resumedJobs: 0,
    malformedJobs: 0,
    leftOver: 0,
    polls: 0,
    catalogued: 0,
    toppedUp: 0,
  };

  try {
    const loaded = await loadOpenJobs();
    let jobs = loaded.jobs;
    stats.recoveredJobs += loaded.recovered;
    stats.resumedJobs = loaded.resumed;
    stats.malformedJobs = loaded.malformed;

    // Trigger first. If anything later in the run fails, the paid work is
    // already recorded and the next run reads it.
    const busy = new Set(jobs.flatMap((job) => job.sourceIds));
    const due = (await dueSources(GROUPS_PER_SNAPSHOT * MAX_SNAPSHOTS_PER_RUN)).filter(
      (source) => !busy.has(source.id)
    );
    const batches = chunk(due, GROUPS_PER_SNAPSHOT).slice(0, MAX_SNAPSHOTS_PER_RUN);
    stats.groups = batches.reduce((total, batch) => total + batch.length, 0);

    const started = await Promise.all(
      batches.map(async (batch): Promise<Job | null> => {
        const sourceIds = batch.map((source) => source.id);
        try {
          const snapshotId = await bdTrigger(
            batch.map((source) => ({ url: source.url, since: sinceFor(source.lastChecked) }))
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
          return row ? { ...row, sourceIds } : null;
        } catch (error) {
          console.error("scanner_trigger_failed", { sourceIds, error: errorMessage(error) });
          return null;
        }
      })
    );
    for (const job of started) if (job) jobs.push(job);
    stats.triggered = started.filter(Boolean).length;

    const run = await startScanRun([...new Set(jobs.flatMap((job) => job.sourceIds))]);

    // Wait for Bright Data, reading each snapshot as it lands. Waiting costs
    // nothing: the clock runs but the CPU does not.
    const deadline = startedAt + WAIT_FOR_SNAPSHOTS_MS;
    while (jobs.length) {
      await keepAlive();
      const swept = await sweep(jobs, run, keepAlive);
      jobs = swept.stillRunning;
      stats.collected += swept.collected;
      stats.completedJobs += swept.completed;
      stats.retriedJobs += swept.retried;
      stats.recoveredJobs += swept.recovered;
      stats.polls += 1;
      if (!jobs.length || Date.now() + POLL_EVERY_MS > deadline) break;
      await sleep(POLL_EVERY_MS);
    }
    stats.leftOver = jobs.length;

    await finishScanRun(run);
    await expireSeenPosts();

    // Catalogue work is last. A finder failure cannot block live scanning.
    try {
      stats.catalogued = await collectCatalogue();
    } catch (error) {
      console.error("catalogue_collection_failed", { error: errorMessage(error) });
    }
    try {
      await keepAlive();
      stats.toppedUp = await topUpShortMembers();
    } catch (error) {
      console.error("catalogue_top_up_failed", { error: errorMessage(error) });
    }
  } catch (error) {
    console.error("scanner_run_failed", { error: errorMessage(error), ...stats });
    return Response.json({ ok: false, error: errorMessage(error), ...stats }, { status: 500 });
  } finally {
    if (lease) {
      await releaseLease(SCAN_LEASE_ID, lease).catch((error) => {
        console.error("scanner_lease_release_failed", { error: errorMessage(error) });
      });
    }
  }

  return Response.json({ ok: true, seconds: Math.round((Date.now() - startedAt) / 1000), ...stats });
}
