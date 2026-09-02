/** Pure scanner queue rules, kept separate so the failure states are testable. */

export const JOB_STALE_MS = 20 * 60 * 1000;
/**
 * How long the watchdog lets a collection claim stand. The scanner itself
 * passes zero: it holds the run lease, so any claim it finds at the start of
 * a run was left by a run that died.
 */
export const COLLECTION_CLAIM_STALE_MS = 20 * 60 * 1000;

export type CollectionAttempt = "first" | "retry";

export type JobState =
  | { kind: "running" }
  | { kind: "retry"; queuedAt: number | null }
  | { kind: "collecting"; claimedAt: number; attempt: CollectionAttempt };

export function parseSourceIds(raw: string): number[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    if (!value.every((id) => Number.isInteger(id) && Number(id) > 0)) return null;
    return [...new Set(value as number[])];
  } catch {
    return null;
  }
}

export function parseSlugs(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    if (!value.every((slug) => typeof slug === "string" && slug.trim().length > 0)) return null;
    return [...new Set(value.map((slug) => String(slug).trim()))];
  } catch {
    return null;
  }
}

export function parseJobState(raw: string): JobState | null {
  if (raw === "running") return { kind: "running" };
  if (raw === "retry") return { kind: "retry", queuedAt: null };

  const retry = /^retry:(\d+)$/.exec(raw);
  if (retry) {
    const queuedAt = Number(retry[1]);
    if (!Number.isSafeInteger(queuedAt) || queuedAt <= 0) return null;
    return { kind: "retry", queuedAt };
  }

  const match = /^collecting:(\d+):(first|retry)$/.exec(raw);
  if (!match) return null;

  const claimedAt = Number(match[1]);
  if (!Number.isSafeInteger(claimedAt) || claimedAt <= 0) return null;
  return {
    kind: "collecting",
    claimedAt,
    attempt: match[2] as CollectionAttempt,
  };
}

export function jobExpiryReason(
  job: { status: string; startedAt: number; sourceIds?: readonly number[] },
  now: number,
  claimStaleMs = COLLECTION_CLAIM_STALE_MS
):
  | "empty_queue"
  | "invalid_status"
  | "stale_snapshot"
  | "stale_first_claim"
  | "stale_retry_claim"
  | null {
  if (job.sourceIds?.length === 0) return "empty_queue";
  const state = parseJobState(job.status);
  if (!state) return "invalid_status";
  if (state.kind === "collecting") {
    if (now - state.claimedAt <= claimStaleMs) return null;
    return state.attempt === "first" ? "stale_first_claim" : "stale_retry_claim";
  }
  if (state.kind === "retry" && state.queuedAt !== null) {
    return now - state.queuedAt > JOB_STALE_MS ? "stale_snapshot" : null;
  }
  return now - job.startedAt > JOB_STALE_MS ? "stale_snapshot" : null;
}

export function collectionClaim(
  status: string,
  now: number
): { expected: string; marker: string; attempt: CollectionAttempt } | null {
  const state = parseJobState(status);
  if (!state || state.kind === "collecting") return null;
  const attempt: CollectionAttempt = state.kind === "retry" ? "retry" : "first";
  return {
    expected: status,
    marker: `collecting:${now}:${attempt}`,
    attempt,
  };
}

export function collectionFailureAction(
  attempt: CollectionAttempt,
  now: number
): { kind: "retry"; status: string } | { kind: "drop" } {
  return attempt === "first"
    ? { kind: "retry", status: `retry:${now}` }
    : { kind: "drop" };
}
