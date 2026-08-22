import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import {
  MoneyHandUnknownOutcomeError,
  createMoneyHandPeer,
} from "../skills/npc-moneyhand/scripts/lib/peer.mjs";
import {
  OPCODE,
  clientFrame,
  closeDetails,
  openRawWebSocket,
  waitFor,
} from "./helpers/raw-websocket.js";

const PROTOCOL = "npc-moneyhand/2";
const TEST_SESSION_TIMEOUT_MS = 5_000;

async function unusedLoopbackPort() {
  const server = createNetServer();
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function assertPortReleased(port) {
  const server = createNetServer();
  try {
    server.listen({ host: "127.0.0.1", port, exclusive: true });
    await once(server, "listening");
    assert.equal(server.address().port, port);
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

function extensionHello(options = {}) {
  return {
    v: 2,
    type: "hello",
    protocol: PROTOCOL,
    product: "npc-moneyhand",
    profile: options.profile ?? "work",
    instanceId: options.instanceId ?? "instance_0001",
    bootId: options.bootId ?? "boot_0000001",
    version: "2.0.0-alpha.6",
    auth: options.auth ?? { mode: "none" },
    focus: options.focus ?? { windowId: 1, focused: true, lastFocusedAt: 1 },
    browser: { platform: { os: "win" } },
    unknownOutcomeIds: options.unknownOutcomeIds ?? [],
    capabilities: { rawCdp: true },
  };
}

function authenticationPayload(role, hello, serverNonce) {
  return [
    PROTOCOL,
    role,
    hello.profile,
    hello.instanceId,
    hello.bootId,
    hello.auth.clientNonce,
    serverNonce,
  ].join("\n");
}

function proof(secret, role, hello, serverNonce) {
  return createHmac("sha256", secret)
    .update(authenticationPayload(role, hello, serverNonce), "utf8")
    .digest("hex");
}

async function startPeer(t, options = {}) {
  const peer = createMoneyHandPeer({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 1_000,
    ...options,
  });
  await peer.start();
  t.after(() => peer.stop({ graceMs: 0 }));
  return peer;
}

async function connectExtension(peer, t, options = {}) {
  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
    headFrame: options.headFrame,
    origin: options.origin,
  });
  t.after(() => opened.client.destroy());
  assert.equal(opened.response.status, 101);
  return opened.client;
}

async function confirmReady(client) {
  const ping = await client.nextJson();
  assert.equal(ping.v, 2);
  assert.equal(ping.type, "ping");
  assert.equal(typeof ping.timestamp, "string");
  assert.notEqual(ping.timestamp, "");
  client.sendJson({
    v: 2,
    type: "pong",
    timestamp: ping.timestamp,
  });
  return ping;
}

async function readyExtension(peer, t, hello = extensionHello()) {
  const waiting = peer.waitFor(
    { profile: hello.profile },
    { timeoutMs: TEST_SESSION_TIMEOUT_MS },
  );
  const client = await connectExtension(peer, t);
  client.sendJson(hello);
  const ready = await client.nextJson();
  const ping = await confirmReady(client);
  return {
    client,
    hello,
    ping,
    ready,
    session: await waiting,
  };
}

test("default policy rejects ordinary HTTPS page origins", async (t) => {
  const peer = await startPeer(t);
  const { client, response } = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
    origin: "https://example.com",
  });
  t.after(() => client.destroy());

  assert.equal(response.status, 403);
  await client.waitForSocketClose();
  assert.equal(peer.sessions().length, 0);
});

test("the Peer rejects a Host authority that does not name its loopback listener", async (t) => {
  const peer = await startPeer(t);
  const { client, response } = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
    headers: { Host: "example.invalid:443" },
  });
  t.after(() => client.destroy());

  assert.equal(response.status, 403);
  await client.waitForSocketClose();
});

test("a no-secret Extension hello receives ready and creates one Agent session", async (t) => {
  const peer = await startPeer(t, { maxInflight: 7 });
  const { ready, session } = await readyExtension(peer, t);

  assert.deepEqual(ready, {
    v: 2,
    type: "ready",
    protocol: PROTOCOL,
    heartbeatMs: 5_000,
    maxInflight: 7,
    ackUnknownOutcomeIds: [],
  });
  assert.equal(session.identity.profile, "work");
  assert.equal(session.identity.instanceId, "instance_0001");
  assert.deepEqual(peer.sessions(), [session]);
});

test("one configured port can wait for its Extension without a visible profile selector", async (t) => {
  const peer = await startPeer(t);
  const waiting = peer.waitFor();
  const client = await connectExtension(peer, t);
  client.sendJson(extensionHello({ profile: "hidden-profile" }));
  const ready = await client.nextJson();
  await confirmReady(client);
  const session = await waiting;

  assert.equal(ready.type, "ready");
  assert.equal(session.identity.profile, "hidden-profile");
  assert.deepEqual(peer.sessions(), [session]);
});

