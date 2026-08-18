import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./index";
import { sendEmail } from "./auth";
import { groupSlug, postPermalink } from "./fbgroups";
import { postLimit, smsLimit } from "./plans";
import { newShortCode, sendSms, smsBody, smsProvider } from "./sms";
import { alerts, groups, profiles, seenPosts, sources, users } from "./schema";

export type FetchedPost = {
  id: string;
  text: string;
  url: string;
  author: string;
  postedAt: string;
};

const SEEN_TTL_DAYS = 14;
/**
 * resultsLimit is a cap for the whole run, not for each group. With one flat
 * number a busy group starves the quiet ones, so the cap grows with the group
 * count. It only stops a runaway catch up. We still pay per post returned, and
 * onlyPostsNewerThan is what keeps that number small.
 */
const POSTS_PER_GROUP_CAP = 25;

/* ---------------------------------------------------------------- Bright Data
 *
 * Bright Data replaced Apify because Apify billed a full post price for every
 * group it looked at, even when there was nothing new. Bright Data charges only
 * for posts it actually delivers, so a quiet check is free. See
 * docs/scraper-decision.md for the measurements.
 *
 * The API is asynchronous: trigger a collection, get a snapshot id, come back
 * for the rows. The cron owns that dance, see app/api/cron/scan/route.ts.
 */

const BD_DATASET = "gd_lz11l67o2cb3r0lkj3"; // Facebook - Posts by group URL
const BD_API = "https://api.brightdata.com/datasets/v3";

