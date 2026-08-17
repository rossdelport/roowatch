import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
