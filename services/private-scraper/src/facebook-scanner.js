import { ERROR_CODES, ScraperError, asScraperError } from "./errors.js";
import { buildChronologicalUrl, isChronologicalUrl, parseFacebookTimestamp, processFeedArticles } from "./facebook-feed.js";
import { installResourceBlocking, NetworkByteTracker, classifyProxyError } from "./network.js";

const POST_PATH = /^\/groups\/([^/]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]+)\/?$/i;
const TOP_LEVEL_ARTICLES = 'xpath=//div[@role="article" and not(ancestor::div[@role="article"])]';
function compact(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function groupSlug(raw) {
  try {
    return new URL(raw).pathname.match(/^\/groups\/([^/]+)/i)?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function isExpectedChronologicalGroupUrl(raw, expectedGroupSlug) {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return hostname === "facebook.com"
      && groupSlug(url.toString()) === expectedGroupSlug.toLowerCase()
      && isChronologicalUrl(url.toString());
  } catch {
    return false;
  }
}

function normalisePostUrl(raw, expectedGroupSlug) {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const match = url.pathname.match(POST_PATH);
    if (hostname !== "facebook.com" || !match || match[1].toLowerCase() !== expectedGroupSlug.toLowerCase()) return "";
    url.protocol = "https:";
    url.hostname = "www.facebook.com";
    url.port = "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function systemText(page) {
  try {
    const snippets = await page.locator('[role="alert"], [role="dialog"], [role="status"], [aria-live], main h1, main h2, [role="main"] h1, [role="main"] h2, form').evaluateAll((elements) => elements
      .filter((element) => !element.closest('[role="article"]'))
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length <= 300)
      .slice(0, 500));
    return snippets.join("\n").slice(0, 40_000);
  } catch {
    return "";
  }
}

async function hasOutsideArticleControl(page, labels) {
  return page.locator('main [role="button"], main a, main [aria-label], [role="main"] [role="button"], [role="main"] a, [role="main"] [aria-label]').evaluateAll((elements, expected) => {
    const wanted = new Set(expected.map((label) => label.toLowerCase()));
    return elements.some((element) => {
      if (element.closest('[role="article"]')) return false;
      const aria = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return wanted.has(aria) || wanted.has(text);
    });
  }, labels);
}

async function accountHealth(page) {
  const url = page.url().toLowerCase();
  const content = (await systemText(page)).toLowerCase();
  const articleCount = await page.locator(TOP_LEVEL_ARTICLES).count();
  if (/\/checkpoint\//.test(url) || (articleCount === 0 && /security check|required authentication|enter the code from your authentication app|two-factor authentication|captcha/i.test(content))) {
    throw new ScraperError(ERROR_CODES.CHALLENGE_REQUIRED, "Facebook requires a manual security check", {
      accountStatus: "login_required",
      sessionStatus: "challenge"
    });
  }
  if (articleCount === 0 && /your account has been disabled|account is disabled/i.test(content)) {
    throw new ScraperError(ERROR_CODES.ACCOUNT_DISABLED, "Facebook reports that the account is disabled", {
      accountStatus: "disabled",
      sessionStatus: "login_required"
    });
  }
  if (articleCount === 0 && /your account has been locked|we suspended your account|you can't use facebook right now/i.test(content)) {
    throw new ScraperError(ERROR_CODES.ACCOUNT_BLOCKED, "Facebook reports that the account is blocked", {
      accountStatus: "blocked",
      sessionStatus: "login_required"
    });
  }
  const hasLoginForm = await page.locator('input[name="email"], input[name="pass"]').count() > 0;
  if (/\/login(?:\/|\?|$)/.test(url) || hasLoginForm) {
    throw new ScraperError(ERROR_CODES.LOGIN_REQUIRED, "The Facebook session is logged out", {
      accountStatus: "login_required",
      sessionStatus: "login_required"
    });
  }
  const cookies = await page.context().cookies("https://www.facebook.com/");
  if (!cookies.some((cookie) => cookie.name === "c_user" && cookie.value)) {
    throw new ScraperError(ERROR_CODES.LOGIN_REQUIRED, "Facebook did not accept the account session", {
      accountStatus: "login_required",
      sessionStatus: "login_required"
    });
  }
  return { accountStatus: "healthy", sessionStatus: "healthy" };
}

async function groupHealth(page) {
  const content = (await systemText(page)).toLowerCase();
  const articleCount = await page.locator(TOP_LEVEL_ARTICLES).count();
  if (articleCount === 0 && /this group has been removed|group was deleted|this group doesn't exist|this group does not exist/i.test(content)) {
    throw new ScraperError(ERROR_CODES.GROUP_DELETED, "Facebook reports that the group was deleted", { groupStatus: "deleted" });
  }
  const joinControl = await hasOutsideArticleControl(page, ["join group", "request to join", "join"]);
  if (articleCount === 0 && joinControl) {
    throw new ScraperError(ERROR_CODES.GROUP_ACCESS_LOST, "The monitoring account is not approved in this private group", {
      groupStatus: "waiting_for_access"
    });
  }
  if (articleCount === 0 && /you don't have permission to view this group|you do not have permission to view this group|you are no longer a member/i.test(content)) {
    throw new ScraperError(ERROR_CODES.GROUP_ACCESS_LOST, "The monitoring account lost access to this private group", {
      groupStatus: "access_lost"
    });
  }
  if (articleCount === 0 && /this content isn't available right now|this content is not available right now|page isn't available|page is not available/i.test(content)) {
    throw new ScraperError(ERROR_CODES.GROUP_UNAVAILABLE, "Facebook reports that the group is unavailable", {
      groupStatus: "unavailable"
    });
  }
  return { groupStatus: "healthy" };
}

async function hasChronologicalMarker(page, labels) {
  return page.locator('[role="button"], [aria-label]').evaluateAll((elements, expected) => {
    const wanted = new Set(expected.map((label) => label.trim().toLowerCase()));
    return elements.some((element) => {
      if (element.closest('[role="article"]')) return false;
      const aria = (element.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return wanted.has(aria) || wanted.has(text);
    });
  }, labels);
}

async function articleMetadataAt(page, domIndex) {
  return page.locator(TOP_LEVEL_ARTICLES).nth(domIndex).evaluate((article, index) => {
    let key = article.getAttribute("data-roowatch-article-key") || "";
    if (!key) {
      const root = article.ownerDocument.documentElement;
      const sequence = Number(root.getAttribute("data-roowatch-article-sequence") || 0) + 1;
      root.setAttribute("data-roowatch-article-sequence", String(sequence));
      key = `rw-${sequence}`;
      article.setAttribute("data-roowatch-article-key", key);
    }
    const timestampCandidates = [];
    const timestampNodes = [...article.querySelectorAll('[data-utime], time, abbr, a[href*="/posts/"], a[href*="/permalink/"]')];
    for (const node of timestampNodes.slice(0, 30)) {
      for (const attribute of ["data-utime", "datetime", "title", "aria-label"]) {
        const value = node.getAttribute(attribute);
        if (value && value.length <= 160) timestampCandidates.push(value);
      }
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 80) timestampCandidates.push(text);
    }
    const labels = [...article.querySelectorAll("[aria-label], span, strong")].slice(0, 250).map((node) => {
      const aria = (node.getAttribute?.("aria-label") || "").trim();
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      return aria || (text.length <= 40 ? text : "");
    }).filter(Boolean);
    const pinned = labels.some((label) => /^(?:pinned post|featured post|featured)$/i.test(label));
    const pagelet = article.getAttribute("data-pagelet") || "";
    return { key, pagelet, domIndex: index, pinned, timestampCandidates };
  }, domIndex);
}

async function resolveRecentPostReference(page, metadata, postedAtMs, nowMs, timeZone, expectedGroupSlug) {
  const reference = await page.locator(TOP_LEVEL_ARTICLES).evaluateAll((articles, target) => {
    const cleanPostUrl = (value) => {
      try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
        const match = url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/[A-Za-z0-9_-]+\/?$/i);
        if (hostname !== "facebook.com" || !match || match[1].toLowerCase() !== target.groupSlug) return "";
        url.protocol = "https:";
        url.hostname = "www.facebook.com";
        url.port = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "";
      }
    };
    const article = articles.find((candidate) => candidate.getAttribute("data-roowatch-article-key") === target.key);
    if (!article) return null;
    const postUrl = [...article.querySelectorAll("a[href]")].map((anchor) => cleanPostUrl(anchor.href)).find(Boolean) || "";
    const timestampCandidates = [];
    for (const node of [...article.querySelectorAll('[data-utime], time, abbr, a[href*="/posts/"], a[href*="/permalink/"]')].slice(0, 30)) {
      for (const attribute of ["data-utime", "datetime", "title", "aria-label"]) {
        const value = node.getAttribute(attribute);
        if (value && value.length <= 160) timestampCandidates.push(value);
      }
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 80) timestampCandidates.push(text);
    }
    return { postUrl, timestampCandidates };
  }, { key: metadata.key, groupSlug: expectedGroupSlug.toLowerCase() });
  if (!reference?.postUrl) {
    throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post has no stable permalink");
  }
  const recheckedAtMs = parseFacebookTimestamp(reference.timestampCandidates, nowMs, timeZone, 65);
  if (Math.abs(recheckedAtMs - postedAtMs) > 2_000) {
    throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post moved before it could be extracted safely");
  }
  return { ...metadata, postUrl: normalisePostUrl(reference.postUrl, expectedGroupSlug) };
}

