import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NetworkByteTracker, installResourceBlocking } from "../src/network.js";

test("counts completed and cancelled response bytes without double counting", async () => {
  const session = new EventEmitter();
  session.send = async () => {};
  session.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => session }) };
  let limits = 0;
  const tracker = await new NetworkByteTracker(page, 150, () => { limits += 1; }).start();
  session.emit("Network.dataReceived", { requestId: "one", encodedDataLength: 100 });
  session.emit("Network.loadingFinished", { requestId: "one", encodedDataLength: 120 });
  assert.equal(tracker.bytes, 120);
  session.emit("Network.dataReceived", { requestId: "two", encodedDataLength: 50 });
  session.emit("Network.loadingFailed", { requestId: "two" });
  await Promise.resolve();
  assert.equal(tracker.bytes, 170);
  assert.equal(limits, 1);
  assert.throws(() => tracker.assertWithinLimit(), /exceeded its transfer limit/);
  await tracker.stop();
});

test("blocks streaming sockets and event sources before they can escape the byte guard", async () => {
  let websocketHandler;
  let requestHandler;
  const page = {
    async routeWebSocket(pattern, handler) { assert.equal(pattern, "**/*"); websocketHandler = handler; },
    async route(pattern, handler) { assert.equal(pattern, "**/*"); requestHandler = handler; }
  };
  await installResourceBlocking(page);

  let socketClosed = false;
  await websocketHandler({ async close() { socketClosed = true; } });
  assert.equal(socketClosed, true);

  let aborted = false;
  await requestHandler({
    request() {
      return { url: () => "https://www.facebook.com/events", resourceType: () => "eventsource" };
    },
    async abort() { aborted = true; },
    async continue() { throw new Error("must not continue an event source"); }
  });
  assert.equal(aborted, true);
});
