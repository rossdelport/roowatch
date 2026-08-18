import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.js";

test("structured logs redact secrets, cookies and private text", () => {
  let output = "";
  const logger = createLogger({ write: (value) => { output += value; } });
  logger.error("safe_event", {
    authorization: "Bearer abc.def",
    cookie: "c_user=private",
    password: "private",
    posts: [{ text: "private group message" }],
    error: new Error("proxy https://user:pass@proxy.example failed")
  });
  assert.equal(output.includes("abc.def"), false);
  assert.equal(output.includes("c_user"), false);
  assert.equal(output.includes("private group message"), false);
  assert.equal(output.includes("user:pass"), false);
  assert.equal(JSON.parse(output).event, "safe_event");
});
