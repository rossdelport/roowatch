/**
 * The three plans, in one place.
 *
 * Every group limit in the app reads from here. The Stripe ids let us turn a
 * paid subscription into a plan without a second lookup table.
 */

export type PlanKey = "local" | "growth" | "scale";

export type Plan = {
  key: PlanKey;
  name: string;
  groups: number;
  /**
   * Fair use, and also our cost ceiling. We pay per post read, so this number
   * is the most a single member can ever cost us in a month. Do not remove it.
   * 1,000 posts costs about $1.50 USD to fetch and about $0.65 USD to read.
   */
  postsPerMonth: number;
  alertMinutes: number;
  priceAud: number;
  stripePriceId: string;
  /** Stripe Payment Link a new signup is sent to. Must have a 7 day trial
   *  configured on it in the Stripe Dashboard, card required upfront. */
  stripePaymentLink: string;
};

export const PLANS: Record<PlanKey, Plan> = {
  local: {
    key: "local",
    name: "Local",
    groups: 10,
    postsPerMonth: 10_000,
    alertMinutes: 5,
    priceAud: 297,
    stripePriceId: "price_1U4sCe9HOJbWqVToqrNBDaIp",
    stripePaymentLink: "https://buy.stripe.com/3cI9AN2Df9vYgVyg6bgUM01",
  },
  growth: {
    key: "growth",
    name: "Growth",
    groups: 25,
    postsPerMonth: 25_000,
    alertMinutes: 5,
    priceAud: 597,
    stripePriceId: "price_1U4sCg9HOJbWqVToRKrBxw6W",
    stripePaymentLink: "https://buy.stripe.com/00w5kx4LnbE6dJm6vBgUM02",
  },
  scale: {
    key: "scale",
    name: "Scale",
    groups: 100,
    postsPerMonth: 100_000,
    alertMinutes: 3,
    priceAud: 1997,
    stripePriceId: "price_1U4sCh9HOJbWqVToU4GpQFTO",
    stripePaymentLink: "https://buy.stripe.com/6oUfZb5PreQifRu4ntgUM03",
  },
};

export const DEFAULT_PLAN: PlanKey = "local";

/** Any stored value becomes a real plan. An unknown one falls back to Local. */
export function planFor(value: string | null | undefined): Plan {
  const key = String(value ?? "").trim().toLowerCase();
  return PLANS[key as PlanKey] ?? PLANS[DEFAULT_PLAN];
}

/** How many groups this member may watch. */
export function groupLimit(value: string | null | undefined): number {
  return planFor(value).groups;
}

/** How many posts we will read for this member in one month. */
export function postLimit(value: string | null | undefined): number {
  return planFor(value).postsPerMonth;
}

export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];
