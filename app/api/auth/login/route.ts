import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createSession, sessionCookie } from "../../../../db/auth";
import { verifyPassword } from "../../../../db/password";
import { users } from "../../../../db/schema";

/** One message for every failure, so nobody can find out which emails exist. */
function rejected(error = "bad_login") {
  return Response.json({ error }, { status: 401 });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return rejected();

  const [user] = await getDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) return rejected();

  // Members Ross set up by hand have no password yet. Tell them plainly to use
  // the email link, or they would sit on a wrong password screen forever.
  if (!user.passwordHash) return rejected("no_password");

  if (!(await verifyPassword(password, user.passwordHash))) return rejected();

  const token = await createSession(user.id);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie(token) } }
  );
}
