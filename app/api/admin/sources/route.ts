import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { groups, sources } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "list" | "add" | "update" | "remove";
    sourceId?: number;
    groupName?: string;
    url?: string;
    active?: boolean;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "add") {
    const groupName = (body.groupName ?? "").trim();
    const url = (body.url ?? "").trim();
    if (!groupName || !url.startsWith("http")) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    await db.insert(sources).values({ groupName, url });
  }

  if (body.action === "update" && body.sourceId) {
    const patch: Record<string, unknown> = {};
    if (typeof body.url === "string") patch.url = body.url.trim();
    if (typeof body.groupName === "string") patch.groupName = body.groupName.trim();
    if (typeof body.active === "boolean") patch.active = body.active ? 1 : 0;
    if (Object.keys(patch).length) {
      await db.update(sources).set(patch).where(eq(sources.id, body.sourceId));
    }
  }

  if (body.action === "remove" && body.sourceId) {
    await db.delete(sources).where(eq(sources.id, body.sourceId));
  }

  const allSources = await db.select().from(sources).orderBy(desc(sources.id));
  const allGroups = await db.select().from(groups);

  const rows = allSources.map((s) => ({
    id: s.id,
    groupName: s.groupName,
    url: s.url,
    active: s.active === 1,
    lastChecked: s.lastChecked,
    lastCount: s.lastCount,
    lastMatches: s.lastMatches,
    lastError: s.lastError,
    watchers: allGroups.filter(
      (g) => g.name.toLowerCase() === s.groupName.toLowerCase()
    ).length,
  }));

  // group names members are watching that have no source yet
  const covered = new Set(allSources.map((s) => s.groupName.toLowerCase()));
  const uncovered = [
    ...new Set(
      allGroups
        .filter((g) => !covered.has(g.name.toLowerCase()))
        .map((g) => g.name)
    ),
  ];

  return Response.json({
    ok: true,
    sources: rows,
    uncovered,
    keys: {
      apify: Boolean(process.env.APIFY_TOKEN),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  });
}
