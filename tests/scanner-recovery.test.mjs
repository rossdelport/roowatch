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

test("live scan work happens before collection, catalogue, and top up", () => {
  const source = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const post = source.slice(source.indexOf("export async function POST"));
  const trigger = post.indexOf("await bdTrigger(");
  const sweep = post.indexOf("const swept = await sweep(open)");
  const catalogue = post.indexOf("catalogued = await collectCatalogue()");
  const topUp = post.lastIndexOf("toppedUp = await topUpShortMembers()");

  assert.ok(trigger > 0);
  assert.ok(trigger < sweep);
  assert.ok(sweep < catalogue);
  assert.ok(catalogue < topUp);
  assert.match(source, /GROUPS_PER_BATCH = 1/);
  assert.match(source, /MAX_INFLIGHT = 6/);
  assert.match(source, /MAX_READY_COLLECTIONS_PER_TICK = 1/);
  assert.doesNotMatch(post, /JSON\.parse\(job\.sourceIds\)/);
});

test("claims and checkpoints are conditional, and broken catalogue jobs rotate out", () => {
  const scanner = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const finish = scanner.slice(
    scanner.indexOf("async function finishClaim"),
    scanner.indexOf("async function collectJob")
  );
  const sweep = scanner.slice(
    scanner.indexOf("async function sweep"),
    scanner.indexOf("export async function POST")
  );
  const catalogue = readFileSync("db/catalogue.ts", "utf8");
  const failedCatalogue = catalogue.slice(catalogue.indexOf('console.error("catalogue_job_failed"'));

  assert.match(finish, /eq\(scanJobs\.status, claimMarker\)[\s\S]*returning\(\{ id: scanJobs\.id \}\)/);
  assert.match(sweep, /eq\(scanJobs\.status, claim\.expected\)[\s\S]*returning\(\{ id: scanJobs\.id \}\)/);
  assert.match(failedCatalogue.slice(0, 600), /delete\(catalogueJobs\)/);
});

test("scanner and watchdog use separate cron expressions", () => {
  const config = readFileSync("vite.config.ts", "utf8");
  const worker = readFileSync("worker/index.ts", "utf8");

  const configuredHealth = /crons: \["\* \* \* \* \*", "([^"]+)"\]/.exec(config)?.[1];
  const routedHealth = /const HEALTH_CRON = "([^"]+)"/.exec(worker)?.[1];
  assert.equal(configuredHealth, "0 * * * *");
  assert.equal(routedHealth, configuredHealth);
  assert.match(worker, /event\.cron === HEALTH_CRON/);
  assert.match(worker, /event\.cron === SCAN_CRON/);
  assert.match(worker, /unknown_cron_ignored/);
  assert.match(worker, /runHealth\(request\("\/api\/cron\/health"\)\)/);
  assert.match(worker, /runScan\(request\("\/api\/cron\/scan"\)\)/);
});

test("one claim processes one group and releases any remainder", () => {
  const scanner = readFileSync("app/api/cron/scan/route.ts", "utf8");
  const collect = scanner.slice(
    scanner.indexOf("async function collectJob"),
    scanner.indexOf("async function learnAbout")
  );
  const finish = scanner.slice(
    scanner.indexOf("async function finishClaim"),
    scanner.indexOf("async function collectJob")
  );

  assert.match(collect, /const sourceId = job\.sourceIds\[0\]/);
  assert.match(collect, /const remaining = job\.sourceIds\.slice\(1\)/);
  assert.doesNotMatch(collect, /for \(/);
  assert.match(finish, /status: "running", startedAt/);
  assert.match(finish, /scanner_claim_lost/);
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
