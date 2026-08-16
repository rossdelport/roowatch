import { dueSources, fetchPostsBatch, processSource } from "../../../../db/pipeline";
import { groupSlug } from "../../../../db/fbgroups";

/**
 * How many groups we will read in one 5 minute tick. This is the dial that
 * decides how many customers we can serve at full speed. Going over it does
 * not lose posts, it only makes them late, because the window below stretches
 * to cover the real gap.
 */
const SOURCES_PER_TICK = 120;
/**
 * Groups per Apify run. One run reading 120 groups would not finish inside the
 * tick, so we split the work and start every run at the same time. 120 groups
 * take the same wall clock time as 25.
 *
 * Cost note: Apify charges a fee to start each run, so this is also a money
 * dial. Runs per tick is ceil(due groups / this number), which means a quiet
 * account with 4 groups still pays for exactly one run.
 */
const GROUPS_PER_RUN = 25;
const MIN_GAP_MINUTES = 5;
const BUFFER_MINUTES = 1;

/**
 * The date window is a little wider than the gap since the last scan so a
 * skipped tick cannot lose a post. The seen_posts table stops any overlap from
 * alerting twice.
 */
function windowFor(sources: { lastChecked: number }[]): string {
  const oldest = Math.min(...sources.map((s) => s.lastChecked || 0));
  const minutesSince = oldest ? (Date.now() - oldest) / 60000 : 60;
  // Only a small buffer over the real gap. We pay for every post the scraper
  // returns, so a wide window means paying for the same post again and again.
  // The buffer covers clock skew and posts Facebook indexes late.
  const minutes = Math.ceil(Math.min(Math.max(minutesSince + BUFFER_MINUTES, 6), 360));
  return `${minutes} minutes`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
  const batches = chunk(due, GROUPS_PER_RUN);

  // Every run starts at once. A run that fails returns null and only its own
  // groups fall back to a single fetch, so one bad batch cannot silence the
  // rest of the account.
  const fetched = await Promise.all(
    batches.map(async (part) => {
      try {
        return await fetchPostsBatch(
          part.map((s) => s.url),
          window
        );
      } catch {
        return null;
      }
    })
  );

  const results = [];
  for (let i = 0; i < batches.length; i += 1) {
    const batch = fetched[i];
    for (const source of batches[i]) {
      // An empty array means the run worked and this group had nothing new.
      // Only undefined asks processSource to fetch again, and that costs money,
      // so it must happen when the whole run failed and never by accident.
      const posts = batch ? batch.get(groupSlug(source.url)) ?? [] : undefined;
      results.push({
        id: source.id,
        group: source.groupName,
        ...(await processSource(source.id, posts)),
      });
    }
  }

  return Response.json({
    ok: true,
    ran: results.length,
    runs: batches.length,
    window,
    results,
  });
}
