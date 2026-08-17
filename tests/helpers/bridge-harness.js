import assert from "node:assert/strict";
import { MoneyHandBridge } from "../../extension/bridge.js";
import { MoneyHandExecutor } from "../../extension/executor.js";
import { createFakeChrome } from "./fake-chrome.js";
import { FakeWebSocket } from "./fake-websocket.js";

export async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

export async function readyBridge(t, options = {}) {
  FakeWebSocket.reset();
  const fake = options.fake || createFakeChrome();
  await fake.chrome.storage.local.set({
    enabled: true,
    profileAlias: "work",
    wsEndpoint: "ws://127.0.0.1:19846/extension",
    authToken: "",
  });
  const executor = options.executor || new MoneyHandExecutor(fake.chrome);
  const bridge = new MoneyHandBridge({
    chromeApi: fake.chrome,
    WebSocketImpl: FakeWebSocket,
    executor,
    bootId: options.bootId || "boot_safety",
    random: () => 0.5,
    now: options.now || Date.now,
  });
  await bridge.start();
  t.after(() => bridge.stop());

  const socket = FakeWebSocket.instances[0];
  assert.ok(socket, "bridge did not create a WebSocket");
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
  return { bridge, executor, fake, socket };
}

export function request(id, method, params, behavior) {
  return {
    v: 2,
    type: "request",
    id,
    method,
    params,
    ...(behavior === undefined ? {} : { behavior }),
  };
}
