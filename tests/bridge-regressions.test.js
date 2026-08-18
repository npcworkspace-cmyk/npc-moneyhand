import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MoneyHandBridge, __test__ as bridgeTest } from "../extension/bridge.js";
import { MoneyHandExecutor } from "../extension/executor.js";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

class AsyncCloseWebSocket extends FakeWebSocket {
  close(code = 1000, reason = "") {
    if (this.readyState >= AsyncCloseWebSocket.CLOSING) return;
    this.readyState = AsyncCloseWebSocket.CLOSING;
    setImmediate(() => {
      this.readyState = AsyncCloseWebSocket.CLOSED;
      this.emit("close", { code, reason });
    });
  }
}

test("Extension-initiated close codes are valid for the browser WebSocket API", async () => {
  const source = await readFile(new URL("../extension/bridge.js", import.meta.url), "utf8");
  const closeCodes = [...source.matchAll(/\.close\((\d+)/g)].map((match) => Number(match[1]));
  assert.ok(closeCodes.length > 0);
  assert.deepEqual(closeCodes.filter((code) => code !== 1000 && (code < 3000 || code > 4999)), []);
});

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function createBridge(fake) {
  return new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_regression",
    random: () => 0.5,
  });
}

test("a fresh extension immediately connects to the fixed MoneyHand endpoint", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());

  const status = await bridge.start();

  assert.equal(status.enabled, true);
  assert.equal(status.wsEndpoint, "ws://127.0.0.1:19846/extension");
  assert.equal(status.state, "CONNECTING");
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("default reconnect migrates a legacy endpoint, preserves pairing, and reconnects", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: false,
    profileAlias: "legacy-profile",
    wsEndpoint: "ws://localhost:19847/extension",
    authToken: "legacy-secret-123456",
  });
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());

  const status = await bridge.connectDefault();

  assert.equal(status.enabled, true);
  assert.equal(status.wsEndpoint, "ws://127.0.0.1:19846/extension");
  assert.equal(status.state, "CONNECTING");
  assert.equal(fake.storage.profileAlias, "");
  assert.equal(fake.storage.authToken, "legacy-secret-123456");
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("durable reconnect alarm is never scheduled earlier than Chrome's 30 second floor", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  const now = 1_000_000;
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_alarm",
    random: () => 0.5,
    now: () => now,
  });
  t.after(() => bridge.stop());

  bridge.scheduleReconnect();
  await tick();
  const alarm = fake.calls.find((call) => call.api === "alarms.create");

  assert.ok(alarm);
  assert.equal(alarm.alarmInfo.when, now + bridgeTest.RECONNECT_ALARM_MIN_MS);
});

test("durable reconnect alarm recreates a socket, rearms after failure, and clears only at READY", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  bridge.attachChromeListeners();

  bridge.scheduleReconnect();
  await tick();
  bridge.clearTimer("reconnectTimer");
  assert.equal(bridge.reconnectTimer, undefined);

  fake.events.alarm.emit({ name: bridgeTest.RECONNECT_ALARM });
  const firstSocket = await waitFor(() => FakeWebSocket.instances[0]);
  firstSocket.open();
  await waitFor(() => firstSocket.sent.some((message) => message.type === "hello"));

  assert.equal(bridge.reconnectAttempt, 1, "opening a socket must not reset failure backoff");
  assert.equal(fake.calls.filter((call) => call.api === "alarms.clear").length, 0);

  firstSocket.close(1006, "synthetic failure before READY");
  await waitFor(
    () => fake.calls.filter((call) => call.api === "alarms.create").length >= 2,
    "failed alarm connection did not rearm the durable alarm",
  );
  bridge.clearTimer("reconnectTimer");

  fake.events.alarm.emit({ name: bridgeTest.RECONNECT_ALARM });
  const secondSocket = await waitFor(() => FakeWebSocket.instances[1]);
  secondSocket.open();
  await waitFor(() => secondSocket.sent.some((message) => message.type === "hello"));

  assert.equal(bridge.reconnectAttempt, 2);
  assert.equal(fake.calls.filter((call) => call.api === "alarms.clear").length, 0);

  secondSocket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    heartbeatMs: 20_000,
    maxInflight: 64,
  });
  await waitFor(() => bridge.state === "READY");

  assert.equal(bridge.reconnectAttempt, 0);
  assert.equal(fake.calls.filter((call) => call.api === "alarms.clear").length, 1);
});

