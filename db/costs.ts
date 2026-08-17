/**
 * What everything costs, in one place.
 *
 * The Usage tab reads these. Two of the three are measured from the supplier's
 * own API and one is estimated, and the tab says which is which rather than
 * presenting a guess as a bill.
 */

/** Ross charges in AUD. Bright Data and Anthropic bill in USD. */
export const USD_TO_AUD = 1.4123;

/** Bright Data, per record delivered. Empty checks are free. */
export const BRIGHT_DATA_PER_RECORD_USD = 0.0015;

/**
 * Claude Haiku reading one post against one member's brief. Estimated from
 * token counts, roughly 500 in and 40 out, not from a bill. Anthropic does not
 * expose per key usage on the normal API, so this cannot be measured the way
 * the other two can.
 */
export const CLAUDE_PER_POST_USD = 0.0007;

/** Cloudflare Workers and D1, flat. Resend is inside its free tier. */
export const PLATFORM_PER_MONTH_USD = 5;

export const aud = (usd: number) => usd * USD_TO_AUD;
