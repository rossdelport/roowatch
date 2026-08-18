import { and, eq, lte, ne } from "drizzle-orm";
import { getDb } from "./index";
import { sendEmail } from "./auth";
import { sendClickSendSms } from "./sms";
import { privateActions, privateIncidents, profiles, users } from "./schema";

const SMS_RETRY_MS = 10 * 60 * 1000;
const EMAIL_RETRY_MS = 60 * 60 * 1000;
const EMERGENCY_REMINDER_MS = 24 * 60 * 60 * 1000;
const NO_RETRY = Number.MAX_SAFE_INTEGER;
const ROSS_EMAILS = ["ross@roowatch.com.au", "rossdelport1998@gmail.com"];

function clean(value: string, max = 500) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function alertPhone() {
  const fromSecret = process.env.PRIVATE_ALERT_PHONE || process.env.ROSS_ALERT_PHONE;
  if (fromSecret) return fromSecret;
  const [row] = await getDb()
    .select({ phone: profiles.alertPhone })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.email, "ross@roowatch.com.au"))
    .limit(1);
  return row?.phone || "";
}

export async function recordPrivateAction(input: {
  kind: string;
  message: string;
  status?: string;
  targetType?: string;
  targetId?: string | number;
}) {
  await getDb().insert(privateActions).values({
    kind: clean(input.kind, 80),
    targetType: clean(input.targetType || "system", 40),
    targetId: clean(String(input.targetId ?? ""), 120),
    message: clean(input.message, 500),
    status: clean(input.status || "ok", 40),
    createdAt: Date.now(),
  });
}

