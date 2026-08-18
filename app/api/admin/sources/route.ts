import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { parseGroupInput } from "../../../../db/fbgroups";
import {
  checkGroupVisibility,
  knownGroupVisibility,
} from "../../../../db/group-visibility";
import {
  ensureClassifiedSource,
  routeGroupsForVisibility,
} from "../../../../db/group-mutations";
import { enforcePrivatePlanLimits } from "../../../../db/private-monitoring";
import { groups, sources } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "list" | "add" | "update" | "remove";
    sourceId?: number;
    groupName?: string;
    url?: string;
    active?: boolean;
    visibility?: "public" | "private" | "unknown";
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "add") {
    const groupName = (body.groupName ?? "").trim();
    const parsed = parseGroupInput(body.url ?? "");
    if (!groupName || !parsed?.url) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const url = parsed.url;
    const checked = await knownGroupVisibility(url);
    if (!checked || checked.status !== "ready") {
      return Response.json({ error: "group_check_required" }, { status: 409 });
    }
    if (checked.visibility !== "public") {
      return Response.json({ error: "private_source_use_private_monitoring" }, { status: 400 });
    }

    // Reuse an existing source for the same URL. Source IDs are part of the
    // post de-duplication key, so duplicate rows would process every post
    // twice and send duplicate leads.
    const { id: sourceId, active } = await ensureClassifiedSource({
      groupName,
      url,
      visibility: "public",
    });

    // A member asked for this group by name, so start watching it for them.
    if (sourceId) {
      await db
        .update(groups)
        .set({ status: active ? "watching" : "paused", sourceId })
        .where(sql`lower(${groups.name}) = lower(${groupName})`);
    }
  }

  if (body.action === "update" && body.sourceId) {
    const patch: Record<string, unknown> = {};
    let urlVisibility: "public" | "private" | null = null;
    let previousVisibility = "unknown";
    if (typeof body.url === "string") {
      const parsed = parseGroupInput(body.url);
      if (!parsed?.url) {
        return Response.json({ error: "bad_group_url" }, { status: 400 });
      }
      const checked = await checkGroupVisibility(parsed.url);
      if (checked.status === "checking") {
        return Response.json(
          { error: "group_check_pending", checking: true },
          { status: 202 }
        );
      }
      if (checked.status !== "ready" || checked.visibility === "unknown") {
        return Response.json({ error: "group_check_failed" }, { status: 503 });
      }
      const [duplicate] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.url, parsed.url))
        .limit(1);
      if (duplicate && duplicate.id !== body.sourceId) {
        return Response.json({ error: "duplicate_source" }, { status: 409 });
      }
      const [current] = await db
        .select({ visibility: sources.visibility })
        .from(sources)
        .where(eq(sources.id, body.sourceId))
        .limit(1);
      if (!current) return Response.json({ error: "source_not_found" }, { status: 404 });
      previousVisibility = current.visibility;
      patch.url = parsed.url;
      patch.visibility = checked.visibility;
      patch.visibilityCheckedAt = Date.now();
      patch.lastError = "";
      patch.lastChecked = checked.visibility === "public" ? Date.now() - 60 * 60 * 1000 : 0;
      urlVisibility = checked.visibility;
    }
    if (typeof body.groupName === "string") patch.groupName = body.groupName.trim();
    if (typeof body.active === "boolean") {
      const [source] = await db
        .select({ visibility: sources.visibility })
        .from(sources)
        .where(eq(sources.id, body.sourceId))
        .limit(1);
      if (source?.visibility !== "public") {
        return Response.json({ error: "private_source_use_private_monitoring" }, { status: 400 });
      }
      patch.active = body.active ? 1 : 0;
      await db
        .update(groups)
        .set({ status: body.active ? "watching" : "paused" })
        .where(eq(groups.sourceId, body.sourceId));
    }
    if (Object.keys(patch).length) {
      await db.update(sources).set(patch).where(eq(sources.id, body.sourceId));
      if (urlVisibility) {
        await routeGroupsForVisibility(body.sourceId, previousVisibility, urlVisibility);
      }
      if (urlVisibility) await enforcePrivatePlanLimits();
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
    visibility: s.visibility,
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
