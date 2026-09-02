import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COLLECTION_CLAIM_STALE_MS,
  JOB_STALE_MS,
  collectionClaim,
  collectionFailureAction,
  jobExpiryReason,
  parseJobState,
  parseSlugs,
  parseSourceIds,
} from "../db/scanqueue.ts";

test("source ids are validated once before scanner work", () => {
  assert.deepEqual(parseSourceIds("[3,1,3]"), [3, 1]);
  for (const raw of ["nope", "null", "{}", '["3"]', "[0]", "[-1]", "[1.5]"]) {
    assert.equal(parseSourceIds(raw), null, raw);
  }
});

test("catalogue slugs reject malformed queue rows", () => {
  assert.deepEqual(parseSlugs('[" perth-tradies ","perth-tradies","joondalup"]'), [
    "perth-tradies",
    "joondalup",
  ]);
  for (const raw of ["nope", "null", "{}", "[1]", '[""]']) {
    assert.equal(parseSlugs(raw), null, raw);
  }
});

test("stale ready work is removed before another collection attempt", () => {
  const now = 2_000_000_000_000;
  assert.equal(
    jobExpiryReason({ status: "running", startedAt: now - JOB_STALE_MS - 1 }, now),
    "stale_snapshot"
  );
  assert.equal(
    jobExpiryReason({ status: "retry", startedAt: now - JOB_STALE_MS - 1 }, now),
    "stale_snapshot"
  );
});

test("an empty checkpoint is complete and cannot hold an inflight slot", () => {
  const now = 2_000_000_000_000;
  assert.equal(
    jobExpiryReason({ status: `collecting:${now}:first`, startedAt: now, sourceIds: [] }, now),
    "empty_queue"
  );
});

test("an active collection uses its own lease and does not expire by snapshot age", () => {
  const now = 2_000_000_000_000;
  const freshClaim = `collecting:${now - 60_000}:first`;
  assert.equal(
    jobExpiryReason({ status: freshClaim, startedAt: now - JOB_STALE_MS * 2 }, now),
    null
  );

  const staleClaim = `collecting:${now - COLLECTION_CLAIM_STALE_MS - 1}:retry`;
  assert.equal(
    jobExpiryReason({ status: staleClaim, startedAt: now - JOB_STALE_MS * 2 }, now),
    "stale_retry_claim"
  );

  const staleFirstClaim = `collecting:${now - COLLECTION_CLAIM_STALE_MS - 1}:first`;
  assert.equal(
    jobExpiryReason({ status: staleFirstClaim, startedAt: now - JOB_STALE_MS * 2 }, now),
    "stale_first_claim"
  );
});

test("ready jobs get one first attempt and one retry", () => {
  const first = collectionClaim("running", 1234);
  assert.deepEqual(first, {
    expected: "running",
    marker: "collecting:1234:first",
    attempt: "first",
  });

  const retry = collectionClaim("retry:5000", 5678);
  assert.deepEqual(retry, {
    expected: "retry:5000",
    marker: "collecting:5678:retry",
    attempt: "retry",
  });
  assert.equal(collectionClaim("collecting:1234:first", 9999), null);
  assert.equal(parseJobState("broken"), null);
});

test("a recovered first claim gets a fresh retry window", () => {
  const now = 2_000_000_000_000;
  assert.equal(
    jobExpiryReason({ status: `retry:${now}`, startedAt: now - JOB_STALE_MS * 2 }, now),
    null
  );
  assert.equal(
    jobExpiryReason(
      { status: `retry:${now - JOB_STALE_MS - 1}`, startedAt: now - JOB_STALE_MS * 2 },
      now
    ),
    "stale_snapshot"
  );
});

test("a collection retries once and then drops the broken snapshot", () => {
  assert.deepEqual(collectionFailureAction("first", 1234), {
    kind: "retry",
    status: "retry:1234",
  });
  assert.deepEqual(collectionFailureAction("retry", 5678), { kind: "drop" });
});

