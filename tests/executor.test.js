import assert from "node:assert/strict";
import test from "node:test";
import { MoneyHandExecutor } from "../extension/executor.js";
import { MoneyHandError } from "../extension/protocol.js";
import { createFakeChrome } from "./helpers/fake-chrome.js";

test("raw CDP is attached and forwarded without rewriting method or params", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const result = await executor.execute("cdp.send", {
    target: { tabId: 1, sessionId: "child-1" },
    method: "Runtime.evaluate",
    params: { expression: "6*7", returnByValue: true },
  });
  assert.equal(result.target.sessionId, "child-1");
  const sent = fake.calls.find((call) => call.method === "Runtime.evaluate");
  assert.deepEqual(sent.target, { tabId: 1, sessionId: "child-1" });
  assert.deepEqual(sent.params, { expression: "6*7", returnByValue: true });
  assert.equal(fake.calls.some((call) => call.method === "Page.captureScreenshot"), false);
});

test("flat auto-attach is configured once per tab, not on every raw CDP call", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  for (let index = 0; index < 3; index += 1) {
    await executor.execute("cdp.send", {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression: String(index) },
    });
  }
  assert.equal(fake.calls.filter((call) => call.method === "Target.setAutoAttach").length, 1);
});

test("default typing uses one fast Input.insertText command", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const result = await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "type",
    text: "hello世界",
  });
  assert.deepEqual(result, { target: { tabId: 1 }, action: "type", ok: true });
  const inserts = fake.calls.filter((call) => call.method === "Input.insertText");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.text, "hello世界");
});

test("Agent behavior changes deterministic pointer movement and expires in memory", async () => {
  const fake = createFakeChrome();
  let time = 1000;
  const executor = new MoneyHandExecutor(fake.chrome, { now: () => time });
  await executor.execute("behavior.set", {
    pointerSteps: 3,
    pointerDurationMs: 0,
    ttlMs: 1000,
  });
  await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "move",
    x: 30,
    y: 60,
  });
  assert.equal(fake.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length, 3);
  time = 2001;
  assert.equal((await executor.execute("behavior.get")).behavior.pointerSteps, 1);
});

test("Agent can enable human mode in one call and return to the raw fast path", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome, { random: () => 0.75 });
  const enabled = await executor.execute("behavior.set", {
    mode: "human",
    beforeMs: 0,
    afterMs: 0,
    betweenStepsMs: 0,
    typingDelayMs: 1,
    pointerSteps: 6,
    pointerDurationMs: 0,
  });
  assert.equal(enabled.behavior.mode, "human");

  await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "move",
    x: 90,
    y: 60,
  });
  const moves = fake.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseMoved");
  assert.ok(moves.length > 1);
  assert.deepEqual(
    { x: moves.at(-1).params.x, y: moves.at(-1).params.y },
    { x: 90, y: 60 },
  );

  await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "type",
    text: "abc",
  });
  const humanInserts = fake.calls.filter((call) => call.method === "Input.insertText");
  assert.deepEqual(humanInserts.map((call) => call.params.text), ["a", "b", "c"]);

  await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "scroll",
    deltaX: 15,
    deltaY: 240,
  });
  const wheels = fake.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseWheel");
  assert.ok(wheels.length > 1);
  assert.ok(Math.abs(wheels.reduce((sum, call) => sum + call.params.deltaX, 0) - 15) < 1e-9);
  assert.ok(Math.abs(wheels.reduce((sum, call) => sum + call.params.deltaY, 0) - 240) < 1e-9);

  const restored = await executor.execute("behavior.set", { mode: "raw" });
  assert.equal(restored.behavior.mode, "raw");
  const insertCount = humanInserts.length;
  await executor.execute("input.perform", {
    target: { tabId: 1 },
    action: "type",
    text: "fast",
  });
  const allInserts = fake.calls.filter((call) => call.method === "Input.insertText");
  assert.equal(allInserts.length, insertCount + 1);
  assert.equal(allInserts.at(-1).params.text, "fast");
});

test("context is text-first and screenshots happen only on explicit request", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const context = await executor.execute("observe.context", { target: { tabId: 1 } });
  assert.equal(context.text, "Example page text");
  assert.equal(context.untrustedPageContent, true);
  assert.equal(fake.calls.some((call) => call.method === "Page.captureScreenshot"), false);

  const screenshot = await executor.execute("observe.screenshot", { target: { tabId: 1 } });
  assert.equal(screenshot.mimeType, "image/png");
  assert.equal(screenshot.data, "cG5n");
  assert.equal(fake.calls.filter((call) => call.method === "Page.captureScreenshot").length, 1);
});

