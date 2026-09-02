import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./index";
import {
  buildLeadClassifierPrompt,
  buildLeadClassifierRequest,
  hasLeadProfile,
  LEAD_FILTER_MODEL,
  LEAD_FILTER_REQUEST_TIMEOUT_MS,
  LEAD_VERIFY_MODEL_DEFAULT,
  LeadFilterError,
  leadResponseError,
  obviousNonLeadReason,
  parseLeadDecision,
  rejectedLeadDecision,
  type LeadDecision,
  type LeadMemberProfile,
  type LeadPass,
} from "./leadfilter";
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
const BD_REQUEST_TIMEOUT_MS = 30_000;

function bdHeaders() {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) throw new Error("brightdata_not_configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** One group in a trigger, with its own look-back when it needs one. */
export type BdInput = string | { url: string; since: Date };

/**
 * Kick off one collection covering every group. Returns the snapshot id.
 *
 * Each group carries its own start date. A group that missed a run asks for
 * a wider window without dragging every other group in the snapshot back
 * with it, which is what happened when one date covered the whole batch.
 */
export async function bdTrigger(inputs: BdInput[], since?: Date): Promise<string> {
  const stamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, ".000Z");
  const body = inputs.map((input) => {
    const url = typeof input === "string" ? input : input.url;
    const from = typeof input === "string" ? since : input.since;
    if (!from) throw new Error("brightdata_no_start_date");
    return {
      url,
      start_date: stamp(from),
      end_date: "",
      user_to_not_include: "",
    };
  });

  const res = await fetch(
    `${BD_API}/trigger?dataset_id=${BD_DATASET}&include_errors=true&limit_per_input=${POSTS_PER_GROUP_CAP}`,
    {
      method: "POST",
      headers: bdHeaders(),
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`brightdata_trigger_${res.status}`);

  const data = (await res.json()) as { snapshot_id?: string };
  if (!data.snapshot_id) throw new Error("brightdata_no_snapshot");
  return data.snapshot_id;
}

export type BdProgress = { status: string; records: number; errors: number };

export async function bdProgress(snapshotId: string): Promise<BdProgress> {
  const res = await fetch(`${BD_API}/progress/${snapshotId}`, {
    headers: bdHeaders(),
    signal: AbortSignal.timeout(BD_REQUEST_TIMEOUT_MS),
  });
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
  /** How many people are in it. 0 when no post has told us yet. */
  members: number;
  /** Why we got nothing, in Facebook's words. Empty when all is well. */
  error: string;
  /** True when Facebook says only members may read it. It will never work. */
  private: boolean;
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
    signal: AbortSignal.timeout(BD_REQUEST_TIMEOUT_MS),
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
    facts.set(groupSlug(url), { name: "", members: 0, error: "", private: false });
  }

  for (const row of rows) {
    const input = row.input as { url?: string } | undefined;
    const from = String(input?.url ?? row.group_url ?? row.url ?? "");
    const fact = facts.get(groupSlug(from));
    if (!fact) continue;

    const name = String(row.group_name ?? "").trim();
    if (name) fact.name = name;

    const members = Number(row.group_members ?? 0);
    if (Number.isFinite(members) && members > 0) fact.members = members;

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
    // The scanner reuses this profile row for the whole run.
    profile.smsUsed = used + 1;
    profile.smsMonth = month;
  } catch {
    // The email still goes. A texting outage is not a lost lead.
  }
}

/**
 * Decide whether a post is a lead for one member.
 *
 * This path is intentionally fail-closed. A keyword guess is worse than a
 * delayed lead: it spends the member's attention and makes the product look
 * broken. A failed or malformed model response is retried with the post on the
 * next scan instead of being turned into a false alert.
 */
