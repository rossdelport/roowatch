import {
  privateScraperAuthorised,
  savePrivateHeartbeat,
  type HeartbeatInput,
} from "../../../../../db/private-monitoring";

export async function POST(request: Request) {
  if (!privateScraperAuthorised(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 64_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 64_000) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  let body: HeartbeatInput;
  try {
    body = JSON.parse(raw) as HeartbeatInput;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  try {
    return Response.json(await savePrivateHeartbeat(body));
  } catch (err) {
    const error = err instanceof Error ? err.message : "heartbeat_failed";
    return Response.json(
      { error },
      { status: error === "bad_worker_id" || error === "bad_heartbeat_time" ? 400 : 503 }
    );
  }
}
