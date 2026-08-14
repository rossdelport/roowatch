import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createSession, sessionCookie } from "../../../../db/auth";
import { loginTokens } from "../../../../db/schema";

function invalidLink() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/dashboard?error=link", "Cache-Control": "no-store" },
  });
}

/** Consume a token with one conditional write, so two requests cannot both log in. */
async function consumeToken(token: string) {
  if (!token) return invalidLink();

  const [row] = await getDb()
    .update(loginTokens)
    .set({ used: 1 })
    .where(
      and(
        eq(loginTokens.token, token),
        eq(loginTokens.used, 0),
        gt(loginTokens.expiresAt, Date.now())
      )
    )
    .returning({ userId: loginTokens.userId });

  if (!row) return invalidLink();

  const session = await createSession(row.userId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": sessionCookie(session),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Email security scanners commonly follow GET links. Show a confirmation page
 * on GET and only consume the token after the member submits the form.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const [row] = await getDb()
    .select({ token: loginTokens.token })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.token, token),
        eq(loginTokens.used, 0),
        gt(loginTokens.expiresAt, Date.now())
      )
    )
    .limit(1);

  if (!row) return invalidLink();

  const safeToken = row.token.replace(/[^a-zA-Z0-9_-]/g, "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to RooWatch</title><style>body{align-items:center;background:#fff9f1;color:#172038;display:flex;font-family:Arial,sans-serif;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#fff;border:1px solid #ece5da;border-radius:18px;box-shadow:0 20px 50px rgba(23,32,56,.12);max-width:380px;padding:32px;text-align:center;width:100%}h1{font-size:24px;margin:0 0 10px}p{color:#6b7385;line-height:1.5;margin:0 0 22px}button{background:#ff6a4d;border:0;border-radius:99px;color:#fff;cursor:pointer;font-size:15px;font-weight:700;padding:13px 24px;width:100%}</style></head><body><main class="card"><h1>Continue to RooWatch</h1><p>Click below to finish signing in to your dashboard.</p><form method="post" action="/api/auth/verify"><input type="hidden" name="token" value="${safeToken}"><button type="submit">Continue to dashboard</button></form></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(request: Request) {
  let token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as { token?: string };
      token = String(body.token ?? token);
    } else {
      const form = await request.formData();
      token = String(form.get("token") ?? token);
    }
  } catch {
    return invalidLink();
  }
  return consumeToken(token);
}
