import { dueSources, processSource } from "../../../../db/pipeline";

const SOURCES_PER_TICK = 3;
const MIN_GAP_MINUTES = 10;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.APIFY_TOKEN) {
    return Response.json({ ok: true, skipped: "apify_not_configured" });
  }

  const due = (await dueSources(SOURCES_PER_TICK)).filter(
    (s) => Date.now() - s.lastChecked > MIN_GAP_MINUTES * 60 * 1000
  );

  const results = [];
  for (const source of due) {
    results.push({ id: source.id, group: source.groupName, ...(await processSource(source.id)) });
  }

  return Response.json({ ok: true, ran: results.length, results });
}
