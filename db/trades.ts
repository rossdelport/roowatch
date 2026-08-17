/**
 * The trades and states a member picks at signup. Kept in one place so the
 * signup form and the API always agree on what is valid.
 */

export const TRADES = [
  "Plumber",
  "Electrician",
  "Landscaper or gardener",
  "Builder",
  "Painter",
  "Handyman",
  "Air con installer",
  "Removalist",
  "Cleaner",
  "Pest control",
  "Roofer",
  "Gutter cleaner",
  "Solar install or clean",
  "Carpenter",
  "Concreter",
  "Fencing",
  "Tiler",
  "Plasterer",
  "Gas fitter",
  "Locksmith",
  "Pool care",
  "Car detailing",
] as const;

export const OTHER_TRADE = "Other";

export const STATES = [
  "New South Wales",
  "Victoria",
  "Queensland",
  "Western Australia",
  "South Australia",
  "Tasmania",
  "Australian Capital Territory",
  "Northern Territory",
] as const;

/**
 * Best match for a trade word coming from an ad landing page.
 *
 * The reserve pages say "pest controller" and "landscaper", the dropdown says
 * "Pest control" and "Landscaper or gardener". An exact compare would drop
 * both on the floor and the member would have to pick their own trade again
 * after clicking an ad that already knew it.
 */
export function matchTrade(value: string): string {
  const want = String(value ?? "").trim().toLowerCase();
  if (!want) return "";
  const list = TRADES as readonly string[];
  return (
    list.find((t) => t.toLowerCase() === want) ??
    list.find((t) => t.toLowerCase().startsWith(want)) ??
    list.find((t) => want.startsWith(t.toLowerCase())) ??
    list.find((t) => t.toLowerCase().includes(want.split(" ")[0])) ??
    ""
  );
}

export function isKnownState(value: string) {
  return (STATES as readonly string[]).includes(value);
}
