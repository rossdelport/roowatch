import { currentUser, isAdminEmail } from "./auth";

/**
 * Admin access follows Ross's signed-in session.
 *
 * This keeps the admin tools private without asking for a second password on
 * every visit. A normal member session still gets refused here.
 */
export async function requireAdmin(request: Request) {
  const user = await currentUser(request);
  if (!user || !isAdminEmail(user.email)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
