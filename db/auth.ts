import { eq } from "drizzle-orm";
import { getDb } from "./index";
import { sessions, users } from "./schema";

export const SESSION_COOKIE = "roo_session";
/**
 * Holds Ross's own session token while he is signed in as a member.
 * Same protections as a normal session cookie, because that is exactly what
 * it is: swapping it back in is how he returns to his own account.
 */
export const ADMIN_RETURN_COOKIE = "roo_admin_return";
const SESSION_DAYS = 60;

export function sessionCookie(token: string) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function returnCookie(token: string) {
  const maxAge = 12 * 60 * 60; // long enough for a support session, not forever
  return `${ADMIN_RETURN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedReturnCookie() {
  return `${ADMIN_RETURN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function createSession(userId: string) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await getDb().insert(sessions).values({ token, userId, expiresAt });
  return token;
}

export async function currentUser(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const db = getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .limit(1);
  if (!session || session.expiresAt < Date.now()) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  return user ?? null;
}

export async function endSession(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await getDb().delete(sessions).where(eq(sessions.token, token));
  }
}

/** Ross, on either of the addresses he actually logs in with. */
const ADMIN_EMAILS = new Set(["ross@roowatch.com.au", "rossdelport1998@gmail.com"]);

export function isAdminEmail(email: string) {
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export async function sendEmail(
  to: string | string[],
  subject: string,
  text: string
) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "RooWatch <notify@trynoisy.com>",
      reply_to: "ross@roowatch.com.au",
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
    }),
  });
  return res.ok;
}