/** One incident cycle sends each channel once, with atomic retry claims. */
export async function openPrivateIncident(input: {
  fingerprint: string;
  kind: string;
  title: string;
  detail: string;
  severity?: "warning" | "emergency";
  notify?: boolean;
  targetType?: string;
  targetId?: string | number;
}) {
  const db = getDb();
  const now = Date.now();
  const fingerprint = clean(input.fingerprint, 180);
  const severity = input.severity || "emergency";

  await db
    .insert(privateIncidents)
    .values({
      fingerprint,
      severity,
      kind: clean(input.kind, 80),
      targetType: clean(input.targetType || "system", 40),
      targetId: clean(String(input.targetId ?? ""), 120),
      title: clean(input.title, 160),
      detail: clean(input.detail),
      firstSeenAt: now,
      lastSeenAt: now,
      ...(input.notify === false
        ? {
            smsState: "suppressed",
            emailState: "suppressed",
            recoveryState: "suppressed",
            recoverySmsState: "suppressed",
            recoveryEmailState: "suppressed",
            nextReminderAt: NO_RETRY,
          }
        : {}),
    })
    .onConflictDoNothing();

  let [incident] = await db
    .select()
    .from(privateIncidents)
    .where(eq(privateIncidents.fingerprint, fingerprint))
    .limit(1);
  if (!incident) return;
  const reopened = incident.status === "resolved";
  const suppressUnsent =
    input.notify === false &&
    incident.lastAlertAt === 0 &&
    incident.smsState !== "sent" &&
    incident.emailState !== "sent";
  const unsuppress =
    input.notify !== false &&
    incident.status === "open" &&
    incident.smsState === "suppressed" &&
    incident.emailState === "suppressed";
  await db
    .update(privateIncidents)
    .set({
      status: reopened ? "open" : incident.status,
      severity: unsuppress ? severity : input.severity || incident.severity,
      kind: clean(input.kind, 80),
      targetType: clean(input.targetType || incident.targetType, 40),
      targetId: clean(String(input.targetId ?? incident.targetId), 120),
      title: clean(input.title, 160),
      detail: clean(input.detail),
      lastSeenAt: now,
      occurrences: incident.occurrences + 1,
      ...(reopened
        ? {
            firstSeenAt: now,
            lastAlertAt: 0,
            nextReminderAt: input.notify === false ? NO_RETRY : 0,
            smsState: input.notify === false ? "suppressed" : "pending",
            emailState: input.notify === false ? "suppressed" : "pending",
            recoveryState: input.notify === false ? "suppressed" : "pending",
            recoverySmsState: input.notify === false ? "suppressed" : "pending",
            recoveryEmailState: input.notify === false ? "suppressed" : "pending",
            resolvedAt: 0,
          }
        : unsuppress
          ? {
              lastAlertAt: 0,
              nextReminderAt: 0,
              smsState: "pending",
              emailState: "pending",
              recoveryState: "pending",
              recoverySmsState: "pending",
              recoveryEmailState: "pending",
            }
        : suppressUnsent
          ? {
              nextReminderAt: NO_RETRY,
              smsState: "suppressed",
              emailState: "suppressed",
              recoveryState: "suppressed",
              recoverySmsState: "suppressed",
              recoveryEmailState: "suppressed",
            }
          : {}),
    })
    .where(
      unsuppress
        ? and(
            eq(privateIncidents.id, incident.id),
            eq(privateIncidents.smsState, "suppressed"),
            eq(privateIncidents.emailState, "suppressed")
          )
        : eq(privateIncidents.id, incident.id)
    );

  [incident] = await db
    .select()
    .from(privateIncidents)
    .where(eq(privateIncidents.id, incident.id))
    .limit(1);
  if (!incident) return;
  if (input.notify === false) return;
  if (incident.status === "acknowledged") return;
  const reminder =
    incident.status === "open" &&
    incident.severity === "emergency" &&
    incident.smsState === "sent" &&
    incident.emailState === "sent" &&
    incident.lastAlertAt > 0 &&
    incident.nextReminderAt <= now;
  const wantsSms = reminder || (incident.severity === "emergency" && incident.smsState !== "sent");
  const wantsEmail = reminder || incident.emailState !== "sent";
  if (!wantsSms && !wantsEmail) return;

  // This compare-and-set happens before external calls. Concurrent cron,
  // heartbeat and admin requests cannot claim the same send window.
  const [claimed] = await db
    .update(privateIncidents)
    .set({
      nextReminderAt: now + Math.min(wantsSms ? SMS_RETRY_MS : NO_RETRY, wantsEmail ? EMAIL_RETRY_MS : NO_RETRY),
      ...(!reminder && wantsSms ? { smsState: "sending" } : {}),
      ...(!reminder && wantsEmail ? { emailState: "sending" } : {}),
    })
    .where(and(eq(privateIncidents.id, incident.id), lte(privateIncidents.nextReminderAt, now)))
    .returning({ id: privateIncidents.id });
  if (!claimed) return;

  const title = clean(input.title, 130);
  const detail = clean(input.detail, 260);
  let smsState = incident.smsState;
  let emailState = incident.emailState;
  if (wantsSms) {
    const phone = await alertPhone();
    const result = phone
      ? await sendClickSendSms(
          phone,
          `${reminder ? "RooWatch reminder" : "RooWatch emergency"}: ${title}. ${detail}`.slice(0, 320)
        )
      : { ok: false, error: "alert_phone_not_configured" };
    if (!reminder) smsState = result.ok ? "sent" : clean(result.error || "send_failed", 100);
  } else if (incident.severity === "warning") {
    smsState = "not_applicable";
  }
  if (wantsEmail) {
    const sent = await sendEmail(
      ROSS_EMAILS,
      `RooWatch ${reminder ? "still down" : incident.severity}: ${title}`,
      [title, "", detail, "", "Open the Private monitoring tab for the live status."].join("\n")
    );
    if (!reminder) emailState = sent ? "sent" : "send_failed";
  }

  if (reminder) {
    await db
      .update(privateIncidents)
      .set({ lastAlertAt: now, nextReminderAt: now + EMERGENCY_REMINDER_MS })
      .where(eq(privateIncidents.id, incident.id));
    return;
  }

  const smsDone = incident.severity === "warning" || smsState === "sent";
  const emailDone = emailState === "sent";
  const retryAt = !smsDone
    ? now + SMS_RETRY_MS
    : !emailDone
      ? now + EMAIL_RETRY_MS
      : incident.severity === "emergency"
        ? now + EMERGENCY_REMINDER_MS
        : NO_RETRY;
  await db
    .update(privateIncidents)
    .set({ lastAlertAt: now, nextReminderAt: retryAt, smsState, emailState })
    .where(eq(privateIncidents.id, incident.id));
}

