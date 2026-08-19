import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import {
  ADMIN_RETURN_COOKIE,
  SESSION_COOKIE,
  clearedReturnCookie,
  createSession,
  currentUser,
  isAdminEmail,
  readCookie,
  returnCookie,
  sessionCookie,
} from "../../../../db/auth";
import { sessions, users } from "../../../../db/schema";

/**
 * Sign in as a member, then come back.
 *
 * Ross needs this to set a member's groups up for them on a welcome call, and
 * to show an upsell from inside their own dashboard.
 *
 * The browser asking must already be signed in as Ross. A normal member
 * session must never hand somebody another member's account.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
  };

  const me = await currentUser(request);
  if (!me || !isAdminEmail(me.email)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const targetId = String(body.userId ?? "");
  if (!targetId || targetId === me.id) {
    return Response.json({ error: "bad_target" }, { status: 400 });
  }

  const db = getDb();
  const [target] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) return Response.json({ error: "no_such_user" }, { status: 404 });

  const mine = readCookie(request, SESSION_COOKIE) ?? "";
  const asThem = await createSession(target.id);

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(asThem));
  // Keep Ross's own token so the trip back needs no password.
  if (mine) headers.append("Set-Cookie", returnCookie(mine));
  return Response.json({ ok: true, email: target.email }, { headers });
}

/** Swap Ross's own session back in and drop the member one. */
export async function DELETE(request: Request) {
  const back = readCookie(request, ADMIN_RETURN_COOKIE);
  if (!back) return Response.json({ error: "not_impersonating" }, { status: 400 });

  const db = getDb();
  const [row] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.token, back))
    .limit(1);

  if (!row || row.expiresAt < Date.now()) {
    return Response.json({ error: "return_session_gone" }, { status: 400 });
  }
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  // The stored token must belong to an admin. Otherwise a member who somehow
  // set this cookie could climb into someone else's account with it.
  if (!owner || !isAdminEmail(owner.email)) {
    return Response.json({ error: "not_admin" }, { status: 403 });
  }

  const current = readCookie(request, SESSION_COOKIE);
  if (current && current !== back) {
    await db.delete(sessions).where(eq(sessions.token, current));
  }

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(back));
  headers.append("Set-Cookie", clearedReturnCookie());
  return Response.json({ ok: true }, { headers });
}
