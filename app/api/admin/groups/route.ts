import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { groupSlug, parseGroupInput } from "../../../../db/fbgroups";
import { knownGroupVisibility } from "../../../../db/group-visibility";
import {
  ensureClassifiedSource,
  withGroupMutationLock,
} from "../../../../db/group-mutations";
import { groupLimit, privateGroupLimit } from "../../../../db/plans";
import { groups, privateGroupStates, profiles, sources } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "add" | "remove" | "status";
    userId?: string;
    name?: string;
    groupId?: number;
    status?: string;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();

  if (body.action === "add" && body.userId && body.name?.trim()) {
    const userId = body.userId;
    const parsed = parseGroupInput(body.name);
    if (!parsed?.url) return Response.json({ error: "need_url" }, { status: 400 });
    const url = parsed.url;
    const checked = await knownGroupVisibility(url);
    if (!checked || checked.status !== "ready" || checked.visibility === "unknown") {
      return Response.json({ error: "group_check_required" }, { status: 409 });
    }
    const visibility = checked.visibility;
    const locked = await withGroupMutationLock(userId, async () => {
    const [profile] = await db
      .select({ plan: profiles.plan })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    const mine = await db.select().from(groups).where(eq(groups.userId, userId));
    const totalLimit = groupLimit(profile?.plan);
    if (mine.length >= totalLimit) {
      return Response.json({ error: "plan_limit", limit: totalLimit }, { status: 400 });
    }
    const allSources = await db
      .select({ id: sources.id, url: sources.url, visibility: sources.visibility })
      .from(sources);
    const sourceById = new Map(allSources.map((source) => [source.id, source]));
    const source = allSources.find((row) => groupSlug(row.url) === groupSlug(url));
    if (source && mine.some((group) => group.sourceId === source.id)) {
      return Response.json({ error: "duplicate" }, { status: 400 });
    }
    if (visibility === "private") {
      const privateCount = mine.filter(
        (group) => group.sourceId && sourceById.get(group.sourceId)?.visibility === "private"
      ).length;
      const limit = privateGroupLimit(profile?.plan);
      if (privateCount >= limit) {
        return Response.json({ error: "private_limit", limit }, { status: 400 });
      }
    }

    const { id: sourceId, active } = await ensureClassifiedSource({
      groupName: checked.name || parsed.name,
      url,
      visibility,
      existingSourceId: source?.id,
    });
    let status = active ? "watching" : visibility === "private" ? "paused_private" : "paused";
    if (active && visibility === "private" && sourceId) {
      const [state] = await db
        .select({ status: privateGroupStates.status })
        .from(privateGroupStates)
        .where(eq(privateGroupStates.sourceId, sourceId))
        .limit(1);
      if (state?.status !== "healthy") status = "waiting_for_access";
    }
    await db.insert(groups).values({
      userId,
      name: checked.name || parsed.name,
      sourceId,
      status,
    });
    return Response.json({ ok: true, visibility, status });
    });
    if (locked.busy) {
      return Response.json({ error: "group_update_busy" }, { status: 409 });
    }
    return locked.value;
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