test("a run finds a dead run's claims at once, the watchdog waits", () => {
  const now = 2_000_000_000_000;
  const claim = `collecting:${now - 1000}:first`;
  assert.equal(jobExpiryReason({ status: claim, startedAt: now }, now), null);
  assert.equal(jobExpiryReason({ status: claim, startedAt: now }, now, 0), "stale_first_claim");
});

test("one run triggers, waits, collects, records, then minds the catalogue", () => {
  const source = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const post = source.slice(source.indexOf("export async function POST"));
  const lease = post.indexOf("claimLease(SCAN_LEASE_ID, SCAN_LEASE_MS)");
  const leftovers = post.indexOf("await loadOpenJobs()");
  const trigger = post.indexOf("await bdTrigger(");
  const run = post.indexOf("await startScanRun(");
  const sweep = post.indexOf("const swept = await sweep(jobs, run, keepAlive)");
  const finish = post.indexOf("await finishScanRun(run)");
  const expire = post.indexOf("await expireSeenPosts()");
  const catalogue = post.indexOf("catalogued = await collectCatalogue()");
  const topUp = post.lastIndexOf("toppedUp = await topUpShortMembers()");
  const release = post.lastIndexOf("releaseLease(SCAN_LEASE_ID, lease)");

  assert.ok(lease > 0);
  assert.ok(lease < leftovers);
  assert.ok(leftovers < trigger);
  assert.ok(trigger < run);
  assert.ok(run < sweep);
  assert.ok(sweep < finish);
  assert.ok(finish < expire);
  assert.ok(expire < catalogue);
  assert.ok(catalogue < topUp);
  assert.ok(topUp < release);
  assert.match(source, /SCAN_EVERY_MINUTES = 5/);
  assert.match(source, /MIN_WINDOW_MINUTES = SCAN_EVERY_MINUTES \+ BUFFER_MINUTES/);
  assert.match(source, /jobExpiryReason\(\{ \.\.\.row, sourceIds \}, now, 0\)/);
  assert.doesNotMatch(post, /JSON\.parse\(job\.sourceIds\)/);
  // Groups in an open snapshot are never triggered twice.
  assert.match(post, /\.filter\(\s*\(source\) => !busy\.has\(source\.id\)\s*\)/);
  // The lease is renewed on every poll so a killed run frees it quickly.
  assert.match(post, /while \(jobs\.length\) \{\s*await keepAlive\(\);/);
  assert.match(post, /renewLease\(SCAN_LEASE_ID, lease!, SCAN_LEASE_MS\)/);
});

test("member top ups use their own lease and leave scanner leases alone", () => {
  const catalogue = readFileSync("db/catalogue.ts", "utf8");
  const topUp = catalogue.slice(
    catalogue.indexOf("export async function topUpMember"),
    catalogue.indexOf("/** How long before we look at the same member again. */")
  );

  assert.match(catalogue, /catalogue_top_up:\$\{userId\}/);
  assert.match(topUp, /claimLease\(leaseId, MEMBER_TOP_UP_LEASE_MS\)/);
  assert.match(topUp, /return await topUpMemberUnlocked\(userId, allowSearch\)/);
  assert.match(topUp, /releaseLease\(leaseId, leaseToken\)/);
  assert.doesNotMatch(topUp, /TRIGGER_LEASE_ID|CATALOGUE_TRIGGER_LEASE_ID|CATALOGUE_LEASE_ID/);
});

test("claims and checkpoints are conditional, and broken catalogue jobs rotate out", () => {
  const scanner = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const collect = scanner.slice(
    scanner.indexOf("async function collectJob"),
    scanner.indexOf("async function learnAbout")
  );
  const sweep = scanner.slice(
    scanner.indexOf("async function sweep"),
    scanner.indexOf("export async function POST")
  );
  const catalogue = readFileSync("db/catalogue.ts", "utf8");
  const failedCatalogue = catalogue.slice(catalogue.indexOf('console.error("catalogue_job_failed"'));

  assert.match(collect, /eq\(scanJobs\.status, claimMarker\)[\s\S]*returning\(\{ id: scanJobs\.id \}\)/);
  assert.match(collect, /scanner_claim_lost/);
  assert.match(sweep, /eq\(scanJobs\.status, claim\.expected\)[\s\S]*returning\(\{ id: scanJobs\.id \}\)/);
  assert.match(failedCatalogue.slice(0, 600), /delete\(catalogueJobs\)/);
});

test("scanner runs every five minutes and the watchdog on the hour", () => {
  const config = readFileSync("vite.config.ts", "utf8");
  const worker = readFileSync("worker/index.ts", "utf8");
  const scanner = readFileSync("app/api/cron/scan/route.ts", "utf8");

  const configured = /crons: \["([^"]+)", "([^"]+)"\]/.exec(config);
  const routedScan = /const SCAN_CRON = "([^"]+)"/.exec(worker)?.[1];
  const routedHealth = /const HEALTH_CRON = "([^"]+)"/.exec(worker)?.[1];
  assert.equal(configured?.[1], "*/5 * * * *");
  assert.equal(configured?.[2], "0 * * * *");
  assert.equal(routedScan, configured?.[1]);
  assert.equal(routedHealth, configured?.[2]);
  assert.match(scanner, /SCAN_EVERY_MINUTES = 5/);
  assert.match(worker, /event\.cron === HEALTH_CRON/);
  assert.match(worker, /runHealth\(request\("\/api\/cron\/health"\)\)/);
  assert.match(worker, /runScan\(request\("\/api\/cron\/scan"\)\)/);
  // Every tick that is not the watchdog scans. Cloudflare kept sending the
  // old every minute expression after the deploy, and ignoring it left the
  // scanner off for as long as that lasted.
  assert.doesNotMatch(worker, /unknown_cron_ignored/);
  assert.doesNotMatch(worker, /if \(event\.cron === SCAN_CRON\)/);
  assert.match(worker, /unexpected_cron_treated_as_scan/);
  // So the scan route paces itself: one run per gap, whatever the tick rate,
  // claimed before the run lease.
  assert.match(scanner, /const SCAN_GAP_MS = SCAN_EVERY_MINUTES \* 60 \* 1000 - 30 \* 1000;/);
  const gap = scanner.indexOf("claimLease(SCAN_GAP_ID, SCAN_GAP_MS)");
  const run = scanner.indexOf("claimLease(SCAN_LEASE_ID, SCAN_LEASE_MS)");
  assert.ok(gap > 0 && gap < run);
  assert.match(scanner, /skipped: "too_soon"/);
});

test("a ready snapshot is read whole, every group in it", () => {
  const scanner = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const collect = scanner.slice(
    scanner.indexOf("async function collectJob"),
    scanner.indexOf("async function learnAbout")
  );

  assert.match(collect, /for \(const source of rows\)/);
  assert.match(collect, /processSource\(source\.id, posts, \{ run, fact \}\)/);
  assert.doesNotMatch(collect, /sourceIds\.slice\(1\)/);
});

test("watchdog recovery runs independently of its email cooldown", () => {
  const watchdog = readFileSync("app/api/cron/health/route.ts", "utf8");
  const recovery = watchdog.indexOf("claimLease(RECOVERY_LEASE_ID");
  const alarm = watchdog.indexOf("claimLease(ALARM_LEASE_ID");
  const alreadyWarned = watchdog.indexOf('skipped: "already_warned"');

  assert.ok(recovery > 0);
  assert.ok(recovery < alarm);
  assert.ok(alarm < alreadyWarned);
  assert.match(watchdog, /recoverStaleJobs\(now\)/);
});