export async function classifyPost(
  post: FetchedPost,
  member: LeadMemberProfile,
  context: { groupName: string }
): Promise<LeadDecision> {
  if (!hasLeadProfile(member)) {
    throw new LeadFilterError("lead_filter_profile_incomplete");
  }

  const obviousReject = obviousNonLeadReason(post.text);
  if (obviousReject) return rejectedLeadDecision(obviousReject);

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new LeadFilterError("lead_filter_not_configured");
  }

  // Every post gets the cheap read. Most are not leads and stop here.
  const first = await askLeadModel(anthropicKey, post, member, context, "first", LEAD_FILTER_MODEL);
  if (!first.match) return first;

  // The stronger model reads only the posts the cheap one liked, and a post
  // is a lead only when both say so. If this call fails the post is not
  // guessed at: the error is thrown, nothing is texted, and the next scan
  // tries again.
  const verifyModel = process.env.LEAD_VERIFY_MODEL?.trim() || LEAD_VERIFY_MODEL_DEFAULT;
  const second = await askLeadModel(anthropicKey, post, member, context, "verify", verifyModel);
  if (!second.match) {
    console.warn(JSON.stringify({
      event: "lead_verify_overruled",
      postId: post.id,
      firstReason: first.reason,
      secondReason: second.reason,
      confidence: second.confidence,
    }));
  }
  return second;
}

/** One structured read of one post by one model. Fails closed on anything odd. */
async function askLeadModel(
  anthropicKey: string,
  post: FetchedPost,
  member: LeadMemberProfile,
  context: { groupName: string },
  pass: LeadPass,
  model: string
): Promise<LeadDecision> {
  const prompt = buildLeadClassifierPrompt(post.text, member, context, pass);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(LEAD_FILTER_REQUEST_TIMEOUT_MS),
      body: JSON.stringify(buildLeadClassifierRequest(prompt, model)),
    });
  } catch {
    throw new LeadFilterError(`lead_filter_request_failed_${pass}`);
  }

  if (!res.ok) {
    console.warn(JSON.stringify({
      event: "lead_filter_http_error",
      pass,
      model,
      status: res.status,
      requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? "",
      // The API's own words. A day of 400s went undiagnosed without them.
      body: (await res.text().catch(() => "")).slice(0, 300),
    }));
    throw new LeadFilterError(`lead_filter_http_${res.status}_${pass}`);
  }

  let data: {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { output_tokens?: number };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new LeadFilterError("lead_filter_invalid_response");
  }
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  const diagnostics = {
    pass,
    model,
    stopReason: String(data.stop_reason ?? "unknown"),
    outputTokens: Number(data.usage?.output_tokens ?? 0),
    textLength: text.length,
    fenced: text.includes("```"),
    startsWithObject: text.trimStart().startsWith("{"),
    endsWithObject: text.trimEnd().endsWith("}"),
  };
  const stopError = leadResponseError(data.stop_reason);
  if (stopError) {
    console.warn(JSON.stringify({
      event: "lead_filter_contract_error",
      code: stopError,
      ...diagnostics,
    }));
    throw new LeadFilterError(stopError);
  }
  const decision = parseLeadDecision(text);
  if (!decision) {
    console.warn(JSON.stringify({
      event: "lead_filter_contract_error",
      code: "lead_filter_invalid_response",
      ...diagnostics,
    }));
    throw new LeadFilterError("lead_filter_invalid_response");
  }
  return decision;
}

type SourceRow = typeof sources.$inferSelect;
type UserRow = typeof users.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;

/**
 * Everything a whole scan needs to know about members, read once.
 *
 * A run covers every group we watch. Reading the watcher list, the user and
 * the profile again for each group multiplied a handful of small tables into
 * hundreds of queries a run, and every query is both a subrequest and rows
 * read against the plan's daily limit. The scanner does not need fresher data
 * than the start of its own run.
 */
export type ScanRun = {
  sources: Map<number, SourceRow>;
  /** Lowest id per URL. Only that row may alert, see processSource. */
  canonical: Map<string, number>;
  watching: { userId: string; sourceId: number | null; name: string }[];
  users: Map<string, UserRow>;
  profiles: Map<string, ProfileRow>;
  /** Groups that had nothing new and no change to record, written in one go. */
  quiet: number[];
};