test("localhost is accepted when it is the address saved by the Extension", async (t) => {
  const peer = createMoneyHandPeer({
    host: "localhost",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  t.after(() => peer.stop({ graceMs: 0 }));
  await peer.start();
  assert.match(peer.endpoint, /^ws:\/\/localhost:\d+\/extension$/u);
});

test("waitFor rejects unknown selector keys, including misplaced options", async (t) => {
  const peer = await startPeer(t);

  for (const [selector, key] of [
    [{ timeoutMs: 10 }, "timeoutMs"],
    [{ profile: "work", alias: "legacy" }, "alias"],
  ]) {
    await assert.rejects(
      peer.waitFor(selector),
      (error) => {
        assert.equal(error.code, "INVALID_SELECTOR");
        assert.match(error.message, /profile, instanceId and bootId/u);
        assert.match(error.message, new RegExp(key, "u"));
        return true;
      },
    );
  }
});

test("one port routes each Agent request to the most recently focused Profile", async (t) => {
  const peer = await startPeer(t);
  const first = await readyExtension(peer, t, extensionHello({
    profile: "npc-profile-one",
    instanceId: "instance_profile_one",
    focus: { windowId: 11, focused: false, lastFocusedAt: 100 },
  }));
  const second = await readyExtension(peer, t, extensionHello({
    profile: "npc-profile-two",
    instanceId: "instance_profile_two",
    focus: { windowId: 22, focused: true, lastFocusedAt: 200 },
  }));

  assert.equal(peer.activeSession(), second.session);
  assert.equal(await peer.waitFor({ bootId: first.hello.bootId }), first.session);
  first.client.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    event: "window.focused",
    target: { windowId: 11 },
    data: { focused: true, lastFocusedAt: 300 },
  });
  await waitFor(() => peer.activeSession() === first.session);
  assert.equal(first.session.focus.lastFocusedAt, 300);
  assert.equal(second.session.focus.focused, false);

  const terminalPromise = peer.request({ method: "system.status", params: {} });
  const request = await first.client.nextJson();
  assert.equal(request.type, "request");
  assert.equal(request.method, "system.status");
  first.client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ok: true,
    result: { selectedWindowId: 11 },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await terminalPromise).result, { selectedWindowId: 11 });
});

test("a delayed older focus event cannot override a newer Profile focus", async (t) => {
  const peer = await startPeer(t);
  const first = await readyExtension(peer, t, extensionHello({
    profile: "npc-profile-one",
    instanceId: "instance_profile_one",
    focus: { windowId: 11, focused: false, lastFocusedAt: 100 },
  }));
  const second = await readyExtension(peer, t, extensionHello({
    profile: "npc-profile-two",
    instanceId: "instance_profile_two",
    focus: { windowId: 22, focused: true, lastFocusedAt: 200 },
  }));
  first.client.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    event: "window.focused",
    target: { windowId: 11 },
    data: { focused: true, lastFocusedAt: 300 },
  });
  await waitFor(() => peer.activeSession() === first.session);

  second.client.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    event: "window.focused",
    target: { windowId: 22 },
    data: { focused: true, lastFocusedAt: 200 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(peer.activeSession(), first.session);
  assert.equal(first.session.focus.focused, true);
  assert.equal(first.session.focus.lastFocusedAt, 300);
  assert.equal(second.session.focus.focused, false);
  assert.equal(second.session.focus.lastFocusedAt, 200);

  const terminalPromise = peer.request({ method: "system.status", params: {} });
  const request = await first.client.nextJson();
  assert.equal(request.type, "request");
  assert.equal(request.method, "system.status");
  first.client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ok: true,
    result: { selectedWindowId: 11 },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await terminalPromise).result, { selectedWindowId: 11 });
});

test("a buffered focus event supersedes stale hello focus before session activation", async (t) => {
  let onSessionFocus;
  let onSessionActive;
  let peer;
  peer = await startPeer(t, {
    onSession(session) {
      if (session.identity.profile !== "npc-profile-two") return;
      onSessionFocus = { ...session.focus };
      onSessionActive = peer.activeSession();
    },
  });
  const first = await readyExtension(peer, t, extensionHello({
    profile: "npc-profile-one",
    instanceId: "instance_profile_one",
    bootId: "boot_profile_one",
    focus: { windowId: 11, focused: true, lastFocusedAt: 200 },
  }));
  const waiting = peer.waitFor(
    {},
    { afterSerial: first.session.serial, timeoutMs: TEST_SESSION_TIMEOUT_MS },
  );
  const secondClient = await connectExtension(peer, t);
  secondClient.sendJson(extensionHello({
    profile: "npc-profile-two",
    instanceId: "instance_profile_two",
    bootId: "boot_profile_two",
    focus: { windowId: 22, focused: false, lastFocusedAt: 100 },
  }));
  const ready = await secondClient.nextJson();
  const ping = await secondClient.nextJson();
  assert.equal(ready.type, "ready");
  assert.equal(ping.type, "ping");

  secondClient.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    event: "window.focused",
    target: { windowId: 22 },
    data: { focused: true, lastFocusedAt: 300 },
  });
  secondClient.sendJson({
    v: 2,
    type: "pong",
    timestamp: ping.timestamp,
  });

  const second = await waiting;
  assert.equal(second.identity.profile, "npc-profile-two");
  assert.deepEqual(onSessionFocus, {
    windowId: 22,
    focused: true,
    lastFocusedAt: 300,
  });
  assert.equal(onSessionActive, second);
  assert.equal(peer.activeSession(), second);
  assert.equal(first.session.focus.focused, false);
});

