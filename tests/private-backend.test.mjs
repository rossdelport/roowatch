import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { groupSlug, parseGroupInput } from "../db/fbgroups.ts";
import {
  privateGroupLimit,
  privateScrapingBudgetAudMicros,
  privateScrapingSafetyCutoffAudMicros,
  privateScrapingWarningAudMicros,
} from "../db/plans.ts";

test("private group limits are 40 percent of each plan", () => {
  assert.equal(privateGroupLimit("local"), 4);
  assert.equal(privateGroupLimit("growth"), 10);
  assert.equal(privateGroupLimit("scale"), 40);
});

test("private budget thresholds use exact integer AUD micros", () => {
  assert.deepEqual(
    [
      privateScrapingBudgetAudMicros("local"),
      privateScrapingSafetyCutoffAudMicros("local"),
      privateScrapingWarningAudMicros("local"),
    ],
    [49_250_000, 44_325_000, 39_400_000]
  );
});

test("Facebook group URLs have one case-insensitive canonical form", () => {
  const upper = parseGroupInput("https://www.facebook.com/groups/Perth-Tradies/");
  const lower = parseGroupInput("https://facebook.com/groups/perth-tradies?ref=share");

  assert.ok(upper);
  assert.ok(lower);
  assert.equal(upper.url, "https://www.facebook.com/groups/perth-tradies");
  assert.equal(lower.url, upper.url);
  assert.equal(upper.slug, "perth-tradies");
  assert.equal(groupSlug(upper.url), "perth-tradies");
});

test("suppressed incidents can be atomically promoted after the root outage", async () => {
  const source = await readFile(
    new URL("../db/private-alerts.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /const unsuppress =/);
  assert.match(source, /smsState: "pending"/);
  assert.match(source, /eq\(privateIncidents\.smsState, "suppressed"\)/);
  assert.match(source, /eq\(privateIncidents\.emailState, "suppressed"\)/);
});
