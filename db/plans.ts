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
  /** Private groups are optional and may use up to 40% of all group slots. */
  privateGroups: number;
  /**
   * Fair use, and also our cost ceiling. We pay per post read, so this number
   * is the most a single member can ever cost us in a month. Do not remove it.
   * 1,000 posts costs about $1.50 USD to fetch and about $0.65 USD to read.
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
  /** What they pay for the first month, after the free trial. */
  firstMonthAud: number;
  stripePriceId: string;
  /** Knocks the first invoice down to firstMonthAud. Applied once. */
  stripeCouponId: string;
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
    groups: 10,
    privateGroups: 4,
    postsPerMonth: 10_000,
    smsPerMonth: 150,
    alertMinutes: 5,
    priceAud: 197,
    firstMonthAud: 50,
    stripePriceId: "price_1U5Ja49HOJbWqVToYzQV07oK",
    stripeCouponId: "wEVaw5Ec",
    legacyPriceIds: ["price_1U4sCe9HOJbWqVToqrNBDaIp"],
  },
  growth: {
    key: "growth",
    name: "Growth",
    groups: 25,
    privateGroups: 10,
    postsPerMonth: 25_000,
    smsPerMonth: 375,
    alertMinutes: 5,
    priceAud: 397,
    firstMonthAud: 100,
    stripePriceId: "price_1U5Ja59HOJbWqVTo9JLdtVcU",
    stripeCouponId: "wSgWGxEE",
    legacyPriceIds: ["price_1U4sCg9HOJbWqVToRKrBxw6W"],
  },
  scale: {
    key: "scale",
    name: "Scale",
    groups: 100,
    privateGroups: 40,
    postsPerMonth: 100_000,
    smsPerMonth: 1_500,
    alertMinutes: 3,
    priceAud: 1497,
    firstMonthAud: 375,
    stripePriceId: "price_1U5Ja69HOJbWqVTocZcT4T7D",
    stripeCouponId: "UfVZ9G1F",
    legacyPriceIds: ["price_1U4sCh9HOJbWqVToU4GpQFTO"],
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

/** Maximum private groups. Public groups may use every plan slot. */
export function privateGroupLimit(value: string | null | undefined): number {
  return planFor(value).privateGroups;
}

/** Exact private scraper ceiling in AUD micros: 25% of the standard price. */
export function privateScrapingBudgetAudMicros(
  value: string | null | undefined
): number {
  return planFor(value).priceAud * 250_000;
}

/**
 * New jobs stop at 90% of the hard budget. The last 10% is a conservative
 * buffer for a supplier measurement arriving slightly above its reservation.
 */
export function privateScrapingSafetyCutoffAudMicros(
  value: string | null | undefined
): number {
  return Math.floor(privateScrapingBudgetAudMicros(value) * 9 / 10);
}

/** Ross gets a warning at 80% of the hard budget, before dispatch stops. */
export function privateScrapingWarningAudMicros(
  value: string | null | undefined
): number {
  return Math.floor(privateScrapingBudgetAudMicros(value) * 4 / 5);
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
