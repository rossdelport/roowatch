import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sendSms } from "../../../../db/sms";
import { sendEmail } from "../../../../db/auth";
import { PLAN_KEYS, PLANS, planForPrice, type PlanKey } from "../../../../db/plans";
import { groups, profiles, sources, users } from "../../../../db/schema";
import { sendCapi } from "../../../../db/capi";

/**
 * Stripe tells us here when a trial converts, a card fails, or someone
 * cancels. Before this route existed, none of that reached RooWatch: an
 * account stayed fully active forever regardless of what happened on the
 * Stripe side, since signup was never payment gated. See
 * docs/operations.md, Stripe section.
 */

const LAPSED = new Set(["canceled", "unpaid", "incomplete_expired"]);
const RECOVERED = new Set(["active", "trialing"]);
const SIG_TOLERANCE_SECONDS = 300;

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe's own signing scheme: HMAC-SHA256 of "timestamp.body", hex encoded. */
async function verifyStripeSignature(rawBody: string, header: string, secret: string) {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIG_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((sig) => sameString(expected, sig));
}

async function stripeApi(path: string, params?: Record<string, string>) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  if (!res.ok) throw new Error(`stripe_${res.status}`);
  return res.json();
}

/** A link the member can use to fix a failed payment themselves. Falls back
 *  to a mailto if Stripe cannot hand one back, so the email still sends. */
async function billingPortalUrl(customerId: string): Promise<string> {
  try {
    const session = (await stripeApi("billing_portal/sessions", {
      customer: customerId,
      return_url: "https://roowatch.com.au/dashboard",
    })) as { url?: string };
    return session.url || "mailto:ross@roowatch.com.au";
  } catch {
    return "mailto:ross@roowatch.com.au";
  }
}

/**
 * Stop paying to scan for this member. A group's underlying source is shared
 * with anyone else watching the same public Facebook group, so we only turn
 * the source off once nobody paying is left watching it. Leaving a source
 * running for someone else is correct, not a bug.
 */
async function pauseMember(userId: string) {
  const db = getDb();
  const paused = await db
    .update(groups)
    .set({ status: "paused" })
    .where(and(eq(groups.userId, userId), eq(groups.status, "watching")))
    .returning({ sourceId: groups.sourceId });

  const sourceIds = [...new Set(paused.map((g) => g.sourceId).filter((id): id is number => id != null))];
  for (const sourceId of sourceIds) {
    const [stillWatched] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.sourceId, sourceId), eq(groups.status, "watching")))
      .limit(1);
    if (!stillWatched) {
      await db
        .update(sources)
        .set({ active: 0, lastError: "paused_no_active_watchers" })
        .where(eq(sources.id, sourceId));
    }
  }
}

/** The mirror of pauseMember. Only touches sources we paused for this exact
 *  reason, so it never overrides a deliberate manual pause. */
async function reactivateMember(userId: string) {
  const db = getDb();
  const reactivated = await db
    .update(groups)
    .set({ status: "watching" })
    .where(and(eq(groups.userId, userId), eq(groups.status, "paused")))
    .returning({ sourceId: groups.sourceId });

  const sourceIds = [...new Set(reactivated.map((g) => g.sourceId).filter((id): id is number => id != null))];
  for (const sourceId of sourceIds) {
    await db
      .update(sources)
      .set({ active: 1, lastError: "" })
      .where(and(eq(sources.id, sourceId), eq(sources.lastError, "paused_no_active_watchers")));
  }
}

type CheckoutSession = {
  id?: string;
  mode?: string;
  customer?: string;
  subscription?: string;
  client_reference_id?: string;
  customer_email?: string;
  customer_details?: { email?: string };
  metadata?: { plan?: string };
};

