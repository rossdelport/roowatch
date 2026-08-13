import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { currentUser, sendEmail } from "../../../db/auth";
import { groups, profiles, users } from "../../../db/schema";

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

  const wanted = (body.groups ?? [])
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 20);
  for (const name of wanted) {
    await db
      .insert(groups)
      .values({ userId: user.id, name, status: "pending" });
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
      `Groups they suggested: ${wanted.length ? wanted.join(", ") : "none"}`,
      "",
      "Open the master dashboard to set up their watchlist.",
    ].join("\n")
  );

  return Response.json({ ok: true });
}
