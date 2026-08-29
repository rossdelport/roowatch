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

  const { groups, searched, pending } = await candidatesFor(suburbs, state);

  // Everything the search just found, plus anything catalogued we have never
  // read. One snapshot answers both questions at once: is it public, and how
  // big is it. Empty checks are free, so the quiet ones cost nothing.
  const unchecked = [
    ...pending,
    ...groups.filter((g) => !g.members && !g.proven).map((g) => g.slug),
  ];
  if (unchecked.length) await sizeUnknown(unchecked);

  return Response.json({
    ok: true,
    groups,
    searched: searchConfigured() && searched,
    // How many are still being verified. The wizard waits on this rather than
    // showing a group before we know anybody can read it.
    pending: pending.length,
    sizing: unchecked.length,
  });
}
