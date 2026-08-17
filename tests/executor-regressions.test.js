import assert from "node:assert/strict";
import test from "node:test";
import { MoneyHandExecutor, __test__ } from "../extension/executor.js";
import { MAX_CONTEXT_BYTES, MoneyHandError } from "../extension/protocol.js";
import { createFakeChrome } from "./helpers/fake-chrome.js";

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("continueOnError never lets an unknown input action reach a later batch side effect", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const mutation = "window.__mustNotRun = true";

  await assert.rejects(
    executor.execute("batch.run", {
      continueOnError: true,
      steps: [
        {
          method: "input.perform",
          params: { target: { tabId: 1 }, action: "not-understood" },
        },
        {
          method: "cdp.send",
          params: {
            target: { tabId: 1 },
            method: "Runtime.evaluate",
            params: { expression: mutation },
          },
        },
      ],
    }),
    (error) => error instanceof MoneyHandError
      && error.code === "UNKNOWN_INPUT_ACTION"
      && error.details?.failedAt === 0,
  );
  assert.equal(
    fake.calls.some((call) => call.method === "Runtime.evaluate" && call.params.expression === mutation),
    false,
  );
});

test("tabs.remove rejects multiple tab ids and tabs.update requires an explicit tab id", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);

  await assert.rejects(
    executor.execute("chrome.call", {
      method: "tabs.remove",
      args: [[1, 2]],
    }),
    (error) => error instanceof MoneyHandError && error.code === "INVALID_ARGUMENT",
  );
  assert.equal(fake.tabs.has(1), true);
  assert.equal(fake.tabs.has(2), true);

  await assert.rejects(
    executor.execute("chrome.call", {
      method: "tabs.update",
      args: [{ url: "https://implicit-target.test/" }],
    }),
    (error) => error instanceof MoneyHandError && error.code === "INVALID_TARGET",
  );
  assert.equal(fake.tabs.get(1).url, "https://example.com/");
});

test("observe.context sanitizes adversarial strings to the 512 KiB final wire budget", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const huge = "界".repeat(220_000);
  fake.handlers.set("Runtime.evaluate", {
    result: {
      value: {
        url: `https://example.test/${huge}`,
        title: huge,
        readyState: "complete",
        text: huge,
        textTruncated: false,
        controls: Array.from({ length: 500 }, (_, index) => ({
          tag: "a",
          text: `control-${index}-${huge}`,
          href: `https://example.test/${index}/${huge}`,
          rect: { x: 0, y: index, width: 10, height: 10 },
        })),
      },
    },
  });

  const context = await executor.execute("observe.context", {
    target: { tabId: 1 },
    maxTextChars: 100_000,
    maxElements: 500,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(context)).byteLength;
  assert.ok(bytes <= MAX_CONTEXT_BYTES, `${bytes} exceeds ${MAX_CONTEXT_BYTES}`);
  assert.equal(context.untrustedPageContent, true);
  assert.equal(context.contentTruncated, true);
  assert.ok(context.url.length < huge.length);
  assert.ok(context.title.length < huge.length);
  assert.ok(context.controls.every((control) => !control.href || control.href.length <= 2_048));
});

test("detachAll reports failed tabs and preserves them for a later retry", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  await executor.execute("target.attach", { tabId: 1 });
  const originalDetach = fake.chrome.debugger.detach.bind(fake.chrome.debugger);
  fake.chrome.debugger.detach = async () => {
    throw new Error("synthetic detach failure");
  };

  const first = await executor.detachAll();
  assert.deepEqual(first.detachedTabs, []);
  assert.equal(first.failedTabs.length, 1);
  assert.equal(first.failedTabs[0].tabId, 1);
  assert.equal(executor.attachedTabs.has(1), true);
  assert.equal(fake.attached.has(1), true);

  fake.chrome.debugger.detach = originalDetach;
  const retry = await executor.detachAll();
  assert.deepEqual(retry.detachedTabs, [1]);
  assert.deepEqual(retry.failedTabs, []);
  assert.equal(executor.attachedTabs.has(1), false);
  assert.equal(fake.attached.has(1), false);
});

test("a pending attach is serialized across connection epochs and the replacement owns the final attachment", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  const order = [];
  let attachCount = 0;
  let releaseFirstAttach;
  const firstAttachPending = new Promise((resolve) => {
    releaseFirstAttach = resolve;
  });
  fake.chrome.debugger.attach = async ({ tabId }) => {
    attachCount += 1;
    order.push(`attach:${attachCount}:start`);
    if (fake.attached.has(tabId)) throw new Error("Another debugger is already attached");
    fake.attached.add(tabId);
    if (attachCount === 1) await firstAttachPending;
    order.push(`attach:${attachCount}:end`);
  };
  fake.chrome.debugger.detach = async ({ tabId }) => {
    order.push("detach");
    fake.attached.delete(tabId);
  };

  let oldEpochActive = true;
  const oldRequest = executor.execute(
    "target.attach",
    { tabId: 1 },
    undefined,
    { isActive: () => oldEpochActive },
  );
  await tick();
  assert.equal(attachCount, 1);

  oldEpochActive = false;
  const replacement = executor.execute(
    "target.attach",
    { tabId: 1 },
    undefined,
    { isActive: () => true },
  );
  await tick();
  assert.equal(attachCount, 1, "replacement attach must wait for the old lifecycle operation");

  releaseFirstAttach();
  await assert.rejects(
    oldRequest,
    (error) => error instanceof MoneyHandError && error.code === "CONNECTION_LOST",
  );
  await replacement;

  assert.deepEqual(order, [
    "attach:1:start",
    "attach:1:end",
    "detach",
    "attach:2:start",
    "attach:2:end",
  ]);
  assert.equal(fake.attached.has(1), true);
  assert.equal(executor.attachedTabs.has(1), true);
});