export async function startScanRun(sourceIds: number[]): Promise<ScanRun> {
  const db = getDb();
  const run: ScanRun = {
    sources: new Map(),
    canonical: new Map(),
    watching: [],
    users: new Map(),
    profiles: new Map(),
    quiet: [],
  };

  for (const part of chunkList(sourceIds, 80)) {
    const rows = await db.select().from(sources).where(inArray(sources.id, part));
    for (const row of rows) run.sources.set(row.id, row);
  }

  // Every row for these URLs, not just the ones handed in, or a duplicate
  // could look canonical simply because its twin was not in this run.
  const urls = [...new Set([...run.sources.values()].map((row) => row.url))];
  for (const part of chunkList(urls, 80)) {
    const twins = await db
      .select({ id: sources.id, url: sources.url })
      .from(sources)
      .where(inArray(sources.url, part));
    for (const twin of twins) {
      const held = run.canonical.get(twin.url);
      if (held === undefined || twin.id < held) run.canonical.set(twin.url, twin.id);
    }
  }

  run.watching = await db
    .select({ userId: groups.userId, sourceId: groups.sourceId, name: groups.name })
    .from(groups)
    .where(eq(groups.status, "watching"));

  const memberIds = [...new Set(run.watching.map((row) => row.userId))];
  for (const part of chunkList(memberIds, 80)) {
    const people = await db.select().from(users).where(inArray(users.id, part));
    for (const person of people) run.users.set(person.id, person);
    const details = await db.select().from(profiles).where(inArray(profiles.userId, part));
    for (const detail of details) run.profiles.set(detail.userId, detail);
  }
  return run;
}

/** Write down the groups that had nothing to say. One query, not one each. */
export async function finishScanRun(run: ScanRun) {
  if (!run.quiet.length) return;
  const db = getDb();
  const now = Date.now();
  for (const part of chunkList(run.quiet, 80)) {
    await db
      .update(sources)
      .set({ lastChecked: now, lastCount: 0, lastMatches: 0 })
      .where(inArray(sources.id, part));
  }
  run.quiet = [];
}

/** Forget fingerprints older than the window Bright Data could re-deliver. */
export async function expireSeenPosts() {
  await getDb()
    .delete(seenPosts)
    .where(lt(seenPosts.seenAt, Date.now() - SEEN_TTL_DAYS * 864e5));
}

function chunkList<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Who gets told about a post in this group. Id when set, name when not. */
function watchersOf(run: ScanRun, source: SourceRow): string[] {
  const name = source.groupName.toLowerCase();
  const ids = new Set<string>();
  for (const row of run.watching) {
    if (row.sourceId === source.id) ids.add(row.userId);
    else if (row.sourceId === null && row.name.toLowerCase() === name) ids.add(row.userId);
  }
  return [...ids];
}

export type ProcessOptions = {
  /** Present inside the scanner. Absent when an admin runs one group by hand. */
  run?: ScanRun;
  /** What the snapshot said about the group beyond its posts. */
  fact?: GroupFacts;
};

