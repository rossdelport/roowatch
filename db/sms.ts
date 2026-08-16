/**
 * SMS delivery. Supports Twilio or ClickSend, whichever is configured.
 * Set TWILIO_* or CLICKSEND_* secrets and the right one is used.
 */

/** Australian mobiles to E.164, e.g. 0406 688 617 -> +61406688617 */
export function toE164(raw: string): string | null {
  const digits = String(raw ?? "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits.length >= 9 ? digits : null;
  if (digits.startsWith("61") && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("4")) return `+61${digits}`;
  return null;
}

type SmsResult = { ok: boolean; provider: string; error?: string };

/** Base36, no vowels, so a code can never spell something unfortunate. */
const CODE_ALPHABET = "0123456789bcdfghjklmnpqrstvwxyz";

export function newShortCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * One text, one billable segment.
 *
 * A segment is 160 characters, but only while every character is in the GSM 7
 * bit alphabet. A single smart quote or emoji flips the whole message to UCS-2
 * and the limit drops to 70, which silently doubles or triples the bill. So we
 * strip to plain ASCII first and then hard cap the length.
 *
 * The link has to be ours and short. A Facebook permalink is about 70
 * characters and would eat half the message on its own.
 */
const SEGMENT = 160;

export function smsBody(postText: string, shortCode: string): string {
  const link = `https://roowatch.com.au/l/${shortCode}`;
  const prefix = "RooWatch lead: ";
  const room = SEGMENT - prefix.length - link.length - 2; // 2 for ". " before the link

  const clean = String(postText ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const snippet = clean.length > room ? `${clean.slice(0, room - 3).trimEnd()}...` : clean;
  return `${prefix}${snippet}. ${link}`.slice(0, SEGMENT);
}

async function sendViaTwilio(to: string, body: string): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_FROM || "RooWatch";
  const form = new URLSearchParams({ To: to, From: from, Body: body });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, provider: "twilio", error: `${res.status} ${detail.slice(0, 200)}` };
  }
  return { ok: true, provider: "twilio" };
}

async function sendViaClickSend(to: string, body: string): Promise<SmsResult> {
  const user = process.env.CLICKSEND_USERNAME!;
  const key = process.env.CLICKSEND_API_KEY!;
  const from = process.env.CLICKSEND_FROM || "RooWatch";

  const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${user}:${key}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ source: "roowatch", from, to, body }] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, provider: "clicksend", error: `${res.status} ${detail.slice(0, 200)}` };
  }
  return { ok: true, provider: "clicksend" };
}

export function smsProvider(): "twilio" | "clicksend" | null {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return "twilio";
  if (process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_API_KEY) return "clicksend";
  return null;
}

export async function sendSms(rawTo: string, body: string): Promise<SmsResult> {
  const provider = smsProvider();
  if (!provider) return { ok: false, provider: "none", error: "sms_not_configured" };

  const to = toE164(rawTo);
  if (!to) return { ok: false, provider, error: "bad_number" };

  const text = body.length > 320 ? `${body.slice(0, 317)}...` : body;
  try {
    return provider === "twilio"
      ? await sendViaTwilio(to, text)
      : await sendViaClickSend(to, text);
  } catch (err) {
    return {
      ok: false,
      provider,
      error: err instanceof Error ? err.message : "send_failed",
    };
  }
}
