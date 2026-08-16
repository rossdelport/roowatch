import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { clearedCookie, currentUser, sendEmail } from "../../../../db/auth";
import { hashPassword, passwordProblem, verifyPassword } from "../../../../db/password";
import { toE164 } from "../../../../db/sms";
import {
  alerts,
  groups,
  loginTokens,
  profiles,
  sessions,
  users,
} from "../../../../db/schema";

/** Update the member's own profile and brief. */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    businessName?: string;
    website?: string;
    services?: string;
    location?: string;
    brief?: string;
    password?: string;
    currentPassword?: string;
    smsEnabled?: boolean;
    alertPhone?: string;
  };
  const db = getDb();

  if (typeof body.password === "string") {
    const weak = passwordProblem(body.password);
    if (weak) {
      return Response.json({ error: "weak_password", message: weak }, { status: 400 });
    }
    // Someone with a password must prove they know it. Members who joined by
    // email link have none yet, so their valid session is proof enough.
    if (user.passwordHash) {
      const ok = await verifyPassword(String(body.currentPassword ?? ""), user.passwordHash);
      if (!ok) return Response.json({ error: "wrong_password" }, { status: 400 });
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.password) })
      .where(eq(users.id, user.id));
  }

  if (typeof body.name === "string") {
    await db
      .update(users)
      .set({ name: body.name.trim().slice(0, 80) })
      .where(eq(users.id, user.id));
  }

  // Texts are opt out. Email is not a choice: it is the record of the lead and
  // the thing the refund guarantee is measured against.
  if (typeof body.smsEnabled === "boolean") {
    await db
      .update(profiles)
      .set({ smsEnabled: body.smsEnabled ? 1 : 0 })
      .where(eq(profiles.userId, user.id));
  }

  // The mobile is what a text alert is sent to, so a typo means silence
  // rather than an error. Reject anything that is not a real Australian
  // number instead of storing it and wondering later.
  if (typeof body.alertPhone === "string") {
    const raw = body.alertPhone.trim();
    if (raw && !toE164(raw)) {
      return Response.json({ error: "bad_phone" }, { status: 400 });
    }
    await db
      .update(profiles)
      .set({ alertPhone: raw.slice(0, 40) })
      .where(eq(profiles.userId, user.id));
  }

  const patch: Record<string, string> = {};
  for (const key of ["businessName", "website", "services", "location", "brief"] as const) {
    if (typeof body[key] === "string") patch[key] = body[key]!.trim().slice(0, 600);
  }
  if (Object.keys(patch).length) {
    const [existing] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1);
    if (existing) {
      await db.update(profiles).set(patch).where(eq(profiles.userId, user.id));
    } else {
      await db.insert(profiles).values({ userId: user.id, ...patch });
    }
  }

  return Response.json({ ok: true });
}

/** Delete the member's account and every row they own. */
export async function DELETE(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  await db.delete(alerts).where(eq(alerts.userId, user.id));
  await db.delete(groups).where(eq(groups.userId, user.id));
  await db.delete(profiles).where(eq(profiles.userId, user.id));
  await db.delete(loginTokens).where(eq(loginTokens.userId, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  await db.delete(users).where(eq(users.id, user.id));

  await sendEmail(
    "ross@roowatch.com.au",
    `Member deleted their account: ${user.email}`,
    `${user.email} deleted their RooWatch account. Their data is gone. Check Stripe if a refund is owed.`
  );

  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedCookie() },
  });
}
