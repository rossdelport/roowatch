type CheckoutSession = {
  id: string;
  created: number;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  customer_details?: {
    email?: string | null;
    phone?: string | null;
    name?: string | null;
  } | null;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return Response.json({ error: "admin_not_configured" }, { status: 500 });
  }
  if (!body.password || body.password !== adminPassword) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return Response.json({ ok: true, stripe: false, rows: [] });
  }

  const res = await fetch(
    "https://api.stripe.com/v1/checkout/sessions?limit=100",
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  if (!res.ok) {
    return Response.json(
      { error: "stripe_error", detail: res.status },
      { status: 502 }
    );
  }

  const data = (await res.json()) as { data?: CheckoutSession[] };
  const rows = (data.data ?? []).map((s) => ({
    id: s.id,
    created: s.created,
    status: s.payment_status,
    amount: s.amount_total,
    currency: s.currency,
    email: s.customer_details?.email ?? null,
    phone: s.customer_details?.phone ?? null,
    name: s.customer_details?.name ?? null,
  }));

  return Response.json({ ok: true, stripe: true, rows });
}
