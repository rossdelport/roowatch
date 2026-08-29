import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { profiles, users } from "../../../../db/schema";
import { resolvePlaces } from "../../../../db/gazetteer";
import { searchText } from "../../../../db/groupsearch";
import { TRADES } from "../../../../db/trades";
import { nameFromMapsUrl, normaliseUrl, readSite } from "../../../../db/website";

/**
 * Step one of setup. Reads the member's website and, when a Google key is set,
 * their Google listing. Returns a trade and a suburb list to prefill the next
 * two steps. Everything here is a suggestion. The member can change all of it.
 */

type Scan = {
  businessName: string;
  trade: string;
  state: string;
  suburbs: string[];
  services: string;
  logo: string;
  websiteRead: boolean;
  googleRead: boolean;
  note: string;
};

/** Cheap keyword pass, used when Claude is unavailable or unsure. */
function tradeFromText(text: string): string {
  const low = text.toLowerCase();
  const hints: [string, string][] = [
    ["electric", "Electrician"], ["plumb", "Plumber"], ["carpent", "Carpenter"],
    ["roof", "Roofer"], ["paint", "Painter"], ["landscap", "Landscaper or gardener"],
    ["garden", "Landscaper or gardener"], ["lawn", "Landscaper or gardener"],
    ["tiling", "Tiler"], ["tiler", "Tiler"], ["plaster", "Plasterer"],
    ["gas fit", "Gas fitter"], ["air con", "Air con installer"],
    ["split system", "Air con installer"], ["locksmith", "Locksmith"],
    ["handyman", "Handyman"], ["pest", "Pest control"], ["gutter", "Gutter cleaner"],
    ["solar", "Solar install or clean"], ["concret", "Concreter"],
    ["fencing", "Fencing"], ["remov", "Removalist"], ["pool", "Pool care"],
    ["detail", "Car detailing"], ["clean", "Cleaner"], ["build", "Builder"],
  ];
  return hints.find(([k]) => low.includes(k))?.[1] ?? "";
}

/** Google Places, only when a key is configured. Gives the trade and one suburb. */
async function readGoogle(
  gbpUrl: string
): Promise<{ name: string; trade: string; suburb: string } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const name = nameFromMapsUrl(gbpUrl);
  if (!key || !name) return null;

  try {
    const search = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.primaryTypeDisplayName,places.addressComponents",
      },
      body: JSON.stringify({ textQuery: name, maxResultCount: 1 }),
      signal: AbortSignal.timeout(6000),
    });
    if (!search.ok) return null;

    const data = (await search.json()) as {
      places?: {
        displayName?: { text?: string };
        primaryTypeDisplayName?: { text?: string };
        addressComponents?: { longText?: string; types?: string[] }[];
      }[];
    };
    const place = data.places?.[0];
    if (!place) return null;

    const suburb =
      place.addressComponents?.find((c) => c.types?.includes("locality"))?.longText ?? "";
    return {
      name: place.displayName?.text ?? name,
      trade: tradeFromText(place.primaryTypeDisplayName?.text ?? ""),
      suburb,
    };
  } catch {
    return null;
  }
}

/** Claude reads the page and pulls out the trade, the suburbs and the services. */
async function readWithClaude(
  text: string
): Promise<{
  trade: string;
  suburbs: string[];
  services: string;
  businessName: string;
  baseSuburb: string;
} | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !text) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `Read this Australian trade business website and pull out the facts.

Website text: "${text}"

Reply with only JSON in this shape:
{"businessName":"","trade":"","services":"","suburbs":[],"baseSuburb":""}

trade must be exactly one of these, or "" if you cannot tell:
${TRADES.join(", ")}

services: one short plain sentence about the jobs they do.
suburbs: Australian suburbs or towns they say they serve. Up to 20. Use [] if none are named. Do not guess. Do not include states or countries.
baseSuburb: the one suburb or town the business itself is in, from an address, a footer, or a contact page. "" if it is not on the page. Do not guess.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      trade: String(parsed.trade ?? "").trim(),
      services: String(parsed.services ?? "").trim().slice(0, 400),
      businessName: String(parsed.businessName ?? "").trim().slice(0, 120),
      baseSuburb: String(parsed.baseSuburb ?? "").trim().slice(0, 80),
      suburbs: Array.isArray(parsed.suburbs)
        ? parsed.suburbs.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 20)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Where is this business, according to the rest of the web?
 *
 * A trade website is often three pages and a phone number, with no address and
 * no service areas anywhere on it. The directories that list the same business
 * are far more consistent: a Yellow Pages, hipages or Oneflare result almost
 * always carries the suburb in its title. So when the site itself says nothing
 * we read what everyone else says about it.
 *
 * Two searches and one cheap Haiku call, and only for the member who would
 * otherwise have had to type their whole patch in by hand.
 */
async function placesFromWeb(businessName: string, trade: string): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !businessName) return [];

  const hits = (
    await Promise.all([
      searchText(`"${businessName}" ${trade} australia`),
      searchText(`"${businessName}" contact address suburb`),
    ])
  ).flat();
  if (!hits.length) return [];

  const text = hits
    .map((r) => `${r.title} ${r.description}`)
    .join("\n")
    .slice(0, 6000);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `These are search results about an Australian business called "${businessName}".

