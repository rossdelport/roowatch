import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, isAdminEmail } from "../../../db/auth";
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
    isAdmin: isAdminEmail(user.email),
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
