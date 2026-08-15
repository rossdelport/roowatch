import { dueSources, fetchPostsBatch, processSource } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";

const SOURCES_PER_TICK = 20;
const MIN_GAP_MINUTES = 5;

/**
 * One Apify run covers every due group. The run start fee is paid once instead
 * of once per group, and the date window means we only pay for posts we have
 * not already seen. The window is a little wider than the gap since the last
 * scan so a skipped tick cannot lose a post; the seen_posts table stops any
 * overlap from alerting twice.
 */
function windowFor(sources: { lastChecked: number }[]): string {
  const oldest = Math.min(...sources.map((s) => s.lastChecked || 0));
  const minutesSince = oldest ? (Date.now() - oldest) / 60000 : 60;
  const minutes = Math.ceil(Math.min(Math.max(minutesSince * 2, 15), 360));
  return `${minutes} minutes`;
}

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
  if (!due.length) return Response.json({ ok: true, ran: 0, results: [] });

  const window = windowFor(due);

  let batch: Map<string, Awaited<ReturnType<typeof fetchPostsBatch>> extends Map<string, infer P> ? P : never> | null =
    null;
  try {
    batch = await fetchPostsBatch(
      due.map((s) => s.url),
      window
    );
  } catch {
    // A failed batch falls through to per-source fetches so one bad group
    // cannot silence every other group.
    batch = null;
  }

  const results = [];
  for (const source of due) {
    const posts = batch ? batch.get(groupSlug(source.url)) ?? [] : undefined;
    results.push({
      id: source.id,
      group: source.groupName,
      ...(await processSource(source.id, posts)),
    });
  }

  return Response.json({ ok: true, ran: results.length, window, results });
}