/** Send each recovery channel once. Failed channels remain safely retryable. */
export async function resolvePrivateIncident(fingerprint: string, detail: string) {
  const db = getDb();
  const now = Date.now();
  let [incident] = await db
    .select()
    .from(privateIncidents)
    .where(eq(privateIncidents.fingerprint, clean(fingerprint, 180)))
    .limit(1);
  if (!incident) return;
  const openingWasSuppressed =
    incident.recoveryState === "suppressed" ||
    (incident.smsState === "suppressed" && incident.emailState === "suppressed");
  const openingNeverArrived =
    incident.smsState !== "sent" && incident.emailState !== "sent";
  if (openingWasSuppressed || openingNeverArrived) {
    await db
      .update(privateIncidents)
      .set({
        status: "resolved",
        resolvedAt: now,
        lastSeenAt: now,
        recoveryState: "suppressed",
        recoverySmsState: "suppressed",
        recoveryEmailState: "suppressed",
        nextReminderAt: NO_RETRY,
      })
      .where(eq(privateIncidents.id, incident.id));
    return;
  }
  const wantsSms = incident.severity === "emergency" && incident.recoverySmsState !== "sent";
  const wantsEmail = incident.recoveryEmailState !== "sent";
  if (!wantsSms && !wantsEmail) return;

  // First healthy observation opens the recovery claim window. Later calls
  // can retry a failed channel, but a sent channel is never sent again.
  if (incident.recoveryState === "pending") {
    await db
      .update(privateIncidents)
      .set({ nextReminderAt: 0, recoveryState: "ready" })
      .where(
        and(
          eq(privateIncidents.id, incident.id),
          eq(privateIncidents.recoveryState, "pending")
        )
      );
  }
  const [claimed] = await db
    .update(privateIncidents)
    .set({
      recoveryState: "sending",
      nextReminderAt: now + Math.min(wantsSms ? SMS_RETRY_MS : NO_RETRY, wantsEmail ? EMAIL_RETRY_MS : NO_RETRY),
      ...(wantsSms ? { recoverySmsState: "sending" } : {}),
      ...(wantsEmail ? { recoveryEmailState: "sending" } : {}),
    })
    .where(
      and(
        eq(privateIncidents.id, incident.id),
        ne(privateIncidents.recoveryState, "sent"),
        lte(privateIncidents.nextReminderAt, now)
      )
    )
    .returning({ id: privateIncidents.id });
  if (!claimed) return;

  [incident] = await db
    .select()
    .from(privateIncidents)
    .where(eq(privateIncidents.id, incident.id))
    .limit(1);
  if (!incident) return;
  const recovery = clean(detail, 260);
  let smsState = incident.recoverySmsState;
  let emailState = incident.recoveryEmailState;
  if (wantsSms) {
    const phone = await alertPhone();
    const result = phone
      ? await sendClickSendSms(
          phone,
          `RooWatch recovered: ${incident.title}. ${recovery}`.slice(0, 320)
        )
      : { ok: false, error: "alert_phone_not_configured" };
    smsState = result.ok ? "sent" : clean(result.error || "send_failed", 100);
  } else if (incident.severity === "warning") {
    smsState = "not_applicable";
  }
  if (wantsEmail) {
    const sent = await sendEmail(
      ROSS_EMAILS,
      `RooWatch recovered: ${incident.title}`,
      ["Monitoring is working again.", "", recovery].join("\n")
    );
    emailState = sent ? "sent" : "send_failed";
  }

  const smsDone = incident.severity === "warning" || smsState === "sent";
  const emailDone = emailState === "sent";
  const primaryDelivered = incident.severity === "warning" ? emailDone : smsDone;
  const allDone = smsDone && emailDone;
  await db
    .update(privateIncidents)
    .set({
      status: primaryDelivered ? "resolved" : "open",
      resolvedAt: primaryDelivered ? now : 0,
      lastSeenAt: now,
      recoveryState: allDone ? "sent" : "retrying",
      recoverySmsState: smsState,
      recoveryEmailState: emailState,
      nextReminderAt: !smsDone ? now + SMS_RETRY_MS : !emailDone ? now + EMAIL_RETRY_MS : NO_RETRY,
    })
    .where(eq(privateIncidents.id, incident.id));
}
