import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChronologicalUrl,
  isChronologicalUrl,
  parseFacebookTimestamp,
  processFeedArticles
} from "../src/facebook-feed.js";

const NOW = Date.parse("2026-08-18T04:00:00.000Z");

test("forces a clean chronological Facebook group URL", () => {
  const url = buildChronologicalUrl("https://m.facebook.com/groups/tradies/?ref=share#top");
  assert.equal(url, "https://www.facebook.com/groups/tradies/?sorting_setting=CHRONOLOGICAL");
  assert.equal(isChronologicalUrl(url), true);
  assert.throws(() => buildChronologicalUrl("https://example.com/groups/tradies"), /not a Facebook group URL/);
  assert.throws(() => buildChronologicalUrl("https://www.facebook.com/groups/tradies/posts/123"), /not a Facebook group URL/);
});

test("parses exact and safe relative Facebook timestamps", () => {
  assert.equal(parseFacebookTimestamp(["2026-08-18T03:45:00.000Z"], NOW, "UTC"), Date.parse("2026-08-18T03:45:00.000Z"));
  assert.equal(parseFacebookTimestamp(["15 min"], NOW, "UTC"), NOW - 15 * 60_000);
  assert.equal(parseFacebookTimestamp(["2 h"], NOW, "UTC"), NOW - 2 * 3_600_000);
  assert.throws(() => parseFacebookTimestamp(["1 h"], NOW, "UTC"), /ambiguous one-hour/);
});

test("ignores an old pinned post and never extracts the old normal boundary post", async () => {
  const extracted = [];
  const result = await processFeedArticles({
    articles: [
      { key: "pinned-old", pinned: true, timestampCandidates: ["2026-08-18T00:00:00.000Z"] },
      { key: "recent-1", pinned: false, timestampCandidates: ["2026-08-18T03:40:00.000Z"] },
      { key: "recent-2", pinned: false, timestampCandidates: ["2026-08-18T03:10:00.000Z"] },
      { key: "boundary-old", pinned: false, timestampCandidates: ["2026-08-18T02:54:00.000Z"] },
      { key: "must-not-read", pinned: false, timestampCandidates: ["2026-08-18T02:00:00.000Z"] }
    ],
    nowMs: NOW,
    cutoffMinutes: 65,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async (article, postedAtMs) => {
      extracted.push(article.key);
      return { id: article.key, postedAt: new Date(postedAtMs).toISOString() };
    }
  });
  assert.deepEqual(extracted, ["recent-1", "recent-2"]);
  assert.deepEqual(result.posts.map((post) => post.id), ["recent-1", "recent-2"]);
  assert.equal(result.ignoredPinned, 1);
  assert.equal(result.boundaryReached, true);
});

test("ignores recent pinned posts without reading their timestamp or content", async () => {
  let extracts = 0;
  const result = await processFeedArticles({
    articles: [{ key: "pinned-recent", pinned: true, timestampCandidates: ["5 min"] }],
    nowMs: NOW,
    cutoffMinutes: 65,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => { extracts += 1; return { id: "must-not-send" }; }
  });
  assert.equal(extracts, 0);
  assert.deepEqual(result.posts, []);
  assert.equal(result.ignoredPinned, 1);
  assert.equal(result.normalCount, 0);
});

test("fails closed on a rounded timestamp at the exact cutoff", async () => {
  await assert.rejects(() => processFeedArticles({
    articles: [{ key: "uncertain", pinned: false, timestampCandidates: ["65 min"] }],
    nowMs: NOW,
    cutoffMinutes: 65,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => ({ id: "must-not-send" })
  }), /rounded timestamp/);
});

test("fails closed when a minute-precision time straddles the cutoff", async () => {
  await assert.rejects(() => processFeedArticles({
    articles: [{ key: "uncertain", pinned: false, timestampCandidates: ["today at 02:55"] }],
    nowMs: NOW + 30_000,
    cutoffMinutes: 65,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => ({ id: "must-not-send" })
  }), /minute-precision timestamp/);
});

test("fails closed on a future normal-post timestamp", async () => {
  await assert.rejects(() => processFeedArticles({
    articles: [{ key: "future", pinned: false, timestampCandidates: [new Date(NOW + 180_000).toISOString()] }],
    nowMs: NOW,
    cutoffMinutes: 65,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => ({ id: "must-not-send" })
  }), /timestamp in the future/);
});

test("fails when normal posts are not ordered newest to oldest", async () => {
  await assert.rejects(() => processFeedArticles({
    articles: [
      { key: "older", pinned: false, timestampCandidates: ["2026-08-18T03:20:00.000Z"] },
      { key: "newer", pinned: false, timestampCandidates: ["2026-08-18T03:30:00.000Z"] }
    ],
    nowMs: NOW,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async (article) => ({ id: article.key })
  }), /not ordered newest to oldest/);
});

test("fails on an unverified normal timestamp but skips an unverified pinned item", async () => {
  const pinned = await processFeedArticles({
    articles: [{ key: "pinned", pinned: true, timestampCandidates: [] }],
    nowMs: NOW,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => { throw new Error("must not extract"); }
  });
  assert.equal(pinned.ignoredPinned, 1);

  await assert.rejects(() => processFeedArticles({
    articles: [{ key: "normal", pinned: false, timestampCandidates: [] }],
    nowMs: NOW,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost: async () => null
  }), /verifiable post timestamp/);
});

test("deduplicates a virtualized recent post after resolving its stable id", async () => {
  const ids = new Set();
  const extractPost = async () => {
    if (ids.has("post-1")) return { duplicate: true, post: null };
    ids.add("post-1");
    return { duplicate: false, post: { id: "post-1" } };
  };
  const first = await processFeedArticles({
    articles: [{ key: "", pinned: false, timestampCandidates: ["2026-08-18T03:20:00.000Z"] }],
    nowMs: NOW,
    timeZone: "UTC",
    seenKeys: new Set(),
    extractPost
  });
  const repeated = await processFeedArticles({
    articles: [{ key: "", pinned: false, timestampCandidates: ["2026-08-18T03:20:00.000Z"] }],
    nowMs: NOW,
    timeZone: "UTC",
    seenKeys: new Set(),
    previousNormalTimestampMs: first.previousNormalTimestampMs,
    extractPost
  });
  assert.deepEqual(first.posts, [{ id: "post-1" }]);
  assert.deepEqual(repeated.posts, []);
  assert.equal(repeated.previousNormalTimestampMs, first.previousNormalTimestampMs);
});
