import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groups } from "../../../../db/schema";

const PLAN_LIMIT = 10;

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

    const mine = await db.select().from(groups).where(eq(groups.userId, user.id));
    if (mine.length >= PLAN_LIMIT) {
      return Response.json({ error: "plan_limit" }, { status: 400 });
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
