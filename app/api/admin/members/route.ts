import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { sendEmail } from "../../../../db/auth";
import {
  alerts,
  groups,
  loginTokens,
  profiles,
  sessions,
  users,
} from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "list" | "create" | "delete";
    email?: string;
    name?: string;
    userId?: string;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "create") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(email)) {
      return Response.json({ error: "bad_email" }, { status: 400 });
    }
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) return Response.json({ error: "exists" }, { status: 400 });

    const id = crypto.randomUUID();
    await db.insert(users).values({ id, email, name: (body.name ?? "").trim() });
    await sendEmail(
      email,
      "Your RooWatch account is ready",
      [
        "G'day,",
        "",
        "Your RooWatch account is ready.",
        "",
        "Log in here with this email address. We send you a link, no password needed:",
        "https://roowatch.com.au/dashboard",
        "",
        "Ross from RooWatch",
      ].join("\n")
    );
  }

  if (body.action === "delete" && body.userId) {
    const uid = body.userId;
    await db.delete(alerts).where(eq(alerts.userId, uid));
    await db.delete(groups).where(eq(groups.userId, uid));
    await db.delete(profiles).where(eq(profiles.userId, uid));
    await db.delete(loginTokens).where(eq(loginTokens.userId, uid));
    await db.delete(sessions).where(eq(sessions.userId, uid));
    await db.delete(users).where(eq(users.id, uid));
  }

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
      brief: profile?.brief ?? "",
      groups: allGroups
        .filter((g) => g.userId === u.id)
        .map((g) => ({ id: g.id, name: g.name, status: g.status })),
      alertCount: allAlerts.filter((a) => a.userId === u.id).length,
    };
  });

  return Response.json({ ok: true, members: rows });
}
