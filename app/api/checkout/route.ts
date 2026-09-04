/**
 * RooWatch is closed and no longer accepts new subscriptions.
 *
 * Keep this route as a hard stop because an old dashboard tab or a saved
 * client request can still reach it after the public buttons are removed.
 */
export async function POST() {
  return Response.json(
    { error: "service_closed", message: "RooWatch is no longer accepting new subscriptions." },
    { status: 410 },
  );
}
