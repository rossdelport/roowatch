import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLeadClassifierPrompt,
  hasLeadProfile,
  LEAD_CONFIDENCE_THRESHOLD,
  obviousNonLeadReason,
  parseLeadDecision,
  splitBrief,
} from "../db/leadfilter.ts";

const steve = {
  trade: "Landscaper or gardener",
  services: "",
  location: "Central Coast, Lakke Macquarie, Newcastle",
  brief:
    "Someone in Central Coast, Lake Macquarie or Newcastle might need help if they talk about their yard looking messy or wild, grass, weeds, bushes or trees. Skip these: sellers, other gardeners offering work, far away posts and DIY advice.",
};

function modelJson(overrides = {}) {
  return JSON.stringify({
    match: true,
    service_match: true,
    buyer_intent: true,
    local_match: true,
    provider_or_ad: false,
    diy_or_information: false,
    already_resolved: false,
    confidence: 0.95,
    reason: "They need a gardener to tidy an overgrown yard in Newcastle.",
    evidence: {
      service: "tidy an overgrown yard",
      intent: "need a gardener",
      location: "Newcastle",
    },
    ...overrides,
  });
}

test("Steve's profile is usable even when services is blank", () => {
  assert.equal(hasLeadProfile(steve), true);
  assert.equal(hasLeadProfile({ ...steve, location: "" }), false);
  assert.equal(
    hasLeadProfile({ trade: "Other", services: "", location: "Newcastle", brief: "" }),
    false
  );
});

test("positive brief and Skip these rules are separated", () => {
  const result = splitBrief(steve.brief);
  assert.match(result.include, /yard looking messy/i);
  assert.match(result.exclude, /other gardeners/i);
  assert.doesNotMatch(result.include, /sellers/i);
});

test("hard rejects catch Steve's obvious ads but leave a real request for AI", () => {
  assert.match(
    obviousNonLeadReason(
      "www.skipbinswyong.com.au Skip Bins Wyong 0455888978. Need a skip? Book and pay online."
    ),
    /advertisement/i
  );
  assert.match(
    obviousNonLeadReason("Feedback from my A Night With Spirit event. Highly recommend these nights."),
    /testimonial|event/i
  );
  assert.equal(
    obviousNonLeadReason("Can anyone recommend a gardener in Newcastle to tidy an overgrown yard?"),
    ""
  );
});

test("classifier prompt includes trade, group context, and hard exclusions", () => {
  const prompt = buildLeadClassifierPrompt(
    "Can anyone recommend a gardener in Newcastle?",
    steve,
    { groupName: "Newcastle & Hunter Community" }
  );
  assert.match(prompt.system, /high-precision paid lead filter/i);
  assert.match(prompt.user, /Landscaper or gardener/);
  assert.match(prompt.user, /Newcastle &amp; Hunter Community/);
  assert.match(prompt.user, /other gardeners offering work/);
  assert.match(prompt.user, /Can anyone recommend/);
});

test("a complete, high-confidence structured verdict is a lead", () => {
  const decision = parseLeadDecision(modelJson());
  assert.equal(decision?.match, true);
  assert.equal(decision?.confidence, 0.95);
  assert.equal(decision?.serviceMatch, true);
});

test("string booleans and malformed model output fail closed", () => {
  assert.equal(parseLeadDecision(modelJson({ match: "false" })), null);
  assert.equal(parseLeadDecision("```json\n" + modelJson() + "\n```"), null);
  assert.equal(parseLeadDecision("not json"), null);
  assert.equal(parseLeadDecision(modelJson({ evidence: undefined })), null);
});

test("any failed gate suppresses the alert even when match is true", () => {
  for (const field of ["service_match", "buyer_intent", "local_match"]) {
    const decision = parseLeadDecision(modelJson({ [field]: false }));
    assert.equal(decision?.match, false, field);
  }
  assert.equal(parseLeadDecision(modelJson({ provider_or_ad: true }))?.match, false);
  assert.equal(parseLeadDecision(modelJson({ diy_or_information: true }))?.match, false);
  assert.equal(parseLeadDecision(modelJson({ already_resolved: true }))?.match, false);
});

test("confidence threshold is exact and conservative", () => {
  assert.equal(parseLeadDecision(modelJson({ confidence: LEAD_CONFIDENCE_THRESHOLD }))?.match, true);
  assert.equal(parseLeadDecision(modelJson({ confidence: LEAD_CONFIDENCE_THRESHOLD - 0.001 }))?.match, false);
  assert.equal(parseLeadDecision(modelJson({ confidence: 2 })), null);
});

test("real Steve false positives are not eligible without service evidence", () => {
  const unrelated = [
    "Hi everyone, any recommend dentist that do affordable braces?",
    "Looking for a reliable and experienced dog sitter from 27th December to 6th January.",
  ];
  for (const post of unrelated) {
    const decision = parseLeadDecision(
      modelJson({
        match: false,
        service_match: false,
        buyer_intent: true,
        confidence: 0.99,
        reason: "The post asks for a different service.",
        evidence: { service: "dentist or dog sitter", intent: "looking for help", location: "local group" },
      })
    );
    assert.equal(decision?.match, false, post);
  }
});
