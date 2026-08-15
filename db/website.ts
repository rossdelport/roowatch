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

/** Best effort plain text from a website. Never throws. Empty means no luck. */
export async function readWebsite(raw: string, limit = 4000): Promise<string> {
  const url = normaliseUrl(raw);
  if (!url) return "";
  try {
    const res = await fetch(url.toString(), {
      headers: { "user-agent": "RooWatchBot/1.0 (+https://roowatch.com.au)" },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return "";
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return "";
    return stripHtml((await res.text()).slice(0, 200_000), limit);
  } catch {
    // A slow or dead website must never stop onboarding.
    return "";
  }
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
