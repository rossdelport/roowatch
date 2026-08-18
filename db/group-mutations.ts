import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "./index";
import { groupMutationLocks, groups, profiles, sources } from "./schema";

const GROUP_MUTATION_LEASE_MS = 60_000;

export async function routeGroupsForVisibility(
  sourceId: number,
  previousVisibility: string,
  visibility: "public" | "private"
) {
  if (visibility === previousVisibility) return;
  const db = getDb();
  if (visibility === "private") {
    await db
      .update(groups)
      .set({ status: "waiting_for_access" })
      .where(and(eq(groups.sourceId, sourceId), eq(groups.status, "watching")));
    return;
  }

  // Private-only limit and budget states must not block the public pipeline,
  // but a payment lapse that happened while one of those states was active
  // must still win.
  const rows = await db
    .select({
      id: groups.id,
      status: groups.status,
      subscriptionStatus: profiles.subscriptionStatus,
    })
    .from(groups)
    .leftJoin(profiles, eq(profiles.userId, groups.userId))
    .where(eq(groups.sourceId, sourceId));
  const [source] = await db
    .select({ active: sources.active })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  const lapsed = new Set(["canceled", "unpaid", "incomplete_expired"]);
  const privateOnly = new Set([
    "waiting_for_access",
    "plan_limit_private",
    "budget_paused_private",
  ]);
  const watchingIds = rows
    .filter(
      (row) =>
        privateOnly.has(row.status) &&
        source?.active === 1 &&
        row.subscriptionStatus != null &&
        !lapsed.has(row.subscriptionStatus)
    )
    .map((row) => row.id);
  const pausedIds = rows
    .filter(
      (row) =>
        ["paused_private", "paused_private_payment"].includes(row.status) ||
        (privateOnly.has(row.status) &&
          (source?.active !== 1 ||
            row.subscriptionStatus == null ||
            lapsed.has(row.subscriptionStatus)))
    )
    .map((row) => row.id);
  if (watchingIds.length) {
    await db
      .update(groups)
      .set({ status: "watching" })
      .where(inArray(groups.id, watchingIds));
  }
  if (pausedIds.length) {
    await db
      .update(groups)
      .set({ status: "paused" })
      .where(inArray(groups.id, pausedIds));
  }
}

/** One member's count-and-add sequence must be a single-writer operation. */
export async function withGroupMutationLock<T>(
  userId: string,
  work: () => Promise<T>
): Promise<{ busy: false; value: T } | { busy: true }> {
  const db = getDb();
  const owner = crypto.randomUUID();
  const now = Date.now();
  await db
    .insert(groupMutationLocks)
    .values({ userId, owner: "", lockedUntil: 0 })
    .onConflictDoNothing();
  const [lease] = await db
    .update(groupMutationLocks)
    .set({ owner, lockedUntil: now + GROUP_MUTATION_LEASE_MS })
    .where(
      and(
        eq(groupMutationLocks.userId, userId),
        lte(groupMutationLocks.lockedUntil, now)
      )
    )
    .returning({ owner: groupMutationLocks.owner });
  if (lease?.owner !== owner) return { busy: true };

  try {
    return { busy: false, value: await work() };
  } finally {
    await db
      .update(groupMutationLocks)
      .set({ owner: "", lockedUntil: 0 })
      .where(
        and(
          eq(groupMutationLocks.userId, userId),
          eq(groupMutationLocks.owner, owner)
        )
      );
  }
}

/**
 * Canonical Facebook URLs are unique. Concurrent members therefore share one
 * source row and one paid scrape, even when their add requests land together.
 */
export async function ensureClassifiedSource(input: {
  groupName: string;
  url: string;
  visibility: "public" | "private";
  existingSourceId?: number;
}) {
  const db = getDb();
  const checkedAt = Date.now();
  const [before] = input.existingSourceId
    ? await db
        .select({
          id: sources.id,
          visibility: sources.visibility,
          active: sources.active,
          lastError: sources.lastError,
        })
        .from(sources)
        .where(eq(sources.id, input.existingSourceId))
        .limit(1)
    : await db
        .select({
          id: sources.id,
          visibility: sources.visibility,
          active: sources.active,
          lastError: sources.lastError,
        })
        .from(sources)
        .where(eq(sources.url, input.url))
        .limit(1);
  if (!before) {
    await db
      .insert(sources)
      .values({
        groupName: input.groupName,
        url: input.url,
        visibility: input.visibility,
        visibilityCheckedAt: checkedAt,
        lastChecked:
          input.visibility === "public" ? checkedAt - 60 * 60 * 1000 : 0,
      })
      .onConflictDoNothing();
  }

  const [source] = before
    ? [before]
    : await db
        .select({
          id: sources.id,
          visibility: sources.visibility,
          active: sources.active,
          lastError: sources.lastError,
        })
        .from(sources)
        .where(eq(sources.url, input.url))
        .limit(1);
  if (!source) throw new Error("source_not_saved");

  const reactivate = source.active === 0 && source.lastError === "paused_no_active_watchers";
  await db
    .update(sources)
    .set({
      url: input.url,
      visibility: input.visibility,
      visibilityCheckedAt: checkedAt,
      ...(reactivate ? { active: 1, lastError: "" } : {}),
    })
    .where(eq(sources.id, source.id));

  await routeGroupsForVisibility(source.id, source.visibility, input.visibility);

  return {
    id: source.id,
    active: reactivate ? 1 : source.active,
    previousVisibility: before?.visibility ?? source.visibility,
  };
}
