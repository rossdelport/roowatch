/**
 * Reads a member's website from the Worker.
 *
 * Cheerio and Playwright need Node or a browser, and we have neither here. The
 * page text is all we want, so a strip of the tags does the job.
 */

const BLOCKED_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1)/i;

export function normaliseUrl(raw: string): URL | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (BLOCKED_HOSTS.test(url.hostname)) return null;
    if (!url.hostname.includes(".")) return null;
    return url;
  } catch {
    return null;
  }
}

export function stripHtml(html: string, limit: number): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * The business logo, as an absolute URL, from the raw page HTML.
 *
 * We store the URL rather than the image bytes. A logo can be hundreds of
 * kilobytes, and base64 in a D1 row would be both slow and close to the row
 * size limit. A plain <img src> works fine, and a member can always upload
 * their own picture in Settings if their site blocks hotlinking.
 *
 * Order matters. An <img> the site itself calls a logo is almost always the
 * real thing. apple-touch-icon comes next because it is square and reasonably
 * large. og:image is often a banner or a photo of a van, so it is a fallback.
 * A favicon is usually 16 pixels and looks terrible as an avatar, so it is last.
 */
export function findLogo(html: string, base: URL): string {
  const absolute = (value: string) => {
    try {
      const url = new URL(value.trim(), base);
      return /^https?:$/.test(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  };

  const candidates = [
    html.match(/<img[^>]*logo[^>]*?\ssrc=["']([^"']+)["']/i)?.[1],
    html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i)?.[1],
    html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*?\shref=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+property=["']og:image["'][^>]*?\scontent=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*?\sproperty=["']og:image["']/i)?.[1],
    html.match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*?\shref=["']([^"']+)["']/i)?.[1],
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // Tracking pixels and inline SVG sprites are never a usable avatar.
    if (/^data:/i.test(candidate) && candidate.length > 60_000) continue;
    const url = absolute(candidate);
    if (url) return url;
  }
  return "";
}

/** Page text and logo from one fetch. Never throws. */
export async function readSite(
  raw: string,
  limit = 4000
): Promise<{ text: string; logo: string }> {
  const empty = { text: "", logo: "" };
  const url = normaliseUrl(raw);
  if (!url) return empty;
  try {
    const res = await fetch(url.toString(), {
      headers: { "user-agent": "RooWatchBot/1.0 (+https://roowatch.com.au)" },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return empty;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return empty;

    const html = (await res.text()).slice(0, 200_000);
    return { text: stripHtml(html, limit), logo: findLogo(html, new URL(res.url || url)) };
  } catch {
    // A slow or dead website must never stop onboarding.
    return empty;
  }
}

/** Best effort plain text from a website. Never throws. Empty means no luck. */
export async function readWebsite(raw: string, limit = 4000): Promise<string> {
  return (await readSite(raw, limit)).text;
}

/**
 * The business name sitting inside a Google Maps link.
 * ".../maps/place/Perth+Solar+Panel+Cleaners/@-31.9,115.8" gives us the name
 * with no API key and no cost.
 */
export function nameFromMapsUrl(raw: string): string {
  const match = String(raw ?? "").match(/\/maps\/place\/([^/@?#]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).replace(/\+/g, " ").trim().slice(0, 120);
  } catch {
    return match[1].replace(/\+/g, " ").trim().slice(0, 120);
  }
}
