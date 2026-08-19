import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { groups, sources } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: "list" | "add" | "update" | "remove";
    sourceId?: number;
    groupName?: string;
    url?: string;
    active?: boolean;
  };
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "add") {
    const groupName = (body.groupName ?? "").trim();
    const url = (body.url ?? "").trim();
    if (!groupName || !url.startsWith("http")) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }

    // Reuse an existing source for the same URL. Source IDs are part of the
    // post de-duplication key, so duplicate rows would process every post
    // twice and send duplicate leads.
    const [existing] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.url, url))
      .limit(1);
    let sourceId = existing?.id;
    if (sourceId) {
      await db
        .update(sources)
        .set({ groupName, active: 1, lastError: "" })
        .where(eq(sources.id, sourceId));
    } else {
      const [created] = await db
        .insert(sources)
        .values({ groupName, url })
        .returning({ id: sources.id });
      sourceId = created?.id;
    }

    // A member asked for this group by name, so start watching it for them.
    if (sourceId) {
      await db
        .update(groups)
        .set({ status: "watching", sourceId })
        .where(sql`lower(${groups.name}) = lower(${groupName})`);
    }
  }

  if (body.action === "update" && body.sourceId) {
    const patch: Record<string, unknown> = {};
    if (typeof body.url === "string") patch.url = body.url.trim();
    if (typeof body.groupName === "string") patch.groupName = body.groupName.trim();
    if (typeof body.active === "boolean") {
      patch.active = body.active ? 1 : 0;
      await db
        .update(groups)
        .set({ status: body.active ? "watching" : "paused" })
        .where(eq(groups.sourceId, body.sourceId));
    }
    if (Object.keys(patch).length) {
      await db.update(sources).set(patch).where(eq(sources.id, body.sourceId));
    }
  }

  if (body.action === "remove" && body.sourceId) {
    // Keep member rows usable if Ross removes a source. They become pending
    // instead of retaining a foreign ID that can never be scanned again.
    await db
      .update(groups)
      .set({ sourceId: null, status: "pending" })
      .where(eq(groups.sourceId, body.sourceId));
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
      (g) =>
        g.sourceId === s.id || g.name.toLowerCase() === s.groupName.toLowerCase()
    ).length,
  }));

  // group names members are watching that have no source yet
  const covered = new Set(allSources.map((s) => s.groupName.toLowerCase()));
  const uncovered = [
    ...new Set(
      allGroups
        .filter((g) => !g.sourceId && !covered.has(g.name.toLowerCase()))
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
