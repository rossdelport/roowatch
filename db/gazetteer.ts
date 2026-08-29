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
