import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, sendEmail } from "../../../db/auth";
import { groups, profiles, sources } from "../../../db/schema";
import { parseGroupInput } from "../../../db/fbgroups";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    businessName?: string;
    website?: string;
    services?: string;
    location?: string;
    brief?: string;
    groups?: string[];
  };

  const db = getDb();
  const businessName = (body.businessName ?? "").trim();

  const values = {
    // Members who signed up on /signup already gave a business name. The wizard
    // sends it back unchanged, so this write is a no-op for them.
    ...(businessName ? { businessName } : {}),
    website: (body.website ?? "").trim(),
    services: (body.services ?? "").trim(),
    location: (body.location ?? "").trim(),
    brief: (body.brief ?? "").trim(),
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
  const requestedNames = new Set<string>();
  const uniqueRequested = requested.filter((g) => {
    const key = g.name.trim().toLowerCase();
    if (requestedNames.has(key)) return false;
    requestedNames.add(key);
    return true;
  });
  const existingNames = new Set(existingGroups.map((g) => g.name.trim().toLowerCase()));
  const existingLinks = uniqueRequested.filter(
    (g) => g.url && existingNames.has(g.name.trim().toLowerCase())
  );
  const newRequested = uniqueRequested.filter(
    (g) => !existingNames.has(g.name.trim().toLowerCase())
  );
  const groupSlots = Math.max(0, 10 - existingGroups.length);
  const parsed = [...existingLinks, ...newRequested.slice(0, groupSlots)];
  const skippedGroups = newRequested.length - Math.min(newRequested.length, groupSlots);

  const wanted: string[] = [];
  let watchingNow = 0;

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

    const [existing] = await db
      .select({ id: sources.id, active: sources.active })
      .from(sources)
      .where(eq(sources.url, g.url))
      .limit(1);

    let sourceId = existing?.id;
    if (sourceId && !existing.active) {
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
      "A member just finished onboarding.",
      "",
      `Email: ${user.email}`,
      `Name: ${user.name || "not given"}`,
      `Business: ${businessName || existing?.businessName || "not given"}`,
      `Website: ${values.website}`,
      `Services: ${values.services}`,
      `Location: ${values.location}`,
      `Their brief: ${values.brief || "not given"}`,
      `Groups they gave: ${wanted.length ? wanted.join(", ") : "none"}`,
      `Watching now: ${watchingNow} of ${parsed.length}`,
      "",
      "Open the master dashboard to set up their watchlist.",
    ].join("\n")
  );

  return Response.json({ ok: true, watching: watchingNow, skipped: skippedGroups });
}
