import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchTrade } from "../db/trades.ts";
import { readSite } from "../db/website.ts";

test("setup is four screens and the start button sits on the last one", () => {
  const app = readFileSync("app/dashboard/DashboardApp.tsx", "utf8");
  assert.match(app, /const STAGES: Stage\[\] = \["business", "details", "jobs", "groups"\];/);
  // Drafts saved under the old six screen wizard still land somewhere sensible.
  assert.match(app, /trade: "details", suburbs: "details", review: "groups"/);
  assert.doesNotMatch(app, /stage === "review"/);
  assert.match(app, /stage === "groups" \? \(\s*<button className="btn primary" disabled=\{!canGo\.groups \|\| busy\} onClick=\{finish\}/);
});

test("nobody gets past the website screen without a website that answers", () => {
  const app = readFileSync("app/dashboard/DashboardApp.tsx", "utf8");
  const scan = app.slice(app.indexOf("async function scan()"), app.indexOf("const askForBrief"));
  // A failed check keeps them on the screen with the reason, and only a
  // reached website moves on.
  assert.match(scan, /if \(!res\.ok\) \{[\s\S]*?setNote\([\s\S]*?"unreachable"[\s\S]*?return;/);
  assert.match(scan, /if \(reached\) \{[\s\S]*?setStage\("details"\)/);
  assert.doesNotMatch(scan, /You can fill the rest in yourself/);
  // Coming back later with no website saved starts at the website screen.
  assert.match(app, /if \(!website\.trim\(\) \|\| !draft\.stage\) return "business";/);

  const route = readFileSync("app/api/onboarding/scan/route.ts", "utf8");
  assert.match(route, /if \(!site\.reached\) \{\s*return Response\.json\(\{ error: "unreachable" \}, \{ status: 400 \}\);/);
  const save = readFileSync("app/api/onboarding/route.ts", "utf8");
  assert.match(save, /if \(!normaliseUrl\(website\)\) return Response\.json\(\{ error: "no_website" \}, \{ status: 400 \}\);/);
});

test("a bad address is not reached, and a real site that will not talk still is", async () => {
  assert.equal((await readSite("not a website")).reached, false);
  assert.equal((await readSite("ftp://example.com")).reached, false);

  // A bot wall answers 403. The site is real, we just cannot read it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("no", { status: 403, headers: { "content-type": "text/html" } });
  try {
    const blocked = await readSite("https://example.com.au");
    assert.equal(blocked.reached, true);
    assert.equal(blocked.text, "");

    globalThis.fetch = async () => new Response("<html><body><h1>Bob's Plumbing</h1></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const read = await readSite("example.com.au");
    assert.equal(read.reached, true);
    assert.match(read.text, /Bob's Plumbing/);

    // Nothing at that name at all.
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    assert.equal((await readSite("https://nothing-here.example")).reached, false);

    // Slow is not the same as dead.
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    assert.equal((await readSite("https://slow.example.com.au")).reached, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the trade on the ad follows them into their account", () => {
  // What the reserve pages actually send.
  assert.equal(matchTrade("plumber"), "Plumber");
  assert.equal(matchTrade("pest controller"), "Pest control");
  assert.equal(matchTrade("landscaper"), "Landscaper or gardener");
  assert.equal(matchTrade("astronaut"), "");

  const page = readFileSync("app/signup/page.tsx", "utf8");
  assert.match(page, /trade=\{matchTrade\(trade \?\? ""\)\}/);
  const form = readFileSync("app/signup/SignupApp.tsx", "utf8");
  assert.match(form, /plan,\s*trade,\s*\}/);
  const route = readFileSync("app/api/auth/signup/route.ts", "utf8");
  assert.match(route, /const trade = matchTrade\(clean\(body\.trade, 60\)\);/);
  // The wizard keeps that trade rather than swapping it for a website guess.
  const app = readFileSync("app/dashboard/DashboardApp.tsx", "utf8");
  assert.match(app, /if \(data\.trade && !trade\) setTrade\(data\.trade\);/);
});
