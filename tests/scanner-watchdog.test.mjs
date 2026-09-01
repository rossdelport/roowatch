import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateScannerHealth,
  WATCHDOG_FRESH_MS,
} from "../db/scannerhealth.ts";

const NOW = 2_000_000_000_000;

test("no active sources is healthy and does not ask for recovery", () => {
  assert.deepEqual(evaluateScannerHealth({ active: 0, recent: 0, latestChecked: 0 }, NOW), {
    healthy: true,
    skipped: true,
    covered: 100,
    quietForMs: 0,
    reason: "no_active_sources",
  });
});

test("one fresh group cannot hide a broad hourly stall", () => {
  const result = evaluateScannerHealth(
    { active: 74, recent: 1, latestChecked: NOW - 60_000 },
    NOW
  );
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "low_hourly_coverage");
  assert.equal(result.covered, 1);
});

test("half of active groups plus recent progress is healthy", () => {
  const result = evaluateScannerHealth(
    { active: 74, recent: 37, latestChecked: NOW - WATCHDOG_FRESH_MS },
    NOW
  );
  assert.equal(result.healthy, true);
  assert.equal(result.covered, 50);
});

test("freshness uses raw milliseconds at the exact boundary", () => {
  const atBoundary = evaluateScannerHealth(
    { active: 2, recent: 2, latestChecked: NOW - WATCHDOG_FRESH_MS },
    NOW
  );
  const oneMillisecondLate = evaluateScannerHealth(
    { active: 2, recent: 2, latestChecked: NOW - WATCHDOG_FRESH_MS - 1 },
    NOW
  );

  assert.equal(atBoundary.healthy, true);
  assert.equal(oneMillisecondLate.healthy, false);
  assert.equal(oneMillisecondLate.reason, "no_recent_progress");
});

test("no completed check is a stalled scanner", () => {
  const result = evaluateScannerHealth({ active: 3, recent: 0, latestChecked: 0 }, NOW);
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "no_recent_progress");
  assert.equal(result.quietForMs, Number.POSITIVE_INFINITY);
});