test("coordinate input validates its CSS viewport contract and required fields before attaching", async () => {
  for (const params of [
    { action: "move", x: 1, y: 2 },
    { action: "click", x: 1, y: 2 },
    { action: "scroll", deltaY: 20 },
    { action: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
    { action: "touch", x: 1, y: 2 },
  ]) {
    const fake = createFakeChrome();
    const executor = new MoneyHandExecutor(fake.chrome);
    await assert.doesNotReject(executor.execute("input.perform", {
      target: { tabId: 1 },
      coordinateSpace: "css-viewport-v1",
      ...params,
    }));
    assert.equal(fake.calls.some((call) => call.method?.startsWith("Input.")), true);
  }
  for (const [params, code] of [
    [{ target: { tabId: 1 }, action: "click", x: 1, y: 2, coordinateSpace: "screen" }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1 }, action: "click", x: 1, y: 2, coordinateSpace: null }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1 }, action: "click", y: 2 }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1 }, action: "drag", from: { x: 1, y: 2 }, to: { x: 3 } }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1, sessionId: "child-1" }, action: "touch", x: 1, y: 2 }, "INVALID_TARGET"],
    [{ target: { tabId: 1 }, action: "type", text: "x", coordinateSpace: "css-viewport-v1" }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1 }, action: "key", key: "Enter", coordinateSpace: "css-viewport-v1" }, "INVALID_ARGUMENT"],
    [{ target: { tabId: 1 }, action: "unknown" }, "UNKNOWN_INPUT_ACTION"],
  ]) {
    const fake = createFakeChrome();
    const executor = new MoneyHandExecutor(fake.chrome);
    await assert.rejects(
      executor.execute("input.perform", params),
      (error) => error instanceof MoneyHandError && error.code === code,
    );
    assert.equal(fake.calls.length, 0);
  }
  for (const params of [
    { action: "type", text: "frame" },
    { action: "key", key: "Enter" },
  ]) {
    const fake = createFakeChrome();
    const executor = new MoneyHandExecutor(fake.chrome);
    await assert.doesNotReject(executor.execute("input.perform", {
      target: { tabId: 1, sessionId: "child-1" },
      ...params,
    }));
    assert.equal(fake.calls.some((call) => call.method?.startsWith("Input.") && call.target.sessionId === "child-1"), true);
  }
});

test("a waiting tab blocks writes until the Agent resolves the wait id", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome, { randomUUID: () => "12345678-1234-1234-1234-123456789abc" });
  const waiting = executor.pauseForInstruction(1, new Error("target unclear"));
  await assert.rejects(
    executor.execute("input.perform", { target: { tabId: 1 }, action: "click", x: 1, y: 2 }),
    (error) => error instanceof MoneyHandError && error.code === "TAB_WAITING",
  );
  await executor.execute("observe.context", { target: { tabId: 1 } });
  await executor.execute("instruction.resolve", {
    tabId: 1,
    waitId: waiting.waitId,
    action: "resume",
  });
  await assert.doesNotReject(
    executor.execute("input.perform", { target: { tabId: 1 }, action: "click", x: 1, y: 2 }),
  );
});

test("waiting cannot be bypassed through chrome.call or a batch", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  executor.pauseForInstruction(1, new Error("unclear"));
  await assert.rejects(
    executor.execute("chrome.call", {
      method: "tabs.update",
      args: [1, { url: "https://should-not-run.test/" }],
    }),
    (error) => error instanceof MoneyHandError && error.code === "TAB_WAITING",
  );
  await assert.rejects(
    executor.execute("batch.run", {
      steps: [{
        method: "chrome.call",
        params: { method: "tabs.remove", args: [[1]] },
      }],
    }),
    (error) => error instanceof MoneyHandError && error.code === "TAB_WAITING",
  );
  assert.equal(fake.tabs.get(1).url, "https://example.com/");
});

test("connection reset preserves an explicit instruction wait", () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  executor.pauseForInstruction(1, new Error("unclear"));
  executor.resetConnection();
  assert.equal(executor.waitingTabs.has(1), true);
});

test("nested OOPIF sessions are recursively auto-attached and routed by session id", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  await executor.execute("target.attach", { tabId: 1 });
  const event = await executor.onDebuggerEvent(
    { tabId: 1 },
    "Target.attachedToTarget",
    { sessionId: "oopif-1", targetInfo: { type: "iframe", targetId: "frame-1" } },
  );
  assert.equal(event.target.tabId, 1);
  assert.equal(event.data.params.sessionId, "oopif-1");
  assert.equal(
    fake.calls.some((call) => call.method === "Target.setAutoAttach" && call.target.sessionId === "oopif-1"),
    true,
  );
  const sessions = await executor.execute("target.sessions", { tabId: 1 });
  assert.equal(sessions.sessions[0].sessionId, "oopif-1");
});

test("batch is bounded, sequential and rejects unavailable Chrome methods", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const batch = await executor.execute("batch.run", {
    steps: [
      { method: "cdp.send", params: { target: { tabId: 1 }, method: "Runtime.evaluate", params: { expression: "1" } } },
      { method: "chrome.call", params: { method: "tabs.get", args: [1] } },
    ],
  });
  assert.equal(batch.completed, 2);
  await assert.rejects(
    executor.execute("chrome.call", { method: "runtime.reload", args: [] }),
    /is not exposed/,
  );
  await assert.rejects(
    executor.execute("batch.run", {
      steps: [
        { method: "cdp.send", params: { target: { tabId: 1 }, method: "Runtime.evaluate" } },
        { method: "cdp.send", params: { target: { tabId: 2 }, method: "Runtime.evaluate" } },
      ],
    }),
    (error) => error instanceof MoneyHandError && error.code === "INVALID_BATCH",
  );
  const callsBeforeInvalidCoordinate = fake.calls.length;
  await assert.rejects(
    executor.execute("batch.run", {
      steps: [{
        method: "input.perform",
        params: { target: { tabId: 1 }, action: "click", x: 1, y: 2, coordinateSpace: "screen" },
      }],
    }),
    (error) => error instanceof MoneyHandError && error.code === "INVALID_ARGUMENT",
  );
  assert.equal(fake.calls.length, callsBeforeInvalidCoordinate);
});