test("the first hello frame is processed when it arrives in the HTTP upgrade head", async (t) => {
  const peer = await startPeer(t);
  const hello = extensionHello({
    profile: "head",
    instanceId: "instance_head",
    bootId: "boot_head_01",
  });
  const waiting = peer.waitFor(
    { profile: hello.profile },
    { timeoutMs: TEST_SESSION_TIMEOUT_MS },
  );
  const client = await connectExtension(peer, t, {
    headFrame: clientFrame(JSON.stringify(hello)),
  });

  const ready = await client.nextJson();
  assert.equal(ready.type, "ready");
  await confirmReady(client);
  assert.equal((await waiting).identity.profile, "head");
});

test("HMAC pairing proves both sides before ready without exposing the secret", async (t) => {
  const secret = "pairing-secret-123456";
  const peer = await startPeer(t, { pairingToken: secret });
  const hello = extensionHello({
    profile: "secure",
    instanceId: "instance_secure",
    bootId: "boot_secure_01",
    auth: {
      mode: "hmac-sha256",
      clientNonce: "client_nonce_123456",
    },
  });
  const waiting = peer.waitFor(
    { profile: hello.profile },
    { timeoutMs: TEST_SESSION_TIMEOUT_MS },
  );
  const client = await connectExtension(peer, t);
  client.sendJson(hello);

  const challenge = await client.nextJson();
  assert.equal(challenge.type, "challenge");
  assert.equal(challenge.protocol, PROTOCOL);
  assert.equal(challenge.proof, proof(secret, "server", hello, challenge.nonce));
  assert.equal(JSON.stringify(challenge).includes(secret), false);

  client.sendJson({
    v: 2,
    type: "authenticate",
    protocol: PROTOCOL,
    nonce: challenge.nonce,
    proof: proof(secret, "client", hello, challenge.nonce),
  });
  const ready = await client.nextJson();
  assert.equal(ready.type, "ready");
  await confirmReady(client);
  assert.equal((await waiting).identity.profile, "secure");
});

test("an unauthenticated handshake cannot reserve a paired Extension identity", async (t) => {
  const secret = "pairing-secret-123456";
  const peer = await startPeer(t, { pairingToken: secret });
  const hello = extensionHello({
    profile: "paired-race",
    instanceId: "instance_paired_race",
    bootId: "boot_paired_race",
    auth: {
      mode: "hmac-sha256",
      clientNonce: "client_nonce_paired_race",
    },
  });
  const stalled = await connectExtension(peer, t);
  stalled.sendJson(hello);
  assert.equal((await stalled.nextJson()).type, "challenge");

  const waiting = peer.waitFor(
    { profile: hello.profile },
    { timeoutMs: TEST_SESSION_TIMEOUT_MS },
  );
  const legitimate = await connectExtension(peer, t);
  legitimate.sendJson(hello);
  const challenge = await legitimate.nextJson();
  assert.equal(challenge.type, "challenge");
  legitimate.sendJson({
    v: 2,
    type: "authenticate",
    protocol: PROTOCOL,
    nonce: challenge.nonce,
    proof: proof(secret, "client", hello, challenge.nonce),
  });
  assert.equal((await legitimate.nextJson()).type, "ready");
  await confirmReady(legitimate);
  assert.equal((await waiting).identity.instanceId, hello.instanceId);
});

test("the first ready Extension origin is pinned for the Peer lifetime", async (t) => {
  const peer = await startPeer(t);
  const firstOrigin = `chrome-extension://${"a".repeat(32)}`;
  const otherOrigin = `chrome-extension://${"b".repeat(32)}`;
  await readyExtension(peer, t, extensionHello({
    profile: "origin-one",
    instanceId: "instance_origin_one",
  }));

  const other = await connectExtension(peer, t, { origin: otherOrigin });
  other.sendJson(extensionHello({
    profile: "origin-two",
    instanceId: "instance_origin_two",
  }));
  const close = await other.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1008);
  assert.equal(peer.extensionOrigin, firstOrigin);
  assert.equal(peer.sessions().length, 1);
});

