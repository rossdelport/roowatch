import { currentUser } from "../../../db/auth";
import { PLANS, PLAN_KEYS, type PlanKey } from "../../../db/plans";

/**
 * Start a Stripe checkout for the plan they picked.
 *
 * Built server side rather than with a Payment Link because Payment Links
 * cannot carry a discount, and the first month is 25% of the plan price. It
 * also means the price, the trial and the coupon are all chosen here from the
 * signed in user, so none of them can be edited on the way through.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return Response.json({ error: "stripe_not_configured" }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { plan?: string };
  const wanted = String(body.plan ?? "").toLowerCase();
  const planKey: PlanKey = PLAN_KEYS.includes(wanted as PlanKey) ? (wanted as PlanKey) : "local";
  const plan = PLANS[planKey];

  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": plan.stripePriceId,
    "line_items[0][quantity]": "1",
    "subscription_data[trial_period_days]": "7",
    "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
    // Knocks the first invoice down to the intro price. Applied once, so month
    // two onward is the full amount.
    "discounts[0][coupon]": plan.stripeCouponId,
    customer_email: user.email,
    // The webhook matches the payment back to this account with it.
    client_reference_id: user.email,
    "metadata[plan]": planKey,
    "subscription_data[metadata][plan]": planKey,
    // The dashboard uses this to fire the Facebook pixel only once the card
    // has actually gone through, not at the signup form.
    success_url: "https://roowatch.com.au/dashboard?checkout=success",
    // Back to the dashboard, not the signup form. They already have an
    // account by this point, so sending them to a form that asks them to make
    // one again reads as broken. The dashboard shows them the card screen.
    cancel_url: "https://roowatch.com.au/dashboard",
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return Response.json({ error: "stripe_failed", detail }, { status: 502 });
    }
    const session = (await res.json()) as { url?: string };
    if (!session.url) return Response.json({ error: "stripe_failed" }, { status: 502 });
    return Response.json({ ok: true, url: session.url });
  } catch {
    return Response.json({ error: "stripe_unreachable" }, { status: 502 });
  }
}
