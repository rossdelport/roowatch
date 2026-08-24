import { groupSlug } from "./fbgroups";

/**
 * Finding Facebook groups for a member, without touching Facebook.
 *
 * Facebook refuses this server outright, and none of Bright Data's Facebook
 * datasets discover groups, they all need a URL you already have. But search
 * engines index group pages, so asking a search index is the one honest way to
 * find them. We read a public index; we never sign in to anything.
 *
 * Bright Data still does all the reading. This only finds candidates.
 */

export type FoundGroup = { name: string; url: string; slug: string; score: number };

/**
 * Where people actually ask for a tradie. Community boards and buy swap sell
 * groups produce leads. A group about a football club does not.
 */
const ANGLES = [
  "community noticeboard",
  "buy swap sell",
  "tradies recommendations",
  "locals community group",
];

/**
 * Words that mean a group is about something other than local life. A footy
 * supporters page or a gamers guild has members, but nobody in it is asking
 * for a plumber.
 */
const NOT_FOR_US =
  /\b(football|footy|fc|soccer|cricket|netball|basketball|gamer|gaming|guild|musician|band|anime|crypto|forex|church|bible|dating|singles|fishing|4wd|motorbike|caravan|knitting|scrapbook)\b/i;

/**
 * Places that are not here. Searching "Midland" for a Perth tradie returned
 * Midland, Michigan, and telling the search engine we want Australia is not
 * enough on its own.
 */
const NOT_HERE =
  /\b(michigan|texas|ohio|florida|california|ontario|alberta|yorkshire|lancashire|devon|essex|surrey|kent|scotland|ireland|wales|london|manchester|toronto|chicago|dakota|virginia|carolina|tennessee|missouri|kansas|nebraska|idaho|utah|oregon|arizona|nevada|iowa|indiana|illinois|georgia|alabama|arkansas|wyoming|montana|vermont|maine)\b/i;

/** Words that mean it is exactly the sort of place a job gets asked for. */
const GOOD =
  /\b(community|noticeboard|notice board|buy.?swap.?sell|bss|locals?|residents?|tradie|trades|services|recommend|help|info|news|marketplace|garage sale|what.?s on)\b/i;

/** Titles come back with the site name bolted on. */
function tidyName(raw: string): string {
  return String(raw ?? "")
    .replace(/\s*[|\-–]\s*Facebook.*$/i, "")
    .replace(/^Facebook\s*[|\-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** One search, returning whatever group links it saw. */
async function braveSearch(query: string, key: string): Promise<FoundGroup[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&country=au`,
    { headers: { Accept: "application/json", "X-Subscription-Token": key } }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { web?: { results?: { title?: string; url?: string }[] } };
  return readResults(data.web?.results ?? []);
}

/** Google's Programmable Search, for anyone already inside Google Cloud. */
async function googleSearch(query: string, key: string, cx: string): Promise<FoundGroup[]> {
  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&q=${encodeURIComponent(query)}`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: { title?: string; link?: string }[] };
  return readResults((data.items ?? []).map((i) => ({ title: i.title, url: i.link })));
}

function readResults(results: { title?: string; url?: string }[]): FoundGroup[] {
  const out: FoundGroup[] = [];
  for (const r of results) {
    const url = String(r.url ?? "");
    const slug = groupSlug(url);
    // A post inside a group is not a group. Only the group's own page counts.
    if (!slug || /\/(posts|permalink|videos|photos)\//i.test(url)) continue;
    const name = tidyName(r.title ?? "");
    if (!name || name.length < 3) continue;
    if (NOT_FOR_US.test(name) || NOT_HERE.test(name)) continue;
    out.push({
      name,
      url: `https://www.facebook.com/groups/${slug}`,
      slug,
      score: GOOD.test(name) ? 1 : 0,
    });
  }
  return out;
}

/** True when a search key is configured, so callers can fall back quietly. */
export function searchConfigured(): boolean {
  return Boolean(
    process.env.BRAVE_SEARCH_KEY ||
      (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX)
  );
}

/**
 * Groups worth watching near these suburbs.
 *
 * A handful of queries, run together, deduped by slug. Suburbs are quoted so
 * a search for Manly does not come back full of Manly Warringah football.
 */
export async function findGroups(
  suburbs: string[],
  state: string,
  want = 20
): Promise<FoundGroup[]> {
  const brave = process.env.BRAVE_SEARCH_KEY;
  const gKey = process.env.GOOGLE_SEARCH_KEY;
  const gCx = process.env.GOOGLE_SEARCH_CX;
  if (!brave && !(gKey && gCx)) return [];

  // Three suburbs is plenty. Every extra one is another billed query for a
  // steadily smaller return.
  const places = suburbs.map((s) => s.trim()).filter(Boolean).slice(0, 3);
  if (!places.length && state) places.push(state);
  if (!places.length) return [];

  const queries: string[] = [];
  for (const place of places) {
    for (const angle of ANGLES) {
      // The state is in every query. Without it "Midland" returned Midland,
      // Michigan, and "country=au" alone was not enough to stop it.
      queries.push(`site:facebook.com/groups "${place}" ${state} ${angle}`.trim());
    }
  }

  const batches = await Promise.all(
    queries.map((q) =>
      (brave ? braveSearch(q, brave) : googleSearch(q, gKey!, gCx!)).catch(() => [])
    )
  );

  const seen = new Set<string>();
  const found: FoundGroup[] = [];
  for (const batch of batches) {
    for (const g of batch) {
      if (seen.has(g.slug)) continue;
      seen.add(g.slug);
      // A suburb in the name beats a generic regional group.
      const local = places.some((p) => g.name.toLowerCase().includes(p.toLowerCase()));
      found.push({ ...g, score: g.score + (local ? 2 : 0) });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, want);
}