test("a delayed stale alarm create cannot clear a newer lifecycle alarm", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  const bridge = createBridge(fake);
  const originalCreate = fake.chrome.alarms.create.bind(fake.chrome.alarms);
  let releaseFirstCreate;
  let markFirstCreateStarted;
  const firstCreateStarted = new Promise((resolve) => {
    markFirstCreateStarted = resolve;
  });
  const firstCreatePending = new Promise((resolve) => {
    releaseFirstCreate = resolve;
  });
  let firstCreate = true;
  fake.chrome.alarms.create = async (name, alarmInfo) => {
    await originalCreate(name, alarmInfo);
    if (!firstCreate) return;
    firstCreate = false;
    markFirstCreateStarted();
    await firstCreatePending;
  };
  t.after(async () => {
    releaseFirstCreate();
    fake.chrome.alarms.create = originalCreate;
    await bridge.stop();
  });

  bridge.scheduleReconnect();
  await firstCreateStarted;
  bridge.lifecycle += 1;
  bridge.scheduleReconnect();
  releaseFirstCreate();
  await bridge.alarmQueue;
  bridge.clearTimer("reconnectTimer");

  assert.deepEqual(
    fake.calls
      .filter((call) => call.api === "alarms.create" || call.api === "alarms.clear")
      .map((call) => call.api),
    ["alarms.create", "alarms.clear", "alarms.create"],
  );
});

async function enableBridge(fake) {
  await fake.chrome.storage.local.set({
    enabled: true,
    profileAlias: "work",
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken: "",
  });
}

async function openReadySocket(bridge, index = FakeWebSocket.instances.length) {
  await bridge.connect();
  const socket = FakeWebSocket.instances[index];
  assert.ok(socket, `expected WebSocket instance ${index}`);
  socket.open();
  await waitFor(() => socket.sent.some((message) => message.type === "hello"));
  socket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    heartbeatMs: 20_000,
    maxInflight: 64,
  });
  await waitFor(() => bridge.state === "READY");
  return socket;
}

function cdpRequest(id, expression) {
  return {
    v: 2,
    type: "request",
    id,
    method: "cdp.send",
    params: {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression },
    },
  };
}

function screenshotRequest(id, tabId) {
  return {
    v: 2,
    type: "request",
    id,
    method: "observe.screenshot",
    params: { target: { tabId } },
  };
}

test("an unknown-outcome id cannot execute again until the Agent acknowledges it", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());

  let releaseStarted;
  fake.handlers.set("Runtime.evaluate", () => new Promise((resolve) => {
    releaseStarted = resolve;
  }));

  const firstSocket = await openReadySocket(bridge, 0);
  firstSocket.receive(cdpRequest("ambiguous-write", "firstSideEffect()"));
  await waitFor(() => fake.calls.filter((call) => call.method === "Runtime.evaluate").length === 1);
  firstSocket.close(1006, "network lost");
  await waitFor(() => bridge.unknownOutcomeIds.has("ambiguous-write"));

  const secondSocket = await openReadySocket(bridge, 1);
  secondSocket.receive(cdpRequest("ambiguous-write", "differentSideEffect()"));
  const blocked = await waitFor(
    () => secondSocket.sent.find((message) => message.type === "response" && message.id === "ambiguous-write"),
  );

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "UNKNOWN_OUTCOME_PENDING");
  assert.equal(fake.calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
  assert.deepEqual((await bridge.status()).unknownOutcomeIds, ["ambiguous-write"]);

  releaseStarted({ result: { value: "first completed after disconnect" } });
  await tick();
});