test("an unconfirmed hello cannot pin the Extension origin", async (t) => {
  const peer = await startPeer(t);
  const stalledOrigin = `chrome-extension://${"b".repeat(32)}`;
  const stalled = await connectExtension(peer, t, { origin: stalledOrigin });
  stalled.sendJson(extensionHello({
    profile: "origin-stalled",
    instanceId: "instance_origin_stalled",
  }));
  assert.equal((await stalled.nextJson()).type, "ready");
  const stalledPing = await stalled.nextJson();
  assert.equal(peer.extensionOrigin, undefined);

  const legitimate = await readyExtension(peer, t, extensionHello({
    profile: "origin-confirmed",
    instanceId: "instance_origin_confirmed",
  }));
  assert.equal(peer.extensionOrigin, `chrome-extension://${"a".repeat(32)}`);

  stalled.sendJson({
    v: 2,
    type: "pong",
    timestamp: stalledPing.timestamp,
  });
  const close = await stalled.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1008);
  assert.deepEqual(peer.sessions(), [legitimate.session]);
});

test("far-future focus timestamps cannot pin default routing", async (t) => {
  const peer = await startPeer(t);
  const poisoned = await readyExtension(peer, t, extensionHello({
    profile: "focus-poisoned",
    instanceId: "instance_focus_poisoned",
    focus: {
      windowId: 11,
      focused: false,
      lastFocusedAt: Date.now() + 365 * 24 * 60 * 60 * 1_000,
    },
  }));
  const current = await readyExtension(peer, t, extensionHello({
    profile: "focus-current",
    instanceId: "instance_focus_current",
    focus: { windowId: 22, focused: false, lastFocusedAt: Date.now() },
  }));

  assert.equal(poisoned.session.focus.lastFocusedAt, 0);
  assert.equal(peer.activeSession(), current.session);
});

test("active heartbeat pings echo their correlation token", async (t) => {
  const peer = await startPeer(t);
  const { client } = await readyExtension(peer, t);
  client.sendJson({
    v: 2,
    type: "ping",
    timestamp: "heartbeat_correlation_token",
  });
  const pong = await client.nextJson();
  assert.equal(pong.type, "pong");
  assert.equal(pong.timestamp, "heartbeat_correlation_token");
});

test("a malformed terminal response closes the session with an unknown outcome", async (t) => {
  const peer = await startPeer(t);
  const { client, session } = await readyExtension(peer, t);
  const pending = session.request({
    id: "malformed-terminal",
    method: "system.status",
    params: {},
  });
  assert.equal((await client.nextJson()).id, "malformed-terminal");

  client.sendJson({
    v: 2,
    type: "response",
    id: "malformed-terminal",
    result: { missing: "ok" },
  });
  const close = await client.nextFrame();

  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1002);
  await assert.rejects(pending, (error) => error?.code === "OUTCOME_UNKNOWN");
});

test("Agent requests stay correlated while Extension events are interleaved", async (t) => {
  const peer = await startPeer(t);
  const { client, session } = await readyExtension(peer, t);
  const eventPromise = once(session, "event");
  const terminalPromise = session.request({
    id: "request-1",
    method: "system.status",
    params: {},
  });

  const outbound = await client.nextJson();
  assert.equal(outbound.type, "request");
  assert.equal(outbound.id, "request-1");
  client.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    timestamp: new Date().toISOString(),
    event: "tab.created",
    target: { tabId: 1 },
    data: {},
  });
  const [event] = await eventPromise;
  assert.equal(event.event, "tab.created");
  assert.equal(session.pending.has("request-1"), true);

  client.sendJson({
    v: 2,
    type: "response",
    id: "request-1",
    ok: true,
    result: { connected: true },
    meta: { durationMs: 1 },
  });
  const terminal = await terminalPromise;
  assert.equal(terminal.id, "request-1");
  assert.deepEqual(terminal.result, { connected: true });
  assert.equal(session.pending.size, 0);
});

test("automatic request IDs do not repeat after reconnecting the same boot", async (t) => {
  const peer = await startPeer(t);
  const hello = extensionHello({
    profile: "same-boot",
    instanceId: "instance_same_boot",
    bootId: "boot_same_0001",
  });
  const first = await readyExtension(peer, t, hello);
  const firstTerminal = first.session.request({
    method: "system.status",
    params: {},
  });
  const firstRequest = await first.client.nextJson();
  first.client.sendJson({
    v: 2,
    type: "response",
    id: firstRequest.id,
    ok: true,
    result: {},
    meta: { durationMs: 0 },
  });
  await firstTerminal;
  first.client.destroy();
  await waitFor(() => first.session.closed && peer.rawSockets.size === 0);

  const second = await readyExtension(peer, t, hello);
  const secondTerminal = second.session.request({
    method: "system.status",
    params: {},
  });
  const secondRequest = await second.client.nextJson();
  second.client.sendJson({
    v: 2,
    type: "response",
    id: secondRequest.id,
    ok: true,
    result: {},
    meta: { durationMs: 0 },
  });
  await secondTerminal;

  assert.notEqual(secondRequest.id, firstRequest.id);
  assert.equal(firstRequest.id.endsWith(":1"), true);
  assert.equal(secondRequest.id.endsWith(":1"), true);
});