async function extractPost(page, metadata, postedAtMs, expectedGroupSlug) {
  const raw = await page.locator(TOP_LEVEL_ARTICLES).evaluateAll((articles, target) => {
    const cleanPostUrl = (value) => {
      try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
        const match = url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/[A-Za-z0-9_-]+\/?$/i);
        if (hostname !== "facebook.com" || !match || match[1].toLowerCase() !== target.groupSlug) return "";
        url.protocol = "https:";
        url.hostname = "www.facebook.com";
        url.port = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "";
      }
    };
    const article = articles.find((candidate) => [...candidate.querySelectorAll("a[href]")]
      .some((anchor) => cleanPostUrl(anchor.href) === target.postUrl));
    if (!article) return null;

    const links = [...article.querySelectorAll("a[href]")];
    const postUrl = links.map((anchor) => cleanPostUrl(anchor.href)).find((url) => url === target.postUrl) || "";
    const headings = [...article.querySelectorAll("h2 a, h3 a, h4 a, strong a")];
    const author = headings.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).find(Boolean) || "";
    const preferred = [...article.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]')]
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const text = preferred.sort((left, right) => right.length - left.length)[0] || "";
    return { url: postUrl, author, text };
  }, { ...metadata, groupSlug: expectedGroupSlug.toLowerCase() });

  if (!raw) throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post disappeared before extraction");
  const expectedUrl = normalisePostUrl(metadata.postUrl, expectedGroupSlug);
  const url = normalisePostUrl(raw.url, expectedGroupSlug);
  if (!url || url !== expectedUrl) {
    throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post moved before its permalink could be verified");
  }
  const match = url.match(POST_PATH);
  if (!match) throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post has no stable post URL");
  const text = compact(raw.text, 4_000);
  if (url.length > 700 || match[2].length > 190) {
    throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A recent Facebook post URL is too long to send safely");
  }
  return {
    id: match[2],
    post: text.length <= 10 ? null : {
      id: match[2],
      text,
      url,
      author: compact(raw.author, 160),
      postedAt: new Date(postedAtMs).toISOString()
    }
  };
}