test("stop wins a concurrent stale storage read and prevents WebSocket creation", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  let releaseFirstRead;
  let markFirstReadStarted;
  const firstReadStarted = new Promise((resolve) => {
    markFirstReadStarted = resolve;
  });
  const releaseFirstReadPromise = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });
  let firstRead = true;
  fake.chrome.storage.local.get = async (defaults = {}) => {
    if (!firstRead) return await originalGet(defaults);
    firstRead = false;
    const staleSnapshot = { ...defaults, ...fake.storage };
    markFirstReadStarted();
    await releaseFirstReadPromise;
    return staleSnapshot;
  };

  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  const connectPromise = bridge.connect();
  await firstReadStarted;
  await bridge.stop();
  releaseFirstRead();
  await connectPromise;

  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal((await bridge.status()).state, "DISABLED");
  assert.equal(fake.storage.enabled, false);
});

test("hung screenshots from an old epoch do not consume the new epoch's two screenshot slots", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  const releases = [];
  t.after(() => {
    for (const release of releases) release({ data: "cG5n" });
    return bridge.stop();
  });

  let screenshotCalls = 0;
  fake.handlers.set("Page.captureScreenshot", () => {
    screenshotCalls += 1;
    if (screenshotCalls <= 2) {
      return new Promise((resolve) => {
        releases.push(resolve);
      });
    }
    return { data: "cG5n" };
  });

  const firstSocket = await openReadySocket(bridge, 0);
  firstSocket.receive(screenshotRequest("old-shot-1", 1));
  firstSocket.receive(screenshotRequest("old-shot-2", 2));
  await waitFor(() => screenshotCalls === 2);
  firstSocket.close(1006, "network lost");
  await waitFor(() => bridge.unknownOutcomeIds.size === 2);

  const secondSocket = await openReadySocket(bridge, 1);
  secondSocket.receive(screenshotRequest("new-shot-1", 1));
  secondSocket.receive(screenshotRequest("new-shot-2", 2));
  const responses = await waitFor(() => {
    const matches = secondSocket.sent.filter(
      (message) => message.type === "response" && message.id.startsWith("new-shot-"),
    );
    return matches.length === 2 ? matches : undefined;
  });

  assert.equal(screenshotCalls, 4);
  assert.deepEqual(responses.map((response) => response.ok), [true, true]);
  assert.equal(secondSocket.readyState, FakeWebSocket.OPEN);
});

test("an oversized terminal response becomes a cached RESPONSE_TOO_LARGE without disconnecting", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());

  const oversizedValue = "x".repeat((8 * 1024 * 1024) + 1_024);
  fake.handlers.set("Runtime.evaluate", {
    result: { value: oversizedValue },
  });

  const socket = await openReadySocket(bridge, 0);
  const request = cdpRequest("oversized-result", "returnHugeValue()");
  socket.receive(request);
  const first = await waitFor(
    () => socket.sent.find((message) => message.type === "response" && message.id === request.id),
    "oversized request did not receive a terminal response",
  );

  assert.equal(first.ok, false);
  assert.equal(first.error.code, "RESPONSE_TOO_LARGE");
  assert.equal(socket.readyState, FakeWebSocket.OPEN);

  socket.receive(request);
  const responses = await waitFor(() => {
    const matches = socket.sent.filter((message) => message.type === "response" && message.id === request.id);
    return matches.length === 2 ? matches : undefined;
  });

  assert.deepEqual(responses[1], responses[0]);
  assert.equal(fake.calls.filter((call) => call.method === "Runtime.evaluate").length, 1);
  assert.equal(socket.readyState, FakeWebSocket.OPEN);
});