/**
 * Which plan did they actually buy?
 *
 * We set `metadata.plan` on each Payment Link, but Stripe does not clearly
 * document that Payment Link metadata is copied onto the Checkout Session, and
 * no real checkout has ever run to prove it either way. If that metadata is
 * missing we would silently leave a $597 Growth customer on Local's 10 group
 * limit, with no error anywhere.
 *
 * So the price id is the real source of truth. It is on the subscription they
 * just bought and it maps exactly to one plan. Metadata is only a shortcut that
 * saves an API call when it happens to be there.
 */
async function planFromSession(
  session: CheckoutSession
): Promise<{ plan?: PlanKey; trialEndsAt: number }> {
  const fromMetadata = session.metadata?.plan;
  const known = PLAN_KEYS.includes(fromMetadata as PlanKey)
    ? (fromMetadata as PlanKey)
    : undefined;

  const subscriptionId = String(session.subscription || "");
  if (!subscriptionId) return { plan: known, trialEndsAt: 0 };

  try {
    // Fetched even when metadata already told us the plan, because this is
    // also where the trial end comes from.
    const subscription = (await stripeApi(`subscriptions/${subscriptionId}`)) as {
      trial_end?: number | null;
      items?: { data?: { price?: { id?: string } }[] };
    };
    const priceId = subscription.items?.data?.[0]?.price?.id ?? "";
    return {
      plan: known ?? planForPrice(priceId),
      trialEndsAt: Number(subscription.trial_end ?? 0),
    };
  } catch {
    // Leave the plan alone rather than guess. Ross can set it by hand from the
    // admin command centre, and the payment itself is already recorded.
    return { plan: known, trialEndsAt: 0 };
  }
}

async function handleCheckoutCompleted(session: CheckoutSession) {
  if (session.mode !== "subscription") return;
  const customerId = String(session.customer || "");
  const email = String(
    session.client_reference_id || session.customer_details?.email || session.customer_email || ""
  )
    .trim()
    .toLowerCase();
  if (!customerId || !email) return;

  const db = getDb();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) return;

  // Read before the write. Stripe retries an event whose response it never
  // received, and the handler is safe to re-run, but a welcome text is not:
  // getting it twice reads as a broken product on day one.
  const [before] = await db
    .select({
      status: profiles.subscriptionStatus,
      // Read here rather than after the write, because the write does not
      // touch them and Meta needs them to match the sale to the ad click.
      fbc: profiles.fbc,
      fbp: profiles.fbp,
      phone: profiles.alertPhone,
    })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const firstTime = !RECOVERED.has(before?.status ?? "");

  const { plan, trialEndsAt } = await planFromSession(session);

  await db
    .update(profiles)
    .set({
      stripeCustomerId: customerId,
      subscriptionStatus: trialEndsAt ? "trialing" : "active",
      trialEndsAt,
      ...(plan ? { plan } : {}),
    })
    .where(eq(profiles.userId, user.id));

  await tellRoss(user.id, email, plan);
  if (firstTime) await welcomeMember(user.id);

  // The card has actually cleared, which is the only conversion worth
  // optimising towards. The dashboard fires this too, but only for somebody
  // who comes back from Stripe with the tab still open. This route hears about
  // every one of them, including trials that convert days later.
  if (firstTime) {
    await sendCapi({
      name: "Purchase",
      eventId: `stripe-${session.id ?? customerId}`,
      email,
      phone: before?.phone || undefined,
      fbc: before?.fbc || undefined,
      fbp: before?.fbp || undefined,
      sourceUrl: "https://roowatch.com.au/dashboard",
      value: PLANS[(plan ?? "local") as PlanKey]?.priceAud,
      contentName: "RooWatch subscription",
    });
  }
}

/**
 * The first text a member ever gets from us.
 *
 * Sent from here rather than from the browser, because the celebration on
 * screen depends on somebody making it back from Stripe with the tab still
 * open. The card clearing is the real event, and this route is the only place
 * that hears about it for certain.
 *
 * Failures are swallowed. A texting outage must never fail the webhook and
 * make Stripe retry a payment we have already recorded.
 */
