import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMoneyHandPeer } from "../skills/npc-moneyhand/scripts/lib/peer.mjs";

const peerPort = 19_846;
const pairingToken = process.env.NPC_MONEYHAND_PAIRING_TOKEN || "";
const requirePointer = process.env.NPC_MONEYHAND_REQUIRE_POINTER === "1";

const fixture = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>npc-moneyhand isolated E2E</title>
<style>body{font:16px system-ui;margin:40px}input,button{font:inherit;padding:10px;margin:6px}output{display:block;margin:12px}</style>
</head><body><h1>npc-moneyhand isolated E2E</h1>
<label>Test input <input id="fixture-input" autocomplete="off"></label>
<button id="fixture-button">Apply</button><output id="fixture-output">idle</output>
<script>
window.__fixtureClicks=0;
document.querySelector("#fixture-button").addEventListener("click",()=>{
  window.__fixtureClicks+=1;
  document.querySelector("#fixture-output").textContent="accepted:"+document.querySelector("#fixture-input").value;
});
</script></body></html>`;

const httpServer = createServer((request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(fixture);
});
const peer = createMoneyHandPeer({ port: peerPort, pairingToken });
let session;
let tabId;
let attached = false;
let previousActiveTabId;
let requestSequence = 0;

function report(stage, data = {}) {
  console.log(JSON.stringify({ stage, ...data }));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

async function send(method, params = {}, options = {}) {
  return await session.request({
    id: `e2e:${++requestSequence}:${Date.now()}`,
    method,
    params,
  }, { timeoutMs: 30_000, ...options });
}

async function ok(method, params = {}, options = {}) {
  const terminal = await send(method, params, options);
  if (!terminal.ok) throw new Error(`${method} failed: ${JSON.stringify(terminal.error)}`);
  return terminal.result;
}

async function evaluate(expression) {
  const command = await ok("cdp.send", {
    target: { tabId },
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  });
  return command.result?.result?.value;
}

async function nodeCenter(nodeId) {
  const command = await ok("cdp.send", {
    target: { tabId },
    method: "DOM.getBoxModel",
    params: { nodeId },
  });
  const quad = command.result?.model?.border;
  assert.equal(quad?.length, 8);
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

async function waitForValue(expression, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value === expected) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function waitForTab(expectedUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await ok("chrome.call", { method: "tabs.get", args: [tabId] });
    if (current.result?.url === expectedUrl && current.result.status === "complete") return current.result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for test tab ${tabId}`);
}

async function cleanup() {
  if (session && !session.closed) {
    await ok("behavior.reset").catch(() => undefined);
    if (attached && tabId) await ok("target.detach", { tabId }).catch(() => undefined);
    if (previousActiveTabId) {
      await ok("chrome.call", {
        method: "tabs.update",
        args: [previousActiveTabId, { active: true }],
      }).catch(() => undefined);
    }
    if (tabId) await ok("chrome.call", { method: "tabs.remove", args: [tabId] }).catch(() => undefined);
  }
  await peer.stop().catch(() => undefined);
  httpServer.closeAllConnections?.();
  await new Promise((resolve) => httpServer.close(() => resolve())).catch(() => undefined);
}

