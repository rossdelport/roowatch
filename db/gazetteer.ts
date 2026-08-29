import { eq, sql } from "drizzle-orm";
import { getDb } from "./index";
import { postcodes } from "./schema";

/**
 * Australian places, by postcode.
 *
 * Suburb names repeat. There is a Richmond in five Australian states and more
 * of them in Canada, England, New Zealand and half a dozen American ones. A
 * postcode does not repeat, so it is the one reliable way to tell which
 * Richmond a Facebook group belongs to.
 */

const ABBR: Record<string, string> = {
  "New South Wales": "NSW",
  Victoria: "VIC",
  Queensland: "QLD",
  "Western Australia": "WA",
  "South Australia": "SA",
  Tasmania: "TAS",
  "Northern Territory": "NT",
  "Australian Capital Territory": "ACT",
};

export function stateAbbr(state: string): string {
  return ABBR[state] ?? "";
}

/** The postcode for each of a member's suburbs, in their own state. */
export async function postcodesFor(
  suburbs: string[],
  state: string
): Promise<Map<string, string>> {
  const abbr = stateAbbr(state);
  const wanted = suburbs.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!abbr || !wanted.length) return new Map();

  const rows = await getDb()
    .select({ locality: postcodes.locality, postcode: postcodes.postcode })
    .from(postcodes)
    .where(sql`${postcodes.state} = ${abbr} AND ${postcodes.locality} IN ${wanted}`);

  const out = new Map<string, string>();
  for (const r of rows) out.set(r.locality.toUpperCase(), r.postcode);
  return out;
}

/**
 * Every postcode in one state, so a group naming a postcode from somewhere
 * else can be recognised as somebody else's patch.
 */
export async function postcodesInState(state: string): Promise<Set<string>> {
  const abbr = stateAbbr(state);
  if (!abbr) return new Set();
  const rows = await getDb()
    .select({ postcode: postcodes.postcode })
    .from(postcodes)
    .where(eq(postcodes.state, abbr));
  return new Set(rows.map((r) => r.postcode));
}

const FULL: Record<string, string> = Object.fromEntries(
  Object.entries(ABBR).map(([full, abbr]) => [abbr, full])
);

/** "DEE WHY" reads back as "Dee Why". */
function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_m, lead, ch) => lead + ch.toUpperCase());
}

/**
 * Turn a list of place names scraped off a website into real suburbs, and work
 * out which state the business is in.
 *
 * This used to run against a hand written list of 489 suburbs, which threw
 * away 97 per cent of the country. A tradie in Kwinana or Wodonga got nothing
 * back and typed his whole patch in by hand.
 *
 * A suburb name is not unique. There is a Richmond in five states. So the
 * state that explains the most of the list wins, and a genuine tie hands back
 * nothing rather than guessing wrong and watching the wrong half of Australia.
 */
export async function resolvePlaces(
  names: string[],
  hint = ""
): Promise<{ suburbs: string[]; state: string }> {
  const wanted = [...new Set(names.map((n) => n.trim().toUpperCase()).filter(Boolean))].slice(0, 30);
  const empty = { suburbs: [], state: "" };
  if (!wanted.length) return empty;

  const rows = await getDb()
    .select({ locality: postcodes.locality, state: postcodes.state })
    .from(postcodes)
    .where(sql`${postcodes.locality} IN ${wanted}`);
  if (!rows.length) return empty;

  // Distinct suburbs per state, not rows: a suburb can hold several postcodes
  // and would otherwise vote more than once.
  const byState = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.state;
    if (!byState.has(key)) byState.set(key, new Set());
    byState.get(key)!.add(r.locality.toUpperCase());
  }

  let abbr = stateAbbr(hint);
  if (!abbr) {
    const ranked = [...byState.entries()].sort((a, b) => b[1].size - a[1].size);
    // A tie means we cannot tell. Better to ask than to send a Perth plumber
    // to Sydney.
    if (ranked.length > 1 && ranked[0][1].size === ranked[1][1].size) return empty;
    abbr = ranked[0][0];
  }

  const here = byState.get(abbr);
  if (!here) return empty;
  return {
    // Website order kept, because a tradie lists his home suburb first.
    suburbs: wanted.filter((w) => here.has(w)).map(titleCase).slice(0, 20),
    state: FULL[abbr] ?? "",
  };
}