async function welcomeMember(userId: string) {
  try {
    const [row] = await getDb()
      .select({ phone: profiles.alertPhone })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    const phone = row?.phone?.trim();
    if (!phone) return;
    await sendSms(
      phone,
      "Welcome to RooWatch. You will now start to receive leads the minute we find them!"
    );
  } catch {
    // Never let a text failure break the webhook.
  }
}

/** Ross's mobile. Alerts about the business go here, not to a member. */
const ROSS_MOBILE = "0400369865";

/**
 * Text Ross when a card actually goes through.
 *
 * Only from checkout.session.completed, which Stripe sends once, at the
 * moment the card clears. Signing up and finishing setup deliberately send
 * nothing: he asked to hear about money, not about interest.
 *
 * Every failure is swallowed. A texting outage must never stop a customer's
 * subscription being written down.
 */
async function tellRoss(userId: string, email: string, plan?: string) {
  try {
    const db = getDb();
    const [row] = await db
      .select({ name: users.name, business: profiles.businessName, phone: profiles.alertPhone })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    const who = row?.business?.trim() || row?.name?.trim() || email;
    const p = plan ? PLANS[plan as PlanKey] : undefined;
    const money = p ? `$${p.priceAud}/mo after the trial` : "";
    const body = [
      `New RooWatch customer: ${who}`,
      p ? `${p.name} plan. ${money}` : "",
      row?.phone ? `Call ${row.phone}` : email,
    ]
      .filter(Boolean)
      .join(". ");

    await sendSms(ROSS_MOBILE, body);
  } catch {
    // Never let a text failure break the webhook.
  }
}

type Subscription = {
  customer?: string;
  status?: string;
  trial_end?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  items?: { data?: { price?: { id?: string } }[] };
};

/** "24 August", the way a person writes it. */
function whenDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-AU", {
    timeZone: "Australia/Perth",
    day: "numeric",
    month: "long",
  });
}

