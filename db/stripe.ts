/**
 * Cancel whatever this customer is paying for, so deleting an account never
 * leaves a live subscription still billing them.
 *
 * Shared by the admin delete and the member's own delete. The member's own
 * delete used to skip this and only email Ross to "check Stripe", so the card
 * kept being charged for an account that no longer existed.
 *
 * Best effort on purpose: a Stripe outage must not stop somebody's data being
 * removed. The answer says in words what happened, so the caller can pass it
 * on rather than assume it worked.
 */
export async function cancelStripe(customerId: string): Promise<string> {
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

    let failed = 0;
    for (const sub of live) {
      const res = await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
      // Counted, not assumed. "Cancelled" used to be reported whatever Stripe
      // said back.
      if (!res.ok) failed += 1;
    }
    if (failed) return `STRIPE DID NOT CANCEL ${failed} of ${live.length} subscriptions`;
    return `cancelled ${live.length} subscription${live.length > 1 ? "s" : ""}`;
  } catch {
    return "stripe unreachable";
  }
}
