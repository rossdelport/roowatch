import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { groupSlug, parseGroupInput } from "../../../../db/fbgroups";
import { groupLimit } from "../../../../db/plans";
import { droppedGroups, groups, profiles, sources } from "../../../../db/schema";

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

    const [profile] = await db
      .select({ plan: profiles.plan })
      .from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1);
    const limit = groupLimit(profile?.plan);

    const mine = await db.select().from(groups).where(eq(groups.userId, user.id));
    // A group we found to be private stays on their list so they can see
    // why, but it watches nothing, so it does not use up a slot.
    if (mine.filter((g) => g.status !== "private").length >= limit) {
      return Response.json({ error: "plan_limit", limit }, { status: 400 });
    }

    // Find or make the source, then point their row at it. Without this the
    // group is decoration: the scanner never picks it up.
    //
    // Matched by slug, the way the wizard does it, and oldest first. Matching
    // the raw link missed a group that was already stored with different
    // capitals, and made a second source that was scanned and paid for twice.
    const known = (
      await db
        .select({ id: sources.id, url: sources.url, active: sources.active, lastError: sources.lastError })
        .from(sources)
        .orderBy(sources.id)
    ).filter((s) => groupSlug(s.url) === groupSlug(parsed.url ?? ""));

    // Same rule as the wizard: a group we already know is private can never
    // send them a lead, so it is turned away rather than quietly added.
    if (known.some((s) => /private/i.test(s.lastError))) {
      return Response.json({ error: "private" }, { status: 400 });
    }
    const existing = known[0];

    // Checked before anything is switched back on. This used to run after the
    // source was reactivated, so "already on your list" still restarted a
    // scan nobody had asked for.
    if (existing && mine.some((g) => g.sourceId === existing.id)) {
      return Response.json({ error: "duplicate" }, { status: 400 });
    }

    let sourceId = existing?.id;
    if (sourceId && !existing.active) {
      await db.update(sources).set({ active: 1, lastError: "" }).where(eq(sources.id, sourceId));
    }
    if (!sourceId) {
      const [created] = await db
        .insert(sources)
        // Backdated an hour, same as setup. A group added on a Tuesday
        // afternoon should start showing its posts within a minute, not sit
        // blank until something happens to be posted.
        .values({ groupName: parsed.name, url: parsed.url, lastChecked: Date.now() - 60 * 60 * 1000 })
        .returning({ id: sources.id });
      sourceId = created?.id;
    }

    await db.insert(groups).values({
      userId: user.id,
      name: parsed.name,
      sourceId,
      status: sourceId ? "watching" : "pending",
    });
    return Response.json({ ok: true });
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
    // Written down before the delete, while we can still find the source.
    // topUpShortMembers refills a short watchlist from the catalogue, so
    // without this it would put back the group they just removed, every
    // six hours, forever.
    const [going] = await db
      .select({ url: sources.url })
      .from(groups)
      .leftJoin(sources, eq(sources.id, groups.sourceId))
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)))
      .limit(1);
    const slug = groupSlug(going?.url ?? "");
    if (slug) {
      await db
        .insert(droppedGroups)
        .values({ userId: user.id, slug, droppedAt: Date.now() })
        .onConflictDoNothing();
    }

    await db
      .delete(groups)
      .where(and(eq(groups.id, body.groupId), eq(groups.userId, user.id)));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "bad_request" }, { status: 400 });
}
