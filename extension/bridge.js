import { MoneyHandExecutor } from "./executor.js";
import {
  DEFAULT_ENDPOINT, INPUT_COORDINATE_SPACE, MAX_FOCUS_FUTURE_MS, MAX_MESSAGE_BYTES, MAX_QUEUE_DEPTH,
  MAX_SCREENSHOT_BYTES, MAX_UNKNOWN_OUTCOME_IDS, MoneyHandError, PRODUCT,
  PROTOCOL, PROTOCOL_VERSION, endpointIsAllowed,
  errorMessage, needInstructionMessage, pairingTokenIsValid, parseRequest,
  parseWireMessage, requestIdIsValid, responseMessage,
} from "./protocol.js";

const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED_EVENT_BYTES = 2 * 1024 * 1024, MAX_BUFFERED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TERMINAL_BYTES = 8 * 1024 * 1024, MAX_COMPLETED_CACHE_BYTES = 16 * 1024 * 1024;
const COMPLETED_CACHE_SIZE = 256, DEFAULT_MAX_INFLIGHT = 64, MAX_SCREENSHOT_INFLIGHT = 2;
const RECONNECT_ALARM = "npc-moneyhand-reconnect";
const RECONNECT_ALARM_MIN_MS = 30_000, MAX_RECONNECT_DELAY_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RUNTIME_STATE_KEY = "npcMoneyHandRuntimeV2";
const ICON_PATHS = Object.freeze(Object.fromEntries(
  ["red", "yellow", "green", "blue"].map((color) => [
    color,
    Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/smile-${color}-${size}.png`])),
  ]),
));

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function internalProfile(instanceId) {
  return `npc-${instanceId.replaceAll("-", "").slice(0, 48)}`;
}

function instanceIdIsValid(value) {
  return typeof value === "string"
    && /^[a-f0-9]{32}$/iu.test(value.replaceAll("-", ""));
}

function storedFocusTimestamp(value, now) {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  if (!Number.isSafeInteger(now) || now < 0) return 0;
  return value <= now + MAX_FOCUS_FUTURE_MS ? value : 0;
}

function nextFocusTimestamp(value, now) {
  const previous = storedFocusTimestamp(value, now);
  return Math.max(now, previous ? previous + 1 : 0);
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function requestFingerprint(request) {
  return JSON.stringify({
    method: request.method,
    params: request.params,
    behavior: request.behavior || null,
  });
}

function authenticationPayload(role, context, serverNonce) {
  return [
    PROTOCOL,
    role,
    context.profileAlias,
    context.instanceId,
    context.bootId,
    context.clientNonce,
    serverNonce,
  ].join("\n");
}

async function hmacHex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MoneyHandBridge {
  constructor(options) {
    this.chrome = options.chromeApi; this.WebSocketImpl = options.WebSocketImpl;
    this.executor = options.executor || new MoneyHandExecutor(this.chrome);
    this.random = options.random || Math.random; this.now = options.now || Date.now;
    this.bootId = options.bootId || randomId("boot"); this.bootIdExplicit = Boolean(options.bootId);
    this.socket = undefined; this.epoch = 0; this.lifecycle = 0;
    this.manualDisabled = false; this.state = "DISABLED"; this.lastError = "";
    this.handshakeReady = false; this.reconnectAttempt = 0;
    this.reconnectTimer = undefined; this.heartbeatTimer = undefined;
    this.heartbeatPulseTimer = undefined; this.handshakeTimer = undefined;
    this.connectTimer = undefined; this.connecting = undefined;
    this.alarmQueue = Promise.resolve();
    this.heartbeatMs = HEARTBEAT_MS; this.maxInflight = DEFAULT_MAX_INFLIGHT;
    this.handshakeTimeoutMs = clampInteger(
      options.handshakeTimeoutMs,
      10,
      HANDSHAKE_TIMEOUT_MS,
      HANDSHAKE_TIMEOUT_MS,
    );
    this.eventSeq = 0; this.droppedEvents = 0; this.lastSeenAt = 0;
    this.queues = new Map(); this.inflight = new Map(); this.completed = new Map();
    this.completedBytes = 0; this.unknownOutcomeIds = new Set();
    this.durableStartedIds = new Set(); this.epochBarriers = new Set();
    this.runtimeStateLoaded = false;
    this.runtimeStateQueue = Promise.resolve();
    this.handshakeContext = undefined; this.listenersAttached = false; this.profileAlias = "";
    this.focus = { windowId: -1, focused: false, lastFocusedAt: 0 };
    this.focusGeneration = 0; this.focusQueue = Promise.resolve(); this.iconColor = "";
    this.applyIcon("red");
  }

  applyIcon(color) {
    if (this.iconColor === color) return;
    this.iconColor = color;
    void Promise.resolve(this.chrome.action?.setIcon?.({ path: ICON_PATHS[color] })).catch(() => undefined);
  }

  stateIcon(state = this.state) {
    if (state === "READY") return "green";
    if (state === "CONNECTING" || state === "HANDSHAKE") return "yellow";
    return "red";
  }

  setState(state) {
    this.state = state;
    this.clearTimer("heartbeatPulseTimer");
    this.applyIcon(this.stateIcon(state));
  }

  pulseHeartbeat() {
    if (this.state !== "READY") return;
    this.clearTimer("heartbeatPulseTimer");
    this.applyIcon("blue");
    this.heartbeatPulseTimer = setTimeout(() => {
      this.heartbeatPulseTimer = undefined;
      this.applyIcon(this.stateIcon());
    }, 480);
  }

  attachChromeListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.chrome.debugger.onEvent.addListener((source, method, params) => {
      void this.executor.onDebuggerEvent(source, method, params).then((event) => {
        if (event) this.emitEvent(event, method === "Target.attachedToTarget" || method === "Target.detachedFromTarget");
      }).catch((error) => {
        this.emitEvent({
          event: "debugger.eventError",
          target: { tabId: source?.tabId, sessionId: source?.sessionId },
          data: { method, message: error instanceof Error ? error.message : String(error) },
        }, true);
      });
    });
    this.chrome.debugger.onDetach.addListener((source, reason) => {
      this.emitEvent(this.executor.onDebuggerDetach(source, reason), true);
    });
    this.chrome.tabs.onRemoved.addListener((tabId) => {
      this.emitEvent(this.executor.onTabRemoved(tabId), true);
    });
    this.chrome.tabs.onCreated.addListener((tab) => {
      this.emitEvent({
        event: "tab.created",
        target: { tabId: tab.id, windowId: tab.windowId },
        data: { url: tab.url || "", title: tab.title || "", active: Boolean(tab.active) },
      });
    });
    this.chrome.tabs.onActivated.addListener((info) => {
      this.emitEvent({
        event: "tab.activated",
        target: { tabId: info.tabId, windowId: info.windowId },
        data: {},
      });
    });
    this.chrome.windows?.onFocusChanged?.addListener((windowId) => {
      void this.runFocus((active) => this.recordWindowFocus(windowId, active)).catch(() => undefined);
    });
    this.chrome.alarms?.onAlarm?.addListener((alarm) => {
      if (alarm?.name === RECONNECT_ALARM) {
        const generation = this.lifecycle;
        void this.connect().catch((error) => {
          if (generation !== this.lifecycle) return;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.scheduleReconnect(generation);
        });
      }
    });
  }

  runFocus(operation) {
    const generation = this.focusGeneration;
    const active = () => generation === this.focusGeneration;
    const execute = () => operation(active);
    const pending = this.focusQueue.then(execute, execute);
    this.focusQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  resetFocusQueue() {
    this.focusGeneration += 1;
    this.focusQueue = Promise.resolve();
  }

  async start() {
    this.attachChromeListeners();
    await this.restoreRuntimeState();
    await this.ensureDefaultConnectionSettings();
    return await this.connect();
  }

  async storedSettings() {
    return await this.chrome.storage.local.get({
      enabled: true,
      wsEndpoint: DEFAULT_ENDPOINT,
      authToken: "",
      instanceId: "",
    });
  }

  async ensureDefaultConnectionSettings() {
    const settings = await this.storedSettings();
    const patch = {};
    if (settings.enabled !== true) patch.enabled = true;
    if (settings.wsEndpoint !== DEFAULT_ENDPOINT) patch.wsEndpoint = DEFAULT_ENDPOINT;
    if (settings.profileAlias) patch.profileAlias = "";
    if (Object.keys(patch).length) await this.chrome.storage.local.set(patch);
    return { ...settings, ...patch };
  }

  runtimeStorage() {
    return this.chrome.storage.session ?? this.chrome.storage.local;
  }

  async restoreRuntimeState() {
    if (this.runtimeStateLoaded) return;
    const stored = await this.runtimeStorage().get({ [RUNTIME_STATE_KEY]: {} });
    const state = stored[RUNTIME_STATE_KEY] || {};
    if (!this.bootIdExplicit && typeof state.bootId === "string" && state.bootId.length >= 8) {
      this.bootId = state.bootId;
    }
    for (const id of Array.isArray(state.started) ? state.started : []) {
      if (requestIdIsValid(id)) {
        this.durableStartedIds.add(id);
        this.unknownOutcomeIds.add(id);
      }
    }
    this.executor.restoreWaiting(state.waiting);
    this.runtimeStateLoaded = true;
    await this.persistRuntimeState();
  }

  persistRuntimeState() {
    const state = {
      bootId: this.bootId,
      started: [...this.durableStartedIds].slice(0, MAX_UNKNOWN_OUTCOME_IDS),
      waiting: this.executor.waitingSnapshot(),
    };
    const operation = () => this.runtimeStorage().set({ [RUNTIME_STATE_KEY]: state });
    const pending = this.runtimeStateQueue.then(operation, operation);
    this.runtimeStateQueue = pending.then(() => undefined, () => undefined);
    return pending.catch((error) => {
      throw new MoneyHandError("STATE_PERSIST_FAILED", `Could not persist MV3 runtime state: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async markRequestStarted(id) {
    this.durableStartedIds.add(id);
    try {
      await this.persistRuntimeState();
    } catch (error) {
      this.durableStartedIds.delete(id);
      throw error;
    }
  }

  async clearRequestStarted(ids) {
    for (const id of ids) this.durableStartedIds.delete(id);
    await this.persistRuntimeState();
  }

  async ensureInstanceId() {
    const settings = await this.storedSettings();
    if (instanceIdIsValid(settings.instanceId)) return settings.instanceId;
    const instanceId = crypto.randomUUID();
    await this.chrome.storage.local.set({ instanceId });
    return instanceId;
  }

  async status() {
    const settings = await this.storedSettings();
    const connected = this.state === "READY"
      && this.handshakeReady
      && this.socket?.readyState === this.WebSocketImpl.OPEN;
    return {
      product: PRODUCT,
      enabled: Boolean(settings.enabled),
      profileAlias: this.profileAlias,
      focus: { ...this.focus },
      wsEndpoint: settings.wsEndpoint,
      state: this.state === "READY" && !connected ? "DISCONNECTED" : this.state,
      connected,
      lastError: this.lastError,
      bootId: this.bootId,
      epoch: this.epoch,
      queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.depth, 0),
      inflight: this.inflight.size,
      droppedEvents: this.droppedEvents,
      unknownOutcomeIds: [...this.unknownOutcomeIds],
    };
  }

  async focusSnapshot(active = () => true) {
    const stored = await this.chrome.storage.local.get({
      lastFocusedAt: 0,
      lastFocusedWindowId: -1,
    });
    if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus snapshot belongs to an old connection");
    const window = await this.chrome.windows.getLastFocused().catch(() => undefined);
    if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus snapshot belongs to an old connection");
    const focused = Boolean(window?.focused && Number.isInteger(window.id) && window.id >= 0);
    const observedAt = this.now();
    let lastFocusedAt = storedFocusTimestamp(stored.lastFocusedAt, observedAt);
    let windowId = Number.isInteger(stored.lastFocusedWindowId) ? stored.lastFocusedWindowId : -1;
    if (focused) {
      windowId = window.id;
      lastFocusedAt = nextFocusTimestamp(lastFocusedAt, observedAt);
      await this.chrome.storage.local.set({ lastFocusedAt, lastFocusedWindowId: windowId });
      if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus snapshot belongs to an old connection");
    }
    this.focus = { windowId, focused, lastFocusedAt };
    return { ...this.focus };
  }

  async recordWindowFocus(windowId, active = () => true) {
    if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus event belongs to an old connection");
    const focused = Number.isInteger(windowId) && windowId >= 0;
    if (!focused) {
      this.focus.focused = false;
      this.emitEvent({ event: "window.focused", target: { windowId }, data: { focused: false } }, true);
      return;
    }
    const stored = await this.chrome.storage.local.get({ lastFocusedAt: 0 });
    if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus event belongs to an old connection");
    const observedAt = this.now();
    const lastFocusedAt = nextFocusTimestamp(stored.lastFocusedAt, observedAt);
    await this.chrome.storage.local.set({ lastFocusedAt, lastFocusedWindowId: windowId });
    if (!active()) throw new MoneyHandError("STALE_FOCUS", "Focus event belongs to an old connection");
    this.focus = { windowId, focused: true, lastFocusedAt };
    this.emitEvent({
      event: "window.focused",
      target: { windowId },
      data: { focused: true, lastFocusedAt },
    }, true);
  }

  clearTimer(name) {
    const timer = this[name];
    if (!timer) return;
    if (name === "heartbeatTimer") clearInterval(timer);
    else clearTimeout(timer);
    this[name] = undefined;
  }

  clearConnectionTimers() {
    this.clearTimer("heartbeatTimer");
    this.clearTimer("heartbeatPulseTimer");
    this.clearTimer("handshakeTimer");
    this.clearTimer("connectTimer");
  }

  mutateReconnectAlarm(operation) {
    const pending = this.alarmQueue.then(operation, operation);
    this.alarmQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  clearReconnectAlarm() {
    return this.mutateReconnectAlarm(
      () => Promise.resolve(this.chrome.alarms?.clear(RECONNECT_ALARM)),
    );
  }

  scheduleReconnect(generation = this.lifecycle) {
    if (generation !== this.lifecycle) return;
    this.clearTimer("reconnectTimer");
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(this.reconnectAttempt, 6)));
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.reconnectAttempt += 1;
    this.setState("BACKOFF");
    void this.mutateReconnectAlarm(async () => {
      await Promise.resolve(this.chrome.alarms?.create(RECONNECT_ALARM, {
        when: this.now() + Math.max(delay, RECONNECT_ALARM_MIN_MS),
      }));
      if (generation !== this.lifecycle) {
        await Promise.resolve(this.chrome.alarms?.clear(RECONNECT_ALARM));
      }
    }).catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      if (generation !== this.lifecycle) return;
      void this.connect().catch((error) => {
        if (generation !== this.lifecycle) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect(generation);
      });
    }, delay);
  }

  async connect() {
    if (this.manualDisabled) return await this.status();
    if (this.connecting) return await this.connecting;
    const generation = this.lifecycle;
    let pending;
    pending = this.connectOnce(generation).finally(() => {
      if (this.connecting === pending) this.connecting = undefined;
    });
    this.connecting = pending;
    return await pending;
  }

  async connectOnce(generation = this.lifecycle) {
    if (generation !== this.lifecycle || this.manualDisabled) return await this.status();
    this.clearTimer("reconnectTimer");
    await this.restoreRuntimeState();
    const settings = await this.storedSettings();
    if (generation !== this.lifecycle || this.manualDisabled) return await this.status();
    if (!settings.enabled) {
      this.setState("DISABLED");
      return await this.status();
    }
    const wsEndpoint = String(settings.wsEndpoint || "").trim();
    if (!endpointIsAllowed(wsEndpoint)) {
      this.lastError = "仅允许连接本机 ws://127.0.0.1、localhost 或 ::1";
      this.setState("DISABLED");
      return await this.status();
    }
    const authToken = typeof settings.authToken === "string" ? settings.authToken : "";
    if (!pairingTokenIsValid(authToken)) {
      this.lastError = "配对密钥必须留空或至少包含 16 个字符";
      this.setState("DISABLED");
      return await this.status();
    }
    if (this.socket?.readyState === this.WebSocketImpl.OPEN || this.socket?.readyState === this.WebSocketImpl.CONNECTING) {
      return await this.status();
    }

    let socket;
    try {
      socket = new this.WebSocketImpl(wsEndpoint);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(generation);
      return await this.status();
    }
    const epoch = ++this.epoch;
    this.socket = socket;
    this.setState("CONNECTING");
    this.handshakeReady = false;
    this.handshakeContext = undefined;
    this.connectTimer = setTimeout(() => {
      if (!this.isCurrent(socket, epoch) || socket.readyState !== this.WebSocketImpl.CONNECTING) return;
      this.lastError = "Agent WS 连接超时";
      socket.close(4001, "connect timeout");
    }, 5_000);

    socket.addEventListener("open", async () => {
      if (!this.isCurrent(socket, epoch)) return;
      try {
        this.clearTimer("connectTimer");
        this.setState("HANDSHAKE");
        this.lastError = "";
        this.handshakeTimer = setTimeout(() => {
          if (!this.isCurrent(socket, epoch) || this.handshakeReady) return;
          this.lastError = "Agent WS 握手超时";
          socket.close(4002, "ready timeout");
        }, this.handshakeTimeoutMs);
        this.executor.resetConnection();
        const manifest = this.chrome.runtime.getManifest();
        const platform = await this.chrome.runtime.getPlatformInfo().catch(() => ({}));
        const [instanceId, focus] = await Promise.all([
          this.ensureInstanceId(),
          this.runFocus((active) => this.focusSnapshot(active)),
        ]);
        const reportedUnknownOutcomeIds = [...this.unknownOutcomeIds]
          .slice(0, MAX_UNKNOWN_OUTCOME_IDS);
        const profileAlias = internalProfile(instanceId);
        this.profileAlias = profileAlias;
        if (!this.isCurrent(socket, epoch)) return;
        const context = {
          epoch,
          profileAlias,
          instanceId,
          bootId: this.bootId,
          clientNonce: randomId("nonce"),
          authToken,
          serverAuthenticated: authToken === "",
          challengeInProgress: false,
          authenticateSent: false,
          reportedUnknownOutcomeIds: new Set(reportedUnknownOutcomeIds),
        };
        this.handshakeContext = context;
        this.sendTo(socket, {
          v: PROTOCOL_VERSION,
          type: "hello",
          protocol: PROTOCOL,
          product: PRODUCT,
          profile: profileAlias,
          instanceId,
          bootId: this.bootId,
          version: manifest.version_name || manifest.version,
          auth: authToken
            ? { mode: "hmac-sha256", clientNonce: context.clientNonce }
            : { mode: "none" },
          browser: { userAgent: globalThis.navigator?.userAgent || "", platform },
          focus,
          unknownOutcomeIds: reportedUnknownOutcomeIds,
          capabilities: {
            methods: [
              "system.status", "target.list", "target.attach", "target.detach", "target.sessions",
              "cdp.send", "chrome.call", "input.perform", "batch.run",
              "behavior.get", "behavior.set", "behavior.reset",
              "events.subscribe", "events.unsubscribe",
              "observe.context", "observe.screenshot", "instruction.resolve",
            ],
            rawCdp: true,
            flatSessions: true,
            textFirst: true,
            behaviorModes: ["raw", "human"],
            coordinateContract: INPUT_COORDINATE_SPACE,
            automaticScreenshots: false,
            maxInboundMessageBytes: MAX_MESSAGE_BYTES,
            maxScreenshotBytes: MAX_SCREENSHOT_BYTES,
          },
        });
      } catch (error) {
        if (!this.isCurrent(socket, epoch)) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        socket.close(4011, "handshake setup failed");
      }
    });

    socket.addEventListener("message", (event) => {
      if (!this.isCurrent(socket, epoch)) return;
      void this.handleSocketMessage(socket, epoch, event.data).catch((error) => {
        if (!this.isCurrent(socket, epoch)) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        socket.close(4011, "message handler failed");
      });
    });

    socket.addEventListener("close", (event) => {
      void this.handleSocketClose(socket, epoch, event);
    });

    socket.addEventListener("error", () => {
      if (this.isCurrent(socket, epoch)) this.lastError = "Agent WS 连接失败";
    });
    return await this.status();
  }

  isCurrent(socket, epoch) {
    return this.socket === socket && this.epoch === epoch;
  }

  async handleSocketClose(socket, epoch, event) {
    if (!this.isCurrent(socket, epoch)) return;
    this.clearConnectionTimers();
    this.resetFocusQueue();
    this.interruptEpoch(epoch);
    this.handshakeReady = false;
    this.setState("DISCONNECTED");
    if (this.handshakeContext?.epoch === epoch) this.handshakeContext = undefined;
    this.socket = undefined;
    this.lastError ||= "Agent WS 已断开";
    const generation = this.lifecycle;
    if (event?.code === 1001) {
      const detached = await this.executor.detachAll();
      if (detached.failedTabs.length || detached.pendingTabs.length) {
        this.lastError = "Agent stopped, but some debugger attachments could not be released";
      }
    }
    try {
      const current = await this.storedSettings();
      if (generation !== this.lifecycle) return;
      if (current.enabled) this.scheduleReconnect(generation);
      else this.setState("DISABLED");
    } catch (error) {
      if (generation !== this.lifecycle) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(generation);
    }
  }

  async handleSocketMessage(socket, epoch, data) {
    let message;
    try {
      message = parseWireMessage(data);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      socket.close(4002, "invalid protocol message");
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.lastError = "Agent WS 协议版本不匹配";
      socket.close(4002, "unsupported protocol");
      return;
    }

    if (message.type === "challenge") {
      await this.handleChallenge(socket, epoch, message);
      return;
    }
    if (message.type === "ready") {
      if (this.handshakeReady) {
        socket.close(4002, "duplicate ready");
        return;
      }
      if (message.v !== PROTOCOL_VERSION || message.protocol !== PROTOCOL) {
        socket.close(4002, "unsupported protocol");
        return;
      }
      const context = this.handshakeContext;
      if (!context || context.epoch !== epoch || !context.serverAuthenticated
        || (context.authToken && !context.authenticateSent)) {
        socket.close(4008, "server authentication required");
        return;
      }
      const acknowledged = message.ackUnknownOutcomeIds ?? [];
      if (!Array.isArray(acknowledged)
        || acknowledged.some((id) => (
          typeof id !== "string" || !context.reportedUnknownOutcomeIds.has(id)
        ))) {
        this.lastError = "Agent WS 返回了未报告的 unknown outcome ACK";
        socket.close(4002, "invalid unknown outcome ACK");
        return;
      }
      this.clearTimer("handshakeTimer");
      this.handshakeReady = true;
      this.setState("READY");
      this.reconnectAttempt = 0;
      void this.clearReconnectAlarm().catch(() => undefined);
      this.heartbeatMs = clampInteger(message.heartbeatMs, 5_000, 25_000, HEARTBEAT_MS);
      this.maxInflight = clampInteger(message.maxInflight, 1, 256, DEFAULT_MAX_INFLIGHT);
      this.lastSeenAt = this.now();
      this.heartbeatTimer = setInterval(() => {
        this.heartbeatTick(socket, epoch);
      }, this.heartbeatMs);
      this.emitEvent({
        event: "window.focused",
        target: { windowId: this.focus.windowId },
        data: { focused: this.focus.focused, lastFocusedAt: this.focus.lastFocusedAt },
      }, true);
      for (const id of acknowledged) this.unknownOutcomeIds.delete(id);
      await this.clearRequestStarted(acknowledged);
      return;
    }
    if (message.type === "ping") {
      if (!this.handshakeReady) {
        this.lastError = "Agent WS 在 ready 前发送了心跳";
        socket.close(4002, "ping before ready");
        return;
      }
      this.lastSeenAt = this.now();
      this.pulseHeartbeat();
      this.sendTo(socket, { v: PROTOCOL_VERSION, type: "pong", timestamp: typeof message.timestamp === "string" && message.timestamp.length <= 256 ? message.timestamp : nowIso() });
      return;
    }
    if (message.type === "pong") {
      if (!this.handshakeReady) {
        this.lastError = "Agent WS 在 ready 前发送了心跳响应";
        socket.close(4002, "pong before ready");
        return;
      }
      this.lastSeenAt = this.now();
      this.pulseHeartbeat();
      return;
    }
    if (message.type !== "request") {
      this.lastError = `Agent WS 收到未定义消息类型 '${String(message.type)}'`;
      socket.close(4002, "unexpected protocol message");
      return;
    }
    this.lastSeenAt = this.now();
    if (!this.handshakeReady) {
      const id = typeof message.id === "string" ? message.id : "handshake";
      this.sendTo(socket, errorMessage(id, new MoneyHandError("NOT_READY", "Agent must send ready before requests")));
      return;
    }

    let request;
    try {
      request = parseRequest(message);
    } catch (error) {
      const id = typeof message.id === "string" ? message.id : "invalid";
      this.sendTo(socket, errorMessage(id, error));
      return;
    }
    await this.handleRequest(socket, epoch, request);
  }

  async handleChallenge(socket, epoch, message) {
    const context = this.handshakeContext;
    if (!context || context.epoch !== epoch || this.handshakeReady
      || context.challengeInProgress || context.authenticateSent || !context.authToken) {
      socket.close(4002, "unexpected challenge");
      return;
    }
    if (message.v !== PROTOCOL_VERSION || message.protocol !== PROTOCOL
      || typeof message.nonce !== "string"
      || !/^[A-Za-z0-9._:-]{16,256}$/u.test(message.nonce)
      || typeof message.proof !== "string"
      || !/^[a-f0-9]{64}$/u.test(message.proof)) {
      socket.close(4002, "invalid challenge");
      return;
    }
    context.challengeInProgress = true;
    const expected = await hmacHex(
      context.authToken,
      authenticationPayload("server", context, message.nonce),
    );
    if (!this.isCurrent(socket, epoch)) return;
    if (message.proof !== expected) {
      this.lastError = "Agent WS 配对认证失败";
      socket.close(4008, "authentication failed");
      return;
    }
    context.serverAuthenticated = true;
    const proof = await hmacHex(
      context.authToken,
      authenticationPayload("client", context, message.nonce),
    );
    if (!this.isCurrent(socket, epoch)) return;
    context.authenticateSent = this.sendTo(socket, {
      v: PROTOCOL_VERSION,
      type: "authenticate",
      protocol: PROTOCOL,
      nonce: message.nonce,
      proof,
    });
  }

  async handleRequest(socket, epoch, request) {
    if (!this.isCurrent(socket, epoch)) return;
    const fingerprint = requestFingerprint(request);
    const cached = this.completed.get(request.id);
    if (cached) {
      this.sendTo(socket, cached.fingerprint === fingerprint
        ? cached.message
        : errorMessage(request.id, new MoneyHandError("ID_CONFLICT", "request.id was already used for different request content")));
      return;
    }
    const inflightKey = `${epoch}:${request.id}`;
    if (this.unknownOutcomeIds.has(request.id)) {
      this.sendTo(socket, errorMessage(request.id, new MoneyHandError(
        "UNKNOWN_OUTCOME_PENDING",
        "This request started on a disconnected WS and must be inspected and acknowledged before any reuse",
      )));
      return;
    }
    const existing = this.inflight.get(inflightKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.sendTo(socket, errorMessage(request.id, new MoneyHandError("ID_CONFLICT", "request.id is already in flight with different request content")));
        socket.close(4002, "request id conflict");
      }
      return;
    }
    const epochPrefix = `${epoch}:`;
    const epochInflight = [...this.inflight.keys()]
      .filter((key) => key.startsWith(epochPrefix))
      .length;
    if (epochInflight >= this.maxInflight) {
      const terminal = this.cacheTerminal(
        request.id,
        fingerprint,
        errorMessage(request.id, new MoneyHandError("BUSY", "Maximum in-flight request limit reached")),
      );
      this.sendTo(socket, terminal);
      return;
    }
    if (this.unknownOutcomeIds.size + epochInflight >= MAX_UNKNOWN_OUTCOME_IDS) {
      const terminal = this.cacheTerminal(
        request.id,
        fingerprint,
        errorMessage(request.id, new MoneyHandError(
          "OUTCOME_LEDGER_FULL",
          "Unknown-outcome ledger is full; inspect and acknowledge earlier outcomes before new browser work",
        )),
      );
      this.sendTo(socket, terminal);
      return;
    }
    if (request.method === "observe.screenshot"
      && [...this.inflight].filter(([key, record]) => (
        key.startsWith(`${epoch}:`) && record.requestMethod === "observe.screenshot"
      )).length >= MAX_SCREENSHOT_INFLIGHT) {
      const terminal = this.cacheTerminal(
        request.id,
        fingerprint,
        errorMessage(request.id, new MoneyHandError("BUSY", "At most two screenshots may be in flight")),
      );
      this.sendTo(socket, terminal);
      return;
    }

    let behavior;
    try {
      behavior = this.executor.effectiveBehavior(request.behavior);
    } catch (error) {
      const terminal = this.cacheTerminal(request.id, fingerprint, errorMessage(request.id, error));
      this.sendTo(socket, terminal);
      return;
    }
    const baseKey = request.method === "instruction.resolve"
      ? `control:${request.id}`
      : this.executor.queueKey(request);
    const mayMutate = this.executor.requestMayMutate(request);
    if (mayMutate && this.epochBarriers.size) {
      const terminal = this.cacheTerminal(request.id, fingerprint, errorMessage(
        request.id,
        new MoneyHandError("PREVIOUS_EPOCH_ACTIVE", "A mutation from the previous connection is still settling"),
      ));
      this.sendTo(socket, terminal);
      return;
    }
    const key = `${epoch}:${baseKey}`;
    const record = {
      promise: undefined,
      started: false,
      fingerprint,
      requestMethod: request.method,
      mayMutate,
    };
    let task;
    try {
      task = this.enqueue(key, async (queue) => {
        if (queue.cancelled || !this.isCurrent(socket, epoch) || !this.handshakeReady) {
          if (queue.cancelled && this.isCurrent(socket, epoch) && this.handshakeReady) {
            const terminal = this.cacheTerminal(request.id, fingerprint, errorMessage(request.id, queue.cancelError));
            this.sendTo(socket, terminal);
            return terminal;
          }
          return undefined;
        }
        const started = performance.now();
        let terminal;
        try {
          const result = await this.executor.execute(request.method, request.params, behavior, {
            isActive: () => this.isCurrent(socket, epoch) && this.handshakeReady && !queue.cancelled,
            onStart: async () => {
              record.started = true;
              if (mayMutate) await this.markRequestStarted(request.id);
            },
          });
          if (request.method === "system.status") result.connection = await this.status();
          terminal = responseMessage(request.id, result, Math.round(performance.now() - started));
        } catch (error) {
          if (!this.isCurrent(socket, epoch) || !this.handshakeReady) return undefined;
          if (behavior.onUnclear === "error" || !this.executor.shouldRequestInstruction(error, request.params)) {
            terminal = errorMessage(request.id, error, Math.round(performance.now() - started));
          } else {
            const failure = await this.executor.failureContext(request.params, behavior);
            if (!this.isCurrent(socket, epoch) || !this.handshakeReady) return undefined;
            const wait = this.executor.pauseForInstruction(failure.target.tabId, error);
            if (!wait) {
              terminal = errorMessage(request.id, error, Math.round(performance.now() - started));
            } else {
              await this.persistRuntimeState();
              terminal = needInstructionMessage(
                request.id,
                wait.waitId,
                failure.target,
                error,
                failure.context,
                Math.round(performance.now() - started),
              );
              this.cancelQueue(key, queue, new MoneyHandError(
                "TAB_WAITING",
                `Tab ${failure.target.tabId} is waiting for Agent instruction '${wait.waitId}'`,
                { tabId: failure.target.tabId, waitId: wait.waitId },
              ));
            }
          }
        }
        if (request.method === "instruction.resolve") await this.persistRuntimeState();
        if (this.epoch === epoch) terminal = this.cacheTerminal(request.id, fingerprint, terminal);
        if (this.isCurrent(socket, epoch) && this.handshakeReady) {
          const sent = this.sendTo(socket, terminal);
          if (!sent && record.started) this.unknownOutcomeIds.add(request.id); else if (sent) record.started = false;
          if (sent && mayMutate) await this.clearRequestStarted([request.id]).catch((error) => { this.lastError = error instanceof Error ? error.message : String(error); });
        }
        return terminal;
      });
    } catch (error) {
      const terminal = this.cacheTerminal(request.id, fingerprint, errorMessage(request.id, error));
      this.sendTo(socket, terminal);
      return;
    }
    record.promise = task;
    this.inflight.set(inflightKey, record);
    try {
      await task;
    } catch (error) {
      if (this.isCurrent(socket, epoch) && this.handshakeReady) {
        const terminal = this.cacheTerminal(request.id, fingerprint, errorMessage(request.id, error));
        this.sendTo(socket, terminal);
      }
    } finally {
      this.inflight.delete(inflightKey);
    }
  }

  enqueue(key, operation) {
    const separator = key.indexOf(":");
    const prefix = key.slice(0, separator + 1);
    const baseKey = key.slice(separator + 1);
    const isControl = baseKey.startsWith("control:");
    if (!isControl && baseKey === "exclusive") {
      const conflict = [...this.queues].some(([candidateKey, candidate]) => (
        candidateKey.startsWith(prefix)
        && candidate.depth > 0
        && !candidateKey.slice(prefix.length).startsWith("control:")
      ));
      if (conflict) throw new MoneyHandError("BUSY", "Exclusive browser mutation conflicts with active work");
    } else if (!isControl && this.queues.get(`${prefix}exclusive`)?.depth > 0) {
      throw new MoneyHandError("BUSY", "Browser work conflicts with an exclusive window mutation");
    }
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { tail: Promise.resolve(), depth: 0, cancelled: false, cancelError: undefined };
      this.queues.set(key, queue);
    }
    if (queue.depth >= MAX_QUEUE_DEPTH) {
      throw new MoneyHandError("BUSY", `Queue '${key}' reached its ${MAX_QUEUE_DEPTH} request limit`);
    }
    queue.depth += 1;
    const run = queue.tail.catch(() => undefined).then(() => operation(queue));
    const cleanup = () => {
      queue.depth -= 1;
      if (queue.depth === 0 && this.queues.get(key) === queue) this.queues.delete(key);
    };
    queue.tail = run.then(cleanup, cleanup);
    return run;
  }

  cancelQueue(key, queue, error) {
    queue.cancelled = true;
    queue.cancelError = error;
    if (this.queues.get(key) === queue) this.queues.delete(key);
  }

  interruptEpoch(epoch) {
    const prefix = `${epoch}:`;
    for (const [key, record] of this.inflight) {
      if (key.startsWith(prefix) && record.started) {
        this.unknownOutcomeIds.add(key.slice(prefix.length));
        if (record.mayMutate) this.holdEpochBarrier(record.promise);
      }
      if (key.startsWith(prefix)) this.inflight.delete(key);
    }
    for (const [key, queue] of this.queues) {
      if (key.startsWith(prefix)) {
        this.cancelQueue(key, queue, new MoneyHandError("CONNECTION_LOST", "Request cancelled before execution because the WS connection ended"));
      }
    }
  }

  holdEpochBarrier(promise) {
    const settled = Promise.resolve(promise).catch(() => undefined);
    this.epochBarriers.add(settled);
    void settled.finally(() => this.epochBarriers.delete(settled));
  }

  heartbeatTick(socket, epoch) {
    if (!this.isCurrent(socket, epoch) || !this.handshakeReady) return;
    if (this.now() - this.lastSeenAt >= this.heartbeatMs * 2) {
      this.lastError = "Agent WS 心跳超时";
      this.setState("DISCONNECTED");
      socket.close(4000, "heartbeat timeout");
      return;
    }
    this.pulseHeartbeat();
    this.sendTo(socket, { v: PROTOCOL_VERSION, type: "ping", timestamp: nowIso() });
  }

  cacheTerminal(id, fingerprint, message) {
    const prepared = this.prepareTerminal(message);
    const entryBytes = prepared.bytes + new TextEncoder().encode(fingerprint).byteLength;
    const existing = this.completed.get(id);
    if (existing) {
      this.completedBytes -= existing.bytes;
      this.completed.delete(id);
    }
    this.completed.set(id, { fingerprint, ...prepared, bytes: entryBytes });
    this.completedBytes += entryBytes;
    while (this.completed.size > COMPLETED_CACHE_SIZE || this.completedBytes > MAX_COMPLETED_CACHE_BYTES) {
      const oldestId = this.completed.keys().next().value;
      const oldest = this.completed.get(oldestId);
      this.completedBytes -= oldest.bytes;
      this.completed.delete(oldestId);
    }
    return prepared.message;
  }

  prepareTerminal(message) {
    let data;
    try {
      data = JSON.stringify(message);
    } catch {
      message = errorMessage(message?.id || "invalid", new MoneyHandError(
        "RESPONSE_NOT_SERIALIZABLE",
        "The browser response could not be serialized",
      ));
      data = JSON.stringify(message);
    }
    let bytes = new TextEncoder().encode(data).byteLength;
    if (bytes > MAX_TERMINAL_BYTES) {
      message = errorMessage(message?.id || "invalid", new MoneyHandError(
        "RESPONSE_TOO_LARGE",
        "The browser response exceeds the 8 MiB terminal limit",
      ));
      bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    }
    return { message, bytes };
  }

  sendTo(socket, message, lowPriority = false) {
    if (socket.readyState !== this.WebSocketImpl.OPEN) return false;
    let data;
    try {
      data = JSON.stringify(message);
    } catch {
      this.lastError = "响应无法序列化";
      socket.close(4011, "response serialization failed");
      return false;
    }
    const bytes = new TextEncoder().encode(data).byteLength;
    if (lowPriority && socket.bufferedAmount + bytes > MAX_BUFFERED_EVENT_BYTES) {
      this.droppedEvents += 1;
      return false;
    }
    if (socket.bufferedAmount + bytes > MAX_BUFFERED_TOTAL_BYTES) {
      this.lastError = "Agent WS 输出背压超过 16 MiB";
      socket.close(4013, "outbound backpressure");
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (socket.readyState < this.WebSocketImpl.CLOSING) {
        socket.close(4011, "WebSocket send failed");
      }
      return false;
    }
  }

  emitEvent(event, highPriority = false) {
    const socket = this.socket;
    if (!socket || !this.handshakeReady) return;
    this.sendTo(socket, {
      v: PROTOCOL_VERSION,
      type: "event",
      seq: ++this.eventSeq,
      timestamp: nowIso(),
      ...event,
    }, !highPriority);
  }

  async stop() {
    this.lifecycle += 1;
    this.manualDisabled = true;
    this.connecting = undefined;
    this.resetFocusQueue();
    this.clearTimer("reconnectTimer");
    this.clearConnectionTimers();
    const socket = this.socket;
    const epoch = this.epoch;
    this.interruptEpoch(epoch);
    this.socket = undefined;
    this.handshakeReady = false;
    this.handshakeContext = undefined;
    this.setState("DISABLED");
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) socket.close(1000, "disabled");
    await this.clearReconnectAlarm();
    await this.chrome.storage.local.set({ enabled: false });
    const detached = await this.executor.detachAll();
    if (detached.failedTabs.length || detached.pendingTabs.length) {
      const tabIds = [...detached.failedTabs.map((failure) => failure.tabId), ...detached.pendingTabs];
      this.lastError = `Debugger detach incomplete for tab(s): ${tabIds.join(", ")}`;
    }
    return await this.status();
  }

  async reconnect() {
    this.lifecycle += 1;
    this.manualDisabled = false;
    this.connecting = undefined;
    this.resetFocusQueue();
    const socket = this.socket;
    const epoch = this.epoch;
    this.interruptEpoch(epoch);
    this.socket = undefined;
    this.handshakeReady = false;
    this.handshakeContext = undefined;
    this.setState("CONNECTING");
    this.clearConnectionTimers();
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) socket.close(4012, "reconnect");
    return await this.connect();
  }

  async connectDefault() {
    await this.chrome.storage.local.set({
      enabled: true,
      wsEndpoint: DEFAULT_ENDPOINT,
      profileAlias: "",
    });
    return await this.reconnect();
  }
}

export const __test__ = {
  COMPLETED_CACHE_SIZE,
  DEFAULT_MAX_INFLIGHT,
  HEARTBEAT_MS,
  MAX_BUFFERED_EVENT_BYTES,
  MAX_BUFFERED_TOTAL_BYTES,
  MAX_COMPLETED_CACHE_BYTES,
  MAX_SCREENSHOT_INFLIGHT,
  MAX_TERMINAL_BYTES,
  RECONNECT_ALARM,
  RECONNECT_ALARM_MIN_MS,
  authenticationPayload,
  hmacHex,
  requestFingerprint,
  instanceIdIsValid,
  storedFocusTimestamp,
};
