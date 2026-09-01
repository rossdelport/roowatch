import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import {
  MEMBER_TOP_UP_LEASE_MS,
  memberTopUpLeaseId,
  sizeUnknown,
  topUpMember,
} from "../../../../db/catalogue";
import { resolvePlaces, postcodesFor, postcodesInState } from "../../../../db/gazetteer";
import { findGroups, isAcceptableGroupName } from "../../../../db/groupsearch";
import { groupSlug } from "../../../../db/fbgroups";
import { groupLimit } from "../../../../db/plans";
import { isKnownState } from "../../../../db/trades";
import { claimLease, releaseLease } from "../../../../db/lease";
import { droppedGroups, foundGroups, groups, profiles, sources, users } from "../../../../db/schema";

/**
 * Ross's group repair tools are deliberately separate from the scanner.
 *
 * A rescan only searches Brave and changes this member's `groups` row once a
 * catalogue row has already been checked by Bright Data. It never edits a
 * `scan_jobs` row or pauses a source. The per-member lease stops two clicks,
 * or a rescan racing the automatic top-up, from replacing the same row twice.
 */
const ADMIN_REPAIR_LEASE_MS = 5 * 60 * 1000;
const ADMIN_REPAIR_LEASE_PREFIX = "admin_group_repair:";

type MemberGroup = {
  id: number;
  name: string;
  status: string;
  sourceId: number | null;
  url: string;
};