async function handleSubscriptionChange(subscription: Subscription) {
  const customerId = String(subscription.customer || "");
  const newStatus = String(subscription.status || "");
  if (!customerId || !newStatus) return;

  const db = getDb();
  let row = await lookupByCustomerId(customerId);

  if (!row) {
    // checkout.session.completed may not have landed yet, or landed with a
    // different email than Stripe has on file. Self heal from the customer.
    try {
      const customer = (await stripeApi(`customers/${customerId}`)) as { email?: string };
      const email = String(customer.email || "").trim().toLowerCase();
      if (email) row = await lookupByEmail(email, customerId);
    } catch {
      // no match possible, nothing more we can do with this event
    }
  }
  if (!row) return;

  // The price is the truth about which plan they are on. Following it here
  // means a plan swap made anywhere, the admin panel or the Stripe dashboard,
  // ends up on the member's profile without anyone syncing it by hand.
  const priceId = subscription.items?.data?.[0]?.price?.id ?? "";
  const fromPrice = planForPrice(priceId);
  if (fromPrice) {
    await db.update(profiles).set({ plan: fromPrice }).where(eq(profiles.userId, row.userId));
  }

  // Follow the trial end as well. Upgrading mid trial keeps the trial running,
  // so this has to track rather than be set once at checkout.
  //
  // cancel_at is the date a scheduled cancellation lands. Cancelling in the
  // portal takes effect at the end of the period they paid for, so the status
  // stays trialing or active and nothing else here would notice.
  const cancelAt = Number(
    subscription.cancel_at ??
      (subscription.cancel_at_period_end ? subscription.current_period_end ?? 0 : 0) ??
      0
  );
  await db
    .update(profiles)
    .set({ trialEndsAt: Number(subscription.trial_end ?? 0), cancelAt })
    .where(eq(profiles.userId, row.userId));

  // Only on the tick where it is newly scheduled, or Stripe's other updates
  // would email them the same goodbye over and over.
  if (cancelAt && !row.prevCancelAt) {
    await sendEmail(
      row.email,
      "Your RooWatch subscription is cancelled",
      [
        `G'day ${row.name || "there"},`,
        "",
        "Sorry to see you go.",
        "",
        `Your subscription is cancelled and will end on ${whenDate(cancelAt)}.`,
        "You keep every lead and keep getting new ones right up until then. Nothing else changes.",
        "",
        "Changed your mind? You can turn it back on any time before that date from Settings in your dashboard.",
        "",
        "If we got something wrong, hit reply and tell me. I read every one.",
        "",
        "Ross from RooWatch",
      ].join("\n")
    );
    await sendEmail(
      ["ross@roowatch.com.au", "rossdelport1998@gmail.com"],
      `Cancellation: ${row.email}`,
      `${row.email} cancelled. Their access ends ${whenDate(cancelAt)}. Worth a call before then.`
    );
  }

  const wasLapsed = LAPSED.has(row.prevStatus);
  const nowLapsed = LAPSED.has(newStatus);
  const nowRecovered = RECOVERED.has(newStatus);

  // Side effects happen before the status write, not after. If a step below
  // throws, Stripe retries the whole event and prevStatus still reads as the
  // old value next time, so the pause or reactivate is never silently
  // skipped by a transient error.
  if (nowLapsed && !wasLapsed) {
    await pauseMember(row.userId);
    const fixLink = await billingPortalUrl(customerId);
    const customerSent = await sendEmail(
      row.email,
      "Payment failed, your RooWatch groups are paused",
      [
        "G'day,",
        "",
        "Uh oh. Your last payment did not go through.",
        "",
        "Your groups are paused until this is fixed. You will not get leads while paused.",
        "",
        `Fix it here: ${fixLink}`,
        "",
        "We start watching your groups again the moment it goes through.",
        "",
        "Ross from RooWatch",
      ].join("\n")
    );
    if (!customerSent) throw new Error("customer_email_failed");

    const rossSent = await sendEmail(
      ["ross@roowatch.com.au", "rossdelport1998@gmail.com"],
      `Payment lapsed: ${row.email}`,
      `${row.email}'s subscription is now "${newStatus}". Their groups were paused automatically.`
    );
    if (!rossSent) throw new Error("ross_email_failed");
  } else if (nowRecovered && wasLapsed) {
    await reactivateMember(row.userId);
    const rossSent = await sendEmail(
      ["ross@roowatch.com.au", "rossdelport1998@gmail.com"],
      `Payment recovered: ${row.email}`,
      `${row.email}'s subscription is now "${newStatus}". Their groups were reactivated automatically.`
    );
    if (!rossSent) throw new Error("ross_email_failed");
  }

  await db.update(profiles).set({ subscriptionStatus: newStatus }).where(eq(profiles.userId, row.userId));
}

async function lookupByCustomerId(customerId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      userId: profiles.userId,
      email: users.email,
      name: users.name,
      prevStatus: profiles.subscriptionStatus,
      prevCancelAt: profiles.cancelAt,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.stripeCustomerId, customerId))
    .limit(1);
  return row;
}

async function lookupByEmail(email: string, backfillCustomerId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      userId: profiles.userId,
      email: users.email,
      name: users.name,
      prevStatus: profiles.subscriptionStatus,
      prevCancelAt: profiles.cancelAt,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(users.email, email))
    .limit(1);
  if (row) await db.update(profiles).set({ stripeCustomerId: backfillCustomerId }).where(eq(profiles.userId, row.userId));
  return row;
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook_not_configured" }, { status: 500 });

  const signatureHeader = request.headers.get("stripe-signature") || "";
  const rawBody = await request.text();

  if (!(await verifyStripeSignature(rawBody, signatureHeader, secret))) {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }

  const event = JSON.parse(rawBody) as { type: string; data: { object: unknown } };

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as CheckoutSession);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChange(event.data.object as Subscription);
        break;
    }
  } catch (err) {
    // Non-2xx makes Stripe retry with backoff. Our handlers are written to be
    // safe to re-run, so this is how a transient failure heals itself instead
    // of silently dropping the event.
    return Response.json(
      { error: "handler_failed", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }

  return Response.json({ ok: true });
}
