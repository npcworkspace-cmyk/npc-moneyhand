import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { MoneyHandBridge } from "../extension/bridge.js";
import { MoneyHandExecutor } from "../extension/executor.js";
import { MAX_UNKNOWN_OUTCOME_IDS } from "../extension/protocol.js";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}

function serverProof(secret, hello, nonce) {
  const payload = [
    "npc-moneyhand/2",
    "server",
    hello.profile,
    hello.instanceId,
    hello.bootId,
    hello.auth.clientNonce,
    nonce,
  ].join("\n");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function readyBridge(t, { authToken = "", now = Date.now } = {}) {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: true,
    profileAlias: "work",
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken,
  });
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_test",
    random: () => 0.5,
    now,
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await tick();
  const hello = socket.sent[0];
  assert.equal(hello.type, "hello");
  assert.equal(hello.product, "npc-moneyhand");
  assert.match(hello.profile, /^npc-[a-f0-9]{32}$/u);
  assert.equal(hello.focus.focused, true);
  assert.equal(hello.focus.windowId, 1);
  assert.ok(hello.focus.lastFocusedAt > 0);
  assert.equal(hello.auth.mode, authToken ? "hmac-sha256" : "none");
  assert.equal(hello.capabilities.coordinateContract, "css-viewport-v1");
  if (authToken) {
    assert.equal(JSON.stringify(hello).includes(authToken), false);
    const nonce = "server_nonce_123456789";
    socket.receive({
      v: 2,
      type: "challenge",
      protocol: "npc-moneyhand/2",
      nonce,
      proof: serverProof(authToken, hello, nonce),
    });
    await waitFor(() => socket.sent.find((message) => message.type === "authenticate"));
  }
  socket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    heartbeatMs: 20_000,
    maxInflight: 64,
  });
  await tick();
  return { bridge, fake, socket };
}

test("toolbar smile follows connection state and pulses blue on heartbeat", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  const iconPaths = () => fake.calls
    .filter((call) => call.api === "action.setIcon")
    .map((call) => call.details.path[16]);
  assert.ok(iconPaths().includes("icons/smile-red-16.png"));
  assert.ok(iconPaths().includes("icons/smile-yellow-16.png"));
  assert.equal(iconPaths().at(-1), "icons/smile-green-16.png");

  bridge.heartbeatTick(socket, bridge.epoch);
  assert.equal(iconPaths().at(-1), "icons/smile-blue-16.png");
  bridge.setState("DISCONNECTED");
  assert.equal(iconPaths().at(-1), "icons/smile-red-16.png");
});

test("window focus changes are persisted and sent to the Agent", async (t) => {
  const { fake, socket } = await readyBridge(t);
  fake.events.windowFocus.emit(7);
  const focused = await waitFor(
    () => socket.sent.find((message) => (
      message.type === "event"
      && message.event === "window.focused"
      && message.data?.focused === true
      && message.target?.windowId === 7
    )),
  );
  assert.equal(fake.storage.lastFocusedWindowId, 7);
  assert.equal(fake.storage.lastFocusedAt, focused.data.lastFocusedAt);

  fake.events.windowFocus.emit(-1);
  const blurred = await waitFor(
    () => socket.sent.find((message) => (
      message.type === "event"
      && message.event === "window.focused"
      && message.data?.focused === false
    )),
  );
  assert.equal(blurred.target.windowId, -1);
  assert.equal(fake.storage.lastFocusedAt, focused.data.lastFocusedAt);
});

test("the latest focus is replayed when it changes before READY", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: true,
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken: "",
  });
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_focus_ready",
  });
  t.after(() => bridge.stop());
  await bridge.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await waitFor(() => socket.sent.some((message) => message.type === "hello"));

  fake.events.windowFocus.emit(9);
  await waitFor(() => fake.storage.lastFocusedWindowId === 9);
  socket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    heartbeatMs: 20_000,
    maxInflight: 64,
  });
  const replayed = await waitFor(
    () => socket.sent.find((message) => (
      message.type === "event"
      && message.event === "window.focused"
      && message.target?.windowId === 9
    )),
  );

  assert.equal(replayed.data.focused, true);
  assert.equal(replayed.data.lastFocusedAt, fake.storage.lastFocusedAt);
});

test("focus events are serialized so an older write cannot win a later blur", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  let releaseRead;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let delay = true;
  fake.chrome.storage.local.get = async (defaults = {}) => {
    if (delay && Object.hasOwn(defaults, "lastFocusedAt")) {
      delay = false;
      markStarted();
      await release;
    }
    return await originalGet(defaults);
  };

  fake.events.windowFocus.emit(7);
  await started;
  fake.events.windowFocus.emit(-1);
  releaseRead();
  await waitFor(
    () => socket.sent.some((message) => (
      message.type === "event"
      && message.event === "window.focused"
      && message.target?.windowId === -1
    )),
  );
  fake.chrome.storage.local.get = originalGet;

  assert.equal(bridge.focus.focused, false);
  assert.equal(bridge.focus.windowId, 7);
});

