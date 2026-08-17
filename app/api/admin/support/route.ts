import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { sendEmail } from "../../../../db/auth";
import { planFor } from "../../../../db/plans";
import { profiles, supportMessages, users } from "../../../../db/schema";

/**
 * Every support conversation, and Ross's replies.
 *
 * Threads are ordered unread first, then by most recent, so the person who is
 * waiting is always at the top rather than buried under old chats.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: "list" | "reply" | "read";
    userId?: string;
    message?: string;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;

  const db = getDb();
  let flash = "";

  if (body.action === "reply" && body.userId) {
    const text = (body.message ?? "").trim().slice(0, 2000);
    if (text.length < 2) return Response.json({ error: "empty" }, { status: 400 });

    const [member] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!member) return Response.json({ error: "no_such_user" }, { status: 404 });

    await db.insert(supportMessages).values({
      userId: body.userId,
      fromAdmin: 1,
      body: text,
      readByAdmin: 1,
    });
    // Their thread is now answered as far as Ross is concerned.
    await db
      .update(supportMessages)
      .set({ readByAdmin: 1 })
      .where(eq(supportMessages.userId, body.userId));

    // Nobody sits watching a dashboard. Tell them it is there.
    const sent = await sendEmail(
      member.email,
      "Ross replied to your RooWatch message",
      [
        `G'day ${member.name || "there"},`,
        "",
        text,
        "",
        "Reply from the Support tab in your dashboard:",
        "https://roowatch.com.au/dashboard",
        "",
        "Ross from RooWatch",
      ].join("\n")
    );
    flash = sent ? `Replied to ${member.email}.` : "Saved, but the email did not send.";
  }

  if (body.action === "read" && body.userId) {
    await db
      .update(supportMessages)
      .set({ readByAdmin: 1 })
      .where(eq(supportMessages.userId, body.userId));
  }

  const all = await db.select().from(supportMessages).orderBy(asc(supportMessages.id));
  const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
  const allProfiles = await db.select().from(profiles);

  const threads = allUsers
    .map((u) => {
      const mine = all.filter((m) => m.userId === u.id);
      if (!mine.length) return null;
      const profile = allProfiles.find((p) => p.userId === u.id) ?? null;
      const last = mine[mine.length - 1];
      return {
        userId: u.id,
        email: u.email,
        name: u.name,
        avatar: u.avatar,
        businessName: profile?.businessName ?? "",
        plan: planFor(profile?.plan).name,
        unread: mine.filter((m) => m.fromAdmin === 0 && m.readByAdmin === 0).length,
        lastAt: last.createdAt,
        lastFromAdmin: last.fromAdmin === 1,
        preview: last.body.slice(0, 120),
        messages: mine,
      };
    })
    .filter((t) => t !== null);

  // Waiting first, then whoever spoke most recently.
  threads.sort((a, b) => {
    if (Boolean(b.unread) !== Boolean(a.unread)) return b.unread ? 1 : -1;
    return b.lastAt.localeCompare(a.lastAt);
  });

  return Response.json({
    ok: true,
    flash,
    threads,
    waiting: threads.filter((t) => t.unread > 0).length,
  });
}