/**
 * PO, DC, MC and BC are Australia Post delivery areas, not places anybody
 * lives. Nobody has ever named a community group after Tunstall Square PO.
 */
/**
 * How far out each look reaches, in postcode steps.
 *
 * Ring 0 is next door. Each one after it is the band beyond the last, so a
 * member who still cannot be filled gets fresh suburbs rather than the same
 * ones again. The last edge is the end of it: past about forty postcodes we
 * are in a different part of the state and it is not their patch any more.
 */
/**
 * Australian place names that are also somewhere else.
 *
 * Colonists named their suburbs after home, so nearly every collision is a
 * British one. Padding a search with Doncaster brought back South Yorkshire;
 * padding with Kew brought back a rugby club in London and a garden in Queens.
 * Catching those one town at a time only works until the next one.
 *
 * So we never guess with a name on this list. It is used for suburbs we chose
 * ourselves, never for suburbs a member typed: a plumber who says he works in
 * Richmond means his Richmond, and that is not in doubt.
 *
 * A name here that is not an Australian suburb simply never matches anything,
 * so the list is allowed to be generous.
 */
const SHARED_NAMES = new Set(
  [
    // London and the home counties, which is where most of them come from
    "richmond", "kew", "chelsea", "kensington", "paddington", "camden", "islington",
    "hackney", "greenwich", "woolwich", "eltham", "bromley", "beckenham", "sydenham",
    "dulwich", "lewisham", "brixton", "clapham", "balham", "tooting", "streatham",
    "battersea", "fulham", "putney", "wimbledon", "merton", "mitcham", "morden",
    "sutton", "cheam", "carshalton", "wallington", "purley", "croydon", "norwood",
    "enfield", "barnet", "harrow", "ealing", "acton", "chiswick", "hammersmith",
    "hounslow", "isleworth", "brentford", "twickenham", "surbiton", "kingston",
    "epsom", "ascot", "woking", "guildford", "dorking", "reigate", "redhill",
    "leatherhead", "esher", "caterham", "nutfield", "hampstead", "highgate",
    "marylebone", "mayfair", "pimlico", "bayswater", "maida vale", "belgravia",
    "chertsey", "staines", "windsor", "eton", "slough", "watford", "romford",
    // English towns and cities
    "doncaster", "sheffield", "leeds", "bradford", "rotherham", "barnsley",
    "nottingham", "leicester", "derby", "york", "lancaster", "durham", "carlisle",
    "preston", "blackburn", "burnley", "bolton", "wigan", "oldham", "rochdale",
    "stockport", "salford", "warrington", "chester", "crewe", "stafford",
    "coventry", "warwick", "rugby", "stratford", "worcester", "gloucester",
    "cheltenham", "bath", "bristol", "cotham", "clifton", "redland", "exeter", "plymouth", "torquay", "truro",
    "salisbury", "winchester", "southampton", "portsmouth", "brighton", "hastings",
    "eastbourne", "canterbury", "rochester", "maidstone", "dartford", "dover",
    "folkestone", "ashford", "reading", "oxford", "cambridge", "norwich",
    "ipswich", "colchester", "chelmsford", "luton", "bedford", "northampton",
    "peterborough", "lincoln", "hull", "middlesbrough", "sunderland", "gateshead",
    "newcastle", "durham", "kendal", "keswick", "harrogate", "ripon", "selby",
    "beverley", "grimsby", "scunthorpe", "mansfield", "chesterfield", "matlock",
    "buxton", "macclesfield", "congleton", "nantwich", "shrewsbury", "telford",
    "hereford", "malvern", "evesham", "banbury", "bicester", "swindon", "devizes",
    "trowbridge", "yeovil", "taunton", "bridgwater", "weymouth", "dorchester",
    "poole", "bournemouth", "christchurch", "ringwood", "romsey", "andover",
    "basingstoke", "farnham", "aldershot", "camberley", "bracknell", "maidenhead",
    "henley", "marlow", "amersham", "aylesbury", "hertford", "ware", "royston",
    "huntingdon", "ely", "newmarket", "bury", "sudbury", "braintree", "witham",
    // Scotland, Wales and Ireland
    "armadale", "balmoral", "hamilton", "paisley", "greenock", "ayr", "dumfries",
    "stirling", "perth", "dundee", "aberdeen", "inverness", "elgin", "montrose",
    "arbroath", "falkirk", "linlithgow", "bathgate", "livingston", "kilmarnock",
    "irvine", "troon", "lanark", "moffat", "melrose", "kelso", "jedburgh",
    "cardiff", "swansea", "newport", "wrexham", "bangor", "conwy", "denbigh",
    "brecon", "monmouth", "pembroke", "tenby", "carmarthen", "llanelli",
    "dublin", "cork", "limerick", "galway", "kildare", "wicklow", "wexford",
    "waterford", "kilkenny", "athlone", "belfast", "lisburn", "bangor",
    // North America and New Zealand
    "boston", "springfield", "portland", "salem", "franklin", "clinton",
    "madison", "auburn", "milton", "newton", "concord", "lexington", "georgetown",
    "arlington", "manchester", "aurora", "hudson", "troy", "rome", "athens",
    "berlin", "dover", "greenwich", "stamford", "norwalk", "danbury", "waterbury",
    "nelson", "napier", "hastings", "blenheim", "wanaka", "gisborne", "timaru",
    "oamaru", "invercargill", "whangarei", "taupo", "rotorua", "levin",
  ].map((n) => n.toLowerCase())
);

