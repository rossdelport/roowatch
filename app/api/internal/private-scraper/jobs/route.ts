import {
  privateJobsForWorker,
  privateScraperAuthorised,
  PRIVATE_LOOKBACK_MINUTES,
} from "../../../../../db/private-monitoring";

export async function GET(request: Request) {
  if (!privateScraperAuthorised(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const workerId = new URL(request.url).searchParams.get("workerId") || "";
  try {
    const result = await privateJobsForWorker(workerId);
    return Response.json({
      ok: true,
      serverTimeMs: Date.now(),
      lookbackMinutes: PRIVATE_LOOKBACK_MINUTES,
      jobs: result.jobs,
      reason: result.reason || undefined,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "dispatch_failed";
    return Response.json(
      { error },
      { status: error === "bad_worker_id" ? 400 : 503 }
    );
  }
}
