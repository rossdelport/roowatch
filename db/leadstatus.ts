/**
 * Where Ross has got to with a waitlist lead.
 *
 * Kept out of the components so the funnel table, any future export and the
 * API all agree on the same four words and the same four colours.
 */
export const LEAD_STATUSES = [
  { key: "new", label: "Ready to call", tone: "grey" },
  { key: "booked", label: "Booked call", tone: "amber" },
  { key: "client", label: "Client", tone: "green" },
  { key: "dead", label: "Not interested", tone: "red" },
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number]["key"];

export function isLeadStatus(value: string): value is LeadStatus {
  return LEAD_STATUSES.some((s) => s.key === value);
}

export function leadStatus(value: string | null | undefined) {
  return LEAD_STATUSES.find((s) => s.key === value) ?? LEAD_STATUSES[0];
}
