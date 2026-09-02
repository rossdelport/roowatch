import { currentUser } from "../../../../db/auth";
import { candidatesFor, collectCatalogue, sizeUnknown, waitingFor } from "../../../../db/catalogue";
import { searchConfigured } from "../../../../db/groupsearch";
import { resolvePlaces } from "../../../../db/gazetteer";
import { isKnownState } from "../../../../db/trades";

/**
 * The groups we hand a member during setup, so they never have to go hunting.
 *
 * Catalogue first, which is instant and free. Search only when we do not hold
 * enough for their patch, and whatever it finds is filed for the next member.
 *
 * Anything we have never read is queued for a one off verification scan.
 * The wizard polls here while that runs, and each poll reads whatever has
 * finished, so verified groups appear within seconds of Bright Data
 * answering rather than waiting for the next five minute cron.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    state?: string;
    suburbs?: string[];
    trade?: string;
  };
  const state = String(body.state ?? "").trim();
  const suburbs = (body.suburbs ?? []).map((s) => String(s).trim()).filter(Boolean);
  const trade = String(body.trade ?? "").trim().slice(0, 80);

  // The wizard is client-side, so do not let a hand-built request search an
  // arbitrary suburb under the wrong state. Canonical places also stop a
  // typo or a country name becoming a Brave query and a catalogue row.
  if (!isKnownState(state) || !suburbs.length) {
    console.error("group_search_scope_rejected", { state, suburbs: suburbs.length });
    return Response.json({ ok: true, groups: [], searched: false, pending: 0, sizing: 0 });
  }
  const canonical = await resolvePlaces(suburbs, state);
  if (canonical.state !== state || !canonical.suburbs.length) {
    console.error("group_search_places_rejected", { state, suburbs });
    return Response.json({ ok: true, groups: [], searched: false, pending: 0, sizing: 0 });
  }

  // Read any verification that has finished since the last poll, so the
  // answer below already includes it.
  try {
    await collectCatalogue();
  } catch (error) {
    console.error("catalogue_collect_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { groups, searched } = await candidatesFor(canonical.suburbs, state, 0, trade);

  // Everything filed for their patch that nobody has read yet, whoever found
  // it. One snapshot answers both questions at once: is it public, and how
  // big is it. Empty checks are free, so the quiet ones cost nothing.
  // sizeUnknown skips anything already queued, so polling does not re-buy it.
  const waiting = await waitingFor(canonical.suburbs, state, 0);
  if (waiting.length) await sizeUnknown(waiting);

  return Response.json({
    ok: true,
    groups,
    searched: searchConfigured() && searched,
    // How many are still being verified. The wizard waits on this rather than
    // showing a group before we know anybody can read it.
    pending: waiting.length,
    sizing: waiting.length,
  });
}
