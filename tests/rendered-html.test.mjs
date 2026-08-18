import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const port = 3100 + (process.pid % 500);
const baseUrl = `http://localhost:${port}`;
const instantTimingClaim = /\binstant(?:ly)?\b|\b(?:under|within|in)\s+(?:(?:a|one|1)\s+minute|60[- ]seconds?)\b|\bthe second they post\b|\bsub[- ]?minute\b|\breal[- ]time\b/i;
const emDashClaim = new RegExp([String.fromCharCode(8212), "&" + "mdash;", "&#" + "8212;", "&#x" + "2014;"].join("|"), "i");
let devServer;

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vinext dev server did not start: ${lastError ?? "timeout"}`);
}

async function page(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { response, html: await response.text() };
}

test.before(async () => {
  devServer = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
    env: process.env,
    stdio: "ignore",
  });
  await waitForServer();
});

test.after(() => {
  devServer?.kill("SIGTERM");
});

test("renders the public landing page", async () => {
  const { response, html } = await page("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(html, /<title>RooWatch \| Facebook group lead alerts<\/title>/i);
  assert.match(html, /Facebook group leads for/);
  assert.match(html, /Get local leads/);
  assert.match(html, /Public and private Facebook groups across Australia/);
  assert.match(html, /Private groups are checked once an hour/);
  assert.match(html, /No Facebook password needed/);
  assert.match(html, /You never give us your Facebook login or password/);
  assert.match(html, /Up to 40% can be private/);
  assert.match(html, /Up to 4 can be private/);
  assert.match(html, /Up to 10 can be private/);
  assert.match(html, /Up to 40 can be private/);
  assert.match(html, /All prices are AUD/);
  assert.doesNotMatch(html, instantTimingClaim);
  assert.doesNotMatch(html, /Public groups only/i);
  assert.doesNotMatch(html, emDashClaim);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|react-loading-skeleton/);
});

test("renders generic and trade-specific reserve pages", async () => {
  const generic = await page("/reserve");
  assert.equal(generic.response.status, 200);
  assert.match(generic.html, /Start getting leads/);
  // Pricing replaced the waitlist form, so the page must sell, not collect.
  assert.match(generic.html, /href="\/signup\?plan=local"/);
  assert.doesNotMatch(generic.html, /api\/waitlist/);
  assert.doesNotMatch(generic.html, instantTimingClaim);
  assert.doesNotMatch(generic.html, emDashClaim);
  assert.match(generic.html, /Private groups checked each hour/);

  const trade = await page("/reserve/plumbers");
  assert.equal(trade.response.status, 200);
  assert.match(trade.html, /Your next customer is asking for a <span class="highlight">plumber<\/span>/);
  // The ad already knows their trade, so signup must not ask again.
  assert.match(trade.html, /href="\/signup\?plan=local&trade=plumber"/);
  assert.doesNotMatch(trade.html, instantTimingClaim);
  assert.doesNotMatch(trade.html, emDashClaim);
});

test("keeps signup timing honest", async () => {
  const signup = await page("/signup");
  assert.equal(signup.response.status, 200);
  assert.match(signup.html, /Public groups are checked often/);
  assert.match(signup.html, /Private groups are checked once an hour/);
  assert.doesNotMatch(signup.html, instantTimingClaim);
  assert.doesNotMatch(signup.html, emDashClaim);
});

test("keeps anonymous API access unauthenticated", async () => {
  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("keeps private scraper routes locked without their secret", async () => {
  const jobs = await fetch(
    `${baseUrl}/api/internal/private-scraper/jobs?workerId=private-scraper-01`
  );
  const heartbeat = await fetch(`${baseUrl}/api/internal/private-scraper/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const results = await fetch(`${baseUrl}/api/internal/private-scraper/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(jobs.status, 401);
  assert.equal(heartbeat.status, 401);
  assert.equal(results.status, 401);
});

test("keeps private group states and admin controls visible", () => {
  const source = readFileSync(new URL("../app/dashboard/DashboardApp.tsx", import.meta.url), "utf8");
  assert.match(source, /Bright Data is checking this group/);
  assert.match(source, /privateGroups/);
  assert.match(source, /Private monitoring/);
  assert.match(source, /Checking group type/);
  assert.match(source, /Waiting for access/);
  assert.match(source, /Access lost/);
  assert.match(source, /Private watch paused/);
  assert.match(source, /Over private group limit/);
  assert.match(source, /Needs help/);
  assert.match(source, /Public Bright Data monitoring never pauses here/);
  assert.match(source, /Monitoring is on/);
  assert.match(source, /setTimeout\(loadPrivateMonitoring, 0\)/);
  assert.match(source, /setInterval\(loadPrivateMonitoring, 15_000\)/);
  assert.match(source, /JSON\.stringify\(\{ password: adminPass, action: "status" \}\)/);
  assert.match(source, /res\.status === 202 && data\.checking/);
  assert.match(source, /chronologicalVerified/);
  assert.match(source, /boundaryReached/);
  assert.match(source, /feedEndReached/);
  assert.match(source, /errorDetail/);
  assert.match(source, /65m cut-off/);
  assert.match(source, /warningAudMicros/);
  assert.match(source, /safetyCutoffAudMicros/);
  assert.match(source, /lastSuccessAt/);
  assert.match(source, /Last good/);
  assert.match(source, /aggregate/);
  assert.match(source, /Not reported/);
  assert.match(source, /We never ask for your Facebook password/);
  assert.doesNotMatch(source, /The moment a job comes up|start watching it the moment/i);
  assert.doesNotMatch(source, /Scanning all groups|SCAN_SECONDS/);
  assert.doesNotMatch(source, /Watching live/);
  assert.doesNotMatch(source, emDashClaim);
  assert.match(source, /retry_check/);
  assert.match(source, /validate_session/);
  assert.match(source, /acknowledge_incident/);
  assert.doesNotMatch(source, /generatedAt:\s*data\.generatedAt\s*\|\|/);
  assert.doesNotMatch(source, /Sorry, we cannot watch private groups|Public groups only/i);
});
