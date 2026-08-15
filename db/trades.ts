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

export function isKnownState(value: string) {
  return (STATES as readonly string[]).includes(value);
}
