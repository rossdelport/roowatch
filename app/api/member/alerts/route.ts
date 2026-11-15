import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { alerts, supportMessages } from "../../../../db/schema";

/**
 * "Not a lead".
 *
 * Members were texted about a couch for sale and a bloke looking for work,
 * and the only way anybody found out was Ross being told on the phone. With
 * no way to say "this one was wrong" there was no way to know how often the
 * filter gets it wrong, either.
 *
 * The wrong lead goes into the member's support thread, where Ross already
 * reads and answers, with the post and the reason we gave for sending it.
 * Then it comes off their list. Counting those messages against the leads
 * sent is the accuracy number.
 */
export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { alertId?: number };
  const alertId = Number(body.alertId);
  if (!Number.isInteger(alertId)) return Response.json({ error: "bad_request" }, { status: 400 });

  const db = getDb();
  const [alert] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, user.id)))
    .limit(1);
  if (!alert) return Response.json({ error: "not_yours" }, { status: 404 });

  // Written before the delete. If the delete then fails they can press the
  // button again; the other way round the lead is gone and nobody was told.
  await db.insert(supportMessages).values({
    userId: user.id,
    fromAdmin: 0,
    body: [
      "Not a lead.",
      "",
      `Group: ${alert.groupName}`,
      `Post: "${alert.postText.slice(0, 600)}"`,
      alert.reason ? `Why we sent it: ${alert.reason}` : "",
      alert.postUrl ? `Link: ${alert.postUrl}` : "",
    ]
      .filter((line, i) => line || i === 1)
      .join("\n"),
    // They wrote it, so there is nothing for them to read.
    readByMember: 1,
  });
  console.warn(JSON.stringify({ event: "lead_marked_wrong", userId: user.id, alertId, group: alert.groupName }));

  await db.delete(alerts).where(and(eq(alerts.id, alertId), eq(alerts.userId, user.id)));
  return Response.json({ ok: true });
}
