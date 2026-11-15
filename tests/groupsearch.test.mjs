import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findGroups,
  isAcceptableGroupName,
  nameMentionsPlace,
} from "../db/groupsearch.ts";

const rejectedNames = [
  "Warrandyte lost pets and livestock",
  "Cairns Camera Buy Swap Sell",
  "Cairns Buy Swap Sell Search for Jewellery new and vintage",
  "Dalyellup/Bunbury 4x4 Residents",
  "Central Coast NSW Functions & Events",
  "The Community Hub Group Inc - The Entrance Food Hub",
  "United Country Cotham & Co Realtors",
  "Warrandyte Nature",
  "Protest against extreme rates of Central Coast Council",
  "Muslim’s Community in Sutton-in-Ashfield & Mansfield Nottinghamshire UK",
  "Kirkby-in-Ashfield Community",
];

const acceptedNames = [
  "Central Coast Community Notice Board",
  "Newcastle & Hunter Community",
  "Penrith & Surrounds Community Hub: Noticeboard",
  "Bunbury Residents",
  "Templestowe Business And Community",
  "Cairns QLD Buy, Swap or Sell",
];

test("the shared group gate rejects non-tradie and foreign catalogue names", () => {
  for (const name of rejectedNames) {
    assert.equal(isAcceptableGroupName(name, true), false, name);
  }
});

test("the shared group gate keeps local community groups", () => {
  for (const name of acceptedNames) {
    assert.equal(isAcceptableGroupName(name, true), true, name);
  }
});

test("ordinary town groups are not thrown out by one word", () => {
  // Rejected before the model ever saw them: a postcode at the front read as
  // a street address, and "events", "jobs" and "history" read as hobbies.
  const kept = [
    "6027 Community Noticeboard",
    "Ellenbrook Community News & Events",
    "Baldivis Community Buy Swap Sell & Jobs",
    "Perth Tradies & Recommendations",
    "Canning Vale Chit Chat",
    "Kwinana Community History and News",
  ];
  for (const name of kept) {
    assert.equal(isAcceptableGroupName(name, true), true, name);
  }
  // A street address at the front is still not a group, and a name with no
  // sign of being a local group still fails.
  assert.equal(isAcceptableGroupName("12 Smith Street community garage sale", true), false);
  assert.equal(isAcceptableGroupName("Cairns Events", true), false);
  assert.equal(isAcceptableGroupName("Perth Jobs", true), false);
});

test("a failed search is counted, not passed off as an empty answer", async () => {
  const oldKey = process.env.BRAVE_SEARCH_KEY;
  const oldFetch = globalThis.fetch;
  const oldError = console.error;
  process.env.BRAVE_SEARCH_KEY = "test-brave-key";
  globalThis.fetch = async () => new Response("Usage limit exceeded", { status: 402 });
  console.error = () => {};
  try {
    const report = { asked: 0, failed: 0, status: 0 };
    const found = await findGroups(["Cairns"], "Queensland", 30, new Map(), new Set(), "", report);
    assert.deepEqual(found, []);
    assert.ok(report.asked > 0);
    assert.equal(report.failed, report.asked);
    assert.equal(report.status, 402);
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldError;
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_KEY;
    else process.env.BRAVE_SEARCH_KEY = oldKey;
  }
});

test("place matching does not confuse Ashfield with Sutton-in-Ashfield", () => {
  assert.equal(nameMentionsPlace("Ashfield Community Noticeboard", "Ashfield"), true);
  assert.equal(nameMentionsPlace("Sutton-in-Ashfield Community", "Ashfield"), false);
  assert.equal(nameMentionsPlace("AISKEW Buy Sell", "Kew"), false);
  assert.equal(nameMentionsPlace("Kew Residents", "Kew"), true);
});

test("Brave search is trade-aware and requests Australian web results", async () => {
  const oldKey = process.env.BRAVE_SEARCH_KEY;
  const oldFetch = globalThis.fetch;
  const calls = [];
  process.env.BRAVE_SEARCH_KEY = "test-brave-key";

  const results = [
    {
      title: "Cairns QLD Community Notice Board | Facebook",
      url: "https://www.facebook.com/groups/cairnscommunity",
    },
    {
      title: "Cairns Camera Buy Swap Sell | Facebook",
      url: "https://www.facebook.com/groups/cairnscamera",
    },
    {
      title: "Cairns Buy Swap Sell Search for Jewellery | Facebook",
      url: "https://www.facebook.com/groups/cairnsjewellery",
    },
    {
      title: "Dalyellup/Bunbury 4x4 Residents | Facebook",
      url: "https://www.facebook.com/groups/bunbury4x4",
    },
    {
      title: "Sutton-in-Ashfield Community | Facebook",
      url: "https://www.facebook.com/groups/suttonashfield",
    },
  ];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ web: { results } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const found = await findGroups(
      ["Cairns"],
      "Queensland",
      30,
      new Map(),
      new Set(),
      "Plumber"
    );

    assert.deepEqual(found.map((group) => group.name), [
      "Cairns QLD Community Notice Board",
    ]);
    assert.ok(calls.length > 0);

    let nicheQuery = false;
    for (const raw of calls) {
      const url = new URL(raw);
      assert.equal(url.searchParams.get("country"), "AU");
      assert.equal(url.searchParams.get("search_lang"), "en");
      assert.equal(url.searchParams.get("ui_lang"), "en-AU");
      assert.equal(url.searchParams.get("spellcheck"), "false");
      assert.equal(url.searchParams.get("result_filter"), "web");
      if (/plumber/i.test(url.searchParams.get("q") ?? "")) nicheQuery = true;
    }
    assert.equal(nicheQuery, true, "at least one Brave query should include the member trade");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_KEY;
    else process.env.BRAVE_SEARCH_KEY = oldKey;
  }
});
