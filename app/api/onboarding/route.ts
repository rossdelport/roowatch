import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, sendEmail } from "../../../db/auth";
import { groups, profiles, sources, users } from "../../../db/schema";
import { parseGroupInput } from "../../../db/fbgroups";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    website?: string;
    services?: string;
    location?: string;
    brief?: string;
    groups?: string[];
  };

  const db = getDb();
  const name = (body.name ?? "").trim();
  if (name) {
    await db.update(users).set({ name }).where(eq(users.id, user.id));
  }

  const values = {
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
  const parsed = (body.groups ?? [])
    .map((g) => parseGroupInput(g))
    .filter((g): g is NonNullable<typeof g> => Boolean(g))
    .slice(0, 20);

  const wanted: string[] = [];
  let watchingNow = 0;

  for (const g of parsed) {
    wanted.push(g.url ? `${g.name} (${g.url})` : g.name);

    if (!g.url) {
      await db
        .insert(groups)
        .values({ userId: user.id, name: g.name, status: "pending" });
      continue;
    }

    const [existing] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, g.url))
      .limit(1);

    let sourceId = existing?.id;
    if (!sourceId) {
      const [created] = await db
        .insert(sources)
        .values({ groupName: g.name, url: g.url })
        .returning({ id: sources.id });
      sourceId = created?.id;
    }

    await db
      .insert(groups)
      .values({ userId: user.id, name: g.name, sourceId, status: "watching" });
    watchingNow += 1;
  }

  await sendEmail(
    "ross@roowatch.com.au",
    `New RooWatch signup: ${user.email}`,
    [
      "A member just finished onboarding.",
      "",
      `Email: ${user.email}`,
      `Name: ${name || user.name || "not given"}`,
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

  return Response.json({ ok: true, watching: watchingNow });
}