test("an in-flight ID cannot be reused after recent-ID churn", async (t) => {
  const peer = await startPeer(t, {
    heartbeatMs: 25_000,
    maxInflight: 256,
    requestTimeoutMs: 10_000,
  });
  const { client, session } = await readyExtension(peer, t, extensionHello({
    profile: "pending-eviction",
    instanceId: "instance_pending_evict",
    bootId: "boot_pending_evict",
  }));
  const heldTerminal = session.request({
    id: "held-open",
    method: "system.status",
    params: {},
  }, { timeoutMs: 0 });
  assert.equal((await client.nextJson()).id, "held-open");

  const total = 4_096;
  const batchSize = 255;
  for (let offset = 0; offset < total; offset += batchSize) {
    const batchEnd = Math.min(offset + batchSize, total);
    const terminals = [];
    for (let index = offset; index < batchEnd; index += 1) {
      terminals.push(session.request({
        id: `pending-churn-${index}`,
        method: "system.status",
        params: {},
      }));
    }
    const responseFrames = [];
    for (let index = offset; index < batchEnd; index += 1) {
      const request = await client.nextJson(5_000);
      assert.equal(request.id, `pending-churn-${index}`);
      responseFrames.push(clientFrame(JSON.stringify({
        v: 2,
        type: "response",
        id: request.id,
        ok: true,
        result: {},
        meta: { durationMs: 0 },
      })));
    }
    client.write(Buffer.concat(responseFrames));
    await Promise.all(terminals);
  }

  assert.equal(session.usedIds.has("held-open"), true);
  assert.equal(session.pending.has("held-open"), true);
  await assert.rejects(
    session.request({
      id: "held-open",
      method: "system.status",
      params: {},
    }),
    (error) => error?.code === "ID_CONFLICT",
  );

  client.sendJson({
    v: 2,
    type: "response",
    id: "held-open",
    ok: true,
    result: { held: true },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await heldTerminal).result, { held: true });
  assert.equal(session.pending.has("held-open"), false);
});

test("a timed-out ID stays protected through recent-ID churn and clears local unknown state", async (t) => {
  const peer = await startPeer(t, {
    heartbeatMs: 25_000,
    maxInflight: 256,
    requestTimeoutMs: 10_000,
  });
  const { client, session } = await readyExtension(peer, t, extensionHello({
    profile: "late-eviction",
    instanceId: "instance_late_evict",
    bootId: "boot_late_evict",
  }));
  const timedTerminal = session.request({
    id: "timed-out",
    method: "system.status",
    params: {},
  }, { timeoutMs: 10 });
  const timedRejection = assert.rejects(
    timedTerminal,
    (error) => error instanceof MoneyHandUnknownOutcomeError
      && error.code === "OUTCOME_UNKNOWN"
      && error.id === "timed-out",
  );
  assert.equal((await client.nextJson()).id, "timed-out");
  await timedRejection;
  assert.equal(session.localUnknownOutcomeIds.has("timed-out"), true);

  const total = 4_096;
  const batchSize = 256;
  for (let offset = 0; offset < total; offset += batchSize) {
    const terminals = [];
    for (let index = offset; index < offset + batchSize; index += 1) {
      terminals.push(session.request({
        id: `recent-${index}`,
        method: "system.status",
        params: {},
      }));
    }
    const responseFrames = [];
    for (let index = offset; index < offset + batchSize; index += 1) {
      const request = await client.nextJson(5_000);
      assert.equal(request.id, `recent-${index}`);
      responseFrames.push(clientFrame(JSON.stringify({
        v: 2,
        type: "response",
        id: request.id,
        ok: true,
        result: {},
        meta: { durationMs: 0 },
      })));
    }
    client.write(Buffer.concat(responseFrames));
    await Promise.all(terminals);
  }
  assert.equal(session.usedIds.has("timed-out"), true);
  assert.equal(session.localUnknownOutcomeIds.has("timed-out"), true);
  await assert.rejects(
    session.request({
      id: "timed-out",
      method: "system.status",
      params: {},
    }),
    (error) => error?.code === "ID_CONFLICT",
  );

  let orphanResponses = 0;
  session.on("orphanResponse", () => {
    orphanResponses += 1;
  });
  const lateResponse = once(session, "lateResponse");
  client.sendJson({
    v: 2,
    type: "response",
    id: "timed-out",
    ok: true,
    result: { arrived: "late" },
    meta: { durationMs: 0 },
  });
  const [late] = await lateResponse;
  assert.equal(late.id, "timed-out");
  assert.equal(orphanResponses, 0);
  assert.equal(session.localUnknownOutcomeIds.has("timed-out"), false);
});