/** Run one source end to end: fetch, dedup, match per member, alert. */
export async function processSource(
  sourceId: number,
  prefetched?: FetchedPost[],
  options: ProcessOptions = {}
) {
  const db = getDb();
  const { run, fact } = options;
  const source =
    run?.sources.get(sourceId) ??
    (await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
  if (!source) return { error: "no_source" };

  // Older deployments could already contain duplicate source URLs. Only the
  // oldest row owns a URL; skipping the others prevents duplicate alerts while
  // still allowing the duplicate to become canonical if the original is
  // removed later.
  const canonicalId =
    run?.canonical.get(source.url) ??
    (
      await db
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.url, source.url))
        .orderBy(asc(sources.id))
        .limit(1)
    )[0]?.id;
  if (canonicalId !== undefined && canonicalId !== source.id) {
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
      ? await db.select({ id: seenPosts.id }).from(seenPosts).where(inArray(seenPosts.id, ids))
      : [];
    const seenIds = new Set(already.map((r) => r.id));
    const fresh = posts.filter(
      (p, i) => !seenIds.has(ids[i]) && ids.indexOf(ids[i]) === i
    );
    summary.fresh = fresh.length;

    if (fresh.length) {
      // members watching a group with this name
      let watcherIds: string[];
      if (run) {
        watcherIds = watchersOf(run, source);
      } else {
        const watchers = await db
          .select({ userId: groups.userId })
          .from(groups)
          .where(
            and(
              eq(groups.status, "watching"),
              sql`(${groups.sourceId} = ${source.id} OR (${groups.sourceId} IS NULL AND lower(${groups.name}) = lower(${source.groupName})))`
            )
          );
        watcherIds = [...new Set(watchers.map((w) => w.userId))];
      }

      for (const post of fresh) {
        const postKey = `${source.id}:${post.id}`.slice(0, 190);
        let postOk = true;

        for (const userId of watcherIds) {
          const user =
            run?.users.get(userId) ??
            (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
          const profile =
            run?.profiles.get(userId) ??
            (await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1))[0];
          if (!user || !profile) continue;

          // Fair use. A successful classifier call costs money, so a member who
          // is far past their monthly allowance stops being charged for until
          // next month. The allowance comes from their plan, so this doubles as
          // the cap on what any one member can ever cost us.
          const month = new Date().toISOString().slice(0, 7);
          const used = profile.usageMonth === month ? profile.postsUsed : 0;
          if (used >= postLimit(profile.plan)) continue;

          try {
            const verdict = await classifyPost(post, {
              trade: profile.trade,
              services: profile.services,
              location: profile.location,
              brief: profile.brief,
            }, { groupName: source.groupName });
            await db
              .update(profiles)
              .set({ postsUsed: used + 1, usageMonth: month })
              .where(eq(profiles.userId, userId));
            // The cached copy has to keep count too, or the cap would only
            // be checked against what it was when the run began.
            profile.postsUsed = used + 1;
            profile.usageMonth = month;
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
            if (err instanceof LeadFilterError) {
              console.warn(JSON.stringify({
                event: "lead_filter_error",
                code: err.code,
                sourceId: source.id,
                postId: post.id,
              }));
              // A member can clear their profile after onboarding. Do not let
              // one incomplete watcher hold a shared post open for every other
              // member, and do not count a classifier call that never ran.
              if (err.code === "lead_filter_profile_incomplete") continue;
            }
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

  // What Facebook said about the group outranks our own summary when we
  // failed, and a snapshot that says nothing is not evidence that a private
  // group became readable, so the old reason is carried forward.
  const lastError =
    summary.error || fact?.error || (summary.posts > 0 ? "" : source.lastError);

  const nothingToRecord =
    run && summary.posts === 0 && summary.matches === 0 && lastError === source.lastError;
  if (nothingToRecord) {
    run.quiet.push(source.id);
  } else {
    await db
      .update(sources)
      .set({
        lastChecked: Date.now(),
        lastCount: summary.posts,
        lastMatches: summary.matches,
        lastError,
      })
      .where(eq(sources.id, source.id));
  }

  // The scanner expires fingerprints once per run. A lone admin run still
  // tidies up after itself.
  if (!run) await expireSeenPosts();

  return summary;
}

/** Pick the most overdue active sources for a cron tick. */
export async function dueSources(limit: number) {
  const db = getDb();
  const all = await db.select().from(sources).where(eq(sources.active, 1));

  // A source nobody has budget left for is a source we must stop buying.
  //
  // The post cap used to be checked only when handing a post to a member,
  // which saved the Claude call and nothing else: Bright Data had already
  // delivered and been paid for the record.
  //
  // Profiles first, and usually that is the whole job. The table is small and
  // almost nobody is ever over their cap, so the expensive join across every
  // group only runs on the rare tick where somebody actually is. The first
  // version ran that join every minute and blew the worker's CPU budget, which
  // killed the scan itself.
  const month = new Date().toISOString().slice(0, 7);
  const everyone = await db
    .select({ userId: profiles.userId, plan: profiles.plan, used: profiles.postsUsed, when: profiles.usageMonth })
    .from(profiles);
  const capped = everyone
    .filter((p) => (p.when === month ? p.used : 0) >= postLimit(p.plan))
    .map((p) => p.userId);

  let broke = new Set<number>();
  if (capped.length) {
    const watched = await db
      .select({ sourceId: groups.sourceId, userId: groups.userId })
      .from(groups)
      .where(eq(groups.status, "watching"));
    const withBudget = new Set<number>();
    const all = new Set<number>();
    for (const row of watched) {
      if (row.sourceId == null) continue;
      all.add(row.sourceId);
      if (!capped.includes(row.userId)) withBudget.add(row.sourceId);
    }
    broke = new Set([...all].filter((id) => !withBudget.has(id)));
  }

  const selected = [];
  const urls = new Set<string>();
  for (const source of all.sort((a, b) => a.lastChecked - b.lastChecked)) {
    if (urls.has(source.url)) continue;
    if (broke.has(source.id)) continue;
    urls.add(source.url);
    selected.push(source);
    if (selected.length >= limit) break;
  }
  return selected;
}
