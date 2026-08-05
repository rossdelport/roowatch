import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createSession, sessionCookie } from "../../../../db/auth";
import { loginTokens } from "../../../../db/schema";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const db = getDb();

  const [row] = await db
    .select()
    .from(loginTokens)
    .where(eq(loginTokens.token, token))
    .limit(1);

  if (!row || row.used === 1 || row.expiresAt < Date.now()) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/dashboard?error=link" },
    });
  }

  await db.update(loginTokens).set({ used: 1 }).where(eq(loginTokens.token, token));
  const session = await createSession(row.userId);

  return new Response(null, {
    status: 302,
    headers: { Location: "/dashboard", "Set-Cookie": sessionCookie(session) },
  });
}
