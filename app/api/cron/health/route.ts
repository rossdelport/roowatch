import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sendEmail } from "../../../../db/auth";
import { claimLease } from "../../../../db/lease";
import {
  evaluateScannerHealth,
  WATCHDOG_ALARM_COOLDOWN_MS,
  WATCHDOG_RECOVERY_COOLDOWN_MS,
  WATCHDOG_WINDOW_MS,
} from "../../../../db/scannerhealth";
import { jobExpiryReason, parseSourceIds } from "../../../../db/scanqueue";
import { sendSms } from "../../../../db/sms";
import { health, scanJobs, seenPosts, sources } from "../../../../db/schema";

/**
 * The watchdog.
 *
 * The scanner was off for twenty hours and nobody knew. Cloudflare kills a
 * cron that overruns its CPU budget, and from the outside that looks exactly
 * like a quiet night: no error, no log, no alert, just nothing happening. Two
 * of the three outages that day were found by hand, hours late.
 *
 * So something has to watch the watcher. It asks one question: is the scanner
 * still touching groups? Not "did it find posts", because a genuinely quiet
 * hour finds none and that is fine. Sources being checked is the heartbeat.
 */

const WATCHER = "rossdelport1998@gmail.com";
const ROSS_MOBILE = "0400369865";

const RECOVERY_LEASE_ID = "scanner_watchdog_recovery";
const ALARM_LEASE_ID = "scanner_watchdog_alarm";

async function mark(id: string, value: number) {
  const db = getDb();
  await db
    .insert(health)
    .values({ id, value })
    .onConflictDoUpdate({ target: health.id, set: { value } });
}

/**
 * Drop only work the normal queue rules already consider abandoned.
 *
 * The watchdog does this in one bounded pass and then gets out of the way.
 * The next minute cron sees the open slots and starts fresh work itself.
 */
async function recoverStaleJobs(now: number) {
  const db = getDb();
  const rows = await db
    .select({
      id: scanJobs.id,
      sourceIds: scanJobs.sourceIds,
      startedAt: scanJobs.startedAt,
      status: scanJobs.status,
    })
    .from(scanJobs);

  const stale = rows.flatMap((row) => {
    const sourceIds = parseSourceIds(row.sourceIds);
    const reason =
      sourceIds === null ? "malformed_source_ids" : jobExpiryReason({ ...row, sourceIds }, now);
    return reason ? [{ ...row, reason }] : [];
  });
  if (!stale.length) return 0;

  const predicates = stale.map((row) =>
    and(
      eq(scanJobs.id, row.id),
      eq(scanJobs.status, row.status),
      eq(scanJobs.sourceIds, row.sourceIds),
      eq(scanJobs.startedAt, row.startedAt)
    )
  );
  const removed = await db
    .delete(scanJobs)
    .where(or(...predicates))
    .returning({ id: scanJobs.id });

  console.error("scanner_watchdog_recovered", {
    removed: removed.length,
    jobs: stale.map((row) => ({ id: row.id, reason: row.reason })),
  });
  return removed.length;
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = Date.now();

  await mark("scanner_watchdog_last_run", now);
  const [snapshot] = await db
    .select({
      active: sql<number>`count(*)`,
      recent: sql<number>`sum(case when ${sources.lastChecked} >= ${now - WATCHDOG_WINDOW_MS} then 1 else 0 end)`,
      latestChecked: sql<number>`coalesce(max(${sources.lastChecked}), 0)`,
    })
    .from(sources)
    .where(eq(sources.active, 1));
  const decision = evaluateScannerHealth(
    {
      active: Number(snapshot?.active ?? 0),
      recent: Number(snapshot?.recent ?? 0),
      latestChecked: Number(snapshot?.latestChecked ?? 0),
    },
    now
  );
  const quietFor = Number.isFinite(decision.quietForMs)
    ? Math.floor(decision.quietForMs / 60000)
    : -1;

  if (decision.skipped) {
    await mark("scanner_watchdog_last_healthy", now);
    return Response.json({ ok: true, skipped: "no_active_sources" });
  }
  if (decision.healthy) {
    await mark("scanner_watchdog_last_healthy", now);
    return Response.json({ ok: true, healthy: true, quietFor, covered: decision.covered });
  }

  let recoveredJobs = 0;
  let recoveryAttempted = false;
  let recoveryError = "";
  try {
    const recoveryToken = await claimLease(RECOVERY_LEASE_ID, WATCHDOG_RECOVERY_COOLDOWN_MS);
    if (recoveryToken) {
      recoveryAttempted = true;
      await mark("scanner_watchdog_last_recovery", now);
      recoveredJobs = await recoverStaleJobs(now);
    }
  } catch (error) {
    recoveryError = error instanceof Error ? error.message : String(error);
    console.error("scanner_watchdog_recovery_failed", { error: recoveryError });
  }

  let alerted = false;
  let alertError = "";
  let alarmToken: number | null = null;
  try {
    alarmToken = await claimLease(ALARM_LEASE_ID, WATCHDOG_ALARM_COOLDOWN_MS);
  } catch (error) {
    alertError = error instanceof Error ? error.message : String(error);
    console.error("scanner_watchdog_alarm_lease_failed", { error: alertError });
  }

  if (!alarmToken) {
    return Response.json({
      ok: true,
      healthy: false,
      reason: decision.reason,
      quietFor,
      covered: decision.covered,
      recoveryAttempted,
      recoveredJobs,
      recoveryError,
      skipped: "already_warned",
    });
  }

  await mark("last_alarm", now);

  const [lastPost] = await db
    .select({ seenAt: seenPosts.seenAt })
    .from(seenPosts)
    .orderBy(desc(seenPosts.seenAt))
    .limit(1);
  const postAge = lastPost ? Math.round((now - Number(lastPost.seenAt)) / 60000) : -1;

  const body = [
    "RooWatch has stopped scanning.",
    "",
    `Only ${decision.covered}% of active groups were checked in the last hour.`,
    quietFor >= 0
      ? `The most recently checked group was ${quietFor} minutes ago.`
      : "No active group has ever completed a check.",
    postAge >= 0
      ? `The last post was read ${postAge} minutes ago.`
      : "No posts have ever been read.",
    `${Number(snapshot?.active ?? 0)} groups should be being watched right now.`,
    "",
    "Some groups may miss leads while this is true.",
    "",
    recoveryAttempted
      ? `The watchdog cleared ${recoveredJobs} stale scan jobs. The next five minute scan will pick up from here.`
      : "A recovery attempt already ran within the last hour. The five minute scanner is still retrying.",
    "",
    "If this does not recover, check the live log with:",
    "npx wrangler tail roowatch",
  ].join("\n");

  try {
    await sendEmail(WATCHER, "RooWatch scanner has stopped", body);
    alerted = true;
  } catch (error) {
    alertError = error instanceof Error ? error.message : String(error);
    console.error("scanner_watchdog_email_failed", { error: alertError });
  }

  // A text as well. An email at 3am is read at 9am.
  try {
    await sendSms(
      ROSS_MOBILE,
      `RooWatch scanning has stalled. Only ${decision.covered}% of groups checked in the last hour. Recovery has started.`
    );
  } catch {
    // The email is the alarm. A texting outage must not swallow it.
  }

  return Response.json({
    ok: true,
    healthy: false,
    reason: decision.reason,
    alerted,
    alertError,
    quietFor,
    covered: decision.covered,
    postAge,
    recoveryAttempted,
    recoveredJobs,
    recoveryError,
  });
}
