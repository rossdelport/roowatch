import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sendEmail } from "../../../../db/auth";
import { sendSms } from "../../../../db/sms";
import { health, seenPosts, sources } from "../../../../db/schema";

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

/** How long the scanner may go untouched before it counts as stopped. */
const QUIET_MINUTES = 15;
/** Do not send another warning for this long. A dead scanner is one email. */
const REMIND_HOURS = 4;

const WATCHER = "rossdelport1998@gmail.com";
const ROSS_MOBILE = "0400369865";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = Date.now();

  const active = await db.select({ id: sources.id }).from(sources).where(eq(sources.active, 1));
  // Nothing to scan is not a fault. A brand new account, or a weekend where
  // every group happens to be paused, should not wake anybody up.
  if (!active.length) return Response.json({ ok: true, skipped: "no_active_sources" });

  const [freshest] = await db
    .select({ lastChecked: sources.lastChecked })
    .from(sources)
    .where(eq(sources.active, 1))
    .orderBy(desc(sources.lastChecked))
    .limit(1);

  const quietFor = Math.round((now - Number(freshest?.lastChecked ?? 0)) / 60000);

  // Coverage, not recency.
  //
  // The first version asked only when a group was last touched, so one source
  // being checked occasionally kept it quiet while sixty three others sat
  // still and nothing was read for three hours. What matters is whether the
  // scanner is getting round everybody, not whether it managed one.
  const recent = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.active, 1), gt(sources.lastChecked, now - QUIET_MINUTES * 60 * 1000)));
  const covered = Math.round((recent.length / active.length) * 100);

  if (quietFor < QUIET_MINUTES && covered >= 50) {
    return Response.json({ ok: true, healthy: true, quietFor, covered });
  }

  const [mark] = await db.select().from(health).where(eq(health.id, "last_alarm")).limit(1);
  if (now - Number(mark?.value ?? 0) < REMIND_HOURS * 60 * 60 * 1000) {
    return Response.json({ ok: true, alarming: true, quietFor, skipped: "already_warned" });
  }

  // Written before sending. If the email throws we would rather miss one
  // warning than send one a minute for the rest of the day.
  await db
    .insert(health)
    .values({ id: "last_alarm", value: now })
    .onConflictDoUpdate({ target: health.id, set: { value: now } });

  const [lastPost] = await db
    .select({ seenAt: seenPosts.seenAt })
    .from(seenPosts)
    .orderBy(desc(seenPosts.seenAt))
    .limit(1);
  const postAge = lastPost ? Math.round((now - Number(lastPost.seenAt)) / 60000) : -1;

  const body = [
    "RooWatch has stopped scanning.",
    "",
    `Only ${covered}% of groups were checked in the last ${QUIET_MINUTES} minutes.`,
    `The most recently checked group was ${quietFor} minutes ago.`,
    postAge >= 0
      ? `The last post was read ${postAge} minutes ago.`
      : "No posts have ever been read.",
    `${active.length} groups should be being watched right now.`,
    "",
    "Some groups may miss leads while this is true.",
    "",
    "RooWatch will try to recover on its next scan. It skips old work and",
    "retries a failed collection once when it is safe.",
    "",
    "If this does not recover, check the live log with:",
    "npx wrangler tail roowatch",
  ].join("\n");

  await sendEmail(WATCHER, "RooWatch scanner has stopped", body);

  // A text as well. An email at 3am is read at 9am.
  try {
    await sendSms(
      ROSS_MOBILE,
      `RooWatch scanning has stalled. Only ${covered}% of groups checked in ${QUIET_MINUTES} min. Check your email.`
    );
  } catch {
    // The email is the alarm. A texting outage must not swallow it.
  }

  return Response.json({ ok: true, alerted: true, quietFor, covered, postAge });
}
