import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(html, /Get local leads/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|react-loading-skeleton/);
});

test("renders generic and trade-specific reserve pages", async () => {
  const generic = await page("/reserve");
  assert.equal(generic.response.status, 200);
  assert.match(generic.html, /Start getting leads/);
  // Pricing replaced the waitlist form, so the page must sell, not collect.
  assert.match(generic.html, /href="\/signup\?plan=local"/);
  assert.doesNotMatch(generic.html, /api\/waitlist/);

  const trade = await page("/reserve/plumbers");
  assert.equal(trade.response.status, 200);
  assert.match(trade.html, /Your next customer is asking for a <span class="highlight">plumber<\/span>/);
  // The ad already knows their trade, so signup must not ask again.
  assert.match(trade.html, /href="\/signup\?plan=local&trade=plumber"/);
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
