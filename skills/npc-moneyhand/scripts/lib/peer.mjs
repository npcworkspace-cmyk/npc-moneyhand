import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  MAX_MESSAGE_BYTES,
  MAX_FOCUS_FUTURE_MS,
  MAX_UNKNOWN_OUTCOME_IDS,
  PRODUCT,
  PROTOCOL,
  PROTOCOL_VERSION,
  pairingTokenIsValid,
  profileIsValid,
} from "./protocol.mjs";
import { upgradeWebSocket } from "./websocket.mjs";

const MAX_EXTENSION_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const RECENT_REQUEST_IDS = 4_096;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const METHOD_PATTERN = /^[a-z][a-z0-9_.-]{1,80}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{16,256}$/u;
const HEX_PROOF_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SESSION_SELECTOR_KEYS = new Set(["profile", "instanceId", "bootId"]);

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandPeerError("INVALID_MESSAGE", `${label} must be an object`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MoneyHandPeerError(
      "INVALID_OPTION",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function validateIdentityPart(value, label) {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw new MoneyHandPeerError(
      "INVALID_HELLO",
      `${label} must use 8-256 letters, numbers, '.', '_', ':' or '-'`,
    );
  }
  return value;
}

function validateRequestId(value, label = "request.id") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new MoneyHandPeerError(
      "INVALID_ID",
      `${label} must use 1-128 letters, numbers, '.', '_', ':' or '-'`,
    );
  }
  return value;
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

function hmacHex(secret, payload) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function secureHexEqual(actual, expected) {
  if (!HEX_PROOF_PATTERN.test(actual) || !HEX_PROOF_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function nowIso() {
  return new Date().toISOString();
}

function ackKey(identity) {
  return `${identity.profile}\n${identity.instanceId}\n${identity.bootId}`;
}

function extensionOriginIsAllowed(origin) {
  return typeof origin === "string"
    && /^chrome-extension:\/\/[a-p]{32}\/?$/u.test(origin);
}

function loopbackAuthorityIsAllowed(authority, port) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/iu.exec(authority ?? "");
  return Boolean(match && Number(match[2] ?? 80) === port);
}

function focusTimestampIsReasonable(value, now = Date.now()) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= now + MAX_FOCUS_FUTURE_MS;
}

function selectorMatches(session, selector, afterSerial = 0) {
  if (session.serial <= afterSerial) return false;
  if (selector.profile !== undefined && session.identity.profile !== selector.profile) return false;
  if (selector.instanceId !== undefined && session.identity.instanceId !== selector.instanceId) return false;
  if (selector.bootId !== undefined && session.identity.bootId !== selector.bootId) return false;
  return true;
}

function normalizedFocus(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    windowId: Number.isInteger(input.windowId) ? input.windowId : -1,
    focused: input.focused === true,
    lastFocusedAt: focusTimestampIsReasonable(input.lastFocusedAt)
      ? input.lastFocusedAt
      : 0,
  });
}

function safeCallback(callback, ...args) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(...args);
    if (result && typeof result.then === "function") {
      result.catch(() => {});
    }
  } catch {
    // Agent callbacks must not break transport state.
  }
}

function emitSafely(emitter, event, ...args) {
  for (const listener of emitter.rawListeners(event)) {
    safeCallback(listener.bind(emitter), ...args);
  }
}

export class MoneyHandPeerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MoneyHandPeerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class MoneyHandUnknownOutcomeError extends MoneyHandPeerError {
  constructor(id, message = "Request outcome is unknown; do not retry blindly") {
    super("OUTCOME_UNKNOWN", message, { id });
    this.name = "MoneyHandUnknownOutcomeError";
    this.id = id;
  }
}

export class MoneyHandSession extends EventEmitter {
  constructor(peer, websocket, hello, serial) {
    super();
    this.peer = peer;
    this.websocket = websocket;
    this.serial = serial;
    this.identity = Object.freeze({
      profile: hello.profile,
      instanceId: hello.instanceId,
      bootId: hello.bootId,
      version: hello.version,
      browser: hello.browser,
      capabilities: hello.capabilities,
      focus: hello.focus,
    });
    this.focus = { ...hello.focus };
    this.unknownOutcomeIds = Object.freeze([...hello.unknownOutcomeIds]);
    this.pending = new Map();
    this.usedIds = new Map();
    this.localUnknownOutcomeIds = new Set();
    this.requestSequence = 0;
    this.requestPrefix = randomUUID().replaceAll("-", "").slice(0, 20);
    this.closed = false;
    this.closing = false;
  }

