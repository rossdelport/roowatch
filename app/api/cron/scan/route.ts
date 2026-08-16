import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { bdCollect, bdProgress, bdTrigger, dueSources, processSource } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";
import { scanJobs, sources } from "../../../../db/schema";

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
const MAX_INFLIGHT = 40;
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
/** Poll briefly after triggering so a fast snapshot is collected now rather
 *  than a minute from now. Median collection is about 60 seconds. */
const INLINE_WAIT_MS = 45_000;
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

  const byGroup = await bdCollect(
    job.snapshotId,
    rows.map((s) => s.url)
  );
  for (const source of rows) {
    await processSource(source.id, byGroup.get(groupSlug(source.url)) ?? []);
  }

  await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
  return rows.length;
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

  const db = getDb();
  const open = (await db.select().from(scanJobs)) as Job[];
  const { stillRunning, collected } = await sweep(open);

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

  return Response.json({
    ok: true,
    collected: collected + inlineCollected,
    triggered: started.length,
    groups: due.length,
    batches: batches.length,
    inflight: stillRunning.length + waiting.length,
  });
}