${text}

Which Australian suburbs or towns is this business in or working in?

Reply with only JSON: {"suburbs":[]}

Up to 8. Names only, no states, no postcodes, no countries. Use [] if the
results are about a different business or name no place. Do not guess.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return Array.isArray(parsed.suburbs)
      ? parsed.suburbs.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    website?: string;
    gbpUrl?: string;
  };
  const website = String(body.website ?? "").trim();
  const gbpUrl = String(body.gbpUrl ?? "").trim();
  if (!normaliseUrl(website)) {
    return Response.json({ error: "bad_website" }, { status: 400 });
  }

  const [profile] = await getDb()
    .select({ trade: profiles.trade, state: profiles.state })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const state = profile?.state ?? "";

  // Both reads run at once. Neither one is allowed to hold up the other.
  const [site, google] = await Promise.all([readSite(website), readGoogle(gbpUrl)]);
  const text = site.text;
  const ai = await readWithClaude(text);

  // Their own logo becomes their picture, so the dashboard looks like theirs
  // from the first screen. Only when they have not set one, so a member who
  // uploaded a photo never has it overwritten by a later re-scan.
  if (site.logo) {
    const db = getDb();
    const [current] = await db
      .select({ avatar: users.avatar })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (current && !current.avatar) {
      await db.update(users).set({ avatar: site.logo }).where(eq(users.id, user.id));
    }
  }

  const known = (TRADES as readonly string[]).includes(ai?.trade ?? "") ? ai!.trade : "";
  const trade =
    known || google?.trade || tradeFromText(text) || profile?.trade || "";

  // Keep only real Australian places. A scraped word like "Australia" or a
  // street name must never land in their service area. The lookup runs against
  // the full gazetteer, so it also tells us which state they work in and the
  // member never has to pick one.
  const found = [
    ...(ai?.suburbs ?? []),
    ...(ai?.baseSuburb ? [ai.baseSuburb] : []),
    ...(google?.suburb ? [google.suburb] : []),
  ];
  let place = await resolvePlaces(found, state);

  // Last resort. Plenty of trade sites are three pages and a phone number and
  // never say where they work. The directories that list them do say it, so we
  // ask the web where this business is rather than send them away with nothing.
  const businessName = ai?.businessName || google?.name || nameFromMapsUrl(gbpUrl);
  if (!place.suburbs.length && businessName) {
    const web = await placesFromWeb(businessName, trade);
    if (web.length) place = await resolvePlaces(web, state);
  }
  const suburbs = place.suburbs;

  const notes: string[] = [];
  if (!text) notes.push("We could not read your website.");
  if (gbpUrl && !google) {
    notes.push(
      process.env.GOOGLE_MAPS_API_KEY
        ? "We could not find that Google listing."
        : "Google listings are not connected yet."
    );
  }

  const result: Scan = {
    businessName,
    // Only ever hand back a trade the dropdown actually holds.
    trade: (TRADES as readonly string[]).includes(trade) ? trade : "",
    state: state || place.state,
    suburbs,
    services: ai?.services ?? "",
    logo: site.logo,
    websiteRead: Boolean(text),
    googleRead: Boolean(google),
    note: notes.join(" "),
  };

  return Response.json(result);
}
