import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { ADMIN_RETURN_COOKIE, currentUser, isAdminEmail, readCookie } from "../../../db/auth";
import { planFor } from "../../../db/plans";
import { alerts, groups, profiles } from "../../../db/schema";

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ user: null });

  const db = getDb();
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const myGroups = await db
    .select()
    .from(groups)
    .where(eq(groups.userId, user.id))
    .orderBy(groups.id);

  const myAlerts = await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, user.id))
    .orderBy(desc(alerts.id))
    .limit(50);

  return Response.json({
    user: { id: user.id, email: user.email, name: user.name },
    avatar: user.avatar || undefined,
    hasPassword: Boolean(user.passwordHash),
    isAdmin: isAdminEmail(user.email),
    impersonating: Boolean(readCookie(request, ADMIN_RETURN_COOKIE)),
    plan: planFor(profile?.plan),
    smsUsed:
      profile && profile.smsMonth === new Date().toISOString().slice(0, 7)
        ? profile.smsUsed
        : 0,
    profile: profile ?? null,
    postsUsed:
      profile && profile.usageMonth === new Date().toISOString().slice(0, 7)
        ? profile.postsUsed
        : 0,
    onboarded: Boolean(profile?.onboardedAt),
    groups: myGroups,
    alerts: myAlerts,
  });
}
