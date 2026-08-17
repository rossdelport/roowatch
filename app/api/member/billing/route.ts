import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { profiles } from "../../../../db/schema";

/**
 * A one time link into Stripe's billing portal for this member.
 *
 * The customer id comes from their own row, never from the request, so a
 * member can only ever reach their own subscription. Stripe hosts the cancel,
 * the card change and the invoices, which means no card details and no
 * cancellation logic ever live in RooWatch.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return Response.json({ error: "stripe_not_configured" }, { status: 503 });

  const [profile] = await getDb()
    .select({ stripeCustomerId: profiles.stripeCustomerId })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const customerId = profile?.stripeCustomerId ?? "";
  if (!customerId) return Response.json({ error: "no_subscription" }, { status: 400 });

  try {
    const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: "https://roowatch.com.au/dashboard",
      }).toString(),
    });
    if (!res.ok) return Response.json({ error: "stripe_failed" }, { status: 502 });

    const session = (await res.json()) as { url?: string };
    if (!session.url) return Response.json({ error: "stripe_failed" }, { status: 502 });
    return Response.json({ ok: true, url: session.url });
  } catch {
    return Response.json({ error: "stripe_unreachable" }, { status: 502 });
  }
}