const RING_EDGES = [0, 3, 9, 18, 30, 42];

/** The last ring there is. Beyond this we stop looking and say so. */
export const MAX_RING = RING_EDGES.length - 2;

const POSTAL_ARTIFACT = /\b(PO|DC|MC|BC|LPO|CMA|CMB)$|PO BOX/i;

/**
 * Suburbs next door to the ones a member gave us.
 *
 * A tradie who lists one suburb gets one suburb's worth of searching, and one
 * suburb does not have twenty Facebook groups. A tradie in Templestowe works
 * in Bulleen and Doncaster too, he just did not think to type them.
 *
 * Nearness comes from the postcode. Australia Post allocates numbers
 * geographically inside a state, so 3106 sits between 3105 Bulleen and 3107
 * Templestowe Lower, which are its actual neighbours. This is only used to
 * widen a search, never to decide whose patch a group belongs to, so being
 * roughly right is enough.
 */
export async function nearbySuburbs(
  suburbs: string[],
  state: string,
  want: number,
  ring = 0
): Promise<string[]> {
  const abbr = stateAbbr(state);
  if (!abbr || want <= 0) return [];

  const known = await postcodesFor(suburbs, state);
  const centres = [...new Set([...known.values()].map(Number))].filter(Number.isFinite);
  if (!centres.length) return [];

  // Each ring is the band beyond the last one, so a second look never spends
  // its queries on the same suburbs a first look already covered.
  const inner = RING_EDGES[Math.min(ring, RING_EDGES.length - 1)];
  const outer = RING_EDGES[Math.min(ring + 1, RING_EDGES.length - 1)];
  if (outer <= inner) return [];

  const low = Math.min(...centres) - outer;
  const high = Math.max(...centres) + outer;

  const rows = await getDb()
    .select({ locality: postcodes.locality, postcode: postcodes.postcode })
    .from(postcodes)
    .where(
      sql`${postcodes.state} = ${abbr}
        AND CAST(${postcodes.postcode} AS INTEGER) BETWEEN ${low} AND ${high}`
    );

  const theirs = new Set(suburbs.map((s) => s.trim().toUpperCase()));

  // One name per postcode. A postcode holds a principal suburb and a handful
  // of aliases, and searching all of them spends queries to find the same
  // groups twice. The shortest name is the principal one often enough.
  const best = new Map<string, string>();
  for (const r of rows) {
    const name = r.locality.trim();
    if (!name || theirs.has(name.toUpperCase())) continue;
    if (POSTAL_ARTIFACT.test(name)) continue;
    // Never guess with a name that belongs to two countries. This is a suburb
    // we chose, not one they gave us, so there is nothing to lose by skipping
    // it and a Yorkshire noticeboard to gain by not.
    if (SHARED_NAMES.has(name.toLowerCase())) continue;
    const held = best.get(r.postcode);
    if (!held || name.length < held.length) best.set(r.postcode, name);
  }

  const distance = (pc: string) => Math.min(...centres.map((c) => Math.abs(Number(pc) - c)));
  return [...best.entries()]
    .filter(([pc]) => distance(pc) > inner && distance(pc) <= outer)
    .sort((a, b) => distance(a[0]) - distance(b[0]))
    .slice(0, want)
    .map(([, name]) => titleCase(name));
}
