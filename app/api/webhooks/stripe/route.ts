import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sendEmail } from "../../../../db/auth";
import { PLANS, PLAN_KEYS, type PlanKey } from "../../../../db/plans";
import { groups, profiles, sources, users } from "../../../../db/schema";

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
      plan: known ?? PLAN_KEYS.find((key) => PLANS[key].stripePriceId === priceId),
      trialEndsAt: Number(subscription.trial_end ?? 0),
    };
  } catch {
    // Leave the plan alone rather than guess. Ross can set it by hand from the
    // Marketing tab, and the payment itself is already recorded.
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
}

type Subscription = {
  customer?: string;
  status?: string;
  trial_end?: number | null;
  items?: { data?: { price?: { id?: string } }[] };
};

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
  const fromPrice = priceId
    ? PLAN_KEYS.find((key) => PLANS[key].stripePriceId === priceId)
    : undefined;
  if (fromPrice) {
    await db.update(profiles).set({ plan: fromPrice }).where(eq(profiles.userId, row.userId));
  }

  // Follow the trial end as well. Upgrading mid trial keeps the trial running,
  // so this has to track rather than be set once at checkout.
  await db
    .update(profiles)
    .set({ trialEndsAt: Number(subscription.trial_end ?? 0) })
    .where(eq(profiles.userId, row.userId));

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
    .select({ userId: profiles.userId, email: users.email, prevStatus: profiles.subscriptionStatus })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.stripeCustomerId, customerId))
    .limit(1);
  return row;
}

async function lookupByEmail(email: string, backfillCustomerId: string) {
  const db = getDb();
  const [row] = await db
    .select({ userId: profiles.userId, email: users.email, prevStatus: profiles.subscriptionStatus })
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