test("WS handshake executes a request and returns exactly one correlated terminal response", async (t) => {
  const { bridge, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "r_1",
    method: "cdp.send",
    params: {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression: "6*7" },
    },
  });
  await tick();
  const responses = socket.sent.filter((message) => message.type === "response" && message.id === "r_1");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  await bridge.stop();
});

test("Agent ready confirmation ping echoes its exact timestamp token", async (t) => {
  const { socket } = await readyBridge(t);
  const timestamp = "confirm_1234567890abcdef";
  socket.receive({ v: 2, type: "ping", timestamp });
  const pong = await waitFor(
    () => socket.sent.find((message) => message.type === "pong" && message.timestamp === timestamp),
  );
  assert.equal(pong.v, 2);
});

test("unexpected Agent messages fail closed and cannot fake heartbeat liveness", async (t) => {
  let now = 1_000;
  const { bridge, socket } = await readyBridge(t, { now: () => now });
  const lastSeenAt = bridge.lastSeenAt;
  now = 2_000;

  socket.receive({ v: 2, type: "undefined-state" });
  await tick();

  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(bridge.lastSeenAt, lastSeenAt);
  assert.match(bridge.lastError, /未定义|unexpected/iu);
});

test("unknown-outcome capacity fails closed before another browser action starts", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  for (let index = 0; index < MAX_UNKNOWN_OUTCOME_IDS; index += 1) {
    bridge.unknownOutcomeIds.add(`unknown-${index}`);
  }

  socket.receive({
    v: 2,
    type: "request",
    id: "ledger-full",
    method: "cdp.send",
    params: {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression: "mustNotRun()" },
    },
  });
  await tick();

  const response = socket.sent.find((message) => message.id === "ledger-full");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "OUTCOME_LEDGER_FULL");
  assert.equal(fake.calls.some(
    (call) => call.method === "Runtime.evaluate" && call.params.expression === "mustNotRun()",
  ), false);
});

test("duplicate ids reuse the terminal response without repeating browser side effects", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  const request = {
    v: 2,
    type: "request",
    id: "same-id",
    method: "cdp.send",
    params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression: "1" } },
  };
  socket.receive(request);
  await tick();
  socket.receive(request);
  await tick();
  assert.equal(fake.calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
  assert.equal(socket.sent.filter((message) => message.type === "response" && message.id === "same-id").length, 2);
  await bridge.stop();
});

test("unknown operations return bounded text and wait for a new Agent instruction without screenshots", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "unknown-1",
    method: "page.understand-this",
    params: { tabId: 1 },
  });
  await tick();
  const response = socket.sent.find((message) => message.id === "unknown-1");
  assert.equal(response.status, "needs_instruction");
  assert.equal(response.need.context.text, "Example page text");
  assert.equal(response.need.context.untrustedPageContent, true);
  assert.equal(fake.calls.some((call) => call.method === "Page.captureScreenshot"), false);
  await bridge.stop();
});

test("low-priority events are dropped under WS backpressure but responses are retained", async (t) => {
  const { bridge, socket } = await readyBridge(t);
  socket.bufferedAmount = 3 * 1024 * 1024;
  bridge.emitEvent({ event: "cdp", target: { tabId: 1 }, data: { method: "Network.dataReceived" } });
  assert.equal((await bridge.status()).droppedEvents, 1);
  socket.bufferedAmount = 0;
  socket.receive({
    v: 2,
    type: "request",
    id: "status-1",
    method: "system.status",
    params: {},
  });
  await tick();
  assert.equal(socket.sent.some((message) => message.type === "response" && message.id === "status-1"), true);
  await bridge.stop();
});

test("pairing uses mutual HMAC without sending the raw secret", async (t) => {
  const { bridge, socket } = await readyBridge(t, { authToken: "pair-secret-123456" });
  assert.equal((await bridge.status()).state, "READY");
  assert.equal(socket.sent.some((message) => JSON.stringify(message).includes("pair-secret-123456")), false);
});

test("saving the simple endpoint preserves an independently provisioned pairing secret", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: false,
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken: "pair-secret-123456",
  });
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_pairing_config",
  });
  t.after(() => bridge.stop());
  await bridge.configure({ address: "127.0.0.1", port: 19847 });
  const stored = await fake.chrome.storage.local.get({
    wsEndpoint: "",
    authToken: "",
  });
  assert.equal(stored.wsEndpoint, "ws://127.0.0.1:19847/extension");
  assert.equal(stored.authToken, "pair-secret-123456");
});

