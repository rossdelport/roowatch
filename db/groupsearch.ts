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

export type FoundGroup = {
  name: string;
  url: string;
  slug: string;
  score: number;
  /** The name proves it is Australian, rather than merely might be. */
  auSure: boolean;
  /** The name proves it is somewhere that is definitely not Australia. */
  foreign: boolean;
};

/**
 * Where people actually ask for a tradie.
 *
 * "Buy swap sell" is first on purpose. It is an almost exclusively Australian
 * way of naming a group and it scored twenty out of twenty on locality in
 * testing, where every other phrase leaked overseas.
 */
const ANGLES = [
  "buy swap sell",
  "community noticeboard",
  "locals community group",
  "residents group",
  "community chat",
  "recommendations wanted",
  "tradies recommendations",
  "local business community",
  "mums group",
  "what's on notice board",
];

/**
 * How many searches one member is worth.
 *
 * Every query is billed, and the catalogue means a suburb is only ever
 * searched once for the whole business. The budget is spread across all their
 * suburbs rather than spent on the first one.
 */
const MAX_QUERIES = 24;

/** Places that are not here. Seen in real results, not guessed at. */
const NOT_HERE = new RegExp(
  "\\b(" +
    [
      "michigan|texas|ohio|florida|california|virginia|carolina|tennessee",
      "missouri|kansas|nebraska|idaho|utah|oregon|arizona|nevada|iowa|indiana",
      "illinois|georgia|alabama|arkansas|wyoming|montana|vermont|maine|dakota",
      "kentucky|minnesota|wisconsin|oklahoma|louisiana|mississippi|connecticut",
      "massachusetts|maryland|delaware|pennsylvania|jersey|hampshire|henrico",
      "middle river|\\bmd\\b|\\bmi\\b|\\bva\\b|\\bmn\\b|\\bmo\\b|\\bky\\b|\\boh\\b|\\bnj\\b",
      "ontario|alberta|manitoba|saskatchewan|winnipeg|toronto|vancouver|calgary",
      "british columbia|nova scotia|quebec|aldergrove|langley",
      "yorkshire|lancashire|devon|essex|surrey|scotland|ireland|wales",
      "london|manchester|twickenham|catterick|teesdale|tyneside|wicklow|emlyn",
      "cornwall|somerset|dorset|norfolk|suffolk|cheshire|durham|northumberland",
      "tasman|motueka|new zealand|christchurch|auckland|dunedin",
    ].join("|") +
    ")\\b",
  "i"
);

/**
 * Something that proves this group really is in Australia.
 *
 * Suburb names repeat all over the English speaking world. Richmond alone
 * returned British Columbia, Virginia, Michigan, North Yorkshire, Vermont and
 * a town in New Zealand. Only two results out of thirty nine were the Richmond
 * in Victoria, and both said so with a postcode.
 */
const AU_SIGNAL =
  /\b(nsw|vic|qld|wa|sa|tas|nt|act|australia|aussie|\d{4}|shire|council|hunter|gippsland|riverina|illawarra)\b/i;

/** A group about something else entirely. Nobody there is after a plumber. */
const NOT_FOR_US =
  /\b(football|footy|soccer|cricket|netball|basketball|gamer|gaming|guild|musician|band|anime|crypto|forex|church|bible|dating|singles|fishing|4wd|motorbike|caravan|knitting|scrapbook|school|meetup)\b/i;

/** Words that mean it is exactly the sort of place a job gets asked for. */
const GOOD =
  /\b(community|noticeboard|notice board|buy.?swap.?sell|bss|locals?|residents?|tradie|trades|services|recommend|help|info|news|marketplace|garage sale)\b/i;

