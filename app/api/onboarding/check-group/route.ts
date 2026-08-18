import { currentUser, isAdminEmail } from "../../../../db/auth";
import { groupSlug, parseGroupInput } from "../../../../db/fbgroups";
import { checkGroupVisibility } from "../../../../db/group-visibility";
import { getDb } from "../../../../db";
import { planFor } from "../../../../db/plans";
import { groupVisibilityAttempts, profiles } from "../../../../db/schema";
import { eq, lt, sql } from "drizzle-orm";

/** Start or poll Bright Data's public/private answer for a pasted group. */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const parsed = parseGroupInput(body.url ?? "");
  if (!parsed?.url) {
    return Response.json({ error: "bad_group_url" }, { status: 400 });
  }

  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  const slug = groupSlug(parsed.url);
  const attemptId = `${user.id}:${day}:${slug}`;
  await db
    .delete(groupVisibilityAttempts)
    .where(lt(groupVisibilityAttempts.createdAt, Date.now() - 7 * 24 * 60 * 60 * 1000));
  const [profile] = await db
    .select({ plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const limit = planFor(profile?.plan).groups * 2;
  if (!isAdminEmail(user.email)) {
    // SQLite serialises this statement. Two different links arriving together
    // cannot both see the last free slot and push the paid daily quota over it.
    await db.run(sql`
      INSERT INTO group_visibility_attempts (id, user_id, day, slug, created_at)
      SELECT ${attemptId}, ${user.id}, ${day}, ${slug}, ${Date.now()}
      WHERE (
        SELECT count(*) FROM group_visibility_attempts
        WHERE user_id = ${user.id} AND day = ${day}
      ) < ${limit}
      ON CONFLICT(id) DO NOTHING
    `);
    const [allowed] = await db
      .select({ id: groupVisibilityAttempts.id })
      .from(groupVisibilityAttempts)
      .where(eq(groupVisibilityAttempts.id, attemptId))
      .limit(1);
    if (!allowed) {
      return Response.json({ error: "group_check_limit", limit }, { status: 429 });
    }
  }

  const result = await checkGroupVisibility(parsed.url);
  if (result.status === "checking") {
    return Response.json(
      { ok: true, checking: true, visibility: "unknown" },
      { status: 202 }
    );
  }
  if (result.status === "failed") {
    return Response.json(
      { error: result.error === "check_failed" ? "check_failed" : "visibility_unknown" },
      { status: 503 }
    );
  }

  return Response.json({
    ok: true,
    checking: false,
    visibility: result.visibility,
    name: result.name || parsed.name,
  });
}
