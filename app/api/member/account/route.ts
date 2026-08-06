import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { clearedCookie, currentUser, sendEmail } from "../../../../db/auth";
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
    website?: string;
    services?: string;
    location?: string;
    brief?: string;
  };
  const db = getDb();

  if (typeof body.name === "string") {
    await db
      .update(users)
      .set({ name: body.name.trim().slice(0, 80) })
      .where(eq(users.id, user.id));
  }

  const patch: Record<string, string> = {};
  for (const key of ["website", "services", "location", "brief"] as const) {
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