  request(request, options = {}) {
    if (this.closed || this.closing
      || this.peer.state !== "RUNNING"
      || !this.peer.acceptingRequests) {
      return Promise.reject(new MoneyHandPeerError("NOT_CONNECTED", "Extension session is closed"));
    }
    const input = asObject(request, "request");
    const id = input.id === undefined ? this.#nextId() : validateRequestId(input.id);
    if (this.usedIds.has(id)
      || this.pending.has(id)
      || this.localUnknownOutcomeIds.has(id)) {
      return Promise.reject(new MoneyHandPeerError("ID_CONFLICT", `request.id '${id}' was already used`));
    }
    if (typeof input.method !== "string" || !METHOD_PATTERN.test(input.method)) {
      return Promise.reject(new MoneyHandPeerError("INVALID_METHOD", "request.method is invalid"));
    }
    const params = input.params === undefined ? {} : asObject(input.params, "request.params");
    const behavior = input.behavior === undefined
      ? undefined
      : asObject(input.behavior, "request.behavior");
    const timeoutMs = boundedInteger(
      options.timeoutMs,
      0,
      86_400_000,
      this.peer.requestTimeoutMs,
      "request timeoutMs",
    );
    if (options.signal?.aborted) {
      return Promise.reject(new MoneyHandPeerError("ABORTED_NOT_STARTED", "Request was aborted before send"));
    }
    if (this.pending.size >= this.peer.maxInflight) {
      return Promise.reject(new MoneyHandPeerError("BUSY", "Agent maxInflight limit reached"));
    }

    const message = {
      v: PROTOCOL_VERSION,
      type: "request",
      id,
      method: input.method,
      params,
      ...(behavior === undefined ? {} : { behavior }),
    };

    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: undefined,
        abort: undefined,
        signal: options.signal,
      };
      this.pending.set(id, pending);
      this.#rememberId(id);
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.#deletePending(id, pending)) return;
          if (pending.abort) pending.signal.removeEventListener("abort", pending.abort);
          this.localUnknownOutcomeIds.add(id);
          this.#pruneUsedIds();
          reject(new MoneyHandUnknownOutcomeError(id, "Request timed out after it was sent"));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      if (options.signal) {
        pending.abort = () => {
          if (!this.#deletePending(id, pending)) return;
          if (pending.timer) clearTimeout(pending.timer);
          this.localUnknownOutcomeIds.add(id);
          this.#pruneUsedIds();
          reject(new MoneyHandUnknownOutcomeError(id, "Request was aborted after it was sent"));
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      try {
        this.peer.sendJson(this.websocket, message);
      } catch (error) {
        if (!this.#deletePending(id, pending)) return;
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.abort) options.signal.removeEventListener("abort", pending.abort);
        this.usedIds.delete(id);
        this.localUnknownOutcomeIds.delete(id);
        reject(error);
      }
    });
  }

  async confirmUnknownOutcomes(ids, options = {}) {
    if (this.closed || this.closing
      || this.peer.state !== "RUNNING"
      || !this.peer.acceptingRequests
      || !this.peer.sessions().includes(this)) {
      throw new MoneyHandPeerError(
        "STALE_SESSION",
        "Unknown outcomes must be confirmed on the current live Extension session",
      );
    }
    if (options.signal?.aborted) {
      throw new MoneyHandPeerError("ABORTED", "Unknown outcome confirmation was aborted");
    }
    const values = [...new Set(ids)];
    for (const id of values) {
      validateRequestId(id, "unknown outcome id");
      if (!this.unknownOutcomeIds.includes(id)) {
        throw new MoneyHandPeerError(
          "INVALID_ACK",
          `Unknown outcome '${id}' was not reported by this Extension session`,
        );
      }
    }
    if (!values.length) return this;
    const replacement = this.peer.waitFor({
      profile: this.identity.profile,
      instanceId: this.identity.instanceId,
      bootId: this.identity.bootId,
    }, {
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
      afterSerial: this.serial,
    });
    this.peer.queueUnknownOutcomeAcks(this.identity, values);
    try {
      this.close(1012, "unknown outcomes acknowledged");
      return await replacement;
    } catch (error) {
      this.peer.cancelUnknownOutcomeAcks(this.identity, values);
      throw error;
    }
  }