test("invalid behavior is a direct terminal error and never locks or observes a tab", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "bad-behavior",
    method: "input.perform",
    params: { target: { tabId: 1 }, action: "click", x: 1, y: 2 },
    behavior: { mode: "custom" },
  });
  await tick();
  const response = socket.sent.find((message) => message.id === "bad-behavior");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_BEHAVIOR");
  assert.equal(response.status, undefined);
  assert.equal(fake.calls.some((call) => call.method === "Runtime.evaluate"), false);
  assert.deepEqual((await bridge.executor.status()).waiting, []);
});

test("invalid coordinate space is a direct terminal error with no browser side effect", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  const callsBefore = fake.calls.length;
  socket.receive({
    v: 2,
    type: "request",
    id: "bad-coordinate-space",
    method: "input.perform",
    params: {
      target: { tabId: 1 },
      action: "click",
      x: 1,
      y: 2,
      coordinateSpace: "screen",
    },
  });
  const response = await waitFor(() => socket.sent.find((message) => message.id === "bad-coordinate-space"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_ARGUMENT");
  assert.equal(response.status, undefined);
  assert.equal(fake.calls.length, callsBefore);
  assert.equal((await bridge.status()).state, "READY");
  assert.deepEqual((await bridge.executor.status()).waiting, []);
});

test("disconnect cancels queued writes, reports only started work, and requires explicit ACK", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  let release;
  fake.handlers.set("Runtime.evaluate", () => new Promise((resolve) => {
    release = resolve;
  }));
  const request = (id, expression) => ({
    v: 2,
    type: "request",
    id,
    method: "cdp.send",
    params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression } },
  });
  socket.receive(request("active-write", "1"));
  socket.receive(request("queued-write", "2"));
  await waitFor(() => fake.calls.filter((call) => call.method === "Runtime.evaluate").length === 1);
  socket.close(1006, "network lost");
  await tick();
  release({ result: { value: 1 } });
  await tick();
  assert.equal(fake.calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
  assert.deepEqual((await bridge.status()).unknownOutcomeIds, ["active-write"]);

  await bridge.connect();
  const nextSocket = FakeWebSocket.instances[1];
  nextSocket.open();
  await tick();
  const hello = nextSocket.sent.find((message) => message.type === "hello");
  assert.deepEqual(hello.unknownOutcomeIds, ["active-write"]);
  nextSocket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    ackUnknownOutcomeIds: ["active-write"],
  });
  await tick();
  assert.deepEqual((await bridge.status()).unknownOutcomeIds, []);
});

test("disconnect during Agent-defined pre-delay prevents the browser side effect", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "delayed-write",
    method: "cdp.send",
    params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression: "write()" } },
    behavior: { beforeMs: 25 },
  });
  await tick();
  socket.close(1006, "network lost");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(fake.calls.some((call) => call.method === "Runtime.evaluate"), false);
  assert.deepEqual((await bridge.status()).unknownOutcomeIds, []);
});

test("same request id with different content returns ID_CONFLICT without a second side effect", async (t) => {
  const { fake, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "stable-id",
    method: "cdp.send",
    params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression: "1" } },
  });
  await tick();
  socket.receive({
    v: 2,
    type: "request",
    id: "stable-id",
    method: "cdp.send",
    params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression: "2" } },
  });
  await tick();
  const responses = socket.sent.filter((message) => message.id === "stable-id");
  assert.equal(responses.at(-1).error.code, "ID_CONFLICT");
  assert.equal(fake.calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
});

test("heartbeat closes a half-open connection and stop detaches controlled tabs", async (t) => {
  let now = 1_000;
  const { bridge, fake, socket } = await readyBridge(t, { now: () => now });
  socket.receive({
    v: 2,
    type: "request",
    id: "attach-before-stop",
    method: "target.attach",
    params: { tabId: 1 },
  });
  await tick();
  now += 40_001;
  bridge.heartbeatTick(socket, bridge.epoch);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  await bridge.stop();
  assert.equal(fake.calls.some((call) => call.api === "debugger.detach" && call.target.tabId === 1), true);
});

test("a clean Agent shutdown releases debugger attachments before reconnecting", async (t) => {
  const { fake, socket } = await readyBridge(t);
  socket.receive({
    v: 2,
    type: "request",
    id: "attach-before-agent-stop",
    method: "target.attach",
    params: { tabId: 1 },
  });
  await waitFor(() => fake.attached.has(1));
  socket.close(1001, "agent stopped");
  await waitFor(() => !fake.attached.has(1));

  assert.equal(fake.calls.some(
    (call) => call.api === "debugger.detach" && call.target.tabId === 1,
  ), true);
});
