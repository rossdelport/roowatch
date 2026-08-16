import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groupLimit } from "../../../../db/plans";
import { groups, profiles } from "../../../../db/schema";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: "add" | "remove";
    name?: string;
    groupId?: number;
  };
  const db = getDb();

  if (body.action === "add") {
    const name = (body.name ?? "").trim().slice(0, 120);
    if (!name) return Response.json({ error: "bad_name" }, { status: 400 });

    const [profile] = await db
      .select({ plan: profiles.plan })
      .from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1);
    const limit = groupLimit(profile?.plan);

    const mine = await db.select().from(groups).where(eq(groups.userId, user.id));
    if (mine.length >= limit) {
      return Response.json({ error: "plan_limit", limit }, { status: 400 });
    }
    if (mine.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return Response.json({ error: "duplicate" }, { status: 400 });
    }
    await db.insert(groups).values({ userId: user.id, name, status: "pending" });
    return Response.json({ ok: true });
  }

  if (body.action === "remove" && body.groupId) {
    await db
      .delete(groups)
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "bad_request" }, { status: 400 });
}