  close(code = 1000, reason = "agent closed session") {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      this.websocket.close(code, reason);
    } catch (error) {
      this.closing = false;
      throw new MoneyHandPeerError("INVALID_CLOSE", error.message);
    }
  }

  handleMessage(message, options = {}) {
    if (message.v !== PROTOCOL_VERSION) {
      throw new MoneyHandPeerError("INVALID_MESSAGE", "Extension message has an unsupported version");
    }
    if (message.type === "ping") {
      this.peer.sendJson(this.websocket, {
        v: PROTOCOL_VERSION,
        type: "pong",
        timestamp: typeof message.timestamp === "string" && message.timestamp.length <= 256
          ? message.timestamp
          : nowIso(),
      });
      return;
    }
    if (message.type === "pong") return;
    if (message.type === "event") {
      if (typeof message.event !== "string" || message.event.length < 1 || message.event.length > 256) {
        throw new MoneyHandPeerError("INVALID_MESSAGE", "Extension event name is invalid");
      }
      if (message.event === "window.focused" && options.focusAlreadyApplied !== true) {
        this.peer.updateSessionFocus(this, message);
      }
      emitSafely(this, "event", message);
      safeCallback(this.peer.options.onEvent, this, message);
      emitSafely(this.peer, "event", this, message);
      return;
    }
    if (message.type !== "response") {
      throw new MoneyHandPeerError("INVALID_MESSAGE", `Unexpected Extension message type '${message.type}'`);
    }
    const id = validateRequestId(message.id, "response.id");
    if (typeof message.ok !== "boolean") {
      throw new MoneyHandPeerError("INVALID_MESSAGE", "Extension response.ok must be boolean");
    }
    if (message.ok === false) {
      const error = asObject(message.error, "response.error");
      if (typeof error.code !== "string" || typeof error.message !== "string") {
        throw new MoneyHandPeerError(
          "INVALID_MESSAGE",
          "Extension error response requires string code and message",
        );
      }
    } else if (message.error !== undefined) {
      throw new MoneyHandPeerError("INVALID_MESSAGE", "Successful Extension response cannot contain error");
    }
    const pending = this.pending.get(id);
    if (!pending) {
      const wasUnknown = this.localUnknownOutcomeIds.delete(id);
      if (wasUnknown) this.#pruneUsedIds();
      const event = wasUnknown || this.usedIds.has(id) ? "lateResponse" : "orphanResponse";
      emitSafely(this, event, message);
      emitSafely(this.peer, event, this, message);
      return;
    }
    if (!this.#deletePending(id, pending)) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    this.#pruneUsedIds();
    pending.resolve(message);
  }

  markClosed(details) {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    for (const [id, pending] of this.pending) {
      if (!this.#deletePending(id, pending)) continue;
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      this.localUnknownOutcomeIds.add(id);
      pending.reject(new MoneyHandUnknownOutcomeError(id, "Connection closed before a terminal response"));
    }
    this.#pruneUsedIds();
    emitSafely(this, "close", details);
  }

  #nextId() {
    this.requestSequence += 1;
    return `agent:${this.requestPrefix}:${this.requestSequence}`;
  }

  #rememberId(id) {
    this.usedIds.delete(id);
    this.usedIds.set(id, true);
    this.#pruneUsedIds();
  }

  #deletePending(id, pending) {
    if (this.pending.get(id) !== pending) return false;
    this.pending.delete(id);
    return true;
  }

  #pruneUsedIds() {
    if (this.usedIds.size <= RECENT_REQUEST_IDS) return;
    for (const id of this.usedIds.keys()) {
      if (this.usedIds.size <= RECENT_REQUEST_IDS) break;
      if (this.pending.has(id) || this.localUnknownOutcomeIds.has(id)) continue;
      this.usedIds.delete(id);
    }
  }
}

