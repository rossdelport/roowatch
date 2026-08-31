import { groupSlug } from "./fbgroups.ts";

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
 * Search angles for places where people actually ask for a tradie.
 *
 * These are search angles, not acceptance rules. A buy/swap/sell search can
 * still return a camera or boat group, so the name gate below is final.
 */
const ANGLES = [
  "community",
  "residents",
  "noticeboard",
  "buy swap sell",
  "locals",
  "community group",
  "recommendations",
  "local business",
  "local services",
  "neighbourhood",
];

/**
 * How many searches one member is worth.
 *
 * Every query is billed, and the catalogue means a suburb is only ever
 * searched once for the whole business. The budget is spread across all their
 * suburbs rather than spent on the first one.
 */
const MAX_QUERIES = 40;

/** Keep the member's niche in the search without making it a hard name gate. */
function tradeSearchTerm(trade: string): string {
  const low = String(trade ?? "").trim().toLowerCase();
  if (!low) return "";
  if (/landscap|garden|lawn/.test(low)) return "landscaping gardening";
  if (/air con|air-condition|hvac/.test(low)) return "air conditioning";
  if (/solar/.test(low)) return "solar";
  if (/pest/.test(low)) return "pest control";
  if (/car detailing|detail/.test(low)) return "car detailing";
  const words = low.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ");
}

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
      // Port Hawkesbury is in Nova Scotia and says so nowhere. A "Port" in
      // front of an Australian suburb name is nearly always somewhere else.
      "port hawkesbury|cape breton|newfoundland|saskatoon|mississauga",
      "yorkshire|lancashire|devon|essex|surrey|scotland|ireland|wales",
      // Doncaster is a suburb of Melbourne and a city in South Yorkshire, and
      // the English one names its county about as often as Perth names WA.
      // These are the words those pages use instead. Derby, Bristol and Hull
      // are left out on purpose: all three are also Australian places.
      "\\buk\\b|england|britain|british|sheffield|leeds|bradford|rotherham",
      "barnsley|nottingham|leicester|glasgow|edinburgh|cardiff|belfast",
      "london|manchester|twickenham|catterick|teesdale|tyneside|wicklow|emlyn",
      "cornwall|somerset|dorset|norfolk|suffolk|cheshire|durham|northumberland",
      "sutton-in-ashfield|kirkby-in-ashfield|nottinghamshire",
      "tasman|motueka|new zealand|christchurch|auckland|dunedin",
      // Kew is a suburb of Melbourne and a district of London, and there is a
      // Kew Gardens in Queens. "Queens" on its own is left out, because Queens
      // Park is a real suburb in both Perth and Sydney.
      "new york|\\bny\\b|brooklyn|manhattan|bronx|staten island",
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

/** A group about something else entirely. Nobody there is after a tradie. */
const NOT_FOR_US = new RegExp(
  "\\b(" +
    [
      // Hobbies, sport and social clubs.
      "football|footy|soccer|cricket|netball|basketball|dockers|eagles|gamer|gaming|guild",
      "musician|band|anime|crypto|forex|dating|singles|fishing|4wd|4x4|motorbike|caravan",
      "knitting|scrapbook|school|meetup|go kart|karting|automotive|swap meet|\\brfc\\b|rugby|for sale",
      "yoga|pilates|zumba|\\bgym\\b|fitness|crossfit|bootcamp|climb(ing|ers?)|hiking",
      "bushwalk|walking group|runners?|parkrun|cycl(ing|ists?)|\\bride\\b|\\bmtb\\b|\\bbmx\\b",
      "spiritual|meditation|mindfulness|psychic|tarot|astrology|reiki|wellness|social club",
      "bowling club|riding club|book club|quilt\\w*|sewing|crochet|dance|choir|theatre|museum",
      "travel|surf|skate|martial arts|boxing|boating",
      // Pets, animals and conservation.
      "\\banimal\\b|\\bpet(?:s)?\\b|\\bdog(?:s)?\\b|\\bcat(?:s)?\\b|pupp(?:y|ies)|kittens?|playgroup|homeschool",
      "rescue|rehoming|adopt(?:ion|ing)?|wildlife|livestock|horses?|equine|pon(?:y|ies)",
      "nature|conservation|environment|birding|birdwatch\\w*",
      // Goods-specific buy/sell groups, where the BSS angle is misleading.
      "camera|photograph(?:y|er)?|jewell?ery|\\blego\\b|boats?|tinn(?:y|ies)|camping",
      "\\bford\\b|\\bcars?\\b|\\btrucks?\\b|\\butes?\\b|\\b4wd\\b",
      // Food, events, fundraising and political activity.
      "food|takeaway|hotel|cafe|restaurant|coffee|bak(?:e|ing)|recipes?",
      "events?|functions?|fundrais(?:er|ing)|things to do|social calendar",
      "politics|election|protest|petition|campaign|activis[mt]",
      // Property, jobs and education.
      "realtors?|realty|real estate|property management|tiny house|holiday|tourism",
      "employment|\\bjobs?\\b|hiring|recruit\\w*|vacanc\\w*|careers?",
      "\\buni\\b|university|students?|student accommodation|backpacker|research",
      "academic|psychology|research participation|girl guiding|scouts?",
      // Faith, cultural and other non-service groups seen in the catalogue.
      "church|bible|mosque|temple|pinoy|filipino|south africans?|kiwis?|expats?",
      "creative|artists?|craft|genealogy|history|heritage|vegan|cooking|weight loss",
      "aged care|traffic|merch|support group|community support",
    ].join("|") +
    ")\\b",
  "i"
);

