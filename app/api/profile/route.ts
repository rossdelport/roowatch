import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser } from "../../../db/auth";
import { users } from "../../../db/schema";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    avatar?: string;
  };

  const patch: { name?: string; avatar?: string } = {};
  if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 80);
  if (typeof body.avatar === "string") {
    if (body.avatar.length > 400_000) {
      return Response.json({ error: "image_too_big" }, { status: 400 });
    }
    patch.avatar = body.avatar;
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing_to_update" }, { status: 400 });
  }

  await getDb().update(users).set(patch).where(eq(users.id, user.id));
  return Response.json({ ok: true });
}
