import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { alerts, groups, profiles, users } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();
  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
  const allProfiles = await db.select().from(profiles);
  const allGroups = await db.select().from(groups);
  const allAlerts = await db.select().from(alerts);

  const rows = allUsers.map((u) => {
    const profile = allProfiles.find((p) => p.userId === u.id) ?? null;
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      onboarded: Boolean(profile?.onboardedAt),
      website: profile?.website ?? "",
      services: profile?.services ?? "",
      location: profile?.location ?? "",
      groups: allGroups
        .filter((g) => g.userId === u.id)
        .map((g) => ({ id: g.id, name: g.name, status: g.status })),
      alertCount: allAlerts.filter((a) => a.userId === u.id).length,
    };
  });

  return Response.json({ ok: true, members: rows });
}