/**
 * Phrasing that belongs to a post rather than to a group. A group is called
 * "Joondalup Community"; a post is called "Local cat rescue or rehoming
 * services in Kelmscott".
 */
const NOT_A_NAME =
  /\b(needed|wanted|looking for|does anyone|can anyone|rehoming|rescue|appreciation for|action on|services for|help with|advice on|recommendations? for a)\b/i;

/**
 * Words that mean it is exactly the sort of place a job gets asked for.
 *
 * This is a gate now, not a bonus. It used to only add points, so "Blue
 * Mountains Yoga Community" sailed through on the word community and landed
 * in a plumber's watchlist. A group has to look like somewhere locals or
 * homeowners actually talk, and it has to survive NOT_FOR_US as well.
 */
const GOOD =
  /\b(community|noticeboard|notice board|neighbou?rhood|bss|locals?|residents?|tradie|trades|services?|recommend|help|info|news|marketplace|garage sale|local|business(?:es)?|classifieds?|area|hub|mums?|parents?)\b/i;

/** Common buy/sell word orders, including "buy, swap or sell". */
const BUY_SELL =
  /\b(?:buy[\s,\/&-]+(?:and|or|&)?[\s,\/&-]*(?:swap[\s,\/&-]+(?:and|or|&)?[\s,\/&-]*sell|sell)|sell[\s,\/&-]+(?:and|or|&)?[\s,\/&-]*swap)\b/i;

function hasGoodSignal(name: string): boolean {
  return GOOD.test(name) || BUY_SELL.test(name);
}

