import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { groups } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "add" | "remove" | "status";
    userId?: string;
    name?: string;
    groupId?: number;
    status?: string;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "add" && body.userId && body.name?.trim()) {
    await db.insert(groups).values({
      userId: body.userId,
      name: body.name.trim(),
      status: "watching",
    });
    return Response.json({ ok: true });
  }

  if (body.action === "remove" && body.groupId) {
    await db.delete(groups).where(eq(groups.id, body.groupId));
    return Response.json({ ok: true });
  }

  if (body.action === "status" && body.groupId && body.status) {
    await db
      .update(groups)
      .set({ status: body.status })
      .where(eq(groups.id, body.groupId));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "bad_request" }, { status: 400 });
}
