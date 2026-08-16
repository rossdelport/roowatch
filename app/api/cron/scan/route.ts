import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { bdCollect, bdProgress, bdTrigger, dueSources, processSource } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";
import { scanJobs, sources } from "../../../../db/schema";

/**
 * The scanner.
 *
 * Bright Data is asynchronous, so one pass is two steps that may land in
 * different ticks:
 *
 *   tick A  trigger a collection, write the snapshot id down, wait a little
 *   tick B  the snapshot is ready, read the posts, alert, mark the groups done
 *
 * Writing the snapshot id down is what stops us paying twice. Without it a tick
 * that started while an earlier collection was still running would trigger a
 * second collection for the same groups.
 *
 * Nothing updates sources.lastChecked until the posts are actually processed.
 * So an abandoned collection costs us the records it fetched, but never loses a
 * post: the next trigger simply asks for a wider window.
 */

/** Groups we will ask for in one collection. Bright Data has no run fee, so
 *  this is only about keeping one collection quick enough to be useful. */
const SOURCES_PER_TICK = 120;
/**
 * Do not look at a group again until this long after the last look.
 *
 * This sits below the 5 minute cron interval on purpose. A collection takes 30
 * to 140 seconds, so lastChecked lands a minute or two after the tick that
 * asked for it. At 5 minutes the very next tick saw a gap of only 3 or 4
 * minutes, called the group not due, and skipped it. Groups drifted into
 * alternating batches and each one was only read every 8 or 9 minutes.
 *
 * The cron interval is the real floor here, so a lower number cannot cause
 * scanning more often than every 5 minutes. It only stops a group missing its
 * turn. Under Bright Data this is free: a check that finds nothing costs
 * nothing.
 */
const MIN_GAP_MINUTES = 1;
const BUFFER_MINUTES = 1;
/**
 * The narrowest look-back we will ever ask for.
 *
 * This is the money dial, not the cron interval. We are billed per post
 * delivered, so a post sitting inside the window gets bought again on every
 * scan that still covers it. Buying the same post twice is the price of never
 * missing one.
 *
 *   duplicate factor = window minutes / minutes between scans
 *
 * At a 5 minute cadence with a 6 minute floor that was 1.2x. Dropping to a 1
 * minute cadence without moving this floor would have made it 6x. At 3 minutes
 * it is 3x, which is the cost of the faster promise. seen_posts still stops any
 * member being alerted twice.
 */
const MIN_WINDOW_MINUTES = 3;
/**
 * Wait this long inside the triggering tick before handing the job to the next
 * tick. Most collections finish in 24 to 50 seconds, so this catches the common
 * case. There is no point waiting much longer now that another tick arrives
 * every minute to pick the job up.
 */
const INLINE_WAIT_MS = 55_000;
const POLL_EVERY_MS = 5_000;
/** A collection still running after this is treated as dead and dropped. */
const JOB_STALE_MINUTES = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How far back to ask. A little wider than the real gap so a skipped tick
 * cannot lose a post, and never narrower than MIN_WINDOW_MINUTES so a post
 * Facebook indexes slightly late still gets caught. seen_posts stops the
 * overlap from ever alerting a member twice.
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

/** Read a finished snapshot, alert on anything new, and close the job off. */
async function collectJob(job: { id: number; snapshotId: string; sourceIds: string }) {
  const db = getDb();
  const ids: number[] = JSON.parse(job.sourceIds);
  const rows = ids.length
    ? await db.select().from(sources).where(inArray(sources.id, ids))
    : [];

  if (!rows.length) {
    await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
    return { ran: 0, results: [] };
  }

  const byGroup = await bdCollect(
    job.snapshotId,
    rows.map((s) => s.url)
  );

  const results = [];
  for (const source of rows) {
    results.push({
      id: source.id,
      group: source.groupName,
      ...(await processSource(source.id, byGroup.get(groupSlug(source.url)) ?? [])),
    });
  }

  await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
  return { ran: results.length, results };
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

  // Step 2 first. An outstanding collection always takes priority, because
  // triggering another one while it runs is how you pay twice.
  const [pending] = await db
    .select()
    .from(scanJobs)
    .orderBy(desc(scanJobs.id))
    .limit(1);

  if (pending) {
    const ageMinutes = (Date.now() - pending.startedAt) / 60000;
    let progress;
    try {
      progress = await bdProgress(pending.snapshotId);
    } catch {
      progress = { status: "unknown", records: 0, errors: 0 };
    }

    if (progress.status === "ready") {
      return Response.json({ ok: true, phase: "collected", ...(await collectJob(pending)) });
    }
    if (progress.status === "failed" || ageMinutes > JOB_STALE_MINUTES) {
      // Drop it. lastChecked was never moved, so the next trigger asks for a
      // window wide enough to cover everything this one would have found.
      await db.delete(scanJobs).where(eq(scanJobs.id, pending.id));
      return Response.json({ ok: true, phase: "dropped", status: progress.status });
    }
    return Response.json({ ok: true, phase: "waiting", status: progress.status });
  }

  // Step 1. Nothing outstanding, so start a new collection.
  const due = (await dueSources(SOURCES_PER_TICK)).filter(
    (s) => Date.now() - s.lastChecked > MIN_GAP_MINUTES * 60 * 1000
  );
  if (!due.length) return Response.json({ ok: true, phase: "idle", ran: 0 });

  const since = sinceFor(due);
  let snapshotId: string;
  try {
    snapshotId = await bdTrigger(
      due.map((s) => s.url),
      since
    );
  } catch (err) {
    return Response.json(
      { ok: false, phase: "trigger_failed", error: String(err) },
      { status: 502 }
    );
  }

  const [job] = await db
    .insert(scanJobs)
    .values({
      snapshotId,
      sourceIds: JSON.stringify(due.map((s) => s.id)),
      startedAt: Date.now(),
    })
    .returning({ id: scanJobs.id, snapshotId: scanJobs.snapshotId, sourceIds: scanJobs.sourceIds });

  // Most collections finish inside the tick that started them, so wait a bit
  // rather than making members wait another five minutes for their lead.
  const deadline = Date.now() + INLINE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    let status = "running";
    try {
      status = (await bdProgress(snapshotId)).status;
    } catch {
      break;
    }
    if (status === "ready") {
      return Response.json({
        ok: true,
        phase: "triggered_and_collected",
        since: since.toISOString(),
        ...(await collectJob(job)),
      });
    }
    if (status === "failed") {
      await db.delete(scanJobs).where(eq(scanJobs.id, job.id));
      return Response.json({ ok: true, phase: "failed", snapshotId });
    }
  }

  return Response.json({
    ok: true,
    phase: "triggered",
    snapshotId,
    groups: due.length,
    since: since.toISOString(),
  });
}
