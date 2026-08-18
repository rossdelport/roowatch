import { and, eq } from "drizzle-orm";
import { getDb } from "./index";
import { bdCollect, bdProgress, bdTrigger } from "./pipeline";
import { groupSlug } from "./fbgroups";
import { routeGroupsForVisibility } from "./group-mutations";
import { enforcePrivatePlanLimits } from "./private-monitoring";
import { groupVisibilityChecks, sources } from "./schema";

export type GroupVisibility = "public" | "private" | "unknown";

export type VisibilityResult = {
  visibility: GroupVisibility;
  status: "ready" | "checking" | "failed";
  name: string;
  error: string;
};

const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 5 * 60 * 1000;
const START_CLAIM_MS = 5 * 60 * 1000;
const CHECK_STALE_MS = 20 * 60 * 1000;

async function applyKnownVisibility(
  slug: string,
  visibility: Exclude<GroupVisibility, "unknown">,
  checkedAt: number
) {
  const db = getDb();
  let becamePrivate = false;
  const rows = await db
    .select({ id: sources.id, url: sources.url, visibility: sources.visibility })
    .from(sources);
  for (const row of rows) {
    if (groupSlug(row.url) !== slug) continue;
    await db
      .update(sources)
      .set({ visibility, visibilityCheckedAt: checkedAt })
      .where(eq(sources.id, row.id));
    await routeGroupsForVisibility(row.id, row.visibility, visibility);
    if (visibility === "private" && row.visibility !== "private") becamePrivate = true;
  }
  if (becamePrivate) await enforcePrivatePlanLimits();
}

/** Return only a completed, recent answer. Save routes use this as authority. */
export async function knownGroupVisibility(url: string): Promise<VisibilityResult | null> {
  const slug = groupSlug(url);
  if (!slug) return null;
  const db = getDb();

  const allSources = await db
    .select({
      id: sources.id,
      url: sources.url,
      groupName: sources.groupName,
      visibility: sources.visibility,
      visibilityCheckedAt: sources.visibilityCheckedAt,
    })
    .from(sources);
  const source = allSources.find(
    (row) =>
      groupSlug(row.url) === slug &&
      (row.visibility === "public" || row.visibility === "private") &&
      Date.now() - row.visibilityCheckedAt <= CACHE_MS
  );
  if (source) {
    return {
      visibility: source.visibility as GroupVisibility,
      status: "ready",
      name: source.groupName,
      error: "",
    };
  }

  const [cached] = await db
    .select()
    .from(groupVisibilityChecks)
    .where(eq(groupVisibilityChecks.slug, slug))
    .limit(1);
  if (!cached || Date.now() - cached.checkedAt > CACHE_MS) return null;
  if (cached.status !== "public" && cached.status !== "private") return null;
  await applyKnownVisibility(slug, cached.status, cached.checkedAt);
  return {
    visibility: cached.status,
    status: "ready",
    name: cached.groupName,
    error: "",
  };
}

/**
 * Start or poll Bright Data's answer for one pasted group.
 *
 * A request never guesses. The first response is normally `checking`; the UI
 * polls this same function until Bright Data has a finished snapshot.
 */
