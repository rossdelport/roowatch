import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { waitlist } from "../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(email) || email.length > 200) {
    return Response.json({ ok: false, error: "bad_email" }, { status: 400 });
  }

  const db = getDb();
  const existing = await db
    .select({ id: waitlist.id })
    .from(waitlist)
    .where(eq(waitlist.email, email))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(waitlist).values({ email });

    const key = process.env.RESEND_API_KEY;
    if (key) {
      const send = (payload: unknown) =>
        fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }).catch(() => null);

      await Promise.all([
        send({
          from: "RooWatch <notify@trynoisy.com>",
          to: ["ross@roowatch.com.au"],
          subject: `New waitlist signup: ${email}`,
          text: [
            "G'day Ross,",
            "",
            `${email} just joined the RooWatch waitlist.`,
            "",
            "Reply to them from ross@roowatch.com.au while it is warm.",
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
            "G'day,",
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
  }

  return Response.json({ ok: true });
}
