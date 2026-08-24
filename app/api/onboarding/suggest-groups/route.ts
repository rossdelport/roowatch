import { currentUser } from "../../../../db/auth";
import { candidatesFor, sizeUnknown } from "../../../../db/catalogue";
import { searchConfigured } from "../../../../db/groupsearch";

/**
 * The groups we hand a member during setup, so they never have to go hunting.
 *
 * Catalogue first, which is instant and free. Search only when we do not hold
 * enough for their patch, and whatever it finds is filed for the next member.
 *
 * Anything we have never read is queued for a one off sizing scan. The member
 * does not wait on it: the numbers land in the catalogue a minute or two
 * later, and everybody after them sees the sizes straight away.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    state?: string;
    suburbs?: string[];
  };
  const state = String(body.state ?? "").trim();
  const suburbs = (body.suburbs ?? []).map((s) => String(s).trim()).filter(Boolean);

  const { groups, searched } = await candidatesFor(suburbs, state);

  const unsized = groups.filter((g) => !g.members && !g.proven).map((g) => g.slug);
  if (unsized.length) await sizeUnknown(unsized);

  return Response.json({
    ok: true,
    groups,
    searched: searchConfigured() && searched,
    sizing: unsized.length,
  });
}