function bdHeaders() {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) throw new Error("brightdata_not_configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** Kick off one collection covering every group. Returns the snapshot id. */
export async function bdTrigger(sourceUrls: string[], since: Date): Promise<string> {
  const body = sourceUrls.map((url) => ({
    url,
    start_date: since.toISOString().replace(/\.\d+Z$/, ".000Z"),
    end_date: "",
    user_to_not_include: "",
  }));

  const res = await fetch(
    `${BD_API}/trigger?dataset_id=${BD_DATASET}&include_errors=true&limit_per_input=${POSTS_PER_GROUP_CAP}`,
    { method: "POST", headers: bdHeaders(), body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`brightdata_trigger_${res.status}`);

  const data = (await res.json()) as { snapshot_id?: string };
  if (!data.snapshot_id) throw new Error("brightdata_no_snapshot");
  return data.snapshot_id;
}

export type BdProgress = { status: string; records: number; errors: number };

export async function bdProgress(snapshotId: string): Promise<BdProgress> {
  const res = await fetch(`${BD_API}/progress/${snapshotId}`, { headers: bdHeaders() });
  if (!res.ok) throw new Error(`brightdata_progress_${res.status}`);
  const d = (await res.json()) as Partial<BdProgress>;
  return {
    status: String(d.status ?? "unknown"),
    records: Number(d.records ?? 0),
    errors: Number(d.errors ?? 0),
  };
}

/** What one group in a snapshot told us, beyond its posts. */
export type GroupFacts = {
  /** The group's real name on Facebook, when a post carried it. */
  name: string;
  /** Why we got nothing, in Facebook's words. Empty when all is well. */
  error: string;
  /** True when public Bright Data says only members may read it. Route to VPS. */
  private: boolean;
  /** A row explicitly referred to this input, including a no-post response. */
  answered: boolean;
};

/**
 * Read a finished snapshot and bucket the posts by group slug.
 *
 * Rows without a post_id are not all the same thing. Some say "no posts in
 * that window", which is normal and free. Others say "Private group: only
 * members can see who's in the group", which means we will never read that
 * group no matter how long we wait. Both used to be dropped on the floor, so
 * a member could watch a private group for a month and never be told.
 */
export async function bdCollect(
  snapshotId: string,
  sourceUrls: string[]
): Promise<{ posts: Map<string, FetchedPost[]>; facts: Map<string, GroupFacts> }> {
  const res = await fetch(`${BD_API}/snapshot/${snapshotId}?format=json`, {
    headers: bdHeaders(),
  });
  if (!res.ok) throw new Error(`brightdata_snapshot_${res.status}`);

  const raw = (await res.text()).trim();
  let rows: Record<string, unknown>[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Bright Data can answer with newline delimited JSON.
      rows = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Record<string, unknown>[];
    }
  }

  const out = new Map<string, FetchedPost[]>();
  for (const url of sourceUrls) out.set(groupSlug(url), []);

  for (const row of rows) {
    const id = String(row.post_id ?? "").trim();
    if (!id) continue; // an empty period notice, not a post

    const text = String(row.content ?? "").trim();
    if (text.length <= 10) continue;

    const url = String(row.url ?? "");
    const from = String(row.group_url ?? row.input_url ?? url);
    const bucket = out.get(groupSlug(from)) ?? out.get(groupSlug(url));
    if (!bucket) continue;

    bucket.push({
      id,
      text,
      url,
      author: String(row.user_username_raw ?? ""),
      postedAt: String(row.date_posted ?? ""),
    });
  }
  return { posts: out, facts: readFacts(rows, sourceUrls) };
}

function readFacts(
  rows: Record<string, unknown>[],
  sourceUrls: string[]
): Map<string, GroupFacts> {
  const facts = new Map<string, GroupFacts>();
  for (const url of sourceUrls) {
    facts.set(groupSlug(url), { name: "", error: "", private: false, answered: false });
  }

  for (const row of rows) {
    const input = row.input as { url?: string } | undefined;
    const from = String(input?.url ?? row.input_url ?? row.group_url ?? row.url ?? "");
    const fact = facts.get(groupSlug(from));
    if (!fact) continue;
    fact.answered = true;

    const name = String(row.group_name ?? "").trim();
    if (name) fact.name = name;

    const error = String(row.error ?? "").trim();
    if (!error) continue;
    // "Posts for the specified period were not found" is the happy path: we
    // asked about the last few minutes and nothing was posted.
    if (/not found/i.test(error)) continue;
    fact.error = error;
    if (/private/i.test(error)) fact.private = true;
  }
  return facts;
}

/** Pull recent posts for one group through the Apify actor. */
/**
 * One Apify run can cover many groups. The run start fee is charged once, and
 * the date window means we only pay for posts we have not seen. Returns posts
 * keyed by group slug so each source picks up its own.
 */
export async function fetchPostsBatch(
  sourceUrls: string[],
  newerThan: string
): Promise<Map<string, FetchedPost[]>> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("apify_not_configured");
  const actor = process.env.APIFY_ACTOR || "apify~facebook-groups-scraper";

  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}&timeout=240&memory=1024`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: sourceUrls.map((url) => ({ url })),
        onlyPostsNewerThan: newerThan,
        viewOption: "CHRONOLOGICAL",
        resultsLimit: Math.max(100, sourceUrls.length * POSTS_PER_GROUP_CAP),
      }),
    }
  );
  if (!res.ok) throw new Error(`apify_${res.status}`);
  const items = (await res.json()) as Record<string, unknown>[];

  const out = new Map<string, FetchedPost[]>();
  for (const url of sourceUrls) out.set(groupSlug(url), []);

  for (const item of items) {
    const from = String(item.facebookUrl ?? item.inputUrl ?? "");
    const slug = groupSlug(from);
    const bucket = out.get(slug);
    if (!bucket) continue;
    const post = toPost(item, from);
    if (post) bucket.push(post);
  }
  return out;
}

/** Shape one raw Apify item into a post, or null if it is not usable. */
function toPost(item: Record<string, unknown>, sourceUrl: string): FetchedPost | null {
  const text = String(item.text ?? item.message ?? item.postText ?? "").trim();
  const rawUrl = String(item.url ?? item.postUrl ?? item.topLevelUrl ?? "").trim();
  const id = String(item.postId ?? item.id ?? rawUrl ?? text.slice(0, 80));
  if (!id || text.length <= 10) return null;
  const url = postPermalink(
    rawUrl,
    String(item.facebookUrl ?? item.inputUrl ?? sourceUrl ?? ""),
    String(item.legacyId ?? item.postId ?? item.id ?? "")
  );
  const author =
    typeof item.user === "object" && item.user
      ? String((item.user as Record<string, unknown>).name ?? "")
      : String(item.authorName ?? "");
  return { id, text, url, author, postedAt: String(item.time ?? item.date ?? "") };
}

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
      const rawUrl = String(item.url ?? item.postUrl ?? item.topLevelUrl ?? "").trim();
      const id = String(item.postId ?? item.id ?? rawUrl ?? text.slice(0, 80));
      const url = postPermalink(
        rawUrl,
        String(item.facebookUrl ?? item.inputUrl ?? sourceUrl ?? ""),
        String(item.legacyId ?? item.postId ?? item.id ?? "")
      );
      const author =
        typeof item.user === "object" && item.user
          ? String((item.user as Record<string, unknown>).name ?? "")
          : String(item.authorName ?? "");
      const postedAt = String(item.time ?? item.date ?? "");
      return { id, text, url, author, postedAt };
    })
    .filter((p) => p.id && p.text.length > 10);
}

/**
 * Text the member, if they want texts and have not used up their allowance.
 *
 * Email is the record and always goes out. A text is only the nudge that gets
 * a tradie off a roof and onto their phone, so it must never be the reason an
 * alert fails: every failure here is swallowed.
 */
async function maybeText(
  alert: { id: number; smsSent: number; shortCode: string },
  profile: { userId: string; alertPhone: string; smsEnabled: number; plan: string; smsUsed: number; smsMonth: string },
  post: FetchedPost,
  groupName: string
) {
  if (alert.smsSent === 1) return;
  if (!profile.smsEnabled || !profile.alertPhone) return;
  if (!smsProvider()) return;

  const month = new Date().toISOString().slice(0, 7);
  const used = profile.smsMonth === month ? profile.smsUsed : 0;
  if (used >= smsLimit(profile.plan)) return;

  const db = getDb();
  try {
    const body = smsBody(post.text || `new lead in ${groupName}`, alert.shortCode);
    const result = await sendSms(profile.alertPhone, body);
    if (!result.ok) return;

    // Count it and mark it before anything else can fail, so a retry of this
    // alert can never text the same member about the same post twice.
    await db.update(alerts).set({ smsSent: 1 }).where(eq(alerts.id, alert.id));
    await db
      .update(profiles)
      .set({ smsUsed: used + 1, smsMonth: month })
      .where(eq(profiles.userId, profile.userId));
  } catch {
    // The email still goes. A texting outage is not a lost lead.
  }
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
export async function processSource(sourceId: number, prefetched?: FetchedPost[]) {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) return { error: "no_source" };

  // Older deployments could already contain duplicate source URLs. Only the
  // oldest row owns a URL; skipping the others prevents duplicate alerts while
  // still allowing the duplicate to become canonical if the original is
  // removed later.
  const [canonical] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.url, source.url))
    .orderBy(asc(sources.id))
    .limit(1);
  if (canonical && canonical.id !== source.id) {
    await db
      .update(sources)
      .set({ lastChecked: Date.now(), lastError: "duplicate_source" })
      .where(eq(sources.id, source.id));
    return { posts: 0, fresh: 0, matches: 0, error: "duplicate_source" };
  }

  const summary = { posts: 0, fresh: 0, matches: 0, error: "" };
  try {
    const posts = prefetched ?? (await fetchPosts(source.url));
    summary.posts = posts.length;

    // dedup against seen_posts
    const ids = posts.map((p) => `${source.id}:${p.id}`.slice(0, 190));
    const already = ids.length
      ? await db.select().from(seenPosts).where(inArray(seenPosts.id, ids))
      : [];
    const seenIds = new Set(already.map((r) => r.id));
    const fresh = posts.filter(
      (p, i) => !seenIds.has(ids[i]) && ids.indexOf(ids[i]) === i
    );
    summary.fresh = fresh.length;

    if (fresh.length) {
      // members watching a group with this name
      const watchers = await db
        .select({ userId: groups.userId })
        .from(groups)
        .where(
          and(
            eq(groups.status, "watching"),
            sql`(${groups.sourceId} = ${source.id} OR (${groups.sourceId} IS NULL AND lower(${groups.name}) = lower(${source.groupName})))`
          )
        );
      const watcherIds = [...new Set(watchers.map((w) => w.userId))];

      for (const post of fresh) {
        const postKey = `${source.id}:${post.id}`.slice(0, 190);
        let postOk = true;

        for (const userId of watcherIds) {
          const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
          const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
          if (!user || !profile) continue;

          // Fair use. Reading a post costs money, so a member who is far past
          // their monthly allowance stops being charged for until next month.
          // The allowance comes from their plan, so this doubles as the cap on
          // what any one member can ever cost us.
          const month = new Date().toISOString().slice(0, 7);
          const used = profile.usageMonth === month ? profile.postsUsed : 0;
          if (used >= postLimit(profile.plan)) continue;
          await db
            .update(profiles)
            .set({ postsUsed: used + 1, usageMonth: month })
            .where(eq(profiles.userId, userId));

          try {
            const verdict = await classifyPost(post, {
              services: profile.services,
              location: profile.location,
              brief: profile.brief,
            });
            if (!verdict.match) continue;

            summary.matches += 1;

            // Keep the alert row as an idempotent outbox record. If delivery
            // fails, the next scan retries the email without creating another
            // alert in the member's dashboard.
            let [alert] = await db
              .select({
                id: alerts.id,
                emailSent: alerts.emailSent,
                smsSent: alerts.smsSent,
                shortCode: alerts.shortCode,
              })
              .from(alerts)
              .where(and(eq(alerts.userId, userId), eq(alerts.postKey, postKey)))
              .limit(1);
            if (!alert) {
              await db
                .insert(alerts)
                .values({
                  userId,
                  groupName: source.groupName,
                  postText: post.text.slice(0, 1000),
                  postUrl: post.url,
                  reason: verdict.reason,
                  postKey,
                  shortCode: newShortCode(),
                })
                .onConflictDoNothing();
              [alert] = await db
                .select({
                  id: alerts.id,
                  emailSent: alerts.emailSent,
                  smsSent: alerts.smsSent,
                  shortCode: alerts.shortCode,
                })
                .from(alerts)
                .where(and(eq(alerts.userId, userId), eq(alerts.postKey, postKey)))
                .limit(1);
            }
            if (!alert) throw new Error("alert_not_persisted");
            await maybeText(alert, profile, post, source.groupName);
            if (alert.emailSent === 1) continue;

            const emailed = await sendEmail(
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
            if (!emailed) throw new Error("email_delivery_failed");

            await db
              .update(alerts)
              .set({ emailSent: 1 })
              .where(eq(alerts.id, alert.id));
          } catch (err) {
            postOk = false;
            summary.error ||= err instanceof Error ? err.message : "alert_failed";
          }
        }

        // Only fingerprint a post after every matching member has received a
        // durable alert and a successful email result. Failed work is retried
        // on the next scan instead of being silently lost.
        if (postOk) {
          await db
            .insert(seenPosts)
            .values({
              id: postKey,
              sourceId: source.id,
              seenAt: Date.now(),
              text: post.text.slice(0, 600),
              url: post.url,
              author: post.author.slice(0, 120),
            })
            .onConflictDoNothing();
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
  const all = await db
    .select()
    .from(sources)
    .where(and(eq(sources.active, 1), eq(sources.visibility, "public")));
  const selected = [];
  const urls = new Set<string>();
  for (const source of all.sort((a, b) => a.lastChecked - b.lastChecked)) {
    if (urls.has(source.url)) continue;
    urls.add(source.url);
    selected.push(source);
    if (selected.length >= limit) break;
  }
  return selected;
}
