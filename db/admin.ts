export async function requireAdmin(body: { password?: string }) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return Response.json({ error: "admin_not_configured" }, { status: 500 });
  }
  if (!body.password || body.password !== adminPassword) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
