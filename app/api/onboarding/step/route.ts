import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { profiles } from "../../../../db/schema";

/**
 * Saves the setup wizard as the member leaves each step.
 *
 * It writes one JSON blob and nothing else. No profile fields, no groups, no
 * sources. That is deliberate: the scanner bills every active source whether
 * anybody watches it or not, so a member who opens the wizard and wanders off
 * must not be able to start a scan. Real rows are still only written by
 * /api/onboarding when they press Start watching.
 *
 * Before this, the wizard held everything in the browser. Close the tab and
 * ten pasted group links were gone.
 */

/** Enough for ten group links, a brief and a suburb list, with room spare. */
const DRAFT_MAX = 8000;

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { draft?: unknown };
  if (!body.draft || typeof body.draft !== "object") {
    return Response.json({ error: "no_draft" }, { status: 400 });
  }

  const draft = JSON.stringify(body.draft);
  // A draft we cannot store in full is worse than no draft, because restoring
  // half of one would quietly drop groups they had already pasted.
  if (draft.length > DRAFT_MAX) {
    return Response.json({ error: "too_big" }, { status: 413 });
  }

  const db = getDb();
  const [existing] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  if (existing) {
    await db
      .update(profiles)
      .set({ wizardDraft: draft })
      .where(eq(profiles.userId, user.id));
  } else {
    await db.insert(profiles).values({ userId: user.id, wizardDraft: draft });
  }

  return Response.json({ ok: true });
}