for (const action of [
  {
    name: "key",
    params: { key: "A", code: "KeyA" },
    method: "Input.dispatchKeyEvent",
    starts: (params) => params.type === "keyDown",
    releases: (params) => params.type === "keyUp",
  },
  {
    name: "touch",
    params: { x: 10, y: 20 },
    method: "Input.dispatchTouchEvent",
    starts: (params) => params.type === "touchStart",
    releases: (params) => params.type === "touchEnd",
  },
  {
    name: "click",
    params: { x: 10, y: 20 },
    method: "Input.dispatchMouseEvent",
    starts: (params) => params.type === "mousePressed",
    releases: (params) => params.type === "mouseReleased",
  },
]) {
  test(`${action.name} emits its release cleanup when the connection dies after press`, async () => {
    const fake = createFakeChrome();
    const executor = new MoneyHandExecutor(fake.chrome);
    let active = true;
    fake.handlers.set(action.method, (_target, params) => {
      if (action.starts(params)) active = false;
      return {};
    });

    await assert.rejects(
      executor.execute(
        "input.perform",
        { target: { tabId: 1 }, action: action.name, ...action.params },
        undefined,
        { isActive: () => active },
      ),
      (error) => error instanceof MoneyHandError && error.code === "CONNECTION_LOST",
    );
    assert.equal(
      fake.calls.some((call) => call.method === action.method && action.releases(call.params)),
      true,
    );
  });
}

test("downloads.open is not exposed through the zero-gesture chrome.call allowlist", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  assert.equal(__test__.ALLOWED_CHROME_CALLS.has("downloads.download"), true);
  assert.equal(
    (await executor.execute("chrome.call", {
      method: "downloads.download",
      args: [{ url: "https://example.com/file.txt" }],
    })).result,
    1,
  );
  assert.equal(__test__.ALLOWED_CHROME_CALLS.has("downloads.open"), false);
  await assert.rejects(
    executor.execute("chrome.call", { method: "downloads.open", args: [1] }),
    (error) => error instanceof MoneyHandError && error.code === "CHROME_METHOD_DENIED",
  );
});

test("detachAll returns a pending tab within its wait budget when attach never settles", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  let markAttachStarted;
  const attachStarted = new Promise((resolve) => {
    markAttachStarted = resolve;
  });
  fake.chrome.debugger.attach = async () => {
    markAttachStarted();
    return await new Promise(() => {});
  };

  void executor.execute("target.attach", { tabId: 1 });
  await attachStarted;
  const started = performance.now();
  const result = await executor.detachAll(15);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 250, `detachAll took ${elapsed} ms`);
  assert.deepEqual(result.detachedTabs, []);
  assert.deepEqual(result.failedTabs, []);
  assert.deepEqual(result.pendingTabs, [1]);
});

test("an early child attach is recursively configured before root auto-attach resolves", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  let releaseRootAutoAttach;
  let markRootAutoAttachStarted;
  const rootAutoAttachStarted = new Promise((resolve) => {
    markRootAutoAttachStarted = resolve;
  });
  const rootAutoAttachPending = new Promise((resolve) => {
    releaseRootAutoAttach = resolve;
  });
  fake.handlers.set("Target.setAutoAttach", async (target) => {
    if (!target.sessionId) {
      markRootAutoAttachStarted();
      await rootAutoAttachPending;
    }
    return {};
  });

  const rootAttach = executor.execute("target.attach", { tabId: 1 });
  await rootAutoAttachStarted;
  await executor.onDebuggerEvent(
    { tabId: 1 },
    "Target.attachedToTarget",
    {
      sessionId: "early-oopif",
      targetInfo: { type: "iframe", targetId: "frame-early" },
    },
  );

  const sessions = await executor.execute("target.sessions", { tabId: 1 });
  assert.equal(
    fake.calls.some((call) => (
      call.method === "Target.setAutoAttach"
      && call.target.tabId === 1
      && call.target.sessionId === "early-oopif"
    )),
    true,
  );
  assert.equal(sessions.sessions[0].sessionId, "early-oopif");
  assert.equal(sessions.sessions[0].autoAttachConfigured, true);

  releaseRootAutoAttach();
  await rootAttach;
});

test("OOPIF detach during recursive auto-attach cannot write a removed session", async () => {
  const fake = createFakeChrome();
  const executor = new MoneyHandExecutor(fake.chrome);
  executor.autoAttachConfiguredTabs.add(1);
  let releaseAutoAttach;
  let markAutoAttachStarted;
  const autoAttachStarted = new Promise((resolve) => {
    markAutoAttachStarted = resolve;
  });
  fake.handlers.set("Target.setAutoAttach", () => new Promise((resolve) => {
    releaseAutoAttach = resolve;
    markAutoAttachStarted();
  }));

  const attached = executor.onDebuggerEvent(
    { tabId: 1 },
    "Target.attachedToTarget",
    {
      sessionId: "detaching-oopif",
      targetInfo: { type: "iframe", targetId: "frame-detaching" },
    },
  );
  await autoAttachStarted;
  await executor.onDebuggerEvent(
    { tabId: 1 },
    "Target.detachedFromTarget",
    { sessionId: "detaching-oopif" },
  );
  releaseAutoAttach({});

  await assert.doesNotReject(attached);
  assert.equal(executor.childSessions.get(1)?.has("detaching-oopif") ?? false, false);
});
