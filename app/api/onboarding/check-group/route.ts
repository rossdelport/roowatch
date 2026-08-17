import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { sources } from "../../../../db/schema";
import { groupSlug, parseGroupInput } from "../../../../db/fbgroups";

/**
 * Can we watch this group?
 *
 * Facebook will not tell an anonymous fetch whether a group is private, so
 * the only honest source is our own scanning. Every group any member has ever
 * added is checked every few minutes, and Facebook answers a private one with
 * "Only members can see who's in the group". We write that down, so the
 * second person to try the same group is turned away in an instant, for
 * nothing.
 *
 * A group nobody has tried before is allowed through. The first scan settles
 * it, and the group then shows as private in their list.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const parsed = parseGroupInput(body.url ?? "");
  const slug = parsed?.url ? groupSlug(parsed.url) : "";
  if (!slug) return Response.json({ ok: true });

  const all = await getDb()
    .select({ url: sources.url, lastError: sources.lastError })
    .from(sources)
    .where(eq(sources.active, 1));

  const known = all.find((s) => groupSlug(s.url) === slug);
  if (known && /private/i.test(known.lastError)) {
    return Response.json({ error: "private" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