test("disconnect rejects an in-flight request as unknown and never retries it", async (t) => {
  const peer = await startPeer(t);
  const { client, session } = await readyExtension(peer, t);
  const terminalPromise = session.request({
    id: "uncertain-write",
    method: "cdp.send",
    params: {
      target: { tabId: 1 },
      method: "Runtime.evaluate",
      params: { expression: "sideEffect()" },
    },
  });
  const outbound = await client.nextJson();
  assert.equal(outbound.id, "uncertain-write");
  const rejected = assert.rejects(
    terminalPromise,
    (error) => error instanceof MoneyHandUnknownOutcomeError
      && error.code === "OUTCOME_UNKNOWN"
      && error.id === "uncertain-write",
  );
  client.destroy();
  let disconnectTimer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        disconnectTimer = setTimeout(
          () => reject(new Error("abrupt disconnect did not reject the request")),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(disconnectTimer);
  }
  assert.equal(session.localUnknownOutcomeIds.has("uncertain-write"), true);
  await waitFor(() => session.closed);
  assert.equal(peer.sessions().length, 0);
  await waitFor(() => peer.rawSockets.size === 0);
});

test("a replaced session cannot confirm unknown outcomes", async (t) => {
  const peer = await startPeer(t);
  const hello = extensionHello({
    profile: "stale",
    instanceId: "instance_stale_1",
    bootId: "boot_stale_001",
    unknownOutcomeIds: ["stale-outcome"],
  });
  const first = await readyExtension(peer, t, hello);
  first.client.destroy();
  await waitFor(() => first.session.closed && peer.rawSockets.size === 0);
  const second = await readyExtension(peer, t, hello);

  await assert.rejects(
    first.session.confirmUnknownOutcomes(["stale-outcome"]),
    (error) => error?.code === "STALE_SESSION",
  );
  assert.deepEqual(peer.sessions(), [second.session]);
  assert.equal(second.ready.ackUnknownOutcomeIds.length, 0);
  assert.equal(second.session.closed, false);
  assert.equal(second.session.closing, false);
  assert.equal(peer.pendingAcks.size, 0);
  assert.equal(peer.waiters.size, 0);
});

test("a duplicate active profile is closed without replacing the first session", async (t) => {
  const peer = await startPeer(t);
  const first = await readyExtension(peer, t, extensionHello({
    profile: "shared",
    instanceId: "instance_first",
    bootId: "boot_first_01",
  }));
  const second = await connectExtension(peer, t);
  second.sendJson(extensionHello({
    profile: "shared",
    instanceId: "instance_second",
    bootId: "boot_second_1",
  }));

  const close = await second.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1008);
  assert.equal(peer.sessions().length, 1);
  assert.equal(peer.sessions()[0], first.session);
  assert.equal(first.session.closed, false);
});

test("a duplicate instanceId across profiles cannot replace the first session", async (t) => {
  const peer = await startPeer(t);
  const first = await readyExtension(peer, t, extensionHello({
    profile: "primary",
    instanceId: "instance_shared",
    bootId: "boot_primary_1",
  }));
  const second = await connectExtension(peer, t);
  second.sendJson(extensionHello({
    profile: "secondary",
    instanceId: "instance_shared",
    bootId: "boot_secondary1",
  }));

  const close = await second.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1008);
  assert.equal(peer.sessions().length, 1);
  assert.equal(peer.sessions()[0], first.session);
  assert.equal(first.session.closed, false);
});

test("start and stop are idempotent and the same Peer can restart", async (t) => {
  const peer = createMoneyHandPeer({
    host: "127.0.0.1",
    port: 0,
    handshakeTimeoutMs: 500,
    heartbeatMs: 5_000,
  });
  t.after(() => peer.stop({ graceMs: 0 }));

  const [firstEndpoint, duplicateStart] = await Promise.all([peer.start(), peer.start()]);
  assert.equal(firstEndpoint, duplicateStart);
  assert.equal(peer.state, "RUNNING");
  await Promise.all([peer.stop({ graceMs: 0 }), peer.stop({ graceMs: 0 })]);
  assert.equal(peer.state, "STOPPED");
  assert.equal(peer.endpoint, undefined);

  const restarted = await peer.start();
  assert.match(restarted, /^ws:\/\/127\.0\.0\.1:\d+\/extension$/u);
  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
  });
  opened.client.destroy();
  assert.equal(opened.response.status, 101);
  await peer.stop({ graceMs: 0 });
  assert.equal(peer.state, "STOPPED");
});

test("invalid negative stop grace leaves the running Peer recoverable", async (t) => {
  const peer = await startPeer(t);
  const server = peer.server;
  const endpoint = peer.endpoint;
  const port = peer.boundPort;

  await assert.rejects(
    peer.stop({ graceMs: -1 }),
    (error) => error?.code === "INVALID_OPTION",
  );
  assert.equal(peer.state, "RUNNING");
  assert.equal(peer.server, server);
  assert.equal(peer.endpoint, endpoint);
  assert.equal(peer.boundPort, port);
  assert.equal(peer.server?.listening, true);

  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
  });
  assert.equal(opened.response.status, 101);
  opened.client.destroy();
  await waitFor(() => peer.rawSockets.size === 0);

  await peer.stop({ graceMs: 0 });
  assert.equal(peer.state, "STOPPED");
  assert.equal(peer.server, undefined);
  assert.equal(peer.endpoint, undefined);
  assert.equal(peer.boundPort, undefined);
  assert.equal(server.listening, false);
});

