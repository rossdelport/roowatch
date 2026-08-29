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
   *
   * Set on 28 Aug 2026 at 500 posts per group. The median group produces
   * 4.4 posts a day, so twenty groups runs near 2,600 a month and almost
   * nobody reaches the cap. It exists for the outlier: one measured group
   * does 74 posts a day on its own, and without a ceiling a single noisy
   * watchlist would cost more than the plan.
   */
  postsPerMonth: number;
  /**
   * Text messages we will send this member each month. Same idea as the post
   * cap: a hard ceiling on what one member can cost. About $0.072 AUD each, so
   * Local tops out near $22 AUD of texts. Past the cap they still get every
   * lead by email, they just stop getting texts.
   */
  smsPerMonth: number;
  alertMinutes: number;
  priceAud: number;
  stripePriceId: string;
  /**
   * Prices we used to sell at. A member who signed up on an old price must
   * still resolve to the right plan when Stripe tells us about their
   * subscription, or a paying customer would silently drop to Local limits.
   */
  legacyPriceIds: string[];
};

export const PLANS: Record<PlanKey, Plan> = {
  local: {
    key: "local",
    name: "Local",
    groups: 20,
    postsPerMonth: 5_000,
    smsPerMonth: 50,
    alertMinutes: 5,
    priceAud: 97,
    stripePriceId: "price_1U9J1r9HOJbWqVTomTe8d2Vp",
    legacyPriceIds: ["price_1U5Ja49HOJbWqVToYzQV07oK", "price_1U4sCe9HOJbWqVToqrNBDaIp"],
  },
  growth: {
    key: "growth",
    name: "Growth",
    groups: 50,
    postsPerMonth: 12_500,
    smsPerMonth: 50,
    alertMinutes: 5,
    priceAud: 197,
    stripePriceId: "price_1U9JSx9HOJbWqVToJKSr9IbN",
    legacyPriceIds: ["price_1U5Ja59HOJbWqVTo9JLdtVcU", "price_1U4sCg9HOJbWqVToRKrBxw6W"],
  },
  scale: {
    key: "scale",
    name: "Scale",
    groups: 200,
    postsPerMonth: 58_500,
    smsPerMonth: 200,
    alertMinutes: 3,
    priceAud: 897,
    stripePriceId: "price_1U9JSx9HOJbWqVTooh1nDP4d",
    legacyPriceIds: ["price_1U5Ja69HOJbWqVTocZcT4T7D", "price_1U4sCh9HOJbWqVToU4GpQFTO"],
  },
};

/**
 * Days free before the first bill. No intro discount any more: full price from
 * day fifteen, which is simpler to say and simpler to read on an invoice.
 */
export const TRIAL_DAYS = 14;

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

/** How many texts we will send this member in one month. */
export function smsLimit(value: string | null | undefined): number {
  return planFor(value).smsPerMonth;
}

export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

/**
 * Which plan a Stripe price belongs to, current or retired.
 *
 * Prices change when Ross changes his mind about pricing. Members already
 * paying stay on the price they signed up at, so matching only the current
 * price would quietly drop a paying customer to Local limits the day after a
 * price change.
 */
export function planForPrice(priceId: string): PlanKey | undefined {
  if (!priceId) return undefined;
  return PLAN_KEYS.find(
    (key) =>
      PLANS[key].stripePriceId === priceId || PLANS[key].legacyPriceIds.includes(priceId)
  );
}