test("completed cache budget includes large request fingerprints", () => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  const bridge = createBridge(fake);
  const padding = "x".repeat(900 * 1024);
  const encoder = new TextEncoder();

  for (let index = 0; index < 24; index += 1) {
    const id = `large-fingerprint-${index}`;
    const fingerprint = bridgeTest.requestFingerprint({
      method: "system.status",
      params: { padding, index },
    });
    bridge.cacheTerminal(id, fingerprint, {
      v: 2,
      type: "response",
      id,
      ok: true,
      result: { index },
      meta: { durationMs: 0 },
    });
  }

  const retainedBytes = [...bridge.completed.values()].reduce((total, entry) => (
    total
      + encoder.encode(entry.fingerprint).byteLength
      + encoder.encode(JSON.stringify(entry.message)).byteLength
  ), 0);
  assert.ok(retainedBytes <= bridgeTest.MAX_COMPLETED_CACHE_BYTES);
  assert.equal(bridge.completedBytes, retainedBytes);
  assert.ok(bridge.completed.size < 24, "large fingerprints must force byte-budget eviction");
  assert.equal(bridge.completed.has("large-fingerprint-0"), false);
  assert.equal(bridge.completed.has("large-fingerprint-23"), true);
});

test("a delayed close settings read cannot schedule reconnect after stop", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  const socket = await openReadySocket(bridge, 0);
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  let releaseCloseRead;
  let markCloseReadStarted;
  const closeReadStarted = new Promise((resolve) => {
    markCloseReadStarted = resolve;
  });
  const releaseCloseReadPromise = new Promise((resolve) => {
    releaseCloseRead = resolve;
  });
  let delayNextRead = true;
  fake.chrome.storage.local.get = async (defaults = {}) => {
    if (!delayNextRead) return await originalGet(defaults);
    delayNextRead = false;
    const staleEnabledSettings = { ...defaults, ...fake.storage };
    markCloseReadStarted();
    await releaseCloseReadPromise;
    return staleEnabledSettings;
  };

  socket.close(1006, "network lost");
  await closeReadStarted;
  await bridge.stop();
  const alarmCreatesBeforeRelease = fake.calls.filter((call) => call.api === "alarms.create").length;
  releaseCloseRead();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(bridge.state, "DISABLED");
  assert.equal(bridge.reconnectTimer, undefined);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(
    fake.calls.filter((call) => call.api === "alarms.create").length,
    alarmCreatesBeforeRelease,
  );
});

test("socket invalidation exits READY synchronously and status cannot report a ghost connection", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  const socket = await openReadySocket(bridge, 0);
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  let markCloseReadStarted;
  const closeReadStarted = new Promise((resolve) => {
    markCloseReadStarted = resolve;
  });
  fake.chrome.storage.local.get = async () => {
    markCloseReadStarted();
    return await new Promise(() => {});
  };

  socket.close(1006, "synthetic close with hung storage");
  await closeReadStarted;

  assert.equal(bridge.state, "DISCONNECTED");
  assert.equal(bridge.handshakeReady, false);
  assert.equal(bridge.socket, undefined);

  fake.chrome.storage.local.get = originalGet;
  const status = await bridge.status();
  assert.equal(status.state, "DISCONNECTED");
  assert.equal(status.connected, false);

  bridge.state = "READY";
  const defensiveStatus = await bridge.status();
  assert.equal(defensiveStatus.state, "DISCONNECTED");
  assert.equal(defensiveStatus.connected, false);
});

test("handshake storage failure closes the socket without an unhandled rejection", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  await bridge.connect();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    fake.chrome.storage.local.get = async () => {
      throw new Error("synthetic ensureInstanceId storage failure");
    };
    socket.open();
    await waitFor(() => socket.readyState === FakeWebSocket.CLOSED);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(unhandled, []);
    assert.notEqual(bridge.state, "HANDSHAKE");
    assert.equal(bridge.handshakeReady, false);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    fake.chrome.storage.local.get = originalGet;
    await bridge.stop();
  }
});

