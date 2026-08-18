import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, sendEmail } from "../../../db/auth";
import { groups, privateGroupStates, profiles, sources } from "../../../db/schema";
import { groupSlug, parseGroupInput } from "../../../db/fbgroups";
import { knownGroupVisibility, type GroupVisibility } from "../../../db/group-visibility";
import {
  ensureClassifiedSource,
  withGroupMutationLock,
} from "../../../db/group-mutations";
import { BRIEF_MAX, BRIEF_MIN } from "../../../db/brief";
import { groupLimit, privateGroupLimit } from "../../../db/plans";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    businessName?: string;
    website?: string;
    gbpUrl?: string;
    trade?: string;
    services?: string;
    suburbs?: string[];
    brief?: string;
    groups?: string[];
  };

  const db = getDb();
  const businessName = (body.businessName ?? "").trim();
  const rawTrade = (body.trade ?? "").trim();
  const suburbs = (body.suburbs ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 20);
  const brief = (body.brief ?? "").trim();

  if (!rawTrade) return Response.json({ error: "no_trade" }, { status: 400 });
  if (!suburbs.length) return Response.json({ error: "no_suburbs" }, { status: 400 });
  if (brief.length < BRIEF_MIN) return Response.json({ error: "short_brief" }, { status: 400 });
  // Refuse a brief that is too long rather than cut the end off it. Silently
  // losing the "skip these" half of someone's brief would wreck their matching.
  if (brief.length > BRIEF_MAX) return Response.json({ error: "long_brief" }, { status: 400 });

  // A trade is either one from our list or the member's own words behind
  // "Other". Both are plain text, so length is the only thing to police.
  const trade = rawTrade.slice(0, 60);

  const values = {
    ...(businessName ? { businessName } : {}),
    trade,
    website: (body.website ?? "").trim().slice(0, 300),
    gbpUrl: (body.gbpUrl ?? "").trim().slice(0, 500),
    services: (body.services ?? "").trim().slice(0, 600),
    // The pipeline reads location as free text, so the suburb list joins up.
    location: suburbs.join(", ").slice(0, 600),
    brief,
    onboardedAt: new Date().toISOString(),
    // Setup is done, so the half finished copy is no longer the truth.
    wizardDraft: "",
  };

  const locked = await withGroupMutationLock(user.id, async () => {
  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  // A pasted link becomes a watched source straight away. A bare name waits
  // for Ross to find the group on the welcome call.
  const existingGroups = await db
    .select({ id: groups.id, name: groups.name, sourceId: groups.sourceId, status: groups.status })
    .from(groups)
    .where(eq(groups.userId, user.id));

  const requested = (body.groups ?? [])
    .map((g) => parseGroupInput(g))
    .filter((g): g is NonNullable<typeof g> => Boolean(g));
  const seen = new Set<string>();
  const uniqueRequested = requested.filter((g) => {
    const key = g.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const allSources = await db
    .select({
      id: sources.id,
      url: sources.url,
      active: sources.active,
      visibility: sources.visibility,
    })
    .from(sources);
  const sourceById = new Map(allSources.map((source) => [source.id, source]));
  const existingSlugs = new Set(
    existingGroups
      .map((group) => group.sourceId ? sourceById.get(group.sourceId)?.url : "")
      .map((url) => groupSlug(url ?? ""))
      .filter(Boolean)
  );
  const existingNames = new Set(existingGroups.map((g) => g.name.trim().toLowerCase()));
  const existingLinks = uniqueRequested.filter(
    (g) =>
      g.url &&
      !existingSlugs.has(groupSlug(g.url)) &&
      existingNames.has(g.name.trim().toLowerCase())
  );
  const newRequested = uniqueRequested.filter(
    (g) =>
      !existingNames.has(g.name.trim().toLowerCase()) &&
      (!g.url || !existingSlugs.has(groupSlug(g.url)))
  );

  // The browser's answer is never trusted. Every URL must have a completed
  // server-side Bright Data classification before it can create a source.
  const visibilityByUrl = new Map<string, Exclude<GroupVisibility, "unknown">>();
  for (const group of [...existingLinks, ...newRequested]) {
    if (!group.url) continue;
    const checked = await knownGroupVisibility(group.url);
    if (!checked || checked.status !== "ready" || checked.visibility === "unknown") {
      return Response.json(
        { error: "group_check_required", group: group.name },
        { status: 409 }
      );
    }
    visibilityByUrl.set(group.url, checked.visibility);
  }

  const limit = groupLimit(existing?.plan);
  if (existingGroups.length + newRequested.length > limit) {
    return Response.json({ error: "plan_limit", limit }, { status: 400 });
  }
  const privateLimit = privateGroupLimit(existing?.plan);
  const existingPrivate = existingGroups.filter(
    (group) => group.sourceId && sourceById.get(group.sourceId)?.visibility === "private"
  ).length;
  const newPrivate = newRequested.filter(
    (group) => group.url && visibilityByUrl.get(group.url) === "private"
  ).length;
  const convertedPrivate = existingLinks.filter((group) => {
    if (!group.url || visibilityByUrl.get(group.url) !== "private") return false;
    const existingGroup = existingGroups.find(
      (row) => row.name.trim().toLowerCase() === group.name.trim().toLowerCase()
    );
    return !existingGroup?.sourceId || sourceById.get(existingGroup.sourceId)?.visibility !== "private";
  }).length;
  if (existingPrivate + newPrivate + convertedPrivate > privateLimit) {
    return Response.json({ error: "private_limit", limit: privateLimit }, { status: 400 });
  }

  // Validation is complete. Only now is setup marked finished.
  if (existing) {
    await db.update(profiles).set(values).where(eq(profiles.userId, user.id));
  } else {
    await db.insert(profiles).values({ userId: user.id, ...values });
  }

  const parsed = [...existingLinks, ...newRequested];

  const wanted: string[] = [];
  let watchingNow = 0;

  // Matched by slug, not the raw url string. A pasted link can differ from
  // what is already stored by a trailing slash or similar and still be the
  // exact same group. Matching on the raw string missed that and created a
  // second source scanning the same group twice.
  for (const g of parsed) {
    wanted.push(g.url ? `${g.name} (${g.url})` : g.name);

    const existingGroup = existingGroups.find(
      (row) => row.name.trim().toLowerCase() === g.name.trim().toLowerCase()
    );

    if (!g.url) {
      if (existingGroup) continue;
      await db
        .insert(groups)
        .values({ userId: user.id, name: g.name, status: "pending" });
      continue;
    }

    const slug = groupSlug(g.url);
    const source = allSources.find((s) => groupSlug(s.url) === slug);
    const visibility = visibilityByUrl.get(g.url);
    if (!visibility) {
      return Response.json({ error: "group_check_required", group: g.name }, { status: 409 });
    }

    const { id: sourceId, active } = await ensureClassifiedSource({
      groupName: g.name,
      url: g.url,
      visibility,
      existingSourceId: source?.id,
    });
    if (!source) {
      // A later entry in this same request reuses the new source as well.
      allSources.push({ id: sourceId, url: g.url, active: 1, visibility });
    }

    let status = active ? "watching" : visibility === "private" ? "paused_private" : "paused";
    if (active && visibility === "private" && sourceId) {
      const [health] = await db
        .select({ status: privateGroupStates.status })
        .from(privateGroupStates)
        .where(eq(privateGroupStates.sourceId, sourceId))
        .limit(1);
      if (health?.status !== "healthy") status = "waiting_for_access";
    }

    if (existingGroup) {
      if (sourceId) {
        await db
          .update(groups)
          .set({ sourceId, status })
          .where(eq(groups.id, existingGroup.id));
        watchingNow += 1;
      }
      continue;
    }

    await db
      .insert(groups)
      .values({ userId: user.id, name: g.name, sourceId, status });
    watchingNow += 1;
  }

  await sendEmail(
    ["ross@roowatch.com.au", "rossdelport1998@gmail.com"],
    `New RooWatch signup: ${user.email}`,
    [
      "A member just finished setup.",
      "",
      `Email: ${user.email}`,
      `Name: ${user.name || "not given"}`,
      `Business: ${businessName || existing?.businessName || "not given"}`,
      `Trade: ${trade}`,
      `Website: ${values.website}`,
      `Google listing: ${values.gbpUrl || "not given"}`,
      `Suburbs: ${values.location}`,
      `Their brief: ${values.brief}`,
      `Groups they gave: ${wanted.length ? wanted.join(", ") : "none"}`,
      `Watching now: ${watchingNow} of ${parsed.length}`,
      "",
      "Open the master dashboard to check their watchlist.",
    ].join("\n")
  );

  return Response.json({ ok: true, watching: watchingNow, skipped: 0 });
  });
  if (locked.busy) {
    return Response.json({ error: "group_update_busy" }, { status: 409 });
  }
  return locked.value;
}
