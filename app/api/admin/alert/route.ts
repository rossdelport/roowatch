import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import { sendEmail } from "../../../../db/auth";
import { alerts, users } from "../../../../db/schema";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    groupName?: string;
    postText?: string;
    postUrl?: string;
    reason?: string;
  };
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const groupName = (body.groupName ?? "").trim();
  const postText = (body.postText ?? "").trim();
  if (!body.userId || !groupName || !postText) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const db = getDb();
  const [member] = await db
    .select()
    .from(users)
    .where(eq(users.id, body.userId))
    .limit(1);
  if (!member) return Response.json({ error: "no_member" }, { status: 404 });

  const postUrl = (body.postUrl ?? "").trim();
  const reason = (body.reason ?? "").trim();

  const [createdAlert] = await db.insert(alerts).values({
    userId: member.id,
    groupName,
    postText,
    postUrl,
    reason,
  }).returning({ id: alerts.id });

  const emailed = await sendEmail(
    member.email,
    `New lead in ${groupName}`,
    [
      "G'day,",
      "",
      `Someone just posted in ${groupName}:`,
      "",
      `"${postText}"`,
      "",
      reason ? `Why we sent this: ${reason}` : "",
      postUrl ? `Open the post: ${postUrl}` : "",
      "",
      "Reply fast. The first business to answer usually wins the job.",
      "",
      "Ross from RooWatch",
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (createdAlert) {
    await db
      .update(alerts)
      .set({ emailSent: emailed ? 1 : 0 })
      .where(eq(alerts.id, createdAlert.id));
  }

  return Response.json({ ok: true, emailed });
}
