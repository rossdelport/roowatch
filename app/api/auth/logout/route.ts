import { clearedCookie, endSession } from "../../../../db/auth";

export async function POST(request: Request) {
  await endSession(request);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedCookie() },
  });
}