/** Titles come back with the site name bolted on. */
function tidyName(raw: string): string {
  return String(raw ?? "")
    .replace(/\s*[|\-–]\s*Facebook.*$/i, "")
    .replace(/^Facebook\s*[|\-–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * One deterministic name gate for every automatic group path.
 *
 * Search results, old catalogue rows and Bright Data's later group name can
 * all describe the same URL differently. Keeping this test pure and shared
 * stops an old row bypassing the rules that a fresh Brave result obeys.
 */
export function groupNameRejection(name: string): string {
  const clean = tidyName(name);
  if (!clean || clean.length < 3) return "empty_name";
  if (/^Group \d+$/i.test(clean)) return "numeric_placeholder";
  if (/^\d+[a-z]?\s/i.test(clean)) return "post_or_address";
  if (NOT_A_NAME.test(clean)) return "post_title";
  if (NOT_FOR_US.test(clean)) return "non_tradie_topic";
  if (!hasGoodSignal(clean)) return "no_local_group_signal";
  return "";
}

/** True when an automatically discovered name is safe to offer. */
export function isAcceptableGroupName(name: string, rejectForeign = false): boolean {
  return !groupNameRejection(name) && (!rejectForeign || !NOT_HERE.test(tidyName(name)));
}

/** Match a locality as a name, not as a substring of another locality. */
export function nameMentionsPlace(haystack: string, place: string): boolean {
  const q = String(place ?? "").trim();
  if (q.length < 3) return false;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Treat a hyphen as part of a compound name. This keeps ASHFIELD from
  // matching Sutton-in-Ashfield, a common Brave result for the WA suburb.
  return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`, "i").test(
    String(haystack ?? "")
  );
}

function readResults(results: { title?: string; url?: string }[]): FoundGroup[] {
  const out: FoundGroup[] = [];
  for (const r of results) {
    const url = String(r.url ?? "");
    const slug = groupSlug(url);
    if (!slug) continue;

    // Only the group's own page. A permalink's title is the post, not the
    // group, and trusting it put "Local cat rescue in Kelmscott" and "Xero
    // bookkeeping services" into a plumber's watchlist. Volume comes from
    // asking more questions, not from mining post text.
    if (/\/(posts|permalink|videos|photos)\//i.test(url)) continue;
    const name = tidyName(r.title ?? "");
    // Must look like somewhere locals talk, not merely somewhere. This is
    // deliberately shared with catalogue rows filed before the rule existed.
    if (!isAcceptableGroupName(name)) continue;
    out.push({
      name,
      url: `https://www.facebook.com/groups/${slug}`,
      slug,
      score: hasGoodSignal(name) ? 3 : 0,
      auSure: AU_SIGNAL.test(name),
      foreign: NOT_HERE.test(name),
    });
  }
  return out;
}

/**
 * One raw search, titles and blurbs only.
 *
 * Used to work out where a business is when its own website never says. A
 * trade site often has no address at all, but the directories that list it do:
 * "Brightside Solar, Solar Installer, Joondalup WA" is a Yellow Pages title.
 */
export async function searchText(
  query: string
): Promise<{ title: string; description: string }[]> {
  const key = process.env.BRAVE_SEARCH_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&country=AU&search_lang=en&ui_lang=en-AU&safesearch=strict&spellcheck=false&result_filter=web`,
      { headers: { Accept: "application/json", "X-Subscription-Token": key } }
    );
    if (!res.ok) {
      console.error("brave text", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return [];
    }
    const data = (await res.json()) as {
      web?: { results?: { title?: string; description?: string }[] };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: String(r.title ?? ""),
      description: String(r.description ?? ""),
    }));
  } catch {
    return [];
  }
}

async function braveSearch(query: string, key: string): Promise<FoundGroup[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&country=AU&search_lang=en&ui_lang=en-AU&safesearch=strict&spellcheck=false&result_filter=web&extra_snippets=true`,
    { headers: { Accept: "application/json", "X-Subscription-Token": key } }
  );
  if (!res.ok) {
    // Logged, not swallowed. This returned an empty list for a 402 "Usage
    // limit exceeded" and group discovery looked merely unlucky for hours,
    // while the real answer was that the month's search credit had run out.
    console.error("brave search", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return [];
  }
  const data = (await res.json()) as { web?: { results?: { title?: string; url?: string }[] } };
  return readResults(data.web?.results ?? []);
}

