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
    focused: false,
    textContent: "",
    title: "",
    value: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    focus() {
      this.focused = true;
    },
    listener(type) {
      return listeners.get(type);
    },
  };
}

test("popup runtime saves, reports transport errors, refreshes READY, and validates locally", async () => {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousSetInterval = globalThis.setInterval;
  const elements = {
    "#connection": fakeElement(),
    "#address": fakeElement(),
    "#port": fakeElement(),
    "#save": fakeElement(),
    "#status": fakeElement(),
  };
  const messages = [];
  let intervalCallback;
  let responseMode = "initial";
  let releaseConfigure;
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
    storage: {
      local: {
        async get() {
          return {
            enabled: false,
            wsEndpoint: "ws://127.0.0.1:19847/extension",
          };
        },
      },
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (responseMode === "reject") throw new Error("后台通道断开");
        if (responseMode === "empty") return undefined;
        if (responseMode === "deferred-configure" && message.type === "popup.configure") {
          return await new Promise((resolve) => {
            releaseConfigure = resolve;
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
        if (message.type === "popup.configure") {
          return { enabled: true, state: "CONNECTING", lastError: "" };
        }
        return { enabled: false, state: "DISABLED", lastError: "" };
      },
    },
  };

  try {
    await import(`../extension/popup.js?popup-runtime=${Date.now()}`);
    await waitFor(() => messages.length === 1);

    assert.equal(elements["#address"].value, "127.0.0.1");
    assert.equal(elements["#port"].value, "19847");
    assert.equal(elements["#status"].textContent, "未启用");
    assert.equal(typeof intervalCallback, "function");

    const submit = elements["#connection"].listener("submit");
    const event = { preventDefault() {} };
    elements["#address"].value = "localhost";
    elements["#port"].value = "19848";
    await submit(event);

    assert.deepEqual(messages.at(-1), {
      type: "popup.configure",
      address: "localhost",
      port: 19848,
    });
    assert.equal(elements["#status"].textContent, "连接中");
    assert.equal(elements["#save"].disabled, false);

    responseMode = "deferred-status";
    const messagesBeforeSlowPoll = messages.length;
    intervalCallback();
    await waitFor(() => messages.length === messagesBeforeSlowPoll + 1);
    responseMode = "initial";
    await submit(event);
    releaseStatus({ enabled: true, state: "READY", lastError: "" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements["#status"].textContent, "连接中");

    responseMode = "deferred-configure";
    const messagesBeforeConfigure = messages.length;
    const pendingConfigure = submit(event);
    await waitFor(() => messages.length === messagesBeforeConfigure + 1);
    assert.equal(elements["#save"].disabled, true);
    intervalCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, messagesBeforeConfigure + 1);
    releaseConfigure({ enabled: true, state: "CONNECTING", lastError: "" });
    await pendingConfigure;
    assert.equal(elements["#save"].disabled, false);

    responseMode = "reject";
    await submit(event);
    assert.equal(elements["#status"].textContent, "后台通道断开");
    assert.equal(elements["#status"].className, "red");

    responseMode = "empty";
    intervalCallback();
    await waitFor(() => elements["#status"].textContent.includes("未返回状态"));

    responseMode = "ready";
    intervalCallback();
    await waitFor(() => elements["#status"].textContent === "已连接");
    assert.equal(elements["#status"].className, "green");

    const sentBeforeValidation = messages.length;
    elements["#address"].value = "192.168.1.10";
    await submit(event);
    assert.equal(messages.length, sentBeforeValidation);
    assert.equal(elements["#status"].textContent, "地址仅支持 127.0.0.1、localhost 或 ::1");
    assert.equal(elements["#address"].focused, true);

    elements["#address"].value = "127.0.0.1";
    elements["#port"].value = "70000";
    await submit(event);
    assert.equal(messages.length, sentBeforeValidation);
    assert.equal(elements["#status"].textContent, "端口必须是 1–65535");
    assert.equal(elements["#port"].focused, true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    globalThis.setInterval = previousSetInterval;
  }
});
