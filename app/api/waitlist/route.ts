import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { waitlist } from "../../../db/schema";

function sendEmails(key: string, email: string, name: string, phone: string, trade: string) {
  const firstName = name.trim().split(/\s+/)[0] || "there";
  const send = (payload: unknown) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch(() => null);

  return Promise.all([
    send({
      from: "RooWatch <notify@trynoisy.com>",
      to: ["ross@roowatch.com.au"],
      subject: `New waitlist signup: ${name || email}`,
      text: [
        "G'day Ross,",
        "",
        "New waitlist signup on roowatch.com.au.",
        "",
        `Name: ${name || "not given"}`,
        `Phone: ${phone || "not given"}`,
        `Email: ${email}`,
        `Trade: ${trade || "not known"}`,
        "",
        "Call them while it is warm.",
        "",
        "RooWatch",
      ].join("\n"),
    }),
    send({
      from: "Ross from RooWatch <ross@trynoisy.com>",
      reply_to: "ross@roowatch.com.au",
      to: [email],
      subject: "You're on the RooWatch list",
      text: [
        `G'day ${firstName},`,
        "",
        "Your spot on the RooWatch waitlist is saved.",
        "",
        "Here is what happens next:",
        "1. We message you before your spot opens.",
        "2. We have a quick chat about your business and your suburbs.",
        "3. We set up your watchlist and the leads start coming.",
        "",
        "Got a question? Just reply to this email.",
        "",
        "Ross",
        "RooWatch",
      ].join("\n"),
    }),
  ]);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    phone?: string;
    partial?: boolean;
    trade?: string;
  };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(email) || email.length > 200) {
    return Response.json({ ok: false, error: "bad_email" }, { status: 400 });
  }

  const trade = String(body.trade ?? "").trim().slice(0, 40).replace(/[^a-zA-Z \-]/g, "");

  const db = getDb();
  const existing = await db
    .select({ id: waitlist.id, phone: waitlist.phone })
    .from(waitlist)
    .where(eq(waitlist.email, email))
    .limit(1);

  // Step 1: save the email straight away, quietly
  if (body.partial) {
    if (existing.length === 0) {
      await db.insert(waitlist).values({ email, trade });
    }
    return Response.json({ ok: true });
  }

  // Step 2: full signup
  const name = String(body.name ?? "").trim().slice(0, 120);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  const phoneDigits = phone.replace(/\D/g, "");
  if (!name || phoneDigits.length < 8) {
    return Response.json({ ok: false, error: "bad_details" }, { status: 400 });
  }

  const alreadyComplete = existing.length > 0 && existing[0].phone.length > 0;

  if (existing.length === 0) {
    await db.insert(waitlist).values({ email, name, phone, trade });
  } else if (!alreadyComplete) {
    await db
      .update(waitlist)
      .set(trade ? { name, phone, trade } : { name, phone })
      .where(eq(waitlist.email, email));
  }

  const key = process.env.RESEND_API_KEY;
  if (key && !alreadyComplete) {
    await sendEmails(key, email, name, phone, trade);
  }

  return Response.json({ ok: true });
}
