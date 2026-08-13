import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./index";
import { sendEmail } from "./auth";
import { alerts, groups, profiles, seenPosts, sources, users } from "./schema";

export type FetchedPost = {
  id: string;
  text: string;
  url: string;
  author: string;
  postedAt: string;
};

const SEEN_TTL_DAYS = 14;

/** Pull recent posts for one group through the Apify actor. */
export async function fetchPosts(sourceUrl: string): Promise<FetchedPost[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("apify_not_configured");

  const actor = process.env.APIFY_ACTOR || "apify~facebook-groups-scraper";
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&timeout=120&memory=1024`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url: sourceUrl }],
        resultsLimit: 20,
        viewOption: "CHRONOLOGICAL",
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`apify_${res.status}`);
  }
  const items = (await res.json()) as Record<string, unknown>[];

  return items
    .map((item) => {
      const text = String(item.text ?? item.message ?? item.postText ?? "").trim();
      const url = String(item.url ?? item.postUrl ?? item.topLevelUrl ?? "").trim();
      const id = String(item.postId ?? item.id ?? url ?? text.slice(0, 80));
      const author =
        typeof item.user === "object" && item.user
          ? String((item.user as Record<string, unknown>).name ?? "")
          : String(item.authorName ?? "");
      const postedAt = String(item.time ?? item.date ?? "");
      return { id, text, url, author, postedAt };
    })
    .filter((p) => p.id && p.text.length > 10);
}

/** Decide whether a post is a lead for one member. Claude first, keywords as fallback. */
export async function classifyPost(
  post: FetchedPost,
  member: { services: string; location: string; brief: string }
): Promise<{ match: boolean; reason: string }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const wants = [member.brief, member.services].filter(Boolean).join(". ");

  if (anthropicKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 150,
          messages: [
            {
              role: "user",
              content: `You check Facebook group posts for a local business.

The business: ${wants}
Their area: ${member.location}

The post: "${post.text.slice(0, 1200)}"

Is this post a sales lead for the business? A lead means the poster wants to hire, buy, or get a recommendation for this kind of service. Small talk, jokes, spam, people offering their own services, and unrelated topics are not leads.

Reply with only JSON: {"match": true or false, "reason": "one short plain sentence"}`,
            },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          content?: { type: string; text?: string }[];
        };
        const text = data.content?.find((c) => c.type === "text")?.text ?? "";
        const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        return {
          match: Boolean(parsed.match),
          reason: String(parsed.reason ?? "").slice(0, 200),
        };
      }
    } catch {
      // fall through to keywords
    }
  }

  const keywords = wants
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3);
  const hay = post.text.toLowerCase();
  const asking = /recommend|looking for|anyone know|who do|need a|quote|hire/.test(hay);
  const hit = keywords.find((k) => hay.includes(k));
  if (asking && hit) {
    return { match: true, reason: `They are asking for ${hit}.` };
  }
  return { match: false, reason: "" };
}

/** Run one source end to end: fetch, dedup, match per member, alert. */
export async function processSource(sourceId: number) {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) return { error: "no_source" };

  const summary = { posts: 0, fresh: 0, matches: 0, error: "" };
  try {
    const posts = await fetchPosts(source.url);
    summary.posts = posts.length;

    // dedup against seen_posts
    const ids = posts.map((p) => `${source.id}:${p.id}`.slice(0, 190));
    const already = ids.length
      ? await db.select().from(seenPosts).where(inArray(seenPosts.id, ids))
      : [];
    const seenIds = new Set(already.map((r) => r.id));
    const fresh = posts.filter((p, i) => !seenIds.has(ids[i]));
    summary.fresh = fresh.length;

    for (const post of fresh) {
      await db
        .insert(seenPosts)
        .values({ id: `${source.id}:${post.id}`.slice(0, 190), sourceId: source.id, seenAt: Date.now() })
        .onConflictDoNothing();
    }

    if (fresh.length) {
      // members watching a group with this name
      const watchers = await db
        .select({ userId: groups.userId })
        .from(groups)
        .where(and(sql`lower(${groups.name}) = lower(${source.groupName})`, eq(groups.status, "watching")));
      const watcherIds = [...new Set(watchers.map((w) => w.userId))];

      for (const userId of watcherIds) {
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
        if (!user || !profile) continue;

        for (const post of fresh) {
          const verdict = await classifyPost(post, {
            services: profile.services,
            location: profile.location,
            brief: profile.brief,
          });
          if (!verdict.match) continue;

          summary.matches += 1;
          await db.insert(alerts).values({
            userId,
            groupName: source.groupName,
            postText: post.text.slice(0, 1000),
            postUrl: post.url,
            reason: verdict.reason,
          });
          await sendEmail(
            user.email,
            `New lead in ${source.groupName}`,
            [
              "G'day,",
              "",
              `Someone just posted in ${source.groupName}:`,
              "",
              `"${post.text.slice(0, 600)}"`,
              "",
              verdict.reason ? `Why we sent this: ${verdict.reason}` : "",
              post.url ? `Open the post: ${post.url}` : "",
              "",
              "Reply fast. The first business to answer usually wins the job.",
              "",
              "Ross from RooWatch",
            ]
              .filter(Boolean)
              .join("\n")
          );
        }
      }
    }
  } catch (err) {
    summary.error = err instanceof Error ? err.message : "unknown";
  }

  await db
    .update(sources)
    .set({
      lastChecked: Date.now(),
      lastCount: summary.posts,
      lastMatches: summary.matches,
      lastError: summary.error,
    })
    .where(eq(sources.id, source.id));

  // expire old dedup fingerprints
  await db
    .delete(seenPosts)
    .where(lt(seenPosts.seenAt, Date.now() - SEEN_TTL_DAYS * 864e5));

  return summary;
}

/** Pick the most overdue active sources for a cron tick. */
export async function dueSources(limit: number) {
  const db = getDb();
  const all = await db.select().from(sources).where(eq(sources.active, 1));
  return all.sort((a, b) => a.lastChecked - b.lastChecked).slice(0, limit);
}
