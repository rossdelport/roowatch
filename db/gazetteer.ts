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
