import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { sendEmail } from "../../../../db/auth";
import { BRIEF_MAX } from "../../../../db/brief";
import { enforcePrivatePlanLimits } from "../../../../db/private-monitoring";
import { PLANS, PLAN_KEYS, planFor, type PlanKey } from "../../../../db/plans";
import {
  alerts,
  groups,
  loginTokens,
  profiles,
  sessions,
  users,
} from "../../../../db/schema";

/** A subscription in one of these states is money this month. */
const PAYING = new Set(["active"]);
/** Not money yet, but it will be unless they cancel. */
const TRIALING = new Set(["trialing"]);

/**
 * Cancel whatever this customer is paying for, so deleting a member never
 * leaves a live subscription still billing them. Best effort on purpose: a
 * Stripe outage must not stop Ross removing someone's data.
 */
async function cancelStripe(customerId: string): Promise<string> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return "stripe not configured";
  if (!customerId) return "no stripe customer";
  try {
    const list = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=20`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!list.ok) return `stripe error ${list.status}`;

    const data = (await list.json()) as { data?: { id: string; status: string }[] };
    const live = (data.data ?? []).filter((s) => s.status !== "canceled");
    if (!live.length) return "nothing to cancel";

    for (const sub of live) {
      await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
    }
    return `cancelled ${live.length} subscription${live.length > 1 ? "s" : ""}`;
  } catch {
    return "stripe unreachable";
  }
}

type SwitchResult = { ok: boolean; detail: string; hadSubscription: boolean };

/**
 * Move the member's live Stripe subscription onto the new plan's price.
 *
 * Proration is left on Stripe's default, so an upgrade puts the difference on
 * their next invoice rather than charging the card on the spot. A member still
 * inside their trial keeps it: swapping a price does not end a trial.
 *
 * A member with no subscription is a normal case, not a failure. Ross comps
 * people and creates accounts by hand.
 */
async function switchStripePlan(customerId: string, priceId: string): Promise<SwitchResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: true, detail: "Stripe is not configured", hadSubscription: false };
  if (!customerId) return { ok: true, detail: "no Stripe customer", hadSubscription: false };

  const auth = { Authorization: `Bearer ${key}` };
  try {
    const listRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=20`,
      { headers: auth }
    );
    if (!listRes.ok) {
      return { ok: false, detail: `Stripe would not answer (${listRes.status})`, hadSubscription: true };
    }

    const list = (await listRes.json()) as {
      data?: { id: string; status: string; items?: { data?: { id: string; price?: { id?: string } }[] } }[];
    };
    const live = (list.data ?? []).find(
      (sub) => sub.status === "active" || sub.status === "trialing" || sub.status === "past_due"
    );
    if (!live) return { ok: true, detail: "no live subscription", hadSubscription: false };

    const item = live.items?.data?.[0];
    if (!item?.id) {
      return { ok: false, detail: "subscription has no line to change", hadSubscription: true };
    }
    if (item.price?.id === priceId) {
      return { ok: true, detail: "Stripe was already on that price", hadSubscription: true };
    }

    const form = new URLSearchParams({
      "items[0][id]": item.id,
      "items[0][price]": priceId,
      proration_behavior: "create_prorations",
    });
    const updateRes = await fetch(`https://api.stripe.com/v1/subscriptions/${live.id}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!updateRes.ok) {
      const detail = (await updateRes.text().catch(() => "")).slice(0, 160);
      return { ok: false, detail: `Stripe refused: ${detail}`, hadSubscription: true };
    }
    return { ok: true, detail: "Stripe subscription moved too", hadSubscription: true };
  } catch {
    return { ok: false, detail: "Stripe unreachable", hadSubscription: true };
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "list" | "create" | "delete" | "plan" | "update" | "message";
    email?: string;
    name?: string;
    userId?: string;
    plan?: string;
    businessName?: string;
    brief?: string;
    subject?: string;
    message?: string;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();
  let flash = "";

  if (body.action === "create") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(email)) {
      return Response.json({ error: "bad_email" }, { status: 400 });
    }
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) return Response.json({ error: "exists" }, { status: 400 });

    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email, name: (body.name ?? "").trim() });
    await sendEmail(
      email,
      "Your RooWatch account is ready",
      [
        "G'day,",
        "",
        "Your RooWatch account is ready.",
        "",
        "Log in here with this email address. We send you a link, no password needed:",
        "https://roowatch.com.au/dashboard",
        "",
        "Ross from RooWatch",
      ].join("\n")
    );
    flash = `Created ${email}.`;
  }

  // Move a member between plans, in RooWatch and in Stripe together.
  if (body.action === "plan" && body.userId) {
    const key = String(body.plan ?? "").toLowerCase();
    if (!(key in PLANS)) {
      return Response.json({ error: "bad_plan" }, { status: 400 });
    }
    const plan = PLANS[key as PlanKey];
    const [profile] = await db
      .select({ userId: profiles.userId, stripeCustomerId: profiles.stripeCustomerId })
      .from(profiles)
      .where(eq(profiles.userId, body.userId))
      .limit(1);

    // Billing first. If Stripe will not move, nothing moves. Otherwise a
    // member could sit on Scale limits while still being charged for Local,
    // and nothing on screen would show it.
    const switched = await switchStripePlan(profile?.stripeCustomerId ?? "", plan.stripePriceId);
    if (!switched.ok) {
      return Response.json(
        { error: "stripe_failed", message: `Nothing changed. ${switched.detail}.` },
        { status: 502 }
      );
    }

    if (profile) {
      await db
        .update(profiles)
        .set({ plan: key as PlanKey })
        .where(eq(profiles.userId, body.userId));
    } else {
      await db.insert(profiles).values({ userId: body.userId, plan: key as PlanKey });
    }
    await enforcePrivatePlanLimits();
    flash = `Moved to ${plan.name}. ${switched.detail}.`;
  }

  /** Edit the few fields worth changing by hand. Anything absent is left alone. */
  if (body.action === "update" && body.userId) {
    if (typeof body.name === "string") {
      await db
        .update(users)
        .set({ name: body.name.trim().slice(0, 80) })
        .where(eq(users.id, body.userId));
    }
    const patch: Record<string, string> = {};
    if (typeof body.businessName === "string") {
      patch.businessName = body.businessName.trim().slice(0, 120);
    }
    if (typeof body.brief === "string") patch.brief = body.brief.trim().slice(0, BRIEF_MAX);
    if (Object.keys(patch).length) {
      await db.update(profiles).set(patch).where(eq(profiles.userId, body.userId));
    }
    flash = "Saved.";
  }

  if (body.action === "message" && body.userId) {
    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    const text = (body.message ?? "").trim();
    if (!user || !text) {
      return Response.json({ error: "nothing_to_send" }, { status: 400 });
    }
    const sent = await sendEmail(
      user.email,
      (body.subject ?? "").trim() || "A note from RooWatch",
      [`G'day ${user.name || "there"},`, "", text, "", "Ross from RooWatch"].join("\n")
    );
    flash = sent ? `Emailed ${user.email}.` : "Email could not be sent.";
  }

  if (body.action === "delete" && body.userId) {
    const uid = body.userId;
    const [profile] = await db
      .select({ stripeCustomerId: profiles.stripeCustomerId })
      .from(profiles)
      .where(eq(profiles.userId, uid))
      .limit(1);

    // Stop the billing before the record of it disappears, or they keep paying
    // for an account that no longer exists.
    const stripeResult = await cancelStripe(profile?.stripeCustomerId ?? "");

    await db.delete(alerts).where(eq(alerts.userId, uid));
    await db.delete(groups).where(eq(groups.userId, uid));
    await db.delete(profiles).where(eq(profiles.userId, uid));
    await db.delete(loginTokens).where(eq(loginTokens.userId, uid));
    await db.delete(sessions).where(eq(sessions.userId, uid));
    await db.delete(users).where(eq(users.id, uid));
    flash = `Deleted. Stripe: ${stripeResult}.`;
  }

  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
  const allProfiles = await db.select().from(profiles);
  const allGroups = await db.select().from(groups);
  const allAlerts = await db.select().from(alerts);
  const month = new Date().toISOString().slice(0, 7);

  const rows = allUsers.map((u) => {
    const profile = allProfiles.find((p) => p.userId === u.id) ?? null;
    const plan = planFor(profile?.plan);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      avatar: u.avatar,
      createdAt: u.createdAt,
      onboarded: Boolean(profile?.onboardedAt),
      plan: plan.key,
      planName: plan.name,
      planGroups: plan.groups,
      planPrice: plan.priceAud,
      postsPerMonth: plan.postsPerMonth,
      postsUsed: profile && profile.usageMonth === month ? profile.postsUsed : 0,
      subscriptionStatus: profile?.subscriptionStatus ?? "",
      stripeCustomerId: profile?.stripeCustomerId ?? "",
      businessName: profile?.businessName ?? "",
      trade: profile?.trade ?? "",
      state: profile?.state ?? "",
      phone: profile?.alertPhone ?? "",
      website: profile?.website ?? "",
      services: profile?.services ?? "",
      location: profile?.location ?? "",
      brief: profile?.brief ?? "",
      groups: allGroups
        .filter((g) => g.userId === u.id)
        .map((g) => ({ id: g.id, name: g.name, status: g.status })),
      alertCount: allAlerts.filter((a) => a.userId === u.id).length,
    };
  });

  const paying = rows.filter((r) => PAYING.has(r.subscriptionStatus));
  const trialing = rows.filter((r) => TRIALING.has(r.subscriptionStatus));

  /**
   * Users and MRR by day for the last 30 days.
   *
   * Everyone counts from the day they signed up, at the plan they are on today.
   * Plan changes are not kept as history, so an upgrade looks like they were
   * always on the bigger plan. It shows the shape. It is not an accounting
   * record.
   */
  const history: { day: string; users: number; mrr: number }[] = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i -= 1) {
    const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const upto = rows.filter((r) => (r.createdAt || "").slice(0, 10) <= day);
    history.push({
      day,
      users: upto.length,
      mrr: upto
        .filter((r) => PAYING.has(r.subscriptionStatus))
        .reduce((sum, r) => sum + r.planPrice, 0),
    });
  }

  return Response.json({
    ok: true,
    flash,
    members: rows,
    stats: {
      mrr: paying.reduce((sum, r) => sum + r.planPrice, 0),
      trialMrr: trialing.reduce((sum, r) => sum + r.planPrice, 0),
      total: rows.length,
      paying: paying.length,
      trialing: trialing.length,
      onboarded: rows.filter((r) => r.onboarded).length,
      byPlan: PLAN_KEYS.map((k) => ({
        key: k,
        name: PLANS[k].name,
        count: rows.filter((r) => r.plan === k).length,
      })),
    },
    history,
  });
}