export class MoneyHandPeer extends EventEmitter {
  constructor(options = {}) {
    super();
    const host = options.host === "[::1]" ? "::1" : (options.host ?? "127.0.0.1");
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new MoneyHandPeerError("INVALID_OPTION", "host must be 127.0.0.1, localhost, or ::1");
    }
    const pairingToken = options.pairingToken ?? "";
    if (!pairingTokenIsValid(pairingToken)) {
      throw new MoneyHandPeerError("INVALID_OPTION", "pairingToken must be empty or 16-512 characters");
    }
    this.options = options;
    this.host = host;
    this.port = boundedInteger(options.port, 0, 65_535, 19_846, "port");
    this.path = options.path ?? "/extension";
    if (typeof this.path !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/u.test(this.path)) {
      throw new MoneyHandPeerError("INVALID_OPTION", "path must be an absolute URL path");
    }
    this.pairingToken = pairingToken;
    this.heartbeatMs = boundedInteger(
      options.heartbeatMs,
      5_000,
      25_000,
      20_000,
      "heartbeatMs",
    );
    this.maxInflight = boundedInteger(options.maxInflight, 1, 256, 64, "maxInflight");
    this.handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs,
      250,
      4_500,
      4_000,
      "handshakeTimeoutMs",
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      0,
      86_400_000,
      30_000,
      "requestTimeoutMs",
    );
    this.state = "STOPPED";
    this.requestedState = "STOPPED";
    this.acceptingRequests = false;
    this.lifecycleQueue = Promise.resolve();
    this.server = undefined;
    this.rawSockets = new Set();
    this.connections = new Set();
    this.identities = new Map();
    this.sessionSerial = 0;
    this.waiters = new Set();
    this.pendingAcks = new Map();
    this.boundPort = undefined;
    this.activeSessionRef = undefined;
    this.extensionOrigin = undefined;
  }

  get endpoint() {
    if (this.state !== "RUNNING" || this.boundPort === undefined) return undefined;
    const host = this.host === "::1" ? "[::1]" : this.host;
    return `ws://${host}:${this.boundPort}${this.path}`;
  }

  async start() {
    this.requestedState = "RUNNING";
    return await this.#enqueueLifecycle(async () => {
      if (this.state === "RUNNING") {
        this.acceptingRequests = this.requestedState === "RUNNING";
        return this.endpoint;
      }
      this.state = "STARTING";
      this.acceptingRequests = false;
      try {
        const endpoint = await this.#startServer();
        this.acceptingRequests = this.requestedState === "RUNNING";
        return endpoint;
      } catch (error) {
        this.acceptingRequests = false;
        throw error;
      }
    });
  }

  async stop(options = {}) {
    const input = asObject(options, "stop options");
    const graceMs = boundedInteger(input.graceMs, 0, 5_000, 250, "graceMs");
    this.requestedState = "STOPPED";
    this.acceptingRequests = false;
    return await this.#enqueueLifecycle(async () => {
      if (this.state === "STOPPED") return;
      this.state = "STOPPING";
      try {
        await this.#stopServer(graceMs);
      } finally {
        this.acceptingRequests = false;
        this.state = "STOPPED";
        this.boundPort = undefined;
      }
    });
  }

  sessions() {
    return [...this.connections]
      .map((connection) => connection.session)
      .filter((session) => session && !session.closed && !session.closing);
  }

  activeSession() {
    if (this.activeSessionRef && this.sessions().includes(this.activeSessionRef)) {
      return this.activeSessionRef;
    }
    return this.refreshActiveSession();
  }

  refreshActiveSession() {
    const previous = this.activeSessionRef;
    const sessions = this.sessions();
    const next = sessions.sort((left, right) => (
      Number(right.focus.focused) - Number(left.focus.focused)
      || right.focus.lastFocusedAt - left.focus.lastFocusedAt
      || right.serial - left.serial
    ))[0];
    this.activeSessionRef = next;
    if (next !== previous) {
      safeCallback(this.options.onActiveSession, next, previous);
      emitSafely(this, "activeSession", next, previous);
    }
    return next;
  }

  updateSessionFocus(session, message) {
    if (!this.#applySessionFocus(session, message)) return;
    this.refreshActiveSession();
  }

  #applySessionFocus(session, message) {
    if (!this.sessions().includes(session)) return;
    const data = message?.data && typeof message.data === "object" ? message.data : {};
    if (data.focused === true) {
      const lastFocusedAt = focusTimestampIsReasonable(data.lastFocusedAt)
        ? data.lastFocusedAt
        : Math.max(Date.now(), session.focus.lastFocusedAt);
      const newestKnownFocus = this.sessions().reduce(
        (latest, candidate) => Math.max(latest, candidate.focus.lastFocusedAt),
        0,
      );
      if (lastFocusedAt < newestKnownFocus) return false;
      for (const other of this.sessions()) {
        if (other !== session) other.focus.focused = false;
      }
      session.focus.focused = true;
      session.focus.windowId = Number.isInteger(message?.target?.windowId)
        ? message.target.windowId
        : session.focus.windowId;
      session.focus.lastFocusedAt = Math.max(session.focus.lastFocusedAt, lastFocusedAt);
    } else if (data.focused === false) {
      session.focus.focused = false;
    }
    return true;
  }

  request(request, options = {}) {
    const session = this.activeSession();
    if (!session) {
      return Promise.reject(new MoneyHandPeerError("NOT_CONNECTED", "No Extension session is connected"));
    }
    return session.request(request, options);
  }

  waitFor(selector = {}, options = {}) {
    const input = asObject(selector, "selector");
    const unsupportedKeys = Reflect.ownKeys(input)
      .filter((key) => typeof key !== "string" || !SESSION_SELECTOR_KEYS.has(key));
    if (unsupportedKeys.length) {
      const names = unsupportedKeys.map((key) => String(key)).join(", ");
      return Promise.reject(new MoneyHandPeerError(
        "INVALID_SELECTOR",
        `selector supports only profile, instanceId and bootId; unsupported key(s): ${names}`,
      ));
    }
    const target = { ...input };
    if (target.profile !== undefined && !profileIsValid(target.profile)) {
      return Promise.reject(new MoneyHandPeerError("INVALID_SELECTOR", "selector.profile is invalid"));
    }
    try {
      if (target.instanceId !== undefined) {
        validateIdentityPart(target.instanceId, "selector.instanceId");
      }
      if (target.bootId !== undefined) validateIdentityPart(target.bootId, "selector.bootId");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.state !== "RUNNING" || !this.acceptingRequests) {
      return Promise.reject(new MoneyHandPeerError("NOT_RUNNING", "MoneyHandPeer is not running"));
    }
    const afterSerial = options.afterSerial ?? 0;
    const anySession = target.profile === undefined
      && target.instanceId === undefined
      && target.bootId === undefined;
    const existing = anySession
      ? this.activeSession()
      : this.sessions().find((session) => selectorMatches(session, target, afterSerial));
    if (existing && selectorMatches(existing, target, afterSerial)) return Promise.resolve(existing);
    const timeoutMs = boundedInteger(
      options.timeoutMs,
      0,
      86_400_000,
      60_000,
      "waitFor timeoutMs",
    );
    if (options.signal?.aborted) {
      return Promise.reject(new MoneyHandPeerError("ABORTED", "waitFor was aborted"));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        selector: target,
        afterSerial,
        resolve,
        reject,
        timer: undefined,
        abort: undefined,
        signal: options.signal,
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (!this.waiters.delete(waiter)) return;
          if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
          reject(new MoneyHandPeerError("TIMEOUT", "Timed out waiting for Extension session"));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      if (options.signal) {
        waiter.abort = () => {
          if (!this.waiters.delete(waiter)) return;
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(new MoneyHandPeerError("ABORTED", "waitFor was aborted"));
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  sendJson(websocket, message) {
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data, "utf8") > MAX_MESSAGE_BYTES) {
      throw new MoneyHandPeerError("MESSAGE_TOO_LARGE", "Agent message exceeds the 1 MiB limit");
    }
    websocket.sendText(data);
  }

  queueUnknownOutcomeAcks(identity, ids) {
    const key = ackKey(identity);
    const pending = this.pendingAcks.get(key) ?? new Set();
    for (const id of ids) pending.add(id);
    this.pendingAcks.set(key, pending);
  }

  cancelUnknownOutcomeAcks(identity, ids) {
    const key = ackKey(identity);
    const pending = this.pendingAcks.get(key);
    for (const id of ids) pending?.delete(id);
    if (!pending?.size) this.pendingAcks.delete(key);
    for (const connection of this.connections) {
      if (connection.ackKey === key && connection.state === "READY_CONFIRMING"
        && connection.ackIds.some((id) => ids.includes(id))) {
        connection.websocket.close(1012, "unknown outcome confirmation cancelled");
      }
    }
  }

  #enqueueLifecycle(operation) {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #startServer() {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, (_request, response) => {
      response.writeHead(404, {
        "content-length": "0",
        connection: "close",
      });
      response.end();
    });
    this.server = server;
    server.on("error", (error) => safeCallback(this.options.onServerError, error));
    server.on("connection", (socket) => {
      this.rawSockets.add(socket);
      socket.once("close", () => this.rawSockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    server.on("upgrade", (request, socket, head) => {
      if (this.state !== "RUNNING" || !this.acceptingRequests) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      const websocket = upgradeWebSocket(request, socket, head, {
        path: this.path,
        maxMessageBytes: MAX_EXTENSION_MESSAGE_BYTES,
        maxBufferedBytes: MAX_BUFFERED_BYTES,
        originAllowed: this.options.allowNonExtensionOrigin
          ? undefined
          : extensionOriginIsAllowed,
        hostAllowed: (authority) => loopbackAuthorityIsAllowed(authority, this.boundPort),
      });
      if (websocket) this.#acceptConnection(websocket, request.headers.origin);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.host, port: this.port, exclusive: true });
    }).catch((error) => {
      this.state = "STOPPED";
      this.server = undefined;
      throw new MoneyHandPeerError("LISTEN_FAILED", error.message, { code: error.code });
    });

    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.port;
    this.state = "RUNNING";
    return this.endpoint;
  }

  async #stopServer(graceMs) {
    const server = this.server;
    this.server = undefined;
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new MoneyHandPeerError("STOPPED", "MoneyHandPeer stopped"));
    }
    this.waiters.clear();
    for (const connection of this.connections) {
      connection.websocket.close(1001, "agent stopped");
    }
    if (!server) return;

    const closed = new Promise((resolve) => server.close(resolve));
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      for (const socket of this.rawSockets) socket.destroy();
    }, graceMs);
    await closed;
    clearTimeout(forceTimer);
    for (const socket of this.rawSockets) socket.destroy();
    this.rawSockets.clear();
    this.connections.clear();
    this.identities.clear();
    this.pendingAcks.clear();
  }

  #acceptConnection(websocket, origin) {
    const connection = {
      websocket,
      state: "HELLO",
      hello: undefined,
      session: undefined,
      serverNonce: undefined,
      timer: undefined,
      lastSeenAt: Date.now(),
      heartbeatTimer: undefined,
      identityKeys: [],
      pairingToken: "",
      confirmationToken: "",
      ackKey: "",
      ackIds: [],
      bufferedMessages: [],
      bufferedMessageBytes: 0,
      origin,
    };
    this.connections.add(connection);
    connection.timer = setTimeout(() => {
      websocket.close(1002, "handshake timeout");
    }, this.handshakeTimeoutMs);
    connection.timer.unref?.();

    websocket.on("message", (data) => {
      connection.lastSeenAt = Date.now();
      try {
        const message = asObject(JSON.parse(data), "message");
        if (connection.state === "READY") {
          connection.session.handleMessage(message);
        } else {
          this.#handleHandshakeMessage(connection, message);
        }
      } catch (error) {
        safeCallback(this.options.onProtocolError, error);
        websocket.close(1002, "invalid protocol message");
      }
    });
    websocket.on("protocolError", (details) => {
      safeCallback(this.options.onProtocolError, new MoneyHandPeerError(
        "WEBSOCKET_PROTOCOL_ERROR",
        details.reason,
        details,
      ));
    });
    websocket.on("close", (details) => this.#removeConnection(connection, details));
  }

  #handleHandshakeMessage(connection, message) {
    if (connection.state === "HELLO") {
      const hello = this.#validateHello(message);
      if (this.options.acceptHello) {
        const accepted = this.options.acceptHello(hello);
        if (accepted && typeof accepted.then === "function") {
          accepted.catch(() => {});
          throw new MoneyHandPeerError("INVALID_OPTION", "acceptHello must be synchronous");
        }
        if (accepted === false) {
          connection.websocket.close(1008, "Extension identity rejected");
          return;
        }
      }
      connection.hello = hello;

      const token = this.#pairingTokenFor(hello);
      connection.pairingToken = token;
      if (token) {
        if (hello.auth.mode !== "hmac-sha256") {
          connection.websocket.close(1008, "pairing is required");
          return;
        }
        connection.serverNonce = `nonce_${randomBytes(20).toString("hex")}`;
        const proof = hmacHex(
          token,
          authenticationPayload("server", hello, connection.serverNonce),
        );
        this.sendJson(connection.websocket, {
          v: PROTOCOL_VERSION,
          type: "challenge",
          protocol: PROTOCOL,
          nonce: connection.serverNonce,
          proof,
        });
        connection.state = "AUTHENTICATE";
        return;
      }
      if (hello.auth.mode !== "none") {
        connection.websocket.close(1008, "Agent has no matching pairing token");
        return;
      }
      this.#makeReady(connection);
      return;
    }

    if (connection.state === "AUTHENTICATE") {
      if (message.v !== PROTOCOL_VERSION
        || message.type !== "authenticate"
        || message.protocol !== PROTOCOL
        || message.nonce !== connection.serverNonce
        || typeof message.proof !== "string") {
        connection.websocket.close(1002, "invalid authenticate message");
        return;
      }
      const token = connection.pairingToken;
      const expected = hmacHex(
        token,
        authenticationPayload("client", connection.hello, connection.serverNonce),
      );
      if (!secureHexEqual(message.proof, expected)) {
        connection.websocket.close(1008, "authentication failed");
        return;
      }
      this.#makeReady(connection);
      return;
    }

    if (connection.state === "READY_CONFIRMING") {
      if (message.v === PROTOCOL_VERSION
        && message.type === "pong"
        && message.timestamp === connection.confirmationToken) {
        this.#activateSession(connection);
        return;
      }
      if (message.v === PROTOCOL_VERSION && message.type === "ping") {
        this.sendJson(connection.websocket, {
          v: PROTOCOL_VERSION,
          type: "pong",
          timestamp: typeof message.timestamp === "string" ? message.timestamp : nowIso(),
        });
        return;
      }
      if (message.v === PROTOCOL_VERSION && message.type === "event") {
        const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        if (connection.bufferedMessages.length >= 16
          || connection.bufferedMessageBytes + bytes > MAX_MESSAGE_BYTES) {
          connection.websocket.close(1013, "pre-ready event backpressure");
          return;
        }
        connection.bufferedMessages.push(message);
        connection.bufferedMessageBytes += bytes;
        return;
      }
      connection.websocket.close(1002, "ready confirmation required");
      return;
    }

    connection.websocket.close(1002, "unexpected handshake state");
  }

  #validateHello(message) {
    if (message.v !== PROTOCOL_VERSION
      || message.type !== "hello"
      || message.protocol !== PROTOCOL
      || message.product !== PRODUCT) {
      throw new MoneyHandPeerError("INVALID_HELLO", "Unsupported Extension hello");
    }
    if (!profileIsValid(message.profile)) {
      throw new MoneyHandPeerError("INVALID_HELLO", "hello.profile is invalid");
    }
    const instanceId = validateIdentityPart(message.instanceId, "hello.instanceId");
    const bootId = validateIdentityPart(message.bootId, "hello.bootId");
    const auth = asObject(message.auth, "hello.auth");
    if (!["none", "hmac-sha256"].includes(auth.mode)) {
      throw new MoneyHandPeerError("INVALID_HELLO", "hello.auth.mode is invalid");
    }
    if (auth.mode === "hmac-sha256"
      && (typeof auth.clientNonce !== "string" || !NONCE_PATTERN.test(auth.clientNonce))) {
      throw new MoneyHandPeerError("INVALID_HELLO", "hello.auth.clientNonce is invalid");
    }
    const unknownOutcomeIds = Array.isArray(message.unknownOutcomeIds)
      ? [...new Set(message.unknownOutcomeIds.map((id) => validateRequestId(id, "unknown outcome id")))]
      : [];
    if (unknownOutcomeIds.length > MAX_UNKNOWN_OUTCOME_IDS) {
      throw new MoneyHandPeerError("INVALID_HELLO", "Too many unknown outcome IDs");
    }
    return Object.freeze({
      ...message,
      instanceId,
      bootId,
      auth: Object.freeze({ ...auth }),
      unknownOutcomeIds: Object.freeze(unknownOutcomeIds),
      focus: normalizedFocus(message.focus),
      browser: message.browser && typeof message.browser === "object" ? message.browser : {},
      capabilities: message.capabilities && typeof message.capabilities === "object"
        ? message.capabilities
        : {},
    });
  }

  #pairingTokenFor(hello) {
    const token = this.options.getPairingToken
      ? this.options.getPairingToken(hello)
      : this.pairingToken;
    if (token && typeof token.then === "function") {
      token.catch(() => {});
      throw new MoneyHandPeerError("INVALID_OPTION", "getPairingToken must be synchronous");
    }
    if (!pairingTokenIsValid(token ?? "")) {
      throw new MoneyHandPeerError("INVALID_OPTION", "Resolved pairing token is invalid");
    }
    return token ?? "";
  }

  #makeReady(connection) {
    if (!this.#reserveIdentity(connection)) return;
    const hello = connection.hello;
    const key = ackKey(hello);
    const queued = this.pendingAcks.get(key) ?? new Set();
    for (const id of [...queued]) {
      if (!hello.unknownOutcomeIds.includes(id)) queued.delete(id);
    }
    if (!queued.size) this.pendingAcks.delete(key);
    const ackUnknownOutcomeIds = hello.unknownOutcomeIds.filter((id) => queued.has(id));
    this.sendJson(connection.websocket, {
      v: PROTOCOL_VERSION,
      type: "ready",
      protocol: PROTOCOL,
      heartbeatMs: this.heartbeatMs,
      maxInflight: this.maxInflight,
      ackUnknownOutcomeIds,
    });
    connection.ackKey = key;
    connection.ackIds = ackUnknownOutcomeIds;
    connection.confirmationToken = `confirm_${randomUUID().replaceAll("-", "")}`;
    connection.state = "READY_CONFIRMING";
    this.sendJson(connection.websocket, {
      v: PROTOCOL_VERSION,
      type: "ping",
      timestamp: connection.confirmationToken,
    });
  }

  #reserveIdentity(connection) {
    const hello = connection.hello;
    if (!this.options.allowNonExtensionOrigin
      && this.options.allowMultipleExtensionOrigins !== true
      && this.extensionOrigin
      && connection.origin !== this.extensionOrigin) {
      connection.websocket.close(1008, "Extension origin conflict");
      return false;
    }
    const profileKey = `profile:${hello.profile}`;
    const instanceKey = `instance:${hello.instanceId}`;
    const keys = [profileKey, instanceKey];
    if (keys.some((key) => {
      const owner = this.identities.get(key);
      return owner && owner !== connection;
    })) {
      connection.websocket.close(1008, "Extension identity conflict");
      return false;
    }
    for (const key of keys) this.identities.set(key, connection);
    connection.identityKeys = keys;
    return true;
  }

  #activateSession(connection) {
    if (!this.options.allowNonExtensionOrigin
      && this.options.allowMultipleExtensionOrigins !== true) {
      if (this.extensionOrigin && connection.origin !== this.extensionOrigin) {
        connection.websocket.close(1008, "Extension origin conflict");
        return;
      }
      this.extensionOrigin ??= connection.origin;
    }
    const hello = connection.hello;
    if (connection.ackIds.length) {
      const pending = this.pendingAcks.get(connection.ackKey);
      for (const id of connection.ackIds) pending?.delete(id);
      if (!pending?.size) this.pendingAcks.delete(connection.ackKey);
    }
    if (connection.timer) clearTimeout(connection.timer);
    connection.state = "READY";
    const session = new MoneyHandSession(
      this,
      connection.websocket,
      hello,
      ++this.sessionSerial,
    );
    connection.session = session;
    if (session.focus.focused) {
      const initialFocus = { ...session.focus };
      session.focus.focused = false;
      this.#applySessionFocus(session, {
        target: { windowId: initialFocus.windowId },
        data: {
          focused: true,
          lastFocusedAt: initialFocus.lastFocusedAt,
        },
      });
    }

    const bufferedMessages = connection.bufferedMessages;
    connection.bufferedMessages = [];
    connection.bufferedMessageBytes = 0;
    for (const message of bufferedMessages) {
      if (message.type === "event" && message.event === "window.focused") {
        this.#applySessionFocus(session, message);
      }
    }
    this.refreshActiveSession();
    connection.lastSeenAt = Date.now();
    connection.heartbeatTimer = setInterval(() => {
      if (Date.now() - connection.lastSeenAt >= this.heartbeatMs * 2) {
        connection.websocket.close(4000, "heartbeat timeout");
        return;
      }
      try {
        this.sendJson(connection.websocket, {
          v: PROTOCOL_VERSION,
          type: "ping",
          timestamp: nowIso(),
        });
      } catch {
        connection.websocket.close(1013, "heartbeat backpressure");
      }
    }, this.heartbeatMs);
    connection.heartbeatTimer.unref?.();

    safeCallback(this.options.onSession, session);
    if (hello.unknownOutcomeIds.length) {
      safeCallback(this.options.onUnknownOutcomes, session, [...hello.unknownOutcomeIds]);
    }
    emitSafely(this, "session", session);
    for (const waiter of [...this.waiters]) {
      const anySession = waiter.selector.profile === undefined
        && waiter.selector.instanceId === undefined
        && waiter.selector.bootId === undefined;
      const selected = anySession ? this.activeSession() : session;
      if (!selected || !selectorMatches(selected, waiter.selector, waiter.afterSerial)) continue;
      this.waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(selected);
    }
    if (bufferedMessages.length) {
      queueMicrotask(() => {
        if (session.closed) return;
        for (const message of bufferedMessages) {
          session.handleMessage(message, {
            focusAlreadyApplied: message.type === "event"
              && message.event === "window.focused",
          });
        }
      });
    }
  }

  #removeConnection(connection, details) {
    if (!this.connections.delete(connection)) return;
    if (connection.timer) clearTimeout(connection.timer);
    if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
    for (const key of connection.identityKeys) {
      if (this.identities.get(key) === connection) this.identities.delete(key);
    }
    connection.session?.markClosed(details);
    if (connection.session) emitSafely(this, "sessionClose", connection.session, details);
    this.refreshActiveSession();
  }
}

export function createMoneyHandPeer(options) {
  return new MoneyHandPeer(options);
}

export const __test__ = {
  authenticationPayload,
  hmacHex,
  secureHexEqual,
};