async function endOfFeed(page) {
  return page.locator('[role="status"], [aria-label], div, span').evaluateAll((elements) => elements.some((element) => {
    if (element.closest('[role="article"]')) return false;
    const text = (element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return text.length <= 80 && /^(?:no posts yet|there are no posts in this group|no more posts)[.!]?$/.test(text);
  }));
}

function attachFailureDetails(error, details) {
  const failure = asScraperError(error);
  failure.details = { ...details, ...failure.details };
  return failure;
}

function transferLimitFailure(tracker, error) {
  try {
    tracker?.assertWithinLimit();
    return error;
  } catch (limitError) {
    return limitError;
  }
}

export class FacebookScanner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async scanGroup(entry, job, nowMs, bootstrapBytes = 0) {
    let page;
    let tracker;
    let authenticated = false;
    let accountStatus = "error";
    let sessionStatus = "stale";
    let groupStatus = "error";
    let proxyStatus = "healthy";
    let networkStarted = bootstrapBytes > 0;
    const remainingBytes = this.config.maxTransferBytes - bootstrapBytes;
    try {
      if (remainingBytes <= 0) throw new ScraperError(ERROR_CODES.TRANSFER_LIMIT_EXCEEDED, "Proxy validation used the full transfer allowance");
      page = await entry.context.newPage();
      await installResourceBlocking(page);
      tracker = await new NetworkByteTracker(page, remainingBytes, () => page.close()).start();
      const chronologicalUrl = buildChronologicalUrl(job.url);
      const expectedGroupSlug = groupSlug(chronologicalUrl);
      try {
        networkStarted = true;
        await page.goto(chronologicalUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
      } catch (error) {
        if (/ERR_PROXY|ERR_TUNNEL|407/i.test(String(error?.message || error))) throw classifyProxyError(error);
        tracker.assertWithinLimit();
        throw error;
      }
      tracker.assertWithinLimit();
      ({ accountStatus, sessionStatus } = await accountHealth(page));
      authenticated = true;
      ({ groupStatus } = await groupHealth(page));

      await page.locator(TOP_LEVEL_ARTICLES).first().waitFor({ state: "attached", timeout: this.config.feedWaitTimeoutMs }).catch(() => {});
      ({ groupStatus } = await groupHealth(page));
      tracker.assertWithinLimit();

      const chronologicalUrlKept = isExpectedChronologicalGroupUrl(page.url(), expectedGroupSlug);
      const chronologicalControl = await hasChronologicalMarker(page, this.config.chronologicalLabels);
      if (!chronologicalUrlKept || !chronologicalControl) {
        throw new ScraperError(ERROR_CODES.CHRONOLOGY_UNVERIFIED, "Facebook did not prove that this feed is ordered by new posts");
      }

      const seenKeys = new Set();
      const seenPostIds = new Set();
      const posts = [];
      let previousNormalTimestampMs;
      let ignoredPinnedPosts = 0;
      let postsSkippedNoText = 0;
      let duplicatePostsSkipped = 0;
      let boundaryReached = false;
      let feedEndReached = false;
      let normalPostsInspected = 0;

      for (let scroll = 0; scroll <= this.config.maxScrolls; scroll += 1) {
        tracker.assertWithinLimit();
        const articleCount = await page.locator(TOP_LEVEL_ARTICLES).count();
        for (let domIndex = 0; domIndex < articleCount; domIndex += 1) {
          const metadata = await articleMetadataAt(page, domIndex);
          const batch = await processFeedArticles({
            articles: [metadata],
            nowMs,
            cutoffMinutes: 65,
            timeZone: this.config.facebookTimezone,
            seenKeys,
            previousNormalTimestampMs,
            extractPost: async (recentMetadata, postedAtMs) => {
              const referencedMetadata = await resolveRecentPostReference(
                page,
                recentMetadata,
                postedAtMs,
                nowMs,
                this.config.facebookTimezone,
                expectedGroupSlug
              );
              const extracted = await extractPost(page, referencedMetadata, postedAtMs, expectedGroupSlug);
              if (seenPostIds.has(extracted.id)) {
                duplicatePostsSkipped += 1;
                return { duplicate: true, post: null };
              }
              seenPostIds.add(extracted.id);
              if (!extracted.post) {
                postsSkippedNoText += 1;
              }
              return { duplicate: false, post: extracted.post };
            }
          });
          posts.push(...batch.posts.filter(Boolean));
          if (posts.length > 100) throw new ScraperError(ERROR_CODES.POST_EXTRACTION_FAILED, "A group check produced more than 100 recent text posts");
          previousNormalTimestampMs = batch.previousNormalTimestampMs;
          ignoredPinnedPosts += batch.ignoredPinned;
          normalPostsInspected += batch.normalCount;
          if (batch.boundaryReached) {
            boundaryReached = true;
            await page.close();
            break;
          }
        }
        if (boundaryReached) break;
        if (await endOfFeed(page)) {
          feedEndReached = true;
          break;
        }
        if (scroll === this.config.maxScrolls) {
          throw new ScraperError(ERROR_CODES.BOUNDARY_NOT_REACHED, "The feed did not reach a verified 65-minute boundary before the scroll limit");
        }
        await page.locator(TOP_LEVEL_ARTICLES).last().scrollIntoViewIfNeeded().catch(() => {});
        await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.8, 500)));
        await page.waitForTimeout(1_200);
      }

      tracker.assertWithinLimit();
      const bytesTransferred = bootstrapBytes + tracker.bytes;
      return {
        authenticated,
        accountStatus,
        sessionStatus,
        groupStatus,
        proxyStatus,
        chronologicalVerified: true,
        boundaryReached,
        feedEndReached,
        posts,
        networkStarted,
        bytesTransferred,
        bandwidthTargetExceeded: bytesTransferred > this.config.bandwidthTargetBytes,
        ignoredPinnedPosts,
        postsSkippedNoText,
        duplicatePostsSkipped,
        normalPostsInspected
      };
    } catch (rawError) {
      const error = transferLimitFailure(tracker, rawError);
      const bytesTransferred = bootstrapBytes + (tracker?.bytes || 0);
      throw attachFailureDetails(error, {
        authenticated,
        accountStatus,
        sessionStatus,
        groupStatus,
        proxyStatus,
        networkStarted,
        bytesTransferred,
        bandwidthTargetExceeded: bytesTransferred > this.config.bandwidthTargetBytes
      });
    } finally {
      await tracker?.stop();
      await page?.close().catch(() => {});
    }
  }

  async validateSession(entry, bootstrapBytes = 0, repeatProxyCheck) {
    let proxyBytes = 0;
    let initialBytes = bootstrapBytes;
    let remainingBytes = this.config.maxTransferBytes - initialBytes;
    let page;
    let tracker;
    let networkStarted = bootstrapBytes > 0;
    try {
      if (repeatProxyCheck) {
        networkStarted = true;
        proxyBytes = (await repeatProxyCheck()).bytes;
        initialBytes += proxyBytes;
        remainingBytes = this.config.maxTransferBytes - initialBytes;
      }
      if (remainingBytes <= 0) throw new ScraperError(ERROR_CODES.TRANSFER_LIMIT_EXCEEDED, "Health checks used the full transfer allowance");
      page = await entry.context.newPage();
      await installResourceBlocking(page);
      tracker = await new NetworkByteTracker(page, remainingBytes, () => page.close()).start();
      try {
        networkStarted = true;
        await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
      } catch (error) {
        if (/ERR_PROXY|ERR_TUNNEL|407/i.test(String(error?.message || error))) throw classifyProxyError(error);
        tracker.assertWithinLimit();
        throw error;
      }
      tracker.assertWithinLimit();
      const health = await accountHealth(page);
      const bytesTransferred = initialBytes + tracker.bytes;
      return {
        authenticated: true,
        ...health,
        proxyStatus: "healthy",
        networkStarted,
        bytesTransferred,
        bandwidthTargetExceeded: bytesTransferred > this.config.bandwidthTargetBytes
      };
    } catch (rawError) {
      const error = transferLimitFailure(tracker, rawError);
      const bytesTransferred = initialBytes + (tracker?.bytes || 0);
      throw attachFailureDetails(error, {
        bytesTransferred,
        bandwidthTargetExceeded: bytesTransferred > this.config.bandwidthTargetBytes,
        networkStarted,
        proxyStatus: "healthy"
      });
    } finally {
      await tracker?.stop();
      await page?.close().catch(() => {});
    }
  }
}
