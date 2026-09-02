import { PIXEL_ID } from "./pixel";

/**
 * The server side half of the Facebook pixel.
 *
 * The browser pixel is the only thing that has ever reported a conversion, and
 * it has reported none. Three reasons, all of them fatal on their own:
 *
 * 1. `fbevents.js` loads async. A `track` call made before it arrives only
 *    sits in `fbq.queue`, and the signup form navigates to /dashboard on the
 *    very next line, so the queue dies with the page.
 * 2. Most of the audience is on a phone. iOS, Safari and ad blockers drop a
 *    large share of what does get sent.
 * 3. Purchase needed the member to come back from Stripe with the tab open.
 *
 * This module sends the same events straight from the Worker instead, at the
 * three moments the database already knows for certain. Nothing to block, no
 * race with a page navigation, and the click id travels with it so Meta can
 * match the sale back to the ad that made it.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export type CapiEvent = {
  name: "Lead" | "CompleteRegistration" | "Purchase";
  /** Shared with the browser pixel so Meta counts one conversion, not two. */
  eventId: string;
  email: string;
  phone?: string;
  /** The Meta click id cookie, `fb.1.<ts>.<fbclid>`. Empty if we never saw one. */
  fbc?: string;
  /** The Meta browser id cookie. */
  fbp?: string;
  sourceUrl?: string;
  clientIp?: string;
  clientUserAgent?: string;
  value?: number;
  contentName?: string;
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fire and forget. A Meta outage must never fail a signup, a setup or a
 * Stripe webhook, so every failure is swallowed. It is logged rather than
 * ignored, because a conversion pipeline that silently sends nothing is the
 * exact bug this module exists to fix.
 */
export async function sendCapi(event: CapiEvent) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    console.warn(`capi: META_CAPI_TOKEN not set, ${event.name} not sent`);
    return;
  }

  try {
    const userData: Record<string, unknown> = { em: [await sha256(event.email)] };
    if (event.phone) userData.ph = [await sha256(event.phone.replace(/[^0-9]/g, ""))];
    // Meta matches on these two before it falls back to the hashed email, so
    // they are what actually ties a sale to the ad set that paid for it.
    if (event.fbc) userData.fbc = event.fbc;
    if (event.fbp) userData.fbp = event.fbp;
    if (event.clientIp) userData.client_ip_address = event.clientIp;
    if (event.clientUserAgent) userData.client_user_agent = event.clientUserAgent;

    const payload = {
      data: [
        {
          event_name: event.name,
          event_time: Math.floor(Date.now() / 1000),
          event_id: event.eventId,
          action_source: "website",
          ...(event.sourceUrl ? { event_source_url: event.sourceUrl } : {}),
          user_data: userData,
          custom_data: {
            currency: "AUD",
            ...(event.value ? { value: event.value } : {}),
            ...(event.contentName ? { content_name: event.contentName } : {}),
          },
        },
      ],
    };

    const res = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`capi: ${event.name} rejected ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`capi: ${event.name} failed`, err);
  }
}

/** Reads the `_fbc` and `_fbp` cookies a browser sends us. */
export function attributionFromRequest(request: Request) {
  const jar = request.headers.get("cookie") ?? "";
  const read = (name: string) =>
    jar.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? "";
  return { fbc: read("_fbc"), fbp: read("_fbp") };
}