try {
  const fixtureAddress = await listen(httpServer);
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;
  const endpoint = await peer.start();
  report("waiting", { endpoint, fixtureUrl });

  session = await peer.waitFor({}, { timeoutMs: 120_000 });
  assert.equal(session.identity.capabilities?.coordinateContract, "css-viewport-v1");
  const system = await ok("system.status");
  const initialTargets = await ok("target.list");
  assert.equal(system.connection.state, "READY");
  assert.ok(initialTargets.targets.length > 0);
  report("connected", {
    version: session.identity.version,
    coordinateContract: session.identity.capabilities.coordinateContract,
    chrome: session.identity.browser?.userAgent,
    targetCount: initialTargets.targets.length,
  });
  const activeTabs = await ok("chrome.call", {
    method: "tabs.query",
    args: [{ active: true, lastFocusedWindow: true }],
  });
  previousActiveTabId = activeTabs.result?.[0]?.id;

  const created = await ok("chrome.call", {
    method: "tabs.create",
    args: [{ url: fixtureUrl, active: false }],
  });
  tabId = created.result?.id;
  assert.ok(Number.isInteger(tabId) && tabId > 0);
  await waitForTab(fixtureUrl);

  await ok("target.attach", { tabId, autoAttachFrames: true });
  attached = true;
  await ok("cdp.send", { target: { tabId }, method: "Page.enable", params: {} });
  await waitForValue("document.readyState", "complete");

  const documentResult = await ok("cdp.send", {
    target: { tabId },
    method: "DOM.getDocument",
    params: { depth: 1 },
  });
  const rootNodeId = documentResult.result?.root?.nodeId;
  assert.ok(Number.isInteger(rootNodeId));
  const inputNode = await ok("cdp.send", {
    target: { tabId },
    method: "DOM.querySelector",
    params: { nodeId: rootNodeId, selector: "#fixture-input" },
  });
  assert.ok(Number.isInteger(inputNode.result?.nodeId) && inputNode.result.nodeId > 0);
  const buttonNode = await ok("cdp.send", {
    target: { tabId },
    method: "DOM.querySelector",
    params: { nodeId: rootNodeId, selector: "#fixture-button" },
  });
  assert.ok(Number.isInteger(buttonNode.result?.nodeId) && buttonNode.result.nodeId > 0);
  report("cdp", { tabId, domNodeId: inputNode.result.nodeId });

  const rects = {
    input: await nodeCenter(inputNode.result.nodeId),
    button: await nodeCenter(buttonNode.result.nodeId),
  };
  await ok("chrome.call", {
    method: "tabs.update",
    args: [tabId, { active: true }],
  });
  let visibility = await evaluate("document.visibilityState");
  if (requirePointer && visibility !== "visible") {
    report("awaiting-foreground", { timeoutMs: 30_000 });
    visibility = await waitForValue("document.visibilityState", "visible", 30_000);
  }
  await ok("behavior.reset");
  let pointerValidated = false;
  if (visibility === "visible") {
    await ok("input.perform", { target: { tabId }, action: "click", coordinateSpace: "css-viewport-v1", ...rects.input });
    pointerValidated = await evaluate("document.activeElement?.id") === "fixture-input";
  }
  if (requirePointer) assert.equal(pointerValidated, true);
  if (!pointerValidated) {
    await ok("cdp.send", {
      target: { tabId },
      method: "DOM.focus",
      params: { nodeId: inputNode.result.nodeId },
    });
  }
  await ok("input.perform", { target: { tabId }, action: "type", text: "raw" });
  assert.equal(await evaluate("document.querySelector('#fixture-input').value"), "raw");
  report("raw-input", { value: "raw", visibility, pointerValidated });

  const adjusted = await ok("behavior.set", {
    typingDelayMs: 15,
    pointerSteps: 3,
    pointerDurationMs: 24,
    ttlMs: 60_000,
  });
  assert.equal(adjusted.behavior.typingDelayMs, 15);
  const adjustedStarted = Date.now();
  await ok("input.perform", { target: { tabId }, action: "type", text: "-agent" });
  const adjustedDurationMs = Date.now() - adjustedStarted;
  assert.ok(adjustedDurationMs >= 70);
  if (pointerValidated) {
    await ok("input.perform", { target: { tabId }, action: "click", coordinateSpace: "css-viewport-v1", ...rects.button });
  } else {
    await evaluate("document.querySelector('#fixture-button').click()");
  }
  const pageState = await evaluate(`({
    value: document.querySelector("#fixture-input").value,
    output: document.querySelector("#fixture-output").textContent,
    clicks: window.__fixtureClicks
  })`);
  assert.deepEqual(pageState, { value: "raw-agent", output: "accepted:raw-agent", clicks: 1 });
  report("adjusted-input", { adjustedDurationMs, pageState });

  const context = await ok("observe.context", {
    target: { tabId },
    maxTextChars: 4_000,
    maxElements: 20,
  });
  assert.equal(context.untrustedPageContent, true);
  assert.match(context.text, /accepted:raw-agent/u);
  report("text-context", {
    title: context.title,
    textMatched: true,
    controlCount: context.controls.length,
  });

  const unclear = await send("page.understand-this", { target: { tabId } });
  assert.equal(unclear.status, "needs_instruction");
  assert.match(unclear.need.context.text, /accepted:raw-agent/u);
  await ok("instruction.resolve", {
    tabId,
    waitId: unclear.need.waitId,
    action: "cancel",
  });
  report("agent-fallback", {
    status: unclear.status,
    textOnly: true,
    automaticScreenshot: session.identity.capabilities?.automaticScreenshots,
  });

  const screenshot = await ok("observe.screenshot", {
    target: { tabId },
    format: "jpeg",
    quality: 55,
    fullPage: false,
  });
  assert.equal(screenshot.mimeType, "image/jpeg");
  assert.ok(typeof screenshot.data === "string" && screenshot.data.length > 100);
  report("screenshot-fallback", {
    explicit: true,
    approximateBytes: Math.floor(screenshot.data.length * 0.75),
  });

  report("passed", { profile: session.identity.profile, tabId, pointerValidated });
} catch (error) {
  process.exitCode = 1;
  report("failed", { message: error instanceof Error ? error.message : String(error) });
} finally {
  await cleanup();
}
