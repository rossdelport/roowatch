import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLANS, TRIAL_DAYS } from "../db/plans.ts";

const port = 3100 + (process.pid % 500);
const baseUrl = `http://localhost:${port}`;
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
  assert.match(html, /<title>RooWatch - Instant lead generation<\/title>/i);
  assert.match(html, /Facebook group leads for/);
  assert.match(html, /Closed to new signups/);
  assert.doesNotMatch(html, /href="\/signup\?plan=/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|react-loading-skeleton/);
});

// The plan cards once said 10, 25 and 100 groups while db/plans.ts said 20, 50
// and 200. The page is plain HTML, so nothing else ties the two together.
test("landing page plan cards match db/plans.ts", async () => {
  const { html } = await page("/");
  const cards = html.match(/<article class="plan[ "][\s\S]*?<\/article>/g) ?? [];
  for (const plan of Object.values(PLANS)) {
    const card = cards.find((c) => c.includes(`<span class="plan-title">${plan.name}</span>`));
    assert.ok(card, `no plan card for ${plan.name}`);
    assert.ok(card.includes(`<strong>$${plan.priceAud}</strong>`), `${plan.name} price`);
    assert.ok(
      card.includes(`${TRIAL_DAYS} days free, then $${plan.priceAud} a month`),
      `${plan.name} trial line`
    );
    // Every group count in the card: the headline one and the feature list one.
    const counts = [...card.matchAll(/(\d+)(?:<\/b>)? groups watched/g)].map((m) => Number(m[1]));
    assert.ok(counts.length > 0, `${plan.name} shows no group count`);
    assert.deepEqual([...new Set(counts)], [plan.groups], `${plan.name} group count`);
  }
});

test("renders generic and trade-specific reserve pages", async () => {
  const generic = await page("/reserve");
  assert.equal(generic.response.status, 200);
  assert.match(generic.html, /Start getting leads/);
  assert.match(generic.html, /Closed to new signups/);
  assert.doesNotMatch(generic.html, /href="\/signup\?plan=/);
  assert.doesNotMatch(generic.html, /api\/waitlist/);

  const trade = await page("/reserve/plumbers");
  assert.equal(trade.response.status, 200);
  assert.match(trade.html, /Your next customer is asking for a <span class="highlight">plumber<\/span>/);
  assert.match(trade.html, /Closed to new signups/);
  assert.doesNotMatch(trade.html, /href="\/signup\?plan=/);
});

test("blocks new checkout sessions after shutdown", async () => {
  const response = await fetch(`${baseUrl}/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "local" }),
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "service_closed",
    message: "RooWatch is no longer accepting new subscriptions.",
  });
});

test("keeps anonymous API access unauthenticated", async () => {
  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("keeps the admin command centre private without a second password", async () => {
  const response = await fetch(`${baseUrl}/api/admin/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "this must not unlock anything" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });

  const dashboard = readFileSync("app/dashboard/DashboardApp.tsx", "utf8");
  assert.match(dashboard, /ROSS ADMIN/);
  assert.match(dashboard, /Command centre/);
  assert.match(dashboard, /Customers/);
  assert.match(dashboard, /Payments/);
  assert.match(dashboard, /\{watchingGroupCount\}\/\{plan\.groups\}/);
  assert.match(dashboard, /Setup complete, no card/);
  assert.match(dashboard, /Card accepted, on trial/);
  assert.match(dashboard, /Card accepted, paying/);
  assert.match(dashboard, /!status && !member\.stripeCustomerId/);
  assert.match(dashboard, /journey-left-at-stripe/);
  assert.match(dashboard, /journey-card-added/);
  assert.doesNotMatch(dashboard, /Master password|Master access|adminPass/);

  const guard = readFileSync("db/admin.ts", "utf8");
  assert.match(guard, /currentUser\(request\)/);
  assert.match(guard, /isAdminEmail\(user\.email\)/);
  assert.doesNotMatch(guard, /ADMIN_PASSWORD/);

  const auth = readFileSync("db/auth.ts", "utf8");
  assert.match(auth, /new Set\(\["ross@roowatch\.com\.au"\]\)/);
  assert.doesNotMatch(auth, /rossdelport1998@gmail\.com/);
});
