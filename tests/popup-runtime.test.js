import assert from "node:assert/strict";
import test from "node:test";

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function fakeElement() {
  const listeners = new Map();
  return {
    className: "",
    disabled: false,
    textContent: "",
    title: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    listener(type) {
      return listeners.get(type);
    },
  };
}

test("popup exposes only status and an immediate fixed-endpoint reconnect", async () => {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousSetInterval = globalThis.setInterval;
  const elements = {
    "#connect": fakeElement(),
    "#status": fakeElement(),
  };
  const messages = [];
  let intervalCallback;
  let responseMode = "initial";
  let releaseConnect;
  let releaseStatus;

  globalThis.document = {
    querySelector(selector) {
      return elements[selector];
    },
  };
  globalThis.setInterval = (callback) => {
    intervalCallback = callback;
    return 1;
  };
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (responseMode === "reject") throw new Error("后台通道断开");
        if (responseMode === "empty") return undefined;
        if (responseMode === "deferred-connect" && message.type === "popup.connect") {
          return await new Promise((resolve) => {
            releaseConnect = resolve;
          });
        }
        if (responseMode === "deferred-status" && message.type === "popup.status") {
          return await new Promise((resolve) => {
            releaseStatus = resolve;
          });
        }
        if (responseMode === "ready") {
          return { enabled: true, state: "READY", lastError: "" };
        }
        if (message.type === "popup.connect") {
          return { enabled: true, state: "CONNECTING", lastError: "" };
        }
        return { enabled: true, state: "DISCONNECTED", lastError: "" };
      },
    },
  };

  try {
    await import(`../extension/popup.js?popup-runtime=${Date.now()}`);
    await waitFor(() => messages.length === 1);

    assert.deepEqual(messages[0], { type: "popup.status" });
    assert.equal(elements["#status"].textContent, "等待 Agent");
    assert.equal(typeof intervalCallback, "function");

    const click = elements["#connect"].listener("click");
    await click();
    assert.deepEqual(messages.at(-1), { type: "popup.connect" });
    assert.equal(elements["#status"].textContent, "连接中");
    assert.equal(elements["#connect"].disabled, false);

    responseMode = "deferred-status";
    const messagesBeforeSlowPoll = messages.length;
    intervalCallback();
    await waitFor(() => messages.length === messagesBeforeSlowPoll + 1);
    responseMode = "initial";
    await click();
    releaseStatus({ enabled: true, state: "READY", lastError: "" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements["#status"].textContent, "连接中");

    responseMode = "deferred-connect";
    const messagesBeforeConnect = messages.length;
    const pendingConnect = click();
    await waitFor(() => messages.length === messagesBeforeConnect + 1);
    assert.equal(elements["#connect"].disabled, true);
    intervalCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, messagesBeforeConnect + 1);
    releaseConnect({ enabled: true, state: "CONNECTING", lastError: "" });
    await pendingConnect;
    assert.equal(elements["#connect"].disabled, false);

    responseMode = "reject";
    await click();
    assert.equal(elements["#status"].textContent, "后台通道断开");
    assert.equal(elements["#status"].className, "red");

    responseMode = "empty";
    intervalCallback();
    await waitFor(() => elements["#status"].textContent.includes("未返回状态"));

    responseMode = "ready";
    intervalCallback();
    await waitFor(() => elements["#status"].textContent === "已连接");
    assert.equal(elements["#status"].className, "green");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval;
  }
});
