import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("admin group repair is scoped and leaves scanner jobs alone", () => {
  const route = readFileSync("app/api/admin/groups/route.ts", "utf8");
  const auth = readFileSync("db/auth.ts", "utf8");

  assert.match(route, /requireAdmin\(request\)/);
  assert.match(auth, /ADMIN_EMAILS = new Set\(\["ross@roowatch\.com\.au"\]\)/);
  assert.match(route, /memberTopUpLeaseId\(userId\)/);
  assert.match(route, /action\?: "list" \| "rescan" \| "topup"/);
  assert.match(route, /eq\(groups\.userId, userId\)/);
  assert.match(route, /eq\(groups\.id, target\.id\)/);
  assert.match(route, /findGroups\(\s*canonical\.suburbs,[\s\S]*profile\.trade/);
  assert.match(route, /isAcceptableGroupName\(row\.name, true\)/);
  assert.match(route, /const excludedNames = new Set\(/);
  assert.match(route, /droppedGroups\.slug/);
  assert.match(route, /const ordered = fresh/);
  assert.match(route, /sizeUnknown\(pendingSlugs/);
  assert.match(route, /groupLimit\(current\.profile\.plan\)/);
  assert.match(route, /topUpMember\(userId, true\)/);
  assert.match(route, /stillWatched/);
  assert.doesNotMatch(route, /scanJobs/);
  assert.doesNotMatch(route, /SCAN_PAUSED/);
});