async function memberAndGroups(userId: string): Promise<{
  user: { id: string; email: string; name: string } | null;
  profile: { state: string; location: string; trade: string; plan: string } | null;
  groups: MemberGroup[];
}> {
  const db = getDb();
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [profile] = await db
    .select({ state: profiles.state, location: profiles.location, trade: profiles.trade, plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const [rows, sourceRows] = await Promise.all([
    db
      .select({
        id: groups.id,
        name: groups.name,
        status: groups.status,
        sourceId: groups.sourceId,
      })
      .from(groups)
      .where(eq(groups.userId, userId))
      .orderBy(asc(groups.id)),
    db
      .select({ id: sources.id, url: sources.url, groupName: sources.groupName })
      .from(sources)
      .orderBy(asc(sources.id)),
  ]);
  const byId = new Map(sourceRows.map((source) => [source.id, source.url]));
  const byName = new Map<string, string>();
  for (const source of sourceRows) {
    const key = source.groupName.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, source.url);
  }
  return {
    user: user ?? null,
    profile: profile ?? null,
    groups: rows.map((r) => ({
      ...r,
      url: (r.sourceId ? byId.get(r.sourceId) : byName.get(r.name.trim().toLowerCase())) ?? "",
    })),
  };
}

function profilePlaces(profile: { state: string; location: string }) {
  return profile.location
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * Search fresh Brave results, file them in the catalogue, then return only
 * rows Bright Data has already proved readable. New rows are queued for the
 * normal catalogue verifier and are never assigned to a paying member here.
 */
async function freshVerifiedCandidates(
  profile: { state: string; location: string; trade: string },
  excluded: Set<string>,
  excludedNames: Set<string>
) {
  const suburbs = profilePlaces(profile);
  if (!isKnownState(profile.state) || !suburbs.length) {
    return { verified: [], pending: 0, searched: false };
  }

  const canonical = await resolvePlaces(suburbs, profile.state);
  if (canonical.state !== profile.state || !canonical.suburbs.length) {
    return { verified: [], pending: 0, searched: false };
  }

  const [postcodeOf, statePostcodes] = await Promise.all([
    postcodesFor(canonical.suburbs, profile.state),
    postcodesInState(profile.state),
  ]);
  const found = await findGroups(
    canonical.suburbs,
    profile.state,
    40,
    postcodeOf,
    statePostcodes,
    profile.trade
  );
  const fresh = found.filter(
    (candidate) =>
      !excluded.has(candidate.slug) &&
      !excludedNames.has(candidate.name.trim().toLowerCase())
  );
  if (!fresh.length) return { verified: [], pending: 0, searched: true };

  const db = getDb();
  const now = Date.now();
  for (const candidate of fresh) {
    await db
      .insert(foundGroups)
      .values({
        slug: candidate.slug,
        url: candidate.url,
        name: candidate.name,
        state: profile.state,
        suburb: canonical.suburbs[0] ?? "",
        score: candidate.score,
        foundAt: now,
      })
      .onConflictDoNothing();
  }

  const rows = await db
    .select({
      slug: foundGroups.slug,
      url: foundGroups.url,
      name: foundGroups.name,
      checked: foundGroups.checked,
    })
    .from(foundGroups)
    .where(inArray(foundGroups.slug, fresh.map((candidate) => candidate.slug)));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  // D1 does not promise the order of an IN (...) query. Walk the Brave result
  // order so the first replacement is still the highest-ranked candidate.
  const ordered = fresh
    .map((candidate) => bySlug.get(candidate.slug))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const verified = ordered.filter(
    (row) =>
      row.checked === 1 &&
      isAcceptableGroupName(row.name, true) &&
      !excluded.has(row.slug) &&
      !excludedNames.has(row.name.trim().toLowerCase())
  );
  const pendingSlugs = ordered
    .filter(
      (row) =>
        row.checked !== 1 &&
        isAcceptableGroupName(row.name, true) &&
        !excluded.has(row.slug) &&
        !excludedNames.has(row.name.trim().toLowerCase())
    )
    .map((row) => row.slug);
  if (pendingSlugs.length) {
    // This trigger is catalogue work, not a scanner job. It is intentionally
    // fire-and-forget here: the cron collects it, then a later click can use it.
    await sizeUnknown(pendingSlugs.slice(0, 20));
  }
  return { verified, pending: pendingSlugs.length, searched: true };
}

async function replaceGroup(userId: string, target: MemberGroup, candidate: { slug: string; url: string; name: string }) {
  const db = getDb();
  const [duplicate] = await db
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(sources, eq(sources.id, groups.sourceId))
    .where(
      and(
        eq(groups.userId, userId),
        eq(groups.status, "watching"),
        or(
          eq(sources.url, candidate.url),
          and(
            isNull(groups.sourceId),
            sql`lower(${groups.name}) = lower(${candidate.name})`
          )
        )
      )
    )
    .limit(1);
  if (duplicate && duplicate.id !== target.id) return { ok: false as const, error: "already_watching" };

  const allSources = await db
    .select({ id: sources.id, url: sources.url, active: sources.active, lastError: sources.lastError })
    .from(sources)
    .orderBy(asc(sources.id));
  const existing = allSources.find((source) => groupSlug(source.url) === candidate.slug);
  let sourceId = existing?.id;
  if (existing) {
    if (/private/i.test(existing.lastError)) {
      return { ok: false as const, error: "candidate_private" };
    }
    await db
      .update(sources)
      .set({ groupName: candidate.name, active: 1, lastError: "" })
      .where(eq(sources.id, existing.id));
  } else {
    const [created] = await db
      .insert(sources)
      .values({
        groupName: candidate.name,
        url: candidate.url,
        // Let the normal scanner pick up the replacement without waiting a
        // full interval, while still leaving scanner queue ownership alone.
        lastChecked: Date.now() - 60 * 60 * 1000,
      })
      .returning({ id: sources.id });
    sourceId = created?.id;
  }
  if (!sourceId) return { ok: false as const, error: "source_not_created" };

  // Older rows can have no source_id and are matched by group name in
  // processSource. Recover that source before replacing the label, otherwise
  // the old source could keep running forever with an orphaned group name.
  let oldSourceId = target.sourceId;
  if (!oldSourceId && target.name) {
    const [old] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(sql`lower(${sources.groupName}) = lower(${target.name})`)
      .orderBy(asc(sources.id))
      .limit(1);
    oldSourceId = old?.id ?? null;
  }
  await db
    .update(groups)
    .set({ name: candidate.name, sourceId, status: "watching" })
    .where(and(eq(groups.id, target.id), eq(groups.userId, userId)));

  const oldSlug = groupSlug(target.url);
  if (oldSlug && oldSlug !== candidate.slug) {
    await db
      .insert(droppedGroups)
      .values({ userId, slug: oldSlug, droppedAt: Date.now() })
      .onConflictDoNothing();
  }

  // A source is shared. Only turn the old one off when this member was its
  // final watcher, otherwise another paying member would lose their scan.
  if (oldSourceId && oldSourceId !== sourceId) {
    const [oldSource] = await db
      .select({ groupName: sources.groupName })
      .from(sources)
      .where(eq(sources.id, oldSourceId))
      .limit(1);
    const [stillWatched] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.status, "watching"),
          or(
            eq(groups.sourceId, oldSourceId),
            and(
              isNull(groups.sourceId),
              sql`lower(${groups.name}) = lower(${oldSource?.groupName ?? ""})`
            )
          )
        )
      )
      .limit(1);
    if (!stillWatched) {
      await db.update(sources).set({ active: 0, lastError: "admin_replaced" }).where(eq(sources.id, oldSourceId));
    }
  }
  return { ok: true as const, candidate: candidate.name };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: "list" | "rescan" | "topup" | "add" | "remove" | "status";
    userId?: string;
    name?: string;
    groupId?: number;
    status?: string;
  };
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "list") {
    if (!body.userId) return Response.json({ error: "bad_user" }, { status: 400 });
    const result = await memberAndGroups(body.userId);
    if (!result.user) return Response.json({ error: "user_not_found" }, { status: 404 });
    return Response.json({ ok: true, ...result });
  }

  if ((body.action === "rescan" || body.action === "topup") && body.userId) {
    const userId = body.userId;
    // This outer lock serialises admin clicks. Rescans also claim the shared
    // catalogue lease below, while topUpMember claims it internally. That
    // pair keeps both manual actions and the scheduled top-up single-file.
    const adminLeaseId = `${ADMIN_REPAIR_LEASE_PREFIX}${userId}`;
    const adminLeaseToken = await claimLease(adminLeaseId, ADMIN_REPAIR_LEASE_MS);
    if (!adminLeaseToken) {
      return Response.json({ error: "busy", message: "That member is already being updated." }, { status: 409 });
    }
    const memberLeaseId = memberTopUpLeaseId(userId);
    let memberLeaseToken: number | null = null;
    try {
      if (body.action === "rescan") {
        memberLeaseToken = await claimLease(memberLeaseId, MEMBER_TOP_UP_LEASE_MS);
      }
    } catch (error) {
      await releaseLease(adminLeaseId, adminLeaseToken).catch(() => {});
      console.error("admin_group_repair_member_lease_failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: "lease_failed" }, { status: 503 });
    }
    if (body.action === "rescan" && !memberLeaseToken) {
      await releaseLease(adminLeaseId, adminLeaseToken);
      return Response.json({ error: "busy", message: "That member is already being updated." }, { status: 409 });
    }

    try {
      const current = await memberAndGroups(userId);
      if (!current.user) return Response.json({ error: "user_not_found" }, { status: 404 });
      if (!current.profile) return Response.json({ error: "profile_not_found" }, { status: 422 });

      if (body.action === "topup") {
        // topUpMember has its own per-member lease. The scheduled backfill can
        // therefore keep running for everybody else, and a race on this member
        // is skipped rather than stamping its retry clock six hours ahead.
        let added = 0;
        try {
          added = await topUpMember(userId, true);
        } catch (error) {
          console.error("admin_group_topup_failed", {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          return Response.json(
            { error: "topup_failed", message: "The top up could not finish. Try again." },
            { status: 503 }
          );
        }
        const latest = await memberAndGroups(userId);
        const watching = latest.groups.filter((group) => group.status === "watching").length;
        const limit = groupLimit(current.profile.plan);
        if (!added && watching < limit) {
          return Response.json(
            {
              ok: false,
              error: "topup_pending",
              message: "No checked groups were ready yet. Bright Data may still be checking new results.",
              added,
              watching,
              limit,
              remaining: limit - watching,
              groups: latest.groups,
            },
            { status: 409 }
          );
        }
        return Response.json({
          ok: true,
          action: "topup",
          added,
          watching,
          limit,
          remaining: Math.max(0, limit - watching),
          groups: latest.groups,
        });
      }

      if (!body.groupId) return Response.json({ error: "bad_group" }, { status: 400 });
      const target = current.groups.find((group) => group.id === body.groupId);
      if (!target) return Response.json({ error: "group_not_found" }, { status: 404 });

      // Keep every group this member already watches out of the result. This
      // also means replacing one bad row cannot silently duplicate another or
      // hand the exact target back under a URL variant.
      const excluded = new Set(current.groups.map((group) => groupSlug(group.url)).filter(Boolean));
      const dropped = await db
        .select({ slug: droppedGroups.slug })
        .from(droppedGroups)
        .where(eq(droppedGroups.userId, userId));
      for (const row of dropped) excluded.add(row.slug);
      const excludedNames = new Set(
        current.groups.map((group) => group.name.trim().toLowerCase()).filter(Boolean)
      );
      let search: Awaited<ReturnType<typeof freshVerifiedCandidates>>;
      try {
        search = await freshVerifiedCandidates(current.profile, excluded, excludedNames);
      } catch (error) {
        console.error("admin_group_rescan_failed", {
          userId,
          groupId: body.groupId,
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          { error: "rescan_failed", message: "The group search could not finish. Try again." },
          { status: 503 }
        );
      }
      if (!search.verified.length) {
        return Response.json(
          {
            ok: false,
            error: search.searched ? "no_verified_candidate" : "no_search_scope",
            pending: search.pending,
            message: search.pending
              ? `Search found ${search.pending} new group${search.pending === 1 ? "" : "s"}. Bright Data is checking them now.`
              : "No checked replacement group was found for this member's area yet.",
          },
          { status: 409 }
        );
      }

      const replacement = await replaceGroup(userId, target, search.verified[0]);
      if (!replacement.ok) {
        return Response.json(
          { ok: false, error: replacement.error, message: "That replacement is no longer available." },
          { status: 409 }
        );
      }
      const latest = await memberAndGroups(userId);
      return Response.json({
        ok: true,
        action: "rescan",
        replaced: true,
        oldGroup: target.name,
        newGroup: replacement.candidate,
        pending: search.pending,
        groups: latest.groups,
      });
    } finally {
      if (memberLeaseToken) await releaseLease(memberLeaseId, memberLeaseToken).catch((error) => {
        console.error("admin_group_repair_lease_release_failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await releaseLease(adminLeaseId, adminLeaseToken).catch((error) => {
        console.error("admin_group_admin_lease_release_failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  if (body.action === "add" && body.userId && body.name?.trim()) {
    await db.insert(groups).values({
      userId: body.userId,
      name: body.name.trim(),
      status: "watching",
    });
    return Response.json({ ok: true });
  }

  if (body.action === "remove" && body.groupId) {
    await db.delete(groups).where(eq(groups.id, body.groupId));
    return Response.json({ ok: true });
  }

  if (body.action === "status" && body.groupId && body.status) {
    await db
      .update(groups)
      .set({ status: body.status })
      .where(eq(groups.id, body.groupId));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "bad_request" }, { status: 400 });
}
