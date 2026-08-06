import { requireAdmin } from "../../../../db/admin";
import { processSource } from "../../../../db/pipeline";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    sourceId?: number;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  if (!body.sourceId) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const summary = await processSource(body.sourceId);
  return Response.json({ ok: true, ...summary });
}
