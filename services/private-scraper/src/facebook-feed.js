import { ERROR_CODES, ScraperError } from "./errors.js";

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11]
]);

export function buildChronologicalUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ScraperError(ERROR_CODES.JOB_INVALID, "The Facebook group URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (hostname !== "facebook.com" || !/^\/groups\/[^/]+\/?$/.test(url.pathname)) {
    throw new ScraperError(ERROR_CODES.JOB_INVALID, "The job URL is not a Facebook group URL");
  }
  url.protocol = "https:";
  url.hostname = "www.facebook.com";
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.searchParams.set("sorting_setting", "CHRONOLOGICAL");
  return url.toString();
}

export function isChronologicalUrl(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("sorting_setting") === "CHRONOLOGICAL";
  } catch {
    return false;
  }
}

function zonedParts(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function zonedDateToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month, day, hour, minute, 0);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(guess, timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess -= represented - target;
  }
  return guess;
}

function clock(hourRaw, minuteRaw, meridiemRaw) {
  let hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const meridiem = meridiemRaw?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function inferredYear(month, day, nowMs, timeZone) {
  const now = zonedParts(nowMs, timeZone);
  const thisYear = zonedDateToUtc({ year: now.year, month, day, hour: 0, minute: 0 }, timeZone);
  return thisYear > nowMs + 86_400_000 ? now.year - 1 : now.year;
}

function parseExactText(raw, nowMs, timeZone) {
  const text = raw
    .replace(/\u00a0/g, " ")
    .replace(/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const iso = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  if (Number.isFinite(iso)) return iso;

  if (/^(just now|now)$/i.test(text)) return nowMs;
  let relative = text.match(/^(\d+)\s*(?:s|sec|secs|second|seconds)(?:\s+ago)?$/i);
  if (relative) return nowMs - Number(relative[1]) * 1000;
  relative = text.match(/^(\d+)\s*(?:m|min|mins|minute|minutes)(?:\s+ago)?$/i);
  if (relative) return nowMs - Number(relative[1]) * 60_000;
  relative = text.match(/^(\d+)\s*(?:h|hr|hrs|hour|hours)(?:\s+ago)?$/i);
  if (relative) {
    const hours = Number(relative[1]);
    if (hours === 1) {
      throw new ScraperError(ERROR_CODES.TIMESTAMP_UNVERIFIED, "Facebook exposed only an ambiguous one-hour timestamp");
    }
    return nowMs - hours * 3_600_000;
  }
  relative = text.match(/^(\d+)\s*(?:d|day|days)(?:\s+ago)?$/i);
  if (relative) return nowMs - Number(relative[1]) * 86_400_000;

  let match = text.match(/^(today|yesterday)\s+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (match) {
    const time = clock(match[2], match[3], match[4]);
    if (!time) return null;
    const now = zonedParts(nowMs, timeZone);
    const midday = zonedDateToUtc({ year: now.year, month: now.month - 1, day: now.day, hour: time.hour, minute: time.minute }, timeZone);
    return match[1].toLowerCase() === "yesterday" ? midday - 86_400_000 : midday;
  }

  match = text.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (match && MONTHS.has(match[2].toLowerCase())) {
    const month = MONTHS.get(match[2].toLowerCase());
    const day = Number(match[1]);
    const time = clock(match[4], match[5], match[6]);
    if (!time || day < 1 || day > 31) return null;
    const year = match[3] ? Number(match[3]) : inferredYear(month, day, nowMs, timeZone);
    return zonedDateToUtc({ year, month, day, ...time }, timeZone);
  }

  match = text.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (match && MONTHS.has(match[1].toLowerCase())) {
    const month = MONTHS.get(match[1].toLowerCase());
    const day = Number(match[2]);
    const time = clock(match[4], match[5], match[6]);
    if (!time || day < 1 || day > 31) return null;
    const year = match[3] ? Number(match[3]) : inferredYear(month, day, nowMs, timeZone);
    return zonedDateToUtc({ year, month, day, ...time }, timeZone);
  }
  return null;
}

export function parseFacebookTimestamp(candidates, nowMs, timeZone = "Australia/Perth", cutoffMinutes) {
  let ambiguousError;
  const cutoffMs = cutoffMinutes === undefined ? undefined : nowMs - cutoffMinutes * 60_000;
  for (const candidate of candidates || []) {
    const text = String(candidate || "").replace(/\u00a0/g, " ").trim();
    const roundedMinutes = text.match(/^(\d+)\s*(?:m|min|mins|minute|minutes)(?:\s+ago)?$/i);
    if (cutoffMinutes !== undefined && Number(roundedMinutes?.[1]) === cutoffMinutes) {
      ambiguousError = new ScraperError(
        ERROR_CODES.TIMESTAMP_UNVERIFIED,
        `Facebook exposed only a rounded timestamp at the ${cutoffMinutes}-minute boundary`
      );
      continue;
    }
    try {
      const parsed = parseExactText(text, nowMs, timeZone);
      if (parsed !== null && Number.isFinite(parsed)) {
        const minuteOnly = /^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(?:(?:today|yesterday)|(?:\d{1,2}\s+[a-z]+)|(?:[a-z]+\s+\d{1,2})).*\d{1,2}:\d{2}(?:\s*(?:am|pm))?$/i.test(text);
        if (cutoffMs !== undefined && minuteOnly && parsed < cutoffMs && parsed + 60_000 > cutoffMs) {
          ambiguousError = new ScraperError(
            ERROR_CODES.TIMESTAMP_UNVERIFIED,
            `Facebook exposed only a minute-precision timestamp at the ${cutoffMinutes}-minute boundary`
          );
          continue;
        }
        return parsed;
      }
    } catch (error) {
      if (error instanceof ScraperError) ambiguousError = error;
      else throw error;
    }
  }
  if (ambiguousError) throw ambiguousError;
  throw new ScraperError(ERROR_CODES.TIMESTAMP_UNVERIFIED, "Facebook did not expose a verifiable post timestamp");
}

export async function processFeedArticles({
  articles,
  nowMs,
  cutoffMinutes = 65,
  timeZone,
  seenKeys,
  previousNormalTimestampMs,
  extractPost
}) {
  const posts = [];
  const cutoffMs = nowMs - cutoffMinutes * 60_000;
  let prior = previousNormalTimestampMs;
  let boundaryReached = false;
  let ignoredPinned = 0;
  let normalCount = 0;

  for (const article of articles) {
    if (article.key && seenKeys.has(article.key)) continue;
    if (article.key) seenKeys.add(article.key);

    // Pinned and featured items are outside the normal chronological feed. Do
    // not inspect their timestamp, permalink or content at any age.
    if (article.pinned) {
      ignoredPinned += 1;
      continue;
    }

    let postedAtMs;
    postedAtMs = parseFacebookTimestamp(article.timestampCandidates, nowMs, timeZone, cutoffMinutes);
    if (postedAtMs > nowMs + 120_000) {
      throw new ScraperError(ERROR_CODES.TIMESTAMP_UNVERIFIED, "Facebook exposed a post timestamp in the future");
    }

    normalCount += 1;
    if (postedAtMs < cutoffMs) {
      if (prior !== undefined && postedAtMs > prior + 2_000) {
        throw new ScraperError(ERROR_CODES.CHRONOLOGY_UNVERIFIED, "Normal posts were not ordered newest to oldest");
      }
      prior = postedAtMs;
      boundaryReached = true;
      break;
    }

    const extracted = await extractPost(article, postedAtMs);
    const wrapped = extracted
      && typeof extracted === "object"
      && typeof extracted.duplicate === "boolean"
      && Object.hasOwn(extracted, "post")
      ? extracted
      : { duplicate: false, post: extracted };
    if (wrapped.duplicate) continue;
    if (prior !== undefined && postedAtMs > prior + 2_000) {
      throw new ScraperError(ERROR_CODES.CHRONOLOGY_UNVERIFIED, "Normal posts were not ordered newest to oldest");
    }
    prior = postedAtMs;
    if (wrapped.post != null) posts.push(wrapped.post);
  }

  return { posts, boundaryReached, ignoredPinned, normalCount, previousNormalTimestampMs: prior };
}