test("concurrent starts during STOPPING converge on one listening server", async (t) => {
  const peer = await startPeer(t);
  const oldServer = peer.server;
  const endpoint = peer.endpoint;
  const port = peer.boundPort;
  peer.port = port;

  const nativeClose = oldServer.close.bind(oldServer);
  let closeEnteredResolve;
  const closeEntered = new Promise((resolve) => {
    closeEnteredResolve = resolve;
  });
  let releaseClose;
  const released = new Promise((resolve) => {
    releaseClose = resolve;
  });
  t.after(() => releaseClose());
  oldServer.close = (callback) => {
    closeEnteredResolve();
    return nativeClose((...args) => {
      released.then(() => callback?.(...args));
    });
  };

  const stopping = peer.stop({ graceMs: 0 });
  await closeEntered;
  assert.equal(peer.state, "STOPPING");
  assert.equal(peer.server, undefined);
  const firstStart = peer.start();
  const secondStart = peer.start();
  await Promise.resolve();
  assert.equal(peer.state, "STOPPING");
  releaseClose();
  const [firstEndpoint, secondEndpoint] = await Promise.all([firstStart, secondStart]);
  await stopping;

  assert.equal(firstEndpoint, secondEndpoint);
  assert.equal(firstEndpoint, endpoint);
  assert.equal(peer.state, "RUNNING");
  assert.notEqual(peer.server, oldServer);
  assert.equal(oldServer.listening, false);
  assert.equal(peer.server?.listening, true);
  assert.equal(peer.server.address().port, port);
  assert.equal(Number(oldServer.listening) + Number(peer.server?.listening), 1);

  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: peer.boundPort,
    path: peer.path,
  });
  assert.equal(opened.response.status, 101);
  opened.client.destroy();
  await waitFor(() => peer.rawSockets.size === 0);
});

test("same-tick stop, start, stop from RUNNING ends stopped without a listener", async (t) => {
  const port = await unusedLoopbackPort();
  const peer = await startPeer(t, { port });

  const outcomes = await Promise.allSettled([
    peer.stop({ graceMs: 0 }),
    peer.start(),
    peer.stop({ graceMs: 0 }),
  ]);

  assert.deepEqual(outcomes.map((outcome) => outcome.status), [
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  assert.equal(peer.state, "STOPPED");
  assert.equal(peer.server, undefined);
  assert.equal(peer.endpoint, undefined);
  assert.equal(peer.boundPort, undefined);
  assert.equal(peer.rawSockets.size, 0);
  await assertPortReleased(port);
});

test("same-tick start, stop, start from STOPPED ends with one listener", async (t) => {
  const port = await unusedLoopbackPort();
  const peer = createMoneyHandPeer({
    host: "127.0.0.1",
    port,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 1_000,
  });
  t.after(() => peer.stop({ graceMs: 0 }));

  const outcomes = await Promise.allSettled([
    peer.start(),
    peer.stop({ graceMs: 0 }),
    peer.start(),
  ]);

  assert.deepEqual(outcomes.map((outcome) => outcome.status), [
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
  assert.equal(peer.state, "RUNNING");
  assert.equal(peer.server?.listening, true);
  assert.equal(peer.server.address().port, port);
  assert.equal(peer.boundPort, port);

  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port,
    path: peer.path,
  });
  assert.equal(opened.response.status, 101);
  opened.client.destroy();
  await waitFor(() => peer.rawSockets.size === 0);
});

test("an invalid close code does not strand a live session in closing state", async (t) => {
  const peer = await startPeer(t);
  const { client, session } = await readyExtension(peer, t, extensionHello({
    profile: "close-validation",
    instanceId: "instance_close_valid",
    bootId: "boot_close_valid",
  }));

  for (const code of [1005, 1000.5, "1000"]) {
    assert.throws(
      () => session.close(code, "invalid"),
      (error) => error?.code === "INVALID_CLOSE",
    );
    assert.equal(session.closing, false);
    assert.equal(session.closed, false);
    assert.deepEqual(peer.sessions(), [session]);
  }

  const terminal = session.request({
    method: "system.status",
    params: {},
  });
  const request = await client.nextJson();
  client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ok: true,
    result: { usable: true },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await terminal).result, { usable: true });

  session.close(1000, "done");
  const close = await client.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1000);
  await client.waitForSocketClose();
  await waitFor(() => session.closed && peer.rawSockets.size === 0);
  await peer.stop({ graceMs: 0 });
  assert.equal(peer.state, "STOPPED");
});

