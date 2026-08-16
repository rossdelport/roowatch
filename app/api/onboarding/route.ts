import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, sendEmail } from "../../../db/auth";
import { groups, profiles, sources } from "../../../db/schema";
import { groupSlug, parseGroupInput } from "../../../db/fbgroups";
import { groupLimit } from "../../../db/plans";

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
  if (brief.length < 20) return Response.json({ error: "short_brief" }, { status: 400 });

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
    brief: brief.slice(0, 600),
    onboardedAt: new Date().toISOString(),
  };

  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  if (existing) {
    await db.update(profiles).set(values).where(eq(profiles.userId, user.id));
  } else {
    await db.insert(profiles).values({ userId: user.id, ...values });
  }

  // A pasted link becomes a watched source straight away. A bare name waits
  // for Ross to find the group on the welcome call.
  const existingGroups = await db
    .select({ id: groups.id, name: groups.name })
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

  const existingNames = new Set(existingGroups.map((g) => g.name.trim().toLowerCase()));
  const existingLinks = uniqueRequested.filter(
    (g) => g.url && existingNames.has(g.name.trim().toLowerCase())
  );
  const newRequested = uniqueRequested.filter(
    (g) => !existingNames.has(g.name.trim().toLowerCase())
  );
  const limit = groupLimit(existing?.plan);
  const groupSlots = Math.max(0, limit - existingGroups.length);
  const parsed = [...existingLinks, ...newRequested.slice(0, groupSlots)];
  const skippedGroups = newRequested.length - Math.min(newRequested.length, groupSlots);

  const wanted: string[] = [];
  let watchingNow = 0;

  // Matched by slug, not the raw url string. A pasted link can differ from
  // what is already stored by a trailing slash or similar and still be the
  // exact same group. Matching on the raw string missed that and created a
  // second source scanning the same group twice.
  const allSources = await db.select({ id: sources.id, url: sources.url, active: sources.active }).from(sources);

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

    let sourceId = source?.id;
    if (sourceId && !source.active) {
      // Ross paused this group earlier. A member just asked for it, so it
      // has to start scanning again or they would never get a lead.
      await db
        .update(sources)
        .set({ active: 1, lastError: "" })
        .where(eq(sources.id, sourceId));
    }
    if (!sourceId) {
      const [created] = await db
        .insert(sources)
        .values({ groupName: g.name, url: g.url })
        .returning({ id: sources.id });
      sourceId = created?.id;
      // So a second group later in this same request that resolves to the
      // same slug reuses it too, instead of racing another insert.
      if (sourceId) allSources.push({ id: sourceId, url: g.url ?? "", active: 1 });
    }

    if (existingGroup) {
      if (sourceId) {
        await db
          .update(groups)
          .set({ sourceId, status: "watching" })
          .where(eq(groups.id, existingGroup.id));
        watchingNow += 1;
      }
      continue;
    }

    await db
      .insert(groups)
      .values({ userId: user.id, name: g.name, sourceId, status: "watching" });
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

  return Response.json({ ok: true, watching: watchingNow, skipped: skippedGroups });
}
