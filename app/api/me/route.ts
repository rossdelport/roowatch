import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { ADMIN_RETURN_COOKIE, currentUser, isAdminEmail, readCookie } from "../../../db/auth";
import { planFor } from "../../../db/plans";
import { alerts, groups, profiles, sources, supportMessages } from "../../../db/schema";

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ user: null });

  const db = getDb();
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  // Left join, because a group added by name alone has no source yet and must
  // still appear in the list. Matching mirrors processSource: id when set,
  // name when not.
  const myGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      status: groups.status,
      url: sql<string>`coalesce(${sources.url}, '')`,
      // Facebook's own words when a group cannot be read, so a member is told
      // their group is private rather than left wondering why it is quiet.
      problem: sql<string>`coalesce(${sources.lastError}, '')`,
    })
    .from(groups)
    .leftJoin(
      sources,
      sql`(${groups.sourceId} = ${sources.id} OR (${groups.sourceId} IS NULL AND lower(${groups.name}) = lower(${sources.groupName})))`
    )
    .where(eq(groups.userId, user.id))
    .orderBy(groups.id);

  const myAlerts = await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, user.id))
    .orderBy(desc(alerts.id))
    .limit(50);

  // Drives the dot on the support bubble. Counting is not reading, so this
  // must never mark anything read.
  const [unread] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.userId, user.id),
        eq(supportMessages.fromAdmin, 1),
        eq(supportMessages.readByMember, 0)
      )
    )) as { n: number }[];

  return Response.json({
    user: { id: user.id, email: user.email, name: user.name },
    avatar: user.avatar || undefined,
    hasPassword: Boolean(user.passwordHash),
    isAdmin: isAdminEmail(user.email),
    supportUnread: Number(unread?.n ?? 0),
    impersonating: Boolean(readCookie(request, ADMIN_RETURN_COOKIE)),
    plan: planFor(profile?.plan),
    trialEndsAt: profile?.trialEndsAt ?? 0,
    cancelAt: profile?.cancelAt ?? 0,
    subscriptionStatus: profile?.subscriptionStatus ?? "",
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
