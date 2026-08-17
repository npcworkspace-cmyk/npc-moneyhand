import assert from "node:assert/strict";
import test from "node:test";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("background keeps only known popup message channels open and replies asynchronously", async () => {
  const fake = createFakeChrome();
  const previousChrome = globalThis.chrome;
  const previousWebSocket = globalThis.WebSocket;
  globalThis.chrome = fake.chrome;
  globalThis.WebSocket = FakeWebSocket;

  try {
    await import(`../extension/background.js?background-messaging=${Date.now()}`);
    await tick();

    const [listener] = fake.events.runtimeMessage.listeners;
    assert.equal(typeof listener, "function");

    for (const type of ["popup.status", "popup.configure", "popup.stop"]) {
      let callbackCalls = 0;
      let resolveResponse;
      const response = new Promise((resolve) => {
        resolveResponse = resolve;
      });
      const message = type === "popup.configure"
        ? { type, address: "127.0.0.1", port: 19_846 }
        : { type };
      const returnValue = listener(message, {}, (value) => {
        callbackCalls += 1;
        resolveResponse(value);
      });

      assert.equal(returnValue, true, `${type} must keep the Chrome response channel open`);
      assert.equal(callbackCalls, 0, `${type} must not reply synchronously`);
      assert.equal(typeof await response, "object");
      assert.equal(callbackCalls, 1);
    }

    let unknownResponses = 0;
    const unknownReturn = listener({ type: "some.other.message" }, {}, () => {
      unknownResponses += 1;
    });
    assert.notEqual(unknownReturn, true);
    await tick();
    assert.equal(unknownResponses, 0);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});
