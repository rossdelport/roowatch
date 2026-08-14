import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { isAdminEmail, sendEmail } from "../../../../db/auth";
import { loginTokens, users } from "../../../../db/schema";

/** Has this email paid us through Stripe checkout? */
async function hasPaid(email: string) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return false;
  const res = await fetch(
    "https://api.stripe.com/v1/checkout/sessions?limit=100",
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  if (!res.ok) return false;
  const data = (await res.json()) as {
    data?: { payment_status: string; customer_details?: { email?: string | null } | null }[];
  };
  return (data.data ?? []).some(
    (s) =>
      s.payment_status === "paid" &&
      (s.customer_details?.email ?? "").toLowerCase() === email
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(email)) {
    return Response.json({ error: "bad_email" }, { status: 400 });
  }

  const db = getDb();
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Accounts exist for members Ross created, past logins, Ross himself,
  // and anyone who has paid through Stripe. Everyone else is told to reserve.
  if (!user) {
    const allowed = isAdminEmail(email) || (await hasPaid(email));
    if (!allowed) {
      return Response.json({ ok: true, found: false });
    }
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email });
    [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  }

  const token =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await db.insert(loginTokens).values({
    token,
    userId: user.id,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  const origin = new URL(request.url).origin;
  const link = `${origin}/api/auth/verify?token=${token}`;

  const sent = await sendEmail(
    email,
    "Your RooWatch login link",
    [
      "G'day,",
      "",
      "Here is your login link for RooWatch. It works once and lasts 30 minutes.",
      "",
      link,
      "",
      "If you did not ask for this, you can ignore it.",
      "",
      "Ross from RooWatch",
    ].join("\n")
  );

  // Never expose a live login token in the API response. In production the
  // token must only travel through the member's email channel. Keeping the
  // development fallback behind an explicit dev-only check preserves local
  // testing without turning a missing mail provider into an account takeover.
  return Response.json({
    ok: true,
    found: true,
    sent,
    link: !sent && process.env.NODE_ENV === "development" ? link : undefined,
  });
}
