import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sendEmail } from "../../../../db/auth";
import { loginTokens, users } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(email)) {
    return Response.json({ error: "bad_email" }, { status: 400 });
  }

  const db = getDb();
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email, name: (body.name ?? "").trim() });
    [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
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

  return Response.json({ ok: true, sent, link: sent ? undefined : link });
}
