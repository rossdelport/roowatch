import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { currentUser } from "../../../../db/auth";
import { profiles } from "../../../../db/schema";
import { BRIEF_AI_MAX } from "../../../../db/brief";
import { readWebsite } from "../../../../db/website";

/**
 * Writes the "what a good lead sounds like" brief for a member.
 *
 * The brief drives every match we make, so a vague one costs the member leads.
 * Most tradies will not write a good one from a blank box. We read their
 * website and turn it into the brief for them.
 */

export async function POST(request: Request) {
  const user = await currentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "ai_not_configured" }, { status: 503 });

  // Use what is on screen right now, not only what is saved, so the member can
  // fill in their website and press the button straight away.
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const [saved] = await getDb()
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const pick = (k: string, fallback: string) =>
    String(body[k] ?? "").trim() || fallback;

  const businessName = pick("businessName", saved?.businessName ?? "");
  const website = pick("website", saved?.website ?? "");
  const services = pick("services", saved?.services ?? "");
  const location = pick("location", saved?.location ?? "");
  // The setup wizard sends the trade before it is saved, so take theirs first.
  const trade = pick("trade", saved?.trade ?? "");

  if (!services && !website && !trade) {
    return Response.json({ error: "not_enough" }, { status: 400 });
  }

  const siteText = await readWebsite(website);

  const facts = [
    businessName && `Business name: ${businessName}`,
    trade && `Trade: ${trade}`,
    services && `What they do: ${services}`,
    location && `Where they work: ${location}`,
    siteText && `Their website says: "${siteText}"`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `You write a short brief for an Australian local business. We read Facebook group posts and use this brief to decide which posts are real leads for them.

${facts}

Write the brief as two paragraphs of plain text.

Paragraph one starts with "Someone in " and names their area. Then list the kinds of posts that ARE leads. Include the words a normal person would use, not trade words. Include people who describe the problem without naming the service.

Paragraph two starts with "Skip these: " and lists posts that are NOT leads. Always include people selling, other businesses offering the same service, and anyone outside their area.

Rules:
Use grade 3 English. Short sentences. Simple words.
Never use an em dash.
No headings. No bullet points. No lists. No markdown.
Under ${BRIEF_AI_MAX} characters in total. This is a hard limit.
Reply with the brief only. Do not add any other words.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    return Response.json({ error: "ai_failed" }, { status: 502 });
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  // A model that overshoots its own limit must not become a save that fails
  // for the member. Trim on a sentence boundary so the brief still reads well.
  let brief = (data.content?.find((c) => c.type === "text")?.text ?? "").trim();
  if (brief.length > BRIEF_AI_MAX) {
    const cut = brief.slice(0, BRIEF_AI_MAX);
    const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("\n"));
    brief = (lastStop > BRIEF_AI_MAX * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  if (!brief) return Response.json({ error: "ai_failed" }, { status: 502 });

  return Response.json({ brief });
}
