import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser, sendEmail } from "../../../../db/auth";
import { planFor } from "../../../../db/plans";
import { profiles, supportMessages } from "../../../../db/schema";

/** The member's own conversation. Reading it marks Ross's replies as seen. */
export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.userId, user.id))
    .orderBy(asc(supportMessages.id));

  // Opening the thread is what counts as reading it.
  if (messages.some((m) => m.fromAdmin === 1 && m.readByMember === 0)) {
    await db
      .update(supportMessages)
      .set({ readByMember: 1 })
      .where(and(eq(supportMessages.userId, user.id), eq(supportMessages.fromAdmin, 1)));
  }

  return Response.json({ ok: true, messages });
}

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { message?: string };
  const text = (body.message ?? "").trim().slice(0, 2000);
  if (text.length < 2) return Response.json({ error: "empty" }, { status: 400 });

  const db = getDb();
  await db.insert(supportMessages).values({
    userId: user.id,
    fromAdmin: 0,
    body: text,
    readByMember: 1,
  });

  const [profile] = await db
    .select({ businessName: profiles.businessName, plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const plan = planFor(profile?.plan);

  // A message nobody sees is not support. Ross gets emailed every time, and
  // the plan is in the subject so a Scale customer is obvious at a glance.
  await sendEmail(
    ["ross@roowatch.com.au", "rossdelport1998@gmail.com"],
    `[${plan.name}] Support message from ${profile?.businessName || user.email}`,
    [
      `${user.name || user.email} wrote:`,
      "",
      text,
      "",
      `Plan: ${plan.name}`,
      `Email: ${user.email}`,
      "",
      "Reply from the Support tab in your dashboard.",
    ].join("\n")
  );

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.userId, user.id))
    .orderBy(asc(supportMessages.id));
  return Response.json({ ok: true, messages });
}
