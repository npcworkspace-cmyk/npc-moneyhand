import assert from "node:assert/strict";
import { createMoneyHandPeer } from "../skills/npc-moneyhand/scripts/lib/peer.mjs";

const port = 19_846;
const pairingToken = process.env.NPC_MONEYHAND_PAIRING_TOKEN || "";
const requestedUrl = process.env.NPC_MONEYHAND_TEST_URL;
const keepTab = process.env.NPC_MONEYHAND_KEEP_TAB === "1";

if (!requestedUrl) throw new Error("Set NPC_MONEYHAND_TEST_URL");
const parsedUrl = new URL(requestedUrl);
if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Test URL must use HTTP or HTTPS");

const peer = createMoneyHandPeer({ port, pairingToken });
let session;
let tabId;
let attached = false;
let sequence = 0;

function report(stage, data = {}) {
  console.log(JSON.stringify({ stage, ...data }));
}

async function send(method, params = {}) {
  return await session.request({
    id: `site:${++sequence}:${Date.now()}`,
    method,
    params,
  }, { timeoutMs: 30_000 });
}

async function ok(method, params = {}) {
  const terminal = await send(method, params);
  if (!terminal.ok) throw new Error(`${method} failed: ${JSON.stringify(terminal.error)}`);
  return terminal.result;
}

async function waitForTab(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await ok("chrome.call", { method: "tabs.get", args: [tabId] });
    if (current.result?.status === "complete" && /^https?:/u.test(current.result.url || "")) return current.result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for tab ${tabId}`);
}

try {
  const endpoint = await peer.start();
  report("waiting", { endpoint, requestedUrl });
  session = await peer.waitFor({}, { timeoutMs: 120_000 });

  const created = await ok("chrome.call", {
    method: "tabs.create",
    args: [{ url: requestedUrl, active: true }],
  });
  tabId = created.result?.id;
  assert.ok(Number.isInteger(tabId) && tabId > 0);
  const loadedTab = await waitForTab();

  await ok("target.attach", { tabId, autoAttachFrames: true });
  attached = true;
  const context = await ok("observe.context", {
    target: { tabId },
    maxTextChars: 8_000,
    maxElements: 40,
  });
  const challenge = /验证码|安全验证|异常流量|captcha|verify you are human/iu.test(context.text || "");
  report(challenge ? "challenge" : "passed", {
    tabId,
    profile: session.identity.profile,
    url: loadedTab.url,
    title: context.title,
    readyState: context.readyState,
    textChars: context.text?.length || 0,
    controlCount: context.controls?.length || 0,
    keptOpen: keepTab || challenge,
  });
  if (challenge) process.exitCode = 2;
} catch (error) {
  process.exitCode = 1;
  report("failed", { message: error instanceof Error ? error.message : String(error) });
} finally {
  if (session && !session.closed && attached && tabId) {
    await ok("target.detach", { tabId }).catch(() => undefined);
  }
  if (session && !session.closed && tabId && !keepTab && process.exitCode !== 2) {
    await ok("chrome.call", { method: "tabs.remove", args: [tabId] }).catch(() => undefined);
  }
  await peer.stop().catch(() => undefined);
}