test("a pre-aborted unknown-outcome confirmation has no close or ACK side effects", async (t) => {
  const peer = await startPeer(t);
  const { client, session } = await readyExtension(peer, t, extensionHello({
    profile: "abort-confirm",
    instanceId: "instance_abort_confirm",
    bootId: "boot_abort_confirm",
    unknownOutcomeIds: ["aborted-outcome"],
  }));
  const pendingBefore = [...peer.pendingAcks].map(([key, ids]) => [key, [...ids]]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    session.confirmUnknownOutcomes(
      ["aborted-outcome"],
      { signal: controller.signal },
    ),
    (error) => error?.code === "ABORTED",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.closed, false);
  assert.equal(session.closing, false);
  assert.equal(session.websocket.readyState, 1);
  assert.equal(client.closed, false);
  assert.equal(client.frames.length, 0);
  assert.deepEqual(peer.sessions(), [session]);
  assert.deepEqual(
    [...peer.pendingAcks].map(([key, ids]) => [key, [...ids]]),
    pendingBefore,
  );
  assert.equal(peer.waiters.size, 0);

  const terminal = session.request({
    method: "system.status",
    params: {},
  });
  const request = await client.nextJson();
  client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ok: true,
    result: { open: true },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await terminal).result, { open: true });
});

test("unknown outcome ACKs remain pending until pong confirms the replacement session", async (t) => {
  const peer = await startPeer(t);
  const hello = extensionHello({
    profile: "recover",
    instanceId: "instance_recover",
    bootId: "boot_recover_1",
    unknownOutcomeIds: ["unknown-1", "unknown-2"],
  });
  const first = await readyExtension(peer, t, hello);
  assert.deepEqual(first.ready.ackUnknownOutcomeIds, []);

  const replacementPromise = first.session.confirmUnknownOutcomes(
    ["unknown-1"],
    { timeoutMs: 2_000 },
  );
  const close = await first.client.nextFrame();
  assert.equal(close.opcode, OPCODE.CLOSE);
  assert.equal(closeDetails(close).code, 1012);
  await first.client.waitForSocketClose();
  await waitFor(() => peer.sessions().length === 0);

  const secondClient = await connectExtension(peer, t);
  secondClient.sendJson(hello);
  const ready = await secondClient.nextJson();
  const ping = await secondClient.nextJson();
  assert.equal(ping.type, "ping");
  assert.equal(typeof ping.timestamp, "string");
  assert.notEqual(ping.timestamp, "");
  assert.equal(peer.sessions().length, 0);
  assert.deepEqual(
    [...peer.pendingAcks.values()].map((ids) => [...ids]),
    [["unknown-1"]],
  );
  secondClient.sendJson({
    v: 2,
    type: "pong",
    timestamp: ping.timestamp,
  });
  const replacement = await replacementPromise;
  assert.deepEqual(ready.ackUnknownOutcomeIds, ["unknown-1"]);
  assert.equal(peer.pendingAcks.size, 0);
  assert.ok(replacement.serial > first.session.serial);
  assert.equal(replacement.identity.profile, "recover");
});

test("a timed-out unknown-outcome confirmation cannot ACK a later reconnect", async (t) => {
  const peer = await startPeer(t);
  const hello = extensionHello({
    profile: "ack-timeout",
    instanceId: "instance_ack_timeout",
    bootId: "boot_ack_timeout",
    unknownOutcomeIds: ["unknown-timeout"],
  });
  const first = await readyExtension(peer, t, hello);
  const confirmation = first.session.confirmUnknownOutcomes(
    ["unknown-timeout"],
    { timeoutMs: 30 },
  );
  await first.client.nextFrame();
  await assert.rejects(confirmation, (error) => error?.code === "TIMEOUT");
  assert.equal(peer.pendingAcks.size, 0);

  const late = await connectExtension(peer, t);
  late.sendJson(hello);
  const ready = await late.nextJson();
  assert.deepEqual(ready.ackUnknownOutcomeIds, []);
});

test("repeated reconnects release transport and identity state without reusing request ids", async (t) => {
  const peer = await startPeer(t);
  const requestIds = new Set();

  for (let cycle = 0; cycle < 40; cycle += 1) {
    const connected = await readyExtension(peer, t, extensionHello({
      profile: "churn-profile",
      instanceId: "instance_churn_profile",
      bootId: `boot_churn_${String(cycle).padStart(4, "0")}`,
    }));
    const terminal = connected.session.request({
      method: "system.status",
      params: {},
    });
    const request = await connected.client.nextJson();
    assert.equal(requestIds.has(request.id), false);
    requestIds.add(request.id);
    connected.client.sendJson({
      v: 2,
      type: "response",
      id: request.id,
      ok: true,
      result: { cycle },
      meta: { durationMs: 0 },
    });
    assert.equal((await terminal).result.cycle, cycle);
    connected.client.destroy();
    await waitFor(() => (
      peer.sessions().length === 0
      && peer.connections.size === 0
      && peer.identities.size === 0
      && peer.rawSockets.size === 0
    ));
  }

  assert.equal(requestIds.size, 40);
  assert.equal(peer.state, "RUNNING");
});