export async function checkGroupVisibility(url: string): Promise<VisibilityResult> {
  const slug = groupSlug(url);
  if (!slug) {
    return { visibility: "unknown", status: "failed", name: "", error: "bad_group_url" };
  }

  const known = await knownGroupVisibility(url);
  if (known) return known;

  const db = getDb();
  const [cached] = await db
    .select()
    .from(groupVisibilityChecks)
    .where(eq(groupVisibilityChecks.slug, slug))
    .limit(1);

  if (cached?.status === "checking" && cached.snapshotId) {
    if (Date.now() - cached.updatedAt > CHECK_STALE_MS) {
      const now = Date.now();
      const [timedOut] = await db
        .update(groupVisibilityChecks)
        .set({
          snapshotId: "",
          status: "unknown",
          error: "check_timeout",
          checkedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(groupVisibilityChecks.slug, slug),
            eq(groupVisibilityChecks.updatedAt, cached.updatedAt),
            eq(groupVisibilityChecks.status, "checking")
          )
        )
        .returning({ slug: groupVisibilityChecks.slug });
      return timedOut
        ? { visibility: "unknown", status: "failed", name: cached.groupName, error: "check_timeout" }
        : { visibility: "unknown", status: "checking", name: cached.groupName, error: "" };
    }
    try {
      const progress = await bdProgress(cached.snapshotId);
      if (progress.status === "ready") {
        const { posts, facts } = await bdCollect(cached.snapshotId, [url]);
        const fact = facts.get(slug);
        const visibility: GroupVisibility = fact?.private
          ? "private"
          : !fact?.answered || fact.error
            ? "unknown"
            : "public";
        const status = visibility === "unknown" ? "failed" : visibility;
        const name = fact?.name || cached.groupName || "";
        const error = visibility === "unknown" ? fact?.error || "visibility_unknown" : "";
        await db
          .update(groupVisibilityChecks)
          .set({
            status,
            groupName: name,
            error,
            checkedAt: Date.now(),
            updatedAt: Date.now(),
          })
          .where(eq(groupVisibilityChecks.slug, slug));
        if (visibility !== "unknown") {
          await applyKnownVisibility(slug, visibility, Date.now());
        }
        // `posts` being present is evidence the dataset could read the group.
        // Accessing it here also keeps the intent explicit when Bright Data
        // changes the shape of its empty-result facts.
        void posts;
        return {
          visibility,
          status: visibility === "unknown" ? "failed" : "ready",
          name,
          error,
        };
      }
      if (progress.status === "failed") {
        await db
          .update(groupVisibilityChecks)
          .set({ status: "unknown", error: "check_failed", checkedAt: Date.now(), updatedAt: Date.now() })
          .where(eq(groupVisibilityChecks.slug, slug));
        return { visibility: "unknown", status: "failed", name: "", error: "check_failed" };
      }
      return { visibility: "unknown", status: "checking", name: cached.groupName, error: "" };
    } catch (err) {
      const error = err instanceof Error ? err.message : "check_failed";
      await db
        .update(groupVisibilityChecks)
        .set({ status: "unknown", error: error.slice(0, 200), checkedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(groupVisibilityChecks.slug, slug));
      return { visibility: "unknown", status: "failed", name: "", error };
    }
  }

  if (cached?.status === "starting" && Date.now() - cached.updatedAt < START_CLAIM_MS) {
    return { visibility: "unknown", status: "checking", name: cached.groupName, error: "" };
  }

  if (cached && Date.now() - cached.updatedAt < FAILED_RETRY_MS) {
    return {
      visibility: "unknown",
      status: "failed",
      name: cached.groupName,
      error: cached.error || "visibility_unknown",
    };
  }

  const claimAt = Date.now();
  const [claimed] = cached
    ? await db
        .update(groupVisibilityChecks)
        .set({
          url,
          snapshotId: "",
          status: "starting",
          error: "",
          updatedAt: claimAt,
        })
        .where(
          and(
            eq(groupVisibilityChecks.slug, slug),
            eq(groupVisibilityChecks.updatedAt, cached.updatedAt)
          )
        )
        .returning({ slug: groupVisibilityChecks.slug })
    : await db
        .insert(groupVisibilityChecks)
        .values({ slug, url, status: "starting", updatedAt: claimAt })
        .onConflictDoNothing()
        .returning({ slug: groupVisibilityChecks.slug });
  if (!claimed) {
    return { visibility: "unknown", status: "checking", name: cached?.groupName ?? "", error: "" };
  }

  try {
    const snapshotId = await bdTrigger([url], new Date(Date.now() - 65 * 60 * 1000));
    await db
      .update(groupVisibilityChecks)
      .set({ snapshotId, status: "checking", error: "", updatedAt: Date.now() })
      .where(
        and(
          eq(groupVisibilityChecks.slug, slug),
          eq(groupVisibilityChecks.updatedAt, claimAt),
          eq(groupVisibilityChecks.status, "starting")
        )
      );
    return { visibility: "unknown", status: "checking", name: "", error: "" };
  } catch (err) {
    const error = err instanceof Error ? err.message : "check_failed";
    await db
      .update(groupVisibilityChecks)
      .set({
        status: "unknown",
        error: error.slice(0, 200),
        checkedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(groupVisibilityChecks.slug, slug),
          eq(groupVisibilityChecks.updatedAt, claimAt),
          eq(groupVisibilityChecks.status, "starting")
        )
      );
    return { visibility: "unknown", status: "failed", name: "", error };
  }
}