/** Titles come back with the site name bolted on. */
function tidyName(raw: string): string {
  return String(raw ?? "")
    .replace(/\s*[|\-–]\s*Facebook.*$/i, "")
    .replace(/^Facebook\s*[|\-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
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
    if (NOT_FOR_US.test(name)) continue;
    out.push({
      name,
      url: `https://www.facebook.com/groups/${slug}`,
      slug,
      score: GOOD.test(name) ? 1 : 0,
      auSure: AU_SIGNAL.test(name),
      foreign: NOT_HERE.test(name),
    });
  }
  return out;
}

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

/**
 * Does this name prove the group is Australian?
 *
 * Exported because the catalogue applies the same test. Rows filed before
 * these rules existed must not keep being handed out.
 */
export function looksAustralian(name: string): boolean {
  return AU_SIGNAL.test(name) && !NOT_HERE.test(name);
}

/** True when a search key is configured, so callers can fall back quietly. */
export function searchConfigured(): boolean {
  return Boolean(
    process.env.BRAVE_SEARCH_KEY ||
      (process.env.GOOGLE_SEARCH_KEY && process.env.GOOGLE_SEARCH_CX)
  );
}

/** The other states, so a Melbourne tradie is not offered a Perth group. */
const STATE_WORDS: Record<string, RegExp> = {
  "New South Wales": /\bnsw\b/i,
  Victoria: /\bvic\b/i,
  Queensland: /\bqld\b/i,
  "Western Australia": /\bwa\b/i,
  "South Australia": /\bsa\b/i,
  Tasmania: /\btas\b/i,
  "Northern Territory": /\bnt\b/i,
  "Australian Capital Territory": /\bact\b/i,
};

/** Groups worth watching near these suburbs. */
export async function findGroups(
  suburbs: string[],
  state: string,
  want = 20
): Promise<FoundGroup[]> {
  const brave = process.env.BRAVE_SEARCH_KEY;
  const gKey = process.env.GOOGLE_SEARCH_KEY;
  const gCx = process.env.GOOGLE_SEARCH_CX;
  if (!brave && !(gKey && gCx)) return [];

  // Every suburb they gave us, not the first three. A tradie who drives to six
  // suburbs wants groups in all six.
  const places = suburbs.map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!places.length && state) places.push(state);
  if (!places.length) return [];

  // With two suburbs that is ten angles each; with ten suburbs it is the best
  // two each. Either way the bill is the same.
  const perPlace = Math.max(1, Math.floor(MAX_QUERIES / places.length));

  const jobs: { place: string; query: string }[] = [];
  for (const place of places) {
    for (const angle of ANGLES.slice(0, perPlace)) {
      // The state goes in every query. Without it "Midland" returned Midland,
      // Michigan, and country=au alone was not enough to stop it.
      jobs.push({ place, query: `site:facebook.com/groups "${place}" ${state} ${angle}`.trim() });
    }
  }

  const answered = await Promise.all(
    jobs.map((j) =>
      (brave ? braveSearch(j.query, brave) : googleSearch(j.query, gKey!, gCx!))
        .then((rows) => ({ place: j.place, rows }))
        .catch(() => ({ place: j.place, rows: [] as FoundGroup[] }))
    )
  );

  // Grouped by suburb, because how strict we can afford to be depends on the
  // suburb rather than on the search as a whole.
  const byPlace = new Map<string, FoundGroup[]>();
  for (const place of places) byPlace.set(place, []);
  for (const a of answered) byPlace.get(a.place)?.push(...a.rows);

  const wrongState = Object.entries(STATE_WORDS)
    .filter(([name]) => name !== state)
    .map(([, re]) => re);

  const seen = new Set<string>();
  const found: FoundGroup[] = [];

  for (const [, rows] of byPlace) {
    /**
     * Is this suburb name shared with somewhere overseas?
     *
     * Worked out from the answers rather than guessed at. Ellenbrook brings
     * back nothing foreign, so everything it finds can be trusted. Richmond
     * brings back British Columbia, Michigan, Yorkshire and New Zealand, so
     * nothing from Richmond is trusted unless it proves it is Australian.
     *
     * That is the difference between twenty good groups for Ellenbrook and two
     * for Richmond, which is the right answer in both cases.
     */
    const contested = rows.filter((r) => r.foreign).length >= 2;

    for (const g of rows) {
      if (seen.has(g.slug) || g.foreign) continue;
      if (contested && !g.auSure) continue;
      // A group that names a different Australian state is somebody else's
      // patch. Hawthorn is in Melbourne and Mount Hawthorn is in Perth.
      if (wrongState.some((re) => re.test(g.name))) continue;
      seen.add(g.slug);
      const local = places.some((p) => g.name.toLowerCase().includes(p.toLowerCase()));
      found.push({ ...g, score: g.score + (local ? 2 : 0) + (g.auSure ? 3 : 0) });
    }
  }

  return found.sort((a, b) => b.score - a.score).slice(0, want);
}
