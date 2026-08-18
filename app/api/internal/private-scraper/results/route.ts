import {
  privateScraperAuthorised,
  savePrivateResult,
  type PrivateResultInput,
} from "../../../../../db/private-monitoring";

export async function POST(request: Request) {
  if (!privateScraperAuthorised(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 512_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 512_000) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  let body: PrivateResultInput;
  try {
    body = JSON.parse(raw) as PrivateResultInput;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  try {
    const result = await savePrivateResult(body);
    if ("processing" in result && result.processing) {
      return Response.json({ error: "result_processing" }, { status: 503 });
    }
    return Response.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : "result_failed";
    const status = error === "unknown_run"
      ? 404
      : error === "run_mismatch"
        ? 409
        : error.startsWith("bad_")
          ? 400
          : 500;
    return Response.json({ error }, { status });
  }
}
