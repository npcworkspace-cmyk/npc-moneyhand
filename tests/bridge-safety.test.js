import assert from "node:assert/strict";
import test from "node:test";
import { readyBridge, request, waitFor } from "./helpers/bridge-harness.js";

test("an unknown batch action stops later side effects and locks the batch's real tab", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  const mutation = "window.__mustNotRun = true";
  socket.receive(request("unknown-batch", "batch.run", {
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
  }));

  const response = await waitFor(
    () => socket.sent.find((message) => message.type === "response" && message.id === "unknown-batch"),
  );
  assert.equal(response.status, "needs_instruction");
  assert.equal(response.error.code, "UNKNOWN_INPUT_ACTION");
  assert.equal(response.need.target.tabId, 1);
  assert.equal(
    fake.calls.some((call) => call.method === "Runtime.evaluate" && call.params.expression === mutation),
    false,
  );
  assert.deepEqual((await bridge.executor.status()).waiting.map((wait) => wait.tabId), [1]);

  socket.receive(request("blocked-after-batch", "cdp.send", {
    target: { tabId: 1 },
    method: "Runtime.evaluate",
    params: { expression: "window.__alsoMustNotRun = true" },
  }));
  const blocked = await waitFor(
    () => socket.sent.find((message) => message.type === "response" && message.id === "blocked-after-batch"),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "TAB_WAITING");
});

test("chrome.call validation and invocation failures stay direct and never observe or lock a tab", async (t) => {
  const { bridge, fake, socket } = await readyBridge(t);
  let updateCalls = 0;
  fake.chrome.tabs.update = async () => {
    updateCalls += 1;
    throw new Error("synthetic Chrome failure");
  };

  socket.receive(request("implicit-tab", "chrome.call", {
    method: "tabs.update",
    args: [{ url: "https://must-not-run.test/" }],
  }));
  const invalid = await waitFor(
    () => socket.sent.find((message) => message.type === "response" && message.id === "implicit-tab"),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_TARGET");
  assert.equal(invalid.status, undefined);
  assert.equal(updateCalls, 0);

  socket.receive(request("chrome-failure", "chrome.call", {
    method: "tabs.update",
    args: [1, { url: "https://fails.test/" }],
  }));
  const failed = await waitFor(
    () => socket.sent.find((message) => message.type === "response" && message.id === "chrome-failure"),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "CHROME_CALL_FAILED");
  assert.equal(failed.status, undefined);
  assert.equal(updateCalls, 1);

  assert.equal(fake.calls.some((call) => call.method === "Runtime.evaluate"), false);
  assert.deepEqual((await bridge.executor.status()).waiting, []);
});

for (const chromeMethod of ["windows.update", "windows.remove"]) {
  test(`${chromeMethod} returns BUSY while a tab mutation queue is active`, async (t) => {
    const { fake, socket } = await readyBridge(t);
    let releaseTabWrite;
    fake.handlers.set("Runtime.evaluate", () => new Promise((resolve) => {
      releaseTabWrite = resolve;
    }));
    let windowMutationCalls = 0;
    const functionName = chromeMethod.split(".")[1];
    fake.chrome.windows[functionName] = async () => {
      windowMutationCalls += 1;
      return null;
    };

    socket.receive(request("active-tab-write", "cdp.send", {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression: "holdTabQueue()" },
    }));
    await waitFor(() => fake.calls.some((call) => call.method === "Runtime.evaluate"));

    socket.receive(request(`exclusive-${functionName}`, "chrome.call", {
      method: chromeMethod,
      args: functionName === "update" ? [1, { focused: true }] : [1],
    }));

    try {
      const response = await waitFor(
        () => socket.sent.find((message) => message.type === "response" && message.id === `exclusive-${functionName}`),
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "BUSY");
      assert.equal(windowMutationCalls, 0);
    } finally {
      releaseTabWrite?.({ result: { value: "released" } });
    }
  });
}

test("disconnect during slow typing prevents every later character", async (t) => {
  const { fake, socket } = await readyBridge(t);
  let inserts = 0;
  fake.handlers.set("Input.insertText", () => {
    inserts += 1;
    if (inserts === 1) socket.close(1006, "network lost during type");
    return {};
  });

  socket.receive(request("slow-type", "input.perform", {
    target: { tabId: 1 },
    action: "type",
    text: "ABCDE",
  }, {
    typingDelayMs: 15,
  }));
  await waitFor(() => inserts >= 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(inserts, 1);
});

test("a second exclusive window mutation is BUSY while the first remains in flight", async (t) => {
  const { fake, socket } = await readyBridge(t);
  let releaseUpdate;
  let updateCalls = 0;
  let removeCalls = 0;
  fake.chrome.windows.update = async () => {
    updateCalls += 1;
    return await new Promise((resolve) => {
      releaseUpdate = resolve;
    });
  };
  fake.chrome.windows.remove = async () => {
    removeCalls += 1;
  };

  socket.receive(request("held-window-update", "chrome.call", {
    method: "windows.update",
    args: [1, { focused: true }],
  }));
  await waitFor(() => updateCalls === 1);

  socket.receive(request("conflicting-window-remove", "chrome.call", {
    method: "windows.remove",
    args: [1],
  }));
  try {
    const response = await waitFor(
      () => socket.sent.find(
        (message) => message.type === "response" && message.id === "conflicting-window-remove",
      ),
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "BUSY");
    assert.equal(removeCalls, 0);
  } finally {
    releaseUpdate?.({ id: 1, focused: true });
  }
});
