import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groupSlug, parseGroupInput } from "../../../../db/fbgroups";
import { knownGroupVisibility } from "../../../../db/group-visibility";
import {
  ensureClassifiedSource,
  withGroupMutationLock,
} from "../../../../db/group-mutations";
import { groupLimit, privateGroupLimit } from "../../../../db/plans";
import { groups, privateGroupStates, profiles, sources } from "../../../../db/schema";

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: "add" | "remove" | "rename";
    name?: string;
    groupId?: number;
  };
  const db = getDb();

  /**
   * Add a group from a Facebook link.
   *
   * This used to store whatever was typed as a plain name with status
   * "pending", and nothing ever promoted it. A member could add a group, see
   * it sitting in their list, and never be told that nothing was reading it.
   * The onboarding wizard did this properly and Settings did not, which is
   * exactly how a group ends up watching nothing.
   */
  if (body.action === "add") {
    const raw = (body.name ?? "").trim();
    if (!raw) return Response.json({ error: "bad_name" }, { status: 400 });

    const parsed = parseGroupInput(raw);
    if (!parsed?.url) return Response.json({ error: "need_url" }, { status: 400 });
    const parsedUrl = parsed.url;

    const checked = await knownGroupVisibility(parsedUrl);
    if (!checked || checked.status !== "ready" || checked.visibility === "unknown") {
      return Response.json({ error: "group_check_required" }, { status: 409 });
    }
    const visibility = checked.visibility;

    const locked = await withGroupMutationLock(user.id, async () => {
      const [profile] = await db
        .select({ plan: profiles.plan })
        .from(profiles)
        .where(eq(profiles.userId, user.id))
        .limit(1);
      const mine = await db.select().from(groups).where(eq(groups.userId, user.id));
      const limit = groupLimit(profile?.plan);
      if (mine.length >= limit) {
        return Response.json({ error: "plan_limit", limit }, { status: 400 });
      }

      const knownSources = await db
      .select({
        id: sources.id,
        url: sources.url,
        active: sources.active,
        visibility: sources.visibility,
      })
      .from(sources);
      const source = knownSources.find((row) => groupSlug(row.url) === groupSlug(parsedUrl));

      if (source && mine.some((group) => group.sourceId === source.id)) {
        return Response.json({ error: "duplicate" }, { status: 400 });
      }

      if (visibility === "private") {
        const sourceById = new Map(knownSources.map((row) => [row.id, row]));
        const privateCount = mine.filter(
          (group) => group.sourceId && sourceById.get(group.sourceId)?.visibility === "private"
        ).length;
        const privateLimit = privateGroupLimit(profile?.plan);
        if (privateCount >= privateLimit) {
          return Response.json({ error: "private_limit", limit: privateLimit }, { status: 400 });
        }
      }

      const { id: sourceId, active } = await ensureClassifiedSource({
        groupName: checked.name || parsed.name,
        url: parsedUrl,
        visibility,
        existingSourceId: source?.id,
      });

      let status = active ? "watching" : visibility === "private" ? "paused_private" : "paused";
      if (active && visibility === "private") {
        const [health] = await db
        .select({ status: privateGroupStates.status })
        .from(privateGroupStates)
        .where(eq(privateGroupStates.sourceId, sourceId))
        .limit(1);
        if (health?.status !== "healthy") status = "waiting_for_access";
      }

      await db.insert(groups).values({
        userId: user.id,
        name: parsed.name,
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

  /**
   * Rename a group, for looks only. Some groups come back from Facebook as
   * "Perth Group 600380330147945" and a member should be able to write what
   * they actually call it.
   *
   * The trap: a group with no source_id is matched to its scraper by NAME.
   * Renaming one of those would quietly cut it off from the pipeline and the
   * member would simply stop getting leads, with no error anywhere. So we
   * pin the source id first, using the old name, before the name changes.
   */
  if (body.action === "rename" && body.groupId) {
    const name = (body.name ?? "").trim().slice(0, 120);
    if (name.length < 2) return Response.json({ error: "bad_name" }, { status: 400 });

    const [mine] = await db
      .select({ id: groups.id, name: groups.name, sourceId: groups.sourceId })
      .from(groups)
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)))
      .limit(1);
    if (!mine) return Response.json({ error: "not_yours" }, { status: 404 });

    let sourceId = mine.sourceId;
    if (!sourceId) {
      const [match] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(sql`lower(${sources.groupName}) = lower(${mine.name})`)
        .limit(1);
      sourceId = match?.id ?? null;
    }

    await db
      .update(groups)
      .set({ name, ...(sourceId ? { sourceId } : {}) })
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)));
    return Response.json({ ok: true });
  }

  if (body.action === "remove" && body.groupId) {
    await db
      .delete(groups)
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "bad_request" }, { status: 400 });
}
