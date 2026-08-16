import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { createSession, sendEmail, sessionCookie } from "../../../../db/auth";
import { hashPassword, passwordProblem } from "../../../../db/password";
import { profiles, users } from "../../../../db/schema";
import { toE164 } from "../../../../db/sms";
import { isKnownState } from "../../../../db/trades";

const NOTIFY = ["ross@roowatch.com.au", "rossdelport1998@gmail.com"];

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const email = clean(body.email, 200).toLowerCase();
  const password = String(body.password ?? "");
  const name = clean(body.name, 80);
  const businessName = clean(body.businessName, 120);
  const phone = clean(body.phone, 40);
  const trade = clean(body.trade, 60);
  const state = clean(body.state, 60);

  if (!/.+@.+\..+/.test(email)) {
    return Response.json({ error: "bad_email" }, { status: 400 });
  }
  const weak = passwordProblem(password);
  if (weak) return Response.json({ error: "weak_password", message: weak }, { status: 400 });
  if (name.length < 2) return Response.json({ error: "bad_name" }, { status: 400 });
  if (businessName.length < 2) return Response.json({ error: "bad_business" }, { status: 400 });
  if (!toE164(phone)) return Response.json({ error: "bad_phone" }, { status: 400 });
  if (trade.length < 2) return Response.json({ error: "bad_trade" }, { status: 400 });
  if (!isKnownState(state)) return Response.json({ error: "bad_state" }, { status: 400 });

  const db = getDb();
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // Never let a signup claim an address that already has an account. An older
  // member may have no password yet, so they log in with an email link and
  // set a password from Settings.
  if (taken) return Response.json({ error: "email_taken" }, { status: 409 });

  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email,
    name,
    passwordHash: await hashPassword(password),
  });
  // The state seeds the location question in setup, so the member only has to
  // add their suburbs rather than type it all again.
  await db.insert(profiles).values({
    userId: id,
    businessName,
    trade,
    state,
    alertPhone: phone,
    // They gave us a mobile at signup, so use it. Text alerts are the point of
    // the product for someone up a ladder. Settings has the off switch.
    smsEnabled: 1,
    location: state,
  });

  const token = await createSession(id);

  await sendEmail(
    NOTIFY,
    `New RooWatch account: ${businessName}`,
    [
      "Someone just created an account.",
      "",
      `Name: ${name}`,
      `Business: ${businessName}`,
      `Trade: ${trade}`,
      `State: ${state}`,
      `Email: ${email}`,
      `Phone: ${phone}`,
      "",
      "They are in the setup wizard now. Call them today.",
    ].join("\n")
  );

  await sendEmail(
    email,
    "Welcome to RooWatch",
    [
      `G'day ${name},`,
      "",
      "Your RooWatch account is ready.",
      "",
      "Next step: add the Facebook groups you want us to watch. We start watching the moment you finish setup.",
      "",
      "https://roowatch.com.au/dashboard",
      "",
      "Reply to this email if you get stuck. I read every one.",
      "",
      "Ross from RooWatch",
    ].join("\n")
  );

  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie(token) } }
  );
}