/** Google's Programmable Search, for anyone already inside Google Cloud. */
async function googleSearch(query: string, key: string, cx: string): Promise<FoundGroup[]> {
  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&q=${encodeURIComponent(query)}`
  );
  if (!res.ok) {
    console.error("google search", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return [];
  }
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

/**
 * Does this name prove the group is somewhere else?
 *
 * The weaker half of the test above, for use where the row is already pinned
 * to a state. Demanding positive proof there as well threw away real groups:
 * "Templestowe Business And Community" names no state and no postcode, and it
 * is still plainly in Victoria.
 */
export function looksForeign(name: string): boolean {
  return NOT_HERE.test(name);
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
  "New South Wales": /\b(nsw|new south wales)\b/i,
  Victoria: /\b(vic|victoria)\b/i,
  Queensland: /\b(qld|queensland)\b/i,
  "Western Australia": /\b(wa|western australia)\b/i,
  "South Australia": /\b(sa|south australia)\b/i,
  // The full name matters here: there is a Perth in Tasmania, and \btas\b
  // never matched "Tasmania".
  Tasmania: /\b(tas|tasmania)\b/i,
  "Northern Territory": /\b(nt|northern territory)\b/i,
  "Australian Capital Territory": /\b(act|australian capital territory)\b/i,
};

/** Groups worth watching near these suburbs. */
export async function findGroups(
  suburbs: string[],
  state: string,
  want = 20,
  /** Postcode for each of their suburbs, uppercased key. */
  postcodeOf: Map<string, string> = new Map(),
  /** Every postcode in their state, for spotting somebody else's patch. */
  statePostcodes: Set<string> = new Set(),
  /** Optional niche used to improve ranking, never to admit a bad group. */
  trade = ""
): Promise<FoundGroup[]> {
  const brave = process.env.BRAVE_SEARCH_KEY;
  const gKey = process.env.GOOGLE_SEARCH_KEY;
  const gCx = process.env.GOOGLE_SEARCH_CX;
  if (!brave && !(gKey && gCx)) return [];
  if (!STATE_WORDS[state]) {
    console.error("group_search_state_rejected", state);
    return [];
  }

  // Every suburb they gave us, not the first three. A tradie who drives to six
  // suburbs wants groups in all six.
  const places = suburbs.map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!places.length && state) places.push(state);
  if (!places.length) return [];

  // With two suburbs that is ten angles each; with ten suburbs it is the best
  // two each. Either way the bill is the same.
  const perPlace = Math.max(1, Math.floor(MAX_QUERIES / places.length));

  const niche = tradeSearchTerm(trade);
  // A niche-specific search finds trade recommendation groups that a generic
  // "community" query misses. Generic angles stay in the pool because the
  // best local group is usually a broad neighbourhood page, not a trade club.
  const angles = niche
    ? [`${niche} recommendations`, `${niche} local services`, ...ANGLES]
    : ANGLES;

  const jobs: { place: string; query: string }[] = [];
  for (const place of places) {
    for (const angle of angles.slice(0, perPlace)) {
      // The postcode goes in when we know it. It was the single strongest
      // signal in testing: the only two genuine Richmond, Victoria results out
      // of thirty nine both carried 3121 in the name.
      const pc = postcodeOf.get(place.toUpperCase()) ?? "";
      jobs.push({
        place,
        query: `site:facebook.com/groups "${place}" ${pc || state} ${angle}`.trim(),
      });
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

  /**
   * Does this group name one of the places we searched for?
   *
   * A search for "Penrith community" happily returns "Cabarita Beach NSW
   * Community Info", which is eight hundred kilometres away. The only reason
   * it survived was that it says NSW, and proving a group is Australian is not
   * the same as proving it is theirs.
   *
   * Word boundaries on both sides, or Kew matches AISKEW.
   */
  const namesOneOfOurs = (name: string) => {
    const low = name.toLowerCase();
    return places.some((p) => {
      const q = p.trim().toLowerCase();
      if (q.length < 3) return false;
      return nameMentionsPlace(low, q);
    });
  };

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
    // Judged as a share rather than a count. Perth turned up two foreign
    // results out of two hundred and fifty five and was treated as contested,
    // which then threw away a hundred perfectly good Perth groups.
    const foreignShare = rows.length ? rows.filter((r) => r.foreign).length / rows.length : 0;
    const contested = foreignShare >= 0.15 && rows.filter((r) => r.foreign).length >= 3;

    for (const g of rows) {
      if (seen.has(g.slug) || g.foreign) continue;
      if (contested && !g.auSure) continue;
      // A group that names a different Australian state is somebody else's
      // patch. Hawthorn is in Melbourne and Mount Hawthorn is in Perth.
      if (wrongState.some((re) => re.test(g.name))) continue;
      // And a group carrying a postcode from another state is definitely not
      // theirs, whatever its name says. This is what finally separates
      // Hawthorn 3122 from Mount Hawthorn 6016.
      const stamped = g.name.match(/\b\d{4}\b/g) ?? [];
      if (
        statePostcodes.size &&
        stamped.length &&
        !stamped.some((pc) => statePostcodes.has(pc))
      ) {
        continue;
      }
      // It has to be theirs, not merely Australian.
      if (!namesOneOfOurs(g.name)) continue;

      seen.add(g.slug);
      found.push({ ...g, score: g.score + 2 + (g.auSure ? 3 : 0) });
    }
  }

  return found.sort((a, b) => b.score - a.score).slice(0, want);
}