test("handshake deadline also covers hung identity and focus setup", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_hung_handshake",
    handshakeTimeoutMs: 20,
  });
  t.after(() => bridge.stop());
  await bridge.start();
  const socket = FakeWebSocket.instances[0];
  const originalGet = fake.chrome.storage.local.get.bind(fake.chrome.storage.local);
  fake.chrome.storage.local.get = async () => await new Promise(() => {});

  socket.open();
  await waitFor(() => socket.readyState === FakeWebSocket.CLOSED);
  fake.chrome.storage.local.get = originalGet;

  assert.equal(bridge.handshakeReady, false);
  assert.equal(bridge.lastError, "Agent WS 握手超时");

  await bridge.connect();
  const recoveredSocket = FakeWebSocket.instances[1];
  assert.ok(recoveredSocket, "a stale focus queue must not poison the next connection");
  recoveredSocket.open();
  await waitFor(() => recoveredSocket.sent.some((message) => message.type === "hello"));
  recoveredSocket.receive({
    v: 2,
    type: "ready",
    protocol: "npc-moneyhand/2",
    heartbeatMs: 20_000,
    maxInflight: 64,
  });
  await waitFor(() => bridge.state === "READY");

  assert.equal(bridge.handshakeReady, true);
});

test("stop invalidates the old socket before awaiting alarms.clear", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  const socket = await openReadySocket(bridge, 0);
  const originalClear = fake.chrome.alarms.clear.bind(fake.chrome.alarms);
  let releaseClear;
  const clearPending = new Promise((resolve) => {
    releaseClear = resolve;
  });
  fake.chrome.alarms.clear = async () => await clearPending;

  const stopPromise = bridge.stop();
  socket.receive(cdpRequest("after-stop-called", "mustNotExecute()"));
  await tick();

  try {
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.equal(bridge.socket, undefined);
    assert.equal(
      fake.calls.some((call) => call.method === "Runtime.evaluate" && call.params.expression === "mustNotExecute()"),
      false,
    );
  } finally {
    releaseClear();
    fake.chrome.alarms.clear = originalClear;
    await stopPromise;
  }
});

test("corrupt persisted identity and future focus time self-heal before hello", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: true,
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken: "",
    instanceId: "not valid !!!",
    lastFocusedAt: Number.MAX_SAFE_INTEGER,
  });
  const now = 10_000;
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_storage_repair",
    random: () => 0.5,
    now: () => now,
  });
  t.after(() => bridge.stop());

  await bridge.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const hello = await waitFor(() => socket.sent.find((message) => message.type === "hello"));

  assert.match(hello.instanceId, /^[a-f0-9]{8}-[a-f0-9-]{27}$/u);
  assert.notEqual(hello.instanceId, "not valid !!!");
  assert.equal(hello.focus.lastFocusedAt, now);
  assert.equal(fake.storage.lastFocusedAt, now);
});

test("terminal backpressure records an unknown outcome before asynchronous close", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: AsyncCloseWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    bootId: "boot_async_close",
    random: () => 0.5,
  });
  t.after(() => bridge.stop());
  const socket = await openReadySocket(bridge, 0);
  socket.bufferedAmount = bridgeTest.MAX_BUFFERED_TOTAL_BYTES;

  socket.receive(cdpRequest("backpressure-write", "effect()"));
  await waitFor(() => fake.calls.some(
    (call) => call.method === "Runtime.evaluate" && call.params.expression === "effect()",
  ));
  await waitFor(() => bridge.unknownOutcomeIds.has("backpressure-write"));

  assert.equal(socket.sent.some((message) => message.id === "backpressure-write"), false);
});

test("disconnect during durable start records uncertainty before any browser mutation", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  const socket = await openReadySocket(bridge, 0);
  const originalSet = fake.chrome.storage.session.set.bind(fake.chrome.storage.session);
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => {
    markWriteStarted = resolve;
  });
  fake.chrome.storage.session.set = async (values) => {
    markWriteStarted();
    await new Promise((resolve) => {
      releaseWrite = resolve;
    });
    return await originalSet(values);
  };

  socket.receive(cdpRequest("persist-race-write", "MUST_NOT_RUN"));
  await writeStarted;
  socket.close(1006, "network lost");
  await waitFor(() => bridge.unknownOutcomeIds.has("persist-race-write"));
  assert.equal(bridge.epochBarriers.size, 1);

  releaseWrite();
  await waitFor(() => bridge.epochBarriers.size === 0);
  assert.equal(
    fake.calls.some((call) => call.method === "Runtime.evaluate" && call.params.expression === "MUST_NOT_RUN"),
    false,
  );
});

