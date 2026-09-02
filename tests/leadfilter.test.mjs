import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildLeadClassifierPrompt,
  buildLeadClassifierRequest,
  hasLeadProfile,
  LEAD_CONFIDENCE_THRESHOLD,
  LEAD_DECISION_JSON_SCHEMA,
  LEAD_FILTER_MAX_TOKENS,
  LEAD_FILTER_MODEL,
  LEAD_VERIFY_MODEL_DEFAULT,
  leadResponseError,
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

test("Anthropic structured output enforces every parser field", () => {
  assert.equal(LEAD_DECISION_JSON_SCHEMA.type, "object");
  assert.equal(LEAD_DECISION_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    [...LEAD_DECISION_JSON_SCHEMA.required].sort(),
    Object.keys(LEAD_DECISION_JSON_SCHEMA.properties).sort()
  );
  assert.deepEqual(LEAD_DECISION_JSON_SCHEMA.properties.evidence.required, [
    "service",
    "intent",
    "location",
  ]);
  assert.equal(LEAD_DECISION_JSON_SCHEMA.properties.match.type, "boolean");
  assert.equal(LEAD_DECISION_JSON_SCHEMA.properties.confidence.type, "number");
});

test("classifier request sends the schema through the current API field", () => {
  const request = buildLeadClassifierRequest({ system: "system rules", user: "post data" });
  assert.equal(request.model, LEAD_FILTER_MODEL);
  assert.equal(request.max_tokens, LEAD_FILTER_MAX_TOKENS);
  assert.equal(request.system, "system rules");
  assert.deepEqual(request.messages, [{ role: "user", content: "post data" }]);
  assert.equal(request.output_config.format.type, "json_schema");
  assert.deepEqual(request.output_config.format.schema, LEAD_DECISION_JSON_SCHEMA);
  assert.equal("output_format" in request, false);
});

test("only a normally completed Anthropic response is accepted", () => {
  assert.equal(leadResponseError("end_turn"), "");
  assert.equal(leadResponseError("max_tokens"), "lead_filter_output_truncated");
  assert.equal(leadResponseError("refusal"), "lead_filter_refused");
  assert.equal(leadResponseError("model_context_window_exceeded"), "lead_filter_incomplete_response");
  assert.equal(leadResponseError(undefined), "lead_filter_incomplete_response");
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

test("hard rejects catch what members were actually texted about", () => {
  const junk = {
    "Ride on mower for sale, runs well, $850 ono, pick up Toukley.": /selling/i,
    "Trailer 7x4 pick up only $400 firm": /selling/i,
    "Qualified carpenter looking for work around the Central Coast, have own tools.": /looking for work/i,
    "Landscaper available for work, taking on new clients this month, message for a quote": /looking for work|provider/i,
    "We are hiring! Labourer position available, immediate start, apply now.": /job advertisement/i,
    "Kittens free to a good home, 8 weeks old, Wyong": /giveaway|lost pet/i,
    "LOST DOG near Lake Haven, brown kelpie, please share": /giveaway|lost pet/i,
  };
  for (const [post, expected] of Object.entries(junk)) {
    assert.match(obviousNonLeadReason(post), expected, post);
  }

  // Real requests must not be caught by the new rules.
  const real = [
    "Looking for a gardener to tidy the yard before we put the house up for sale, Newcastle",
    "Our house is for sale and the lawns need doing, can anyone recommend someone in Belmont?",
    "How much would you expect to pay to have a big gum tree removed? Need it done in Toukley.",
    "Looking for someone to do a hedge trim and mow at my mums place in Charlestown",
    "Anyone know a good landscaper who can take on a small retaining wall job in Gosford?",
  ];
  for (const post of real) {
    assert.equal(obviousNonLeadReason(post), "", post);
  }
});

test("the prompt spells out what is never a lead", () => {
  const prompt = buildLeadClassifierPrompt("Can anyone recommend a gardener?", steve, {
    groupName: "Newcastle Community",
  });
  assert.match(prompt.system, /These are never leads, whatever words they contain/);
  assert.match(prompt.system, /Somebody selling anything/);
  assert.match(prompt.system, /looking for work/);
  assert.match(prompt.system, /A gardener does not want a dentist, a dog sitter/);
  assert.doesNotMatch(prompt.system, /second opinion/);
});

test("the verify pass is a second, stricter read by a stronger model", () => {
  const prompt = buildLeadClassifierPrompt(
    "Can anyone recommend a gardener?",
    steve,
    { groupName: "Newcastle Community" },
    "verify"
  );
  assert.match(prompt.system, /second opinion and you have the final say/);
  assert.match(prompt.system, /set match to false/);

  const request = buildLeadClassifierRequest(prompt, LEAD_VERIFY_MODEL_DEFAULT);
  assert.equal(request.model, LEAD_VERIFY_MODEL_DEFAULT);
  assert.notEqual(LEAD_VERIFY_MODEL_DEFAULT, LEAD_FILTER_MODEL);
  assert.equal(buildLeadClassifierRequest(prompt).model, LEAD_FILTER_MODEL);

  // Both models must say yes, and the second one has the last word. A
  // failure on either pass throws rather than guessing.
  const pipeline = readFileSync("db/pipeline.ts", "utf8");
  const classify = pipeline.slice(
    pipeline.indexOf("export async function classifyPost"),
    pipeline.indexOf("async function askLeadModel")
  );
  assert.match(classify, /askLeadModel\(anthropicKey, post, member, context, "first", LEAD_FILTER_MODEL\)/);
  assert.match(classify, /if \(!first\.match\) return first;/);
  assert.match(classify, /process\.env\.LEAD_VERIFY_MODEL\?\.trim\(\) \|\| LEAD_VERIFY_MODEL_DEFAULT/);
  assert.match(classify, /askLeadModel\(anthropicKey, post, member, context, "verify", verifyModel\)/);
  assert.match(classify, /lead_verify_overruled/);
  assert.match(classify, /return second;\s*\}/);
  assert.doesNotMatch(classify, /return first;\s*\}/);
});
