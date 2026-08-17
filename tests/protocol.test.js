import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_BEHAVIOR,
  HUMAN_BEHAVIOR,
  MoneyHandError,
  addressIsAllowed,
  endpointAddressPort,
  endpointFromAddressPort,
  endpointIsAllowed,
  methodMatches,
  normalizeBehavior,
  parseRequest,
  parseWireMessage,
  portIsValid,
  responseMessage,
} from "../extension/protocol.js";

test("protocol accepts one compact versioned request", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "request",
    id: "r_1",
    method: "cdp.send",
    params: { target: { tabId: 7 }, method: "Runtime.evaluate", params: { expression: "6*7" } },
  });
  const request = parseRequest(parseWireMessage(raw));
  assert.equal(request.id, "r_1");
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.target.tabId, 7);
});

test("protocol rejects bad JSON, versions and identifiers", () => {
  assert.throws(() => parseWireMessage("{"), (error) => error instanceof MoneyHandError && error.code === "INVALID_JSON");
  assert.throws(() => parseRequest({ v: 1, type: "request", id: "r", method: "cdp.send" }), /protocol version 2/);
  assert.throws(() => parseRequest({ v: 2, type: "request", id: "bad id", method: "cdp.send" }), /request.id/);
});

test("raw behavior is fast and strict", () => {
  assert.deepEqual(DEFAULT_BEHAVIOR, {
    mode: "raw",
    beforeMs: 0,
    afterMs: 0,
    betweenStepsMs: 0,
    typingDelayMs: 0,
    pointerSteps: 1,
    pointerDurationMs: 0,
    onUnclear: "ask",
    ttlMs: 300_000,
  });
  assert.equal(normalizeBehavior(DEFAULT_BEHAVIOR, { typingDelayMs: 25 }).typingDelayMs, 25);
  assert.throws(() => normalizeBehavior(DEFAULT_BEHAVIOR, { randomHumanize: true }), /Unknown behavior field/);
});

test("human behavior is a one-field preset and raw mode restores the fast defaults", () => {
  assert.deepEqual(normalizeBehavior(DEFAULT_BEHAVIOR, { mode: "human" }), HUMAN_BEHAVIOR);
  assert.deepEqual(normalizeBehavior(HUMAN_BEHAVIOR, { mode: "raw" }), DEFAULT_BEHAVIOR);
  assert.equal(
    normalizeBehavior(HUMAN_BEHAVIOR, { typingDelayMs: 30 }).typingDelayMs,
    30,
  );
  assert.throws(
    () => normalizeBehavior(DEFAULT_BEHAVIOR, { mode: "stealth" }),
    /behavior.mode must be 'raw' or 'human'/,
  );
});

test("message limit is measured in UTF-8 bytes", () => {
  assert.throws(
    () => parseWireMessage(`"${"界".repeat(400_000)}"`),
    (error) => error instanceof MoneyHandError && error.code === "MESSAGE_TOO_LARGE",
  );
});

test("only the exact credential-free loopback WS endpoint is accepted", () => {
  assert.equal(endpointIsAllowed("ws://127.0.0.1:19846/extension"), true);
  assert.equal(endpointIsAllowed("ws://localhost:9000/extension"), true);
  assert.equal(endpointIsAllowed("ws://[::1]:19846/extension"), true);
  assert.equal(endpointIsAllowed("ws://localhost:9000"), false);
  assert.equal(endpointIsAllowed("ws://localhost/extension"), false);
  assert.equal(endpointIsAllowed("ws://user:pass@127.0.0.1:19846/extension"), false);
  assert.equal(endpointIsAllowed("ws://127.0.0.1:19846/extension?peer=other"), false);
  assert.equal(endpointIsAllowed("ws://127.0.0.1:19846/other"), false);
  assert.equal(endpointIsAllowed("ws://example.com/socket"), false);
  assert.equal(endpointIsAllowed("http://127.0.0.1:19846"), false);
});

test("simple address and port settings build one exact local endpoint", () => {
  assert.equal(DEFAULT_ENDPOINT, "ws://127.0.0.1:19846/extension");
  assert.equal(addressIsAllowed("127.0.0.1"), true);
  assert.equal(addressIsAllowed("localhost"), true);
  assert.equal(addressIsAllowed("::1"), true);
  assert.equal(addressIsAllowed("192.168.1.2"), false);
  assert.equal(portIsValid("1"), true);
  assert.equal(portIsValid(65_535), true);
  assert.equal(portIsValid("0"), false);
  assert.equal(portIsValid("65536"), false);
  assert.equal(endpointFromAddressPort("localhost", "19847"), "ws://localhost:19847/extension");
  assert.equal(endpointFromAddressPort("::1", 19_848), "ws://[::1]:19848/extension");
  assert.deepEqual(endpointAddressPort("ws://[::1]:19848/extension"), {
    address: "::1",
    port: 19_848,
  });
  assert.throws(
    () => endpointFromAddressPort("example.com", 19_846),
    (error) => error instanceof MoneyHandError && error.code === "INVALID_ENDPOINT",
  );
});

test("event subscriptions use simple wildcard matching", () => {
  assert.equal(methodMatches("Network.*", "Network.requestWillBeSent"), true);
  assert.equal(methodMatches("Page.frameNavigated", "Page.frameNavigated"), true);
  assert.equal(methodMatches("Page.*", "Network.requestWillBeSent"), false);
});

test("10,000 response envelopes retain their request ids", () => {
  for (let index = 0; index < 10_000; index += 1) {
    const message = responseMessage(`r_${index}`, { index });
    assert.equal(message.id, `r_${index}`);
    assert.equal(message.result.index, index);
  }
});