test("a delivered terminal is not reclassified unknown while durable clearing settles", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  t.after(() => bridge.stop());
  const socket = await openReadySocket(bridge, 0);
  const originalSet = fake.chrome.storage.session.set.bind(fake.chrome.storage.session);
  let writes = 0;
  let releaseClear;
  let markClearStarted;
  const clearStarted = new Promise((resolve) => {
    markClearStarted = resolve;
  });
  fake.chrome.storage.session.set = async (values) => {
    writes += 1;
    if (writes === 2) {
      markClearStarted();
      await new Promise((resolve) => {
        releaseClear = resolve;
      });
    }
    return await originalSet(values);
  };

  socket.receive(cdpRequest("delivered-before-stop", "SAFE_LOCAL_EFFECT"));
  const terminal = await waitFor(
    () => socket.sent.find((message) => message.id === "delivered-before-stop"),
  );
  assert.equal(terminal.ok, true);
  await clearStarted;
  socket.close(1001, "agent stopped");
  await tick();
  assert.equal(bridge.unknownOutcomeIds.has("delivered-before-stop"), false);

  releaseClear();
  await waitFor(() => !bridge.durableStartedIds.has("delivered-before-stop"));
});

test("a prior epoch mutation isolates new writes until its Chrome promise settles", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  await enableBridge(fake);
  const bridge = createBridge(fake);
  let releaseOld;
  fake.handlers.set("Runtime.evaluate", (_target, params) => {
    if (params.expression === "OLD") {
      return new Promise((resolve) => {
        releaseOld = resolve;
      });
    }
    return { result: { value: params.expression } };
  });
  t.after(() => {
    releaseOld?.({ result: { value: "OLD" } });
    return bridge.stop();
  });

  const first = await openReadySocket(bridge, 0);
  first.receive(cdpRequest("old-write", "OLD"));
  await waitFor(() => typeof releaseOld === "function");
  first.close(1006, "network lost");
  await waitFor(() => bridge.unknownOutcomeIds.has("old-write"));

  const second = await openReadySocket(bridge, 1);
  second.receive(cdpRequest("blocked-new-write", "NEW"));
  const blocked = await waitFor(
    () => second.sent.find((message) => message.id === "blocked-new-write"),
  );
  assert.equal(blocked.error.code, "PREVIOUS_EPOCH_ACTIVE");
  assert.deepEqual(
    fake.calls.filter((call) => call.method === "Runtime.evaluate")
      .map((call) => call.params.expression),
    ["OLD"],
  );

  releaseOld({ result: { value: "OLD" } });
  await waitFor(() => bridge.epochBarriers.size === 0);
  second.receive(cdpRequest("new-write-after-settle", "NEW"));
  const terminal = await waitFor(
    () => second.sent.find((message) => message.id === "new-write-after-settle"),
  );
  assert.equal(terminal.ok, true);
});

test("MV3 reconstruction restores started work and instruction waits", async (t) => {
  FakeWebSocket.reset();
  const fake = createFakeChrome();
  const first = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    random: () => 0.5,
  });
  await first.restoreRuntimeState();
  first.executor.pauseForInstruction(1, new Error("manual review"));
  await first.markRequestStarted("worker-crash-write");
  await first.persistRuntimeState();

  const second = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor: new MoneyHandExecutor(fake.chrome),
    random: () => 0.5,
  });
  t.after(() => Promise.all([first.stop(), second.stop()]));
  await second.restoreRuntimeState();

  assert.equal(second.bootId, first.bootId);
  assert.equal(second.unknownOutcomeIds.has("worker-crash-write"), true);
  assert.equal(second.executor.waitingTabs.has(1), true);
});
