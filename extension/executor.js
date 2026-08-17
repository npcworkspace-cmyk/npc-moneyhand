import {
  DEFAULT_BEHAVIOR, INPUT_COORDINATE_SPACE, MAX_BATCH_STEPS, MAX_CONTEXT_BYTES, MAX_SCREENSHOT_BYTES,
  MoneyHandError, asObject, compileMethodPattern, normalizeBehavior, sleep,
} from "./protocol.js";

const DEBUGGER_VERSION = "1.3";
const AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] });

const ALLOWED_CHROME_CALLS = new Set([
  "tabs.query", "tabs.get", "tabs.create", "tabs.update", "tabs.remove",
  "tabs.reload", "tabs.goBack", "tabs.goForward", "tabs.duplicate",
  "windows.get", "windows.getAll", "windows.getCurrent", "windows.getLastFocused",
  "windows.create", "windows.update", "windows.remove",
  "downloads.download", "downloads.search", "downloads.pause", "downloads.resume",
  "downloads.cancel", "downloads.erase", "downloads.removeFile", "downloads.show",
]);

const READ_ONLY_CHROME_CALLS = new Set([
  "tabs.query", "tabs.get", "windows.get", "windows.getAll",
  "windows.getCurrent", "windows.getLastFocused", "downloads.search",
]);

const TAB_MUTATIONS_WITH_ID = new Set([
  "tabs.update", "tabs.reload", "tabs.goBack", "tabs.goForward", "tabs.duplicate",
]);

const EXCLUSIVE_CHROME_CALLS = new Set(["windows.update", "windows.remove"]);

const CHROME_CALLS_SAFE_DURING_WAIT = new Set([
  ...READ_ONLY_CHROME_CALLS, "tabs.create", "windows.create", "downloads.pause",
  "downloads.resume", "downloads.cancel", "downloads.erase",
  "downloads.removeFile", "downloads.show",
]);

const DIRECT_ERROR_CODES = new Set([
  "BUSY", "CHROME_METHOD_DENIED", "CHROME_METHOD_UNAVAILABLE", "CHROME_CALL_FAILED",
  "DEBUGGER_CONFLICT", "DETACH_FAILED", "INVALID_ARGUMENT", "INVALID_BATCH",
  "INVALID_BEHAVIOR", "INVALID_TARGET", "NOT_WAITING", "PROTECTED_TARGET",
  "SCREENSHOT_FAILED", "SCREENSHOT_TOO_LARGE", "STATE_PERSIST_FAILED",
  "TAB_WAITING", "WAIT_ID_MISMATCH",
]);

const WAITING_ALLOWED = new Set(["system.status", "behavior.get", "events.subscribe", "events.unsubscribe", "observe.context", "observe.screenshot", "instruction.resolve"]);
const MUTATING_METHODS = new Set(["target.attach", "target.detach", "cdp.send", "input.perform", "batch.run", "instruction.resolve"]);
const COORDINATE_ACTIONS = new Set(["move", "click", "scroll", "drag", "touch"]);
const NO_FALLBACK = Symbol("no-fallback"), DEFAULT_MAX_TEXT_CHARS = 12_000, DEFAULT_MAX_ELEMENTS = 80;
const MAX_CONTEXT_CONTENT_CHARS = 80_000, MAX_CONTEXT_ELEMENTS = 500;
const MAX_URL_CHARS = 4_096, MAX_TITLE_CHARS = 1_024, MAX_CONTROL_HREF_CHARS = 2_048;

function requiredString(object, key) {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MoneyHandError("INVALID_ARGUMENT", `Missing or invalid '${key}'`);
  }
  return value;
}

function finiteNumber(object, key, fallback = NO_FALLBACK) {
  const value = object[key];
  if (value === undefined) {
    if (fallback !== NO_FALLBACK) return fallback;
    throw new MoneyHandError("INVALID_ARGUMENT", `Missing numeric '${key}'`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyHandError("INVALID_ARGUMENT", `'${key}' must be a finite number`);
  }
  return value;
}

function positiveTabId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MoneyHandError("INVALID_TARGET", "A positive integer tabId is required");
  }
  return value;
}

function validateChromeCallScope(method, args) {
  const first = args[0];
  if (TAB_MUTATIONS_WITH_ID.has(method)) {
    positiveTabId(first);
  } else if (method === "tabs.remove") {
    const ids = Array.isArray(first) ? first : [first];
    if (ids.length !== 1) {
      throw new MoneyHandError("INVALID_ARGUMENT", "tabs.remove accepts exactly one tabId per request");
    }
    positiveTabId(ids[0]);
  }
}

function requestIsExclusive(method, params = {}) {
  if (method === "chrome.call") return EXCLUSIVE_CHROME_CALLS.has(params.method);
  if (method !== "batch.run" || !Array.isArray(params.steps)) return false;
  return params.steps.some((step) => requestIsExclusive(step?.method, step?.params));
}

function targetFrom(params) {
  const source = params.target === undefined ? params : asObject(params.target, "target");
  const target = { tabId: positiveTabId(source.tabId) };
  if (source.sessionId !== undefined) {
    if (typeof source.sessionId !== "string" || source.sessionId.length === 0 || source.sessionId.length > 256) {
      throw new MoneyHandError("INVALID_TARGET", "target.sessionId must be a 1-256 character string");
    }
    target.sessionId = source.sessionId;
  }
  return target;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertActive(control) {
  if (control?.isActive && !control.isActive()) {
    throw new MoneyHandError("CONNECTION_LOST", "WS connection ended before the request started");
  }
}

function batchMayContinue(error) {
  return DIRECT_ERROR_CODES.has(error?.code)
    && !["CONNECTION_LOST", "TAB_WAITING"].includes(error.code);
}

function eventTarget(source) {
  const target = {};
  if (Number.isInteger(source?.tabId)) target.tabId = source.tabId;
  if (typeof source?.sessionId === "string") target.sessionId = source.sessionId;
  return target;
}

function clippedString(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function sanitizeContextValue(value, maxTextChars, maxElements) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  let remaining = MAX_CONTEXT_CONTENT_CHARS;
  let contentTruncated = source.contentTruncated === true;
  const take = (input, maximum) => {
    if (typeof input !== "string") return "";
    const limit = Math.max(0, Math.min(maximum, remaining));
    const output = input.slice(0, limit);
    remaining -= output.length;
    if (output.length < input.length) contentTruncated = true;
    return output;
  };
  const output = {
    url: take(source.url, MAX_URL_CHARS),
    title: take(source.title, MAX_TITLE_CHARS),
    readyState: clippedString(source.readyState, 32),
    text: take(source.text, maxTextChars),
    textTruncated: source.textTruncated === true,
    controls: [],
  };
  if (typeof source.text === "string" && output.text.length < source.text.length) output.textTruncated = true;
  const controls = Array.isArray(source.controls) ? source.controls.slice(0, maxElements) : [];
  if (Array.isArray(source.controls) && controls.length < source.controls.length) contentTruncated = true;
  for (const control of controls) {
    if (!control || typeof control !== "object" || Array.isArray(control)) continue;
    const rect = control.rect && typeof control.rect === "object" ? control.rect : {};
    output.controls.push({
      tag: clippedString(control.tag, 32),
      type: clippedString(control.type, 64) || undefined,
      role: clippedString(control.role, 64) || undefined,
      text: take(control.text, 300),
      href: take(control.href, MAX_CONTROL_HREF_CHARS) || undefined,
      rect: {
        x: Number.isFinite(rect.x) ? rect.x : 0,
        y: Number.isFinite(rect.y) ? rect.y : 0,
        width: Number.isFinite(rect.width) ? rect.width : 0,
        height: Number.isFinite(rect.height) ? rect.height : 0,
      },
    });
  }
  output.contentTruncated = contentTruncated;
  while (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_CONTEXT_BYTES && output.controls.length) {
    output.controls.pop();
    output.contentTruncated = true;
  }
  while (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_CONTEXT_BYTES && output.text.length) {
    output.text = output.text.slice(0, Math.floor(output.text.length / 2));
    output.textTruncated = true;
    output.contentTruncated = true;
  }
  return output;
}

export class MoneyHandExecutor {
  constructor(chromeApi, options = {}) {
    this.chrome = chromeApi; this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.behavior = { ...DEFAULT_BEHAVIOR }; this.behaviorExpiresAt = 0;
    this.eventPatterns = new Map(); this.attachedTabs = new Set();
    this.autoAttachConfiguredTabs = new Set(); this.attachmentLocks = new Map();
    this.childSessions = new Map(); this.pointerByTab = new Map();
    this.waitingTabs = new Map();
  }

  resetConnection({ clearWaiting = false } = {}) {
    this.behavior = { ...DEFAULT_BEHAVIOR };
    this.behaviorExpiresAt = 0;
    this.eventPatterns.clear();
    if (clearWaiting) this.waitingTabs.clear();
  }

  currentBehavior() {
    if (this.behaviorExpiresAt && this.now() >= this.behaviorExpiresAt) {
      this.behavior = { ...DEFAULT_BEHAVIOR };
      this.behaviorExpiresAt = 0;
    }
    return { ...this.behavior };
  }

  effectiveBehavior(override) {
    const current = this.currentBehavior();
    return override === undefined ? current : normalizeBehavior(current, override);
  }

  randomBetween(minimum, maximum) {
    const unit = Math.max(0, Math.min(1, Number(this.random()) || 0));
    return minimum + (maximum - minimum) * unit;
  }

  variedDelay(milliseconds, behavior, minimum = 0.65, maximum = 1.4) {
    if (!milliseconds) return 0;
    return behavior.mode === "human"
      ? Math.max(0, Math.round(milliseconds * this.randomBetween(minimum, maximum)))
      : milliseconds;
  }

  async behaviorSleep(milliseconds, behavior, minimum, maximum) {
    await sleep(this.variedDelay(milliseconds, behavior, minimum, maximum));
  }

  queueKey(request) {
    if (requestIsExclusive(request.method, request.params)) return "exclusive";
    const tabIds = this.tabIdsFor(request.method, request.params);
    return tabIds.length === 1 ? `tab:${tabIds[0]}` : tabIds.length > 1 ? "multi-tab" : "global";
  }

  requestMayMutate(request) {
    if (request.method === "chrome.call") return !READ_ONLY_CHROME_CALLS.has(request.params?.method);
    return MUTATING_METHODS.has(request.method);
  }

  tabIdFromParams(params) {
    if (Number.isInteger(params?.tabId) && params.tabId > 0) return params.tabId;
    if (Number.isInteger(params?.target?.tabId) && params.target.tabId > 0) return params.target.tabId;
    if (Array.isArray(params?.steps)) {
      for (const step of params.steps) {
        const found = this.tabIdFromParams(step?.params);
        if (found) return found;
      }
    }
    return undefined;
  }

  tabIdsFor(method, params = {}) {
    const tabIds = new Set();
    const direct = this.tabIdFromParams({ tabId: params.tabId, target: params.target });
    if (direct) tabIds.add(direct);
    if (method === "chrome.call") {
      const chromeMethod = params.method;
      const first = Array.isArray(params.args) ? params.args[0] : undefined;
      if (["tabs.get", "tabs.update", "tabs.reload", "tabs.goBack", "tabs.goForward", "tabs.duplicate"].includes(chromeMethod)) {
        if (Number.isInteger(first) && first > 0) tabIds.add(first);
      } else if (chromeMethod === "tabs.remove") {
        for (const value of Array.isArray(first) ? first : [first]) {
          if (Number.isInteger(value) && value > 0) tabIds.add(value);
        }
      }
    } else if (method === "batch.run" && Array.isArray(params.steps)) {
      for (const step of params.steps) {
        for (const tabId of this.tabIdsFor(step?.method, step?.params)) tabIds.add(tabId);
      }
    }
    return [...tabIds];
  }

  async execute(method, params = {}, behaviorOverride, control = {}) {
    const input = asObject(params, "params");
    const behavior = this.effectiveBehavior(behaviorOverride);
    if (method === "instruction.resolve") return await this.resolveInstruction(input);
    this.assertNotWaiting(method, input);
    assertActive(control);
    await this.behaviorSleep(behavior.beforeMs, behavior);
    assertActive(control);
    await control.onStart?.();
    assertActive(control);
    const result = await this.executeOnce(method, input, behavior, control);
    await this.behaviorSleep(behavior.afterMs, behavior);
    return result;
  }

  async executeOnce(method, params, behavior, control = {}) {
    switch (method) {
      case "system.status":
        return await this.status();
      case "behavior.get":
        return { behavior: this.currentBehavior(), expiresAt: this.behaviorExpiresAt || null };
      case "behavior.set":
        return this.setBehavior(params);
      case "behavior.reset":
        this.behavior = { ...DEFAULT_BEHAVIOR };
        this.behaviorExpiresAt = 0;
        return { behavior: this.currentBehavior(), expiresAt: null };
      case "events.subscribe":
        return this.subscribe(params);
      case "events.unsubscribe":
        return this.unsubscribe(params);
      case "target.list":
        return { targets: await this.chrome.debugger.getTargets() };
      case "target.attach":
        return await this.attachTarget(params, behavior, control);
      case "target.detach":
        return await this.detachTarget(params);
      case "target.sessions":
        return this.targetSessions(params);
      case "cdp.send":
        return await this.cdpSend(params, behavior, control);
      case "chrome.call":
        return await this.chromeCall(params, behavior);
      case "input.perform":
        return await this.inputPerform(params, behavior, control);
      case "batch.run":
        return await this.batchRun(params, behavior, control);
      case "observe.context":
        return await this.observeContext(params, behavior, control);
      case "observe.screenshot":
        return await this.observeScreenshot(params, behavior, control);
      default:
        throw new MoneyHandError("UNKNOWN_METHOD", `Unknown method '${method}'`);
    }
  }

  setBehavior(params) {
    const input = { ...params };
    const reset = input.reset === true;
    delete input.reset;
    this.behavior = normalizeBehavior(reset ? DEFAULT_BEHAVIOR : this.currentBehavior(), input);
    this.behaviorExpiresAt = this.now() + this.behavior.ttlMs;
    return {
      behavior: this.currentBehavior(),
      expiresAt: this.behaviorExpiresAt,
    };
  }

  subscribe(params) {
    const patterns = params.patterns;
    if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 100) {
      throw new MoneyHandError("INVALID_ARGUMENT", "events.subscribe requires 1-100 patterns");
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 120) {
        throw new MoneyHandError("INVALID_ARGUMENT", "Event patterns must be 1-120 character strings");
      }
      this.eventPatterns.set(pattern, compileMethodPattern(pattern));
    }
    return { patterns: [...this.eventPatterns.keys()] };
  }

  unsubscribe(params) {
    if (params.all === true) this.eventPatterns.clear();
    else {
      const patterns = params.patterns;
      if (!Array.isArray(patterns)) throw new MoneyHandError("INVALID_ARGUMENT", "events.unsubscribe requires patterns or all=true");
      for (const pattern of patterns) this.eventPatterns.delete(String(pattern));
    }
    return { patterns: [...this.eventPatterns.keys()] };
  }

  async status() {
    return {
      mode: "ws-only",
      behavior: this.currentBehavior(),
      eventPatterns: [...this.eventPatterns.keys()],
      attachedTabs: [...this.attachedTabs],
      waiting: [...this.waitingTabs.entries()].map(([tabId, wait]) => ({
        tabId,
        waitId: wait.waitId,
        since: wait.since,
        error: wait.error,
      })),
    };
  }

  async attachTarget(params, behavior, control) {
    const tabId = positiveTabId(params.tabId ?? params.target?.tabId);
    const autoAttachFrames = params.autoAttachFrames !== false;
    await this.ensureAttached(tabId, autoAttachFrames, control);
    return { tabId, attached: true, autoAttachFrames };
  }

  // One per-tab lifecycle lock spans WS epochs, late attach compensation and stop().
  async ensureAttached(tabId, autoAttachFrames, control = {}) {
    return await this.withAttachmentLock(tabId, async () => {
      assertActive(control);
      if (!this.attachedTabs.has(tabId)) {
        const tab = await this.chrome.tabs.get(tabId);
        assertActive(control);
        if (!/^(https?|file|data|about):/i.test(tab.url || "")) {
          throw new MoneyHandError("PROTECTED_TARGET", `Chrome does not allow debugger control for '${tab.url || "this target"}'`);
        }
        try {
          await this.chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
        } catch (error) {
          if (/Another debugger|already attached|Cannot attach/i.test(errorMessage(error))) {
            throw new MoneyHandError("DEBUGGER_CONFLICT", `Tab ${tabId} is already controlled by DevTools or another debugger`);
          }
          throw error;
        }
        this.attachedTabs.add(tabId);
        if (control.isActive && !control.isActive()) {
          await this.detachLocked(tabId);
          assertActive(control);
        }
      }
      if (autoAttachFrames && !this.autoAttachConfiguredTabs.has(tabId)) {
        assertActive(control);
        this.autoAttachConfiguredTabs.add(tabId);
        try {
          await this.chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", AUTO_ATTACH);
          if (control.isActive && !control.isActive()) {
            await this.detachLocked(tabId);
            assertActive(control);
          }
        } catch (error) {
          this.autoAttachConfiguredTabs.delete(tabId);
          throw error;
        }
      }
    });
  }

  async withAttachmentLock(tabId, operation) {
    const previous = this.attachmentLocks.get(tabId) || Promise.resolve();
    const current = previous.then(operation, operation);
    this.attachmentLocks.set(tabId, current);
    try {
      return await current;
    } finally {
      if (this.attachmentLocks.get(tabId) === current) this.attachmentLocks.delete(tabId);
    }
  }

  async detachLocked(tabId, ignoreMissing = false) {
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch (error) {
      if (ignoreMissing && /not attached|no target|no tab/i.test(errorMessage(error))) {
        this.cleanupTab(tabId);
        return false;
      }
      throw new MoneyHandError("DETACH_FAILED", `Could not detach debugger from tab ${tabId}: ${errorMessage(error)}`);
    }
    this.cleanupTab(tabId);
    return true;
  }

  async detachTarget(params) {
    const tabId = positiveTabId(params.tabId ?? params.target?.tabId);
    await this.withAttachmentLock(tabId, () => this.detachLocked(tabId));
    return { tabId, attached: false };
  }

  targetSessions(params) {
    const tabId = positiveTabId(params.tabId ?? params.target?.tabId);
    const sessions = this.childSessions.get(tabId) || new Map();
    return {
      tabId,
      sessions: [...sessions].map(([sessionId, value]) => ({ sessionId, ...value })),
    };
  }

  async cdpSend(params, behavior, control) {
    const target = targetFrom(params);
    const method = requiredString(params, "method");
    const commandParams = params.params === undefined ? {} : asObject(params.params, "cdp params");
    await this.ensureAttached(target.tabId, true, control);
    assertActive(control);
    const result = await this.chrome.debugger.sendCommand(target, method, commandParams);
    return { target, method, result: result ?? {} };
  }

  async chromeCall(params, behavior) {
    const method = requiredString(params, "method");
    if (!ALLOWED_CHROME_CALLS.has(method)) {
      throw new MoneyHandError("CHROME_METHOD_DENIED", `Chrome method '${method}' is not exposed`);
    }
    const args = params.args === undefined ? [] : params.args;
    if (!Array.isArray(args) || args.length > 10) {
      throw new MoneyHandError("INVALID_ARGUMENT", "chrome.call args must be an array with at most 10 items");
    }
    validateChromeCallScope(method, args);
    const [domain, functionName] = method.split(".");
    const owner = this.chrome[domain];
    const fn = owner?.[functionName];
    if (typeof fn !== "function") throw new MoneyHandError("CHROME_METHOD_UNAVAILABLE", `Chrome method '${method}' is unavailable`);
    let result;
    try {
      result = await Promise.resolve(fn.apply(owner, args));
    } catch (error) {
      throw new MoneyHandError("CHROME_CALL_FAILED", `Chrome method '${method}' failed: ${errorMessage(error)}`, { method });
    }
    return { method, result: result ?? null };
  }

  async inputPerform(params, behavior, control) {
    const target = targetFrom(params);
    const action = requiredString(params, "action");
    const coordinateAction = COORDINATE_ACTIONS.has(action);
    const coordinateSpace = params.coordinateSpace === undefined ? INPUT_COORDINATE_SPACE : params.coordinateSpace;
    if (coordinateAction && coordinateSpace !== INPUT_COORDINATE_SPACE) throw new MoneyHandError("INVALID_ARGUMENT", `coordinateSpace must be '${INPUT_COORDINATE_SPACE}'`);
    if (!coordinateAction && params.coordinateSpace !== undefined) throw new MoneyHandError("INVALID_ARGUMENT", `coordinateSpace is not valid for input action '${action}'`);
    if (coordinateAction && target.sessionId) throw new MoneyHandError("INVALID_TARGET", "Coordinate input requires a top-level tab target without sessionId");
    if (action === "move") {
      const x = finiteNumber(params, "x"), y = finiteNumber(params, "y");
      await this.ensureAttached(target.tabId, true, control);
      await this.movePointer(target, x, y, behavior, "none", control);
    } else if (action === "click") {
      const x = finiteNumber(params, "x"), y = finiteNumber(params, "y");
      const button = params.button || "left", clickCount = finiteNumber(params, "clickCount", 1);
      await this.ensureAttached(target.tabId, true, control);
      await this.movePointer(target, x, y, behavior, "none", control);
      if (behavior.mode === "human") {
        await this.behaviorSleep(Math.max(20, behavior.typingDelayMs), behavior, 0.5, 1.25);
        assertActive(control);
      }
      let pressed = false;
      try {
        await this.sendInput(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount }, behavior, control);
        pressed = true;
        if (behavior.mode === "human") {
          await this.behaviorSleep(Math.max(25, behavior.typingDelayMs), behavior, 0.55, 1.35);
        }
      } finally {
        if (pressed) {
          await this.sendInput(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount }, behavior);
        }
      }
      assertActive(control);
    } else if (action === "type") {
      const text = requiredString(params, "text");
      await this.ensureAttached(target.tabId, true, control);
      if (behavior.typingDelayMs === 0) {
        await this.sendInput(target, "Input.insertText", { text }, behavior, control);
      } else {
        const characters = Array.from(text);
        for (let index = 0; index < characters.length; index += 1) {
          const character = characters[index];
          await this.sendInput(target, "Input.insertText", { text: character }, behavior, control);
          if (index + 1 < characters.length) {
            const pause = behavior.mode === "human" && this.random() > 0.965
              ? behavior.typingDelayMs * 3
              : behavior.typingDelayMs;
            await this.behaviorSleep(pause, behavior, 0.55, 1.65);
          }
        }
      }
    } else if (action === "key") {
      const key = requiredString(params, "key");
      const common = {
        key,
        code: typeof params.code === "string" ? params.code : undefined,
        modifiers: Number.isInteger(params.modifiers) ? params.modifiers : 0,
        text: typeof params.text === "string" ? params.text : undefined,
      };
      await this.ensureAttached(target.tabId, true, control);
      let keyDown = false;
      try {
        await this.sendInput(target, "Input.dispatchKeyEvent", { ...common, type: "keyDown" }, behavior, control);
        keyDown = true;
        if (behavior.mode === "human") {
          await this.behaviorSleep(Math.max(25, behavior.typingDelayMs), behavior, 0.5, 1.25);
        }
      } finally {
        if (keyDown) await this.sendInput(target, "Input.dispatchKeyEvent", { ...common, type: "keyUp" }, behavior);
      }
      assertActive(control);
    } else if (action === "scroll") {
      const x = finiteNumber(params, "x", this.pointerByTab.get(target.tabId)?.x || 0), y = finiteNumber(params, "y", this.pointerByTab.get(target.tabId)?.y || 0);
      const deltaX = finiteNumber(params, "deltaX", 0), deltaY = finiteNumber(params, "deltaY", 0);
      await this.ensureAttached(target.tabId, true, control);
      if (behavior.mode !== "human") {
        await this.sendInput(target, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX,
          deltaY,
        }, behavior, control);
      } else {
        await this.humanScroll(target, x, y, deltaX, deltaY, behavior, control);
      }
    } else if (action === "drag") {
      const from = asObject(params.from, "from"), to = asObject(params.to, "to");
      const fromX = finiteNumber(from, "x"), fromY = finiteNumber(from, "y");
      const toX = finiteNumber(to, "x"), toY = finiteNumber(to, "y");
      await this.ensureAttached(target.tabId, true, control);
      await this.movePointer(target, fromX, fromY, behavior, "none", control);
      let pressed = false;
      try {
        await this.sendInput(target, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: fromX,
          y: fromY,
          button: "left",
          clickCount: 1,
        }, behavior, control);
        pressed = true;
        if (behavior.mode === "human") {
          await this.behaviorSleep(Math.max(30, behavior.typingDelayMs), behavior, 0.55, 1.25);
        }
        await this.movePointer(target, toX, toY, behavior, "left", control);
      } finally {
        if (pressed) {
          const current = this.pointerByTab.get(target.tabId) || { x: fromX, y: fromY };
          await this.sendInput(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: current.x,
            y: current.y,
            button: "left",
            clickCount: 1,
          }, behavior);
        }
      }
      assertActive(control);
    } else if (action === "touch") {
      const x = finiteNumber(params, "x"), y = finiteNumber(params, "y");
      await this.ensureAttached(target.tabId, true, control);
      let touched = false;
      try {
        await this.sendInput(target, "Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 0 }],
        }, behavior, control);
        touched = true;
        if (behavior.mode === "human") {
          await this.behaviorSleep(Math.max(40, behavior.typingDelayMs), behavior, 0.65, 1.4);
        }
      } finally {
        if (touched) {
          await this.sendInput(target, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, behavior);
        }
      }
      assertActive(control);
    } else {
      throw new MoneyHandError("UNKNOWN_INPUT_ACTION", `Unknown input action '${action}'`);
    }
    return { target, action, ok: true };
  }

  async sendInput(target, method, params, behavior, control) {
    assertActive(control);
    await this.chrome.debugger.sendCommand(target, method, params);
  }

  async movePointer(target, x, y, behavior, button = "none", control) {
    const human = behavior.mode === "human";
    const remembered = this.pointerByTab.get(target.tabId);
    const previous = remembered || (human
      ? { x: x + this.randomBetween(-14, 14), y: y + this.randomBetween(-10, 10) }
      : { x, y });
    const steps = human
      ? Math.max(1, Math.min(100, Math.round(behavior.pointerSteps * this.randomBetween(0.8, 1.25))))
      : behavior.pointerSteps;
    const duration = human
      ? this.variedDelay(behavior.pointerDurationMs, behavior, 0.75, 1.3)
      : behavior.pointerDurationMs;
    const stepDelay = steps > 1 ? duration / (steps - 1) : 0;
    const dx = x - previous.x;
    const dy = y - previous.y;
    const distance = Math.hypot(dx, dy);
    const curve = human
      ? Math.min(90, Math.max(6, distance * 0.18)) * this.randomBetween(-1, 1)
      : 0;
    const perpendicularX = distance ? -dy / distance : 0;
    const perpendicularY = distance ? dx / distance : 0;
    const control1 = {
      x: previous.x + dx * 0.3 + perpendicularX * curve,
      y: previous.y + dy * 0.3 + perpendicularY * curve,
    };
    const control2 = {
      x: previous.x + dx * 0.72 - perpendicularX * curve * 0.45,
      y: previous.y + dy * 0.72 - perpendicularY * curve * 0.45,
    };
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps;
      const inverse = 1 - ratio;
      const nextX = human
        ? inverse ** 3 * previous.x
          + 3 * inverse ** 2 * ratio * control1.x
          + 3 * inverse * ratio ** 2 * control2.x
          + ratio ** 3 * x
        : previous.x + dx * ratio;
      const nextY = human
        ? inverse ** 3 * previous.y
          + 3 * inverse ** 2 * ratio * control1.y
          + 3 * inverse * ratio ** 2 * control2.y
          + ratio ** 3 * y
        : previous.y + dy * ratio;
      await this.sendInput(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: index === steps ? x : nextX,
        y: index === steps ? y : nextY,
        button,
        buttons: button === "left" ? 1 : 0,
      }, behavior, control);
      this.pointerByTab.set(target.tabId, {
        x: index === steps ? x : nextX,
        y: index === steps ? y : nextY,
      });
      if (index < steps) await sleep(stepDelay);
    }
  }

  async humanScroll(target, x, y, deltaX, deltaY, behavior, control) {
    const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    const steps = Math.max(3, Math.min(12, Math.round(3 + Math.log2(1 + magnitude))));
    let sentX = 0;
    let sentY = 0;
    for (let index = 1; index <= steps; index += 1) {
      const previousRatio = (index - 1) / steps;
      const ratio = index / steps;
      const easedPrevious = 1 - (1 - previousRatio) ** 3;
      const eased = 1 - (1 - ratio) ** 3;
      const nextX = index === steps ? deltaX - sentX : deltaX * (eased - easedPrevious);
      const nextY = index === steps ? deltaY - sentY : deltaY * (eased - easedPrevious);
      await this.sendInput(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: nextX,
        deltaY: nextY,
      }, behavior, control);
      sentX += nextX;
      sentY += nextY;
      if (index < steps) {
        await this.behaviorSleep(Math.max(12, behavior.betweenStepsMs / 2), behavior, 0.55, 1.3);
      }
    }
  }

  async batchRun(params, behavior, control = {}) {
    const steps = params.steps;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_BATCH_STEPS) {
      throw new MoneyHandError("INVALID_BATCH", `batch.run requires 1-${MAX_BATCH_STEPS} steps`);
    }
    const allowed = new Set(["cdp.send", "chrome.call", "input.perform", "observe.context", "sleep"]);
    const tabIds = new Set(steps.flatMap((step) => this.tabIdsFor(step?.method, step?.params)));
    if (tabIds.size > 1) {
      throw new MoneyHandError("INVALID_BATCH", "One batch may target only one tab");
    }
    const results = [];
    for (let index = 0; index < steps.length; index += 1) {
      assertActive(control);
      const step = asObject(steps[index], `steps[${index}]`);
      const method = requiredString(step, "method");
      if (!allowed.has(method)) throw new MoneyHandError("INVALID_BATCH", `Method '${method}' is not allowed in a batch`);
      try {
        this.assertNotWaiting(method, step.params || {});
        const result = method === "sleep"
          ? await sleep(Math.max(0, Math.min(30_000, finiteNumber(step.params || {}, "ms", 0)))).then(() => ({ slept: true }))
          : await this.executeOnce(method, step.params ? asObject(step.params, "step.params") : {}, behavior, control);
        results.push({ index, method, ok: true, result });
      } catch (error) {
        results.push({ index, method, ok: false, error: errorMessage(error) });
        if (params.continueOnError !== true || !batchMayContinue(error)) {
          throw new MoneyHandError(
            typeof error?.code === "string" ? error.code : "BATCH_FAILED",
            `Batch failed at step ${index}: ${errorMessage(error)}`,
            { failedAt: index, causeCode: error?.code || "COMMAND_FAILED", results },
          );
        }
      }
      if (index + 1 < steps.length) await this.behaviorSleep(behavior.betweenStepsMs, behavior);
    }
    return { completed: results.filter((result) => result.ok).length, total: steps.length, results };
  }

  async observeContext(params, behavior, control) {
    const target = targetFrom(params);
    await this.ensureAttached(target.tabId, true, control);
    assertActive(control);
    const maxTextChars = Number.isInteger(params.maxTextChars) ? Math.min(MAX_CONTEXT_CONTENT_CHARS, Math.max(1_000, params.maxTextChars)) : DEFAULT_MAX_TEXT_CHARS;
    const maxElements = Number.isInteger(params.maxElements) ? Math.min(MAX_CONTEXT_ELEMENTS, Math.max(0, params.maxElements)) : DEFAULT_MAX_ELEMENTS;
    const expression = `(() => {
      const maxText = ${maxTextChars};
      const maxElements = ${maxElements};
      let remaining = ${MAX_CONTEXT_CONTENT_CHARS};
      let contentTruncated = false;
      const take = (value, maximum) => {
        const input = typeof value === "string" ? value : "";
        const limit = Math.max(0, Math.min(maximum, remaining));
        const output = input.slice(0, limit);
        remaining -= output.length;
        if (output.length < input.length) contentTruncated = true;
        return output;
      };
      const bodyText = document.body?.innerText || document.documentElement?.innerText || "";
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const url = take(location.href, ${MAX_URL_CHARS});
      const title = take(document.title, ${MAX_TITLE_CHARS});
      const text = take(bodyText, maxText);
      const controls = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")]
        .filter(visible)
        .slice(0, maxElements)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type") || undefined,
            role: element.getAttribute("role") || undefined,
            text: take((element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim(), 300),
            href: element instanceof HTMLAnchorElement ? take(element.href, ${MAX_CONTROL_HREF_CHARS}) : undefined,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        });
      return {
        url,
        title,
        readyState: document.readyState,
        text,
        textTruncated: bodyText.length > text.length,
        controls,
        contentTruncated
      };
    })()`;
    const evaluated = await this.chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (evaluated?.exceptionDetails) {
      throw new MoneyHandError("OBSERVE_FAILED", evaluated.exceptionDetails.text || "Page context evaluation failed");
    }
    return { target, ...sanitizeContextValue(evaluated?.result?.value, maxTextChars, maxElements), untrustedPageContent: true };
  }

  async observeScreenshot(params, behavior, control) {
    const target = targetFrom(params);
    await this.ensureAttached(target.tabId, true, control);
    assertActive(control);
    const format = params.format === "jpeg" ? "jpeg" : "png";
    const command = {
      format,
      fromSurface: true,
      captureBeyondViewport: params.fullPage === true,
    };
    if (format === "jpeg" && Number.isInteger(params.quality)) {
      command.quality = Math.max(0, Math.min(100, params.quality));
    }
    const result = await this.chrome.debugger.sendCommand(target, "Page.captureScreenshot", command);
    if (typeof result?.data !== "string") throw new MoneyHandError("SCREENSHOT_FAILED", "Chrome did not return screenshot data");
    const approximateBytes = Math.floor(result.data.length * 0.75);
    if (approximateBytes > MAX_SCREENSHOT_BYTES) {
      throw new MoneyHandError("SCREENSHOT_TOO_LARGE", "Screenshot exceeds the 4 MiB decoded response limit");
    }
    return {
      target,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      data: result.data,
    };
  }

  shouldForwardEvent(method) {
    return [...this.eventPatterns.values()].some((pattern) => pattern.test(method));
  }

  async onDebuggerEvent(source, method, params) {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return undefined;
    const lifecycleEvent = method === "Target.attachedToTarget" || method === "Target.detachedFromTarget";
    let autoAttachError;
    if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
      let sessions = this.childSessions.get(tabId);
      if (!sessions) {
        sessions = new Map();
        this.childSessions.set(tabId, sessions);
      }
      sessions.set(params.sessionId, {
        parentSessionId: source.sessionId,
        targetInfo: params.targetInfo || {},
        autoAttachConfigured: false,
      });
      if (this.autoAttachConfiguredTabs.has(tabId) && params.targetInfo?.type === "iframe") {
        try {
          await this.chrome.debugger.sendCommand({ tabId, sessionId: params.sessionId }, "Target.setAutoAttach", AUTO_ATTACH);
          const entry = sessions.get(params.sessionId);
          if (entry) entry.autoAttachConfigured = true;
        } catch (error) {
          autoAttachError = clippedString(errorMessage(error), 2_048);
          const entry = sessions.get(params.sessionId);
          if (entry) entry.autoAttachError = autoAttachError;
        }
      }
    } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      this.removeChildSession(tabId, params.sessionId);
    }
    if (!lifecycleEvent && !this.shouldForwardEvent(method)) return undefined;
    return {
      event: "cdp",
      target: eventTarget(source),
      data: { method, params: params || {}, ...(autoAttachError ? { autoAttachError } : {}) },
    };
  }

  onDebuggerDetach(source, reason) {
    const tabId = source?.tabId;
    if (Number.isInteger(tabId)) this.cleanupTab(tabId);
    return {
      event: "debugger.detach",
      target: eventTarget(source),
      data: { reason },
    };
  }

  onTabRemoved(tabId) {
    this.cleanupTab(tabId);
    return {
      event: "tab.removed",
      target: { tabId },
      data: {},
    };
  }

  cleanupTab(tabId) {
    this.attachedTabs.delete(tabId); this.autoAttachConfiguredTabs.delete(tabId);
    this.childSessions.delete(tabId); this.pointerByTab.delete(tabId);
    this.waitingTabs.delete(tabId);
  }

  removeChildSession(tabId, sessionId) {
    const sessions = this.childSessions.get(tabId);
    if (!sessions) return;
    const remove = [sessionId];
    while (remove.length) {
      const current = remove.pop();
      sessions.delete(current);
      for (const [childId, child] of sessions) {
        if (child.parentSessionId === current) remove.push(childId);
      }
    }
    if (sessions.size === 0) this.childSessions.delete(tabId);
  }

  assertNotWaiting(method, params) {
    if (WAITING_ALLOWED.has(method)) return;
    if (method === "chrome.call" && READ_ONLY_CHROME_CALLS.has(params.method)) return;
    const tabIds = this.tabIdsFor(method, params);
    let tabId = tabIds.find((candidate) => this.waitingTabs.has(candidate));
    if (!tabId && method === "chrome.call" && !CHROME_CALLS_SAFE_DURING_WAIT.has(params.method) && this.waitingTabs.size) {
      tabId = this.waitingTabs.keys().next().value;
    }
    if (tabId) {
      const wait = this.waitingTabs.get(tabId);
      throw new MoneyHandError("TAB_WAITING", `Tab ${tabId} is waiting for Agent instruction '${wait.waitId}'`, {
        waitId: wait.waitId,
        tabId,
      });
    }
  }

  pauseForInstruction(tabId, error) {
    if (!tabId) return undefined;
    const existing = this.waitingTabs.get(tabId);
    if (existing) return existing;
    const wait = {
      waitId: `wait_${this.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      since: new Date(this.now()).toISOString(),
      error: clippedString(errorMessage(error), 2_048),
    };
    this.waitingTabs.set(tabId, wait);
    return wait;
  }

  waitingSnapshot() {
    return [...this.waitingTabs].map(([tabId, wait]) => ({ tabId, ...wait }));
  }

  restoreWaiting(values) {
    this.waitingTabs.clear();
    for (const value of Array.isArray(values) ? values : []) {
      if (Number.isInteger(value?.tabId) && value.tabId > 0
        && typeof value.waitId === "string" && typeof value.since === "string") {
        this.waitingTabs.set(value.tabId, {
          waitId: value.waitId,
          since: value.since,
          error: typeof value.error === "string" ? value.error : "Restored instruction wait",
        });
      }
    }
  }

  async resolveInstruction(params) {
    const tabId = positiveTabId(params.tabId);
    const wait = this.waitingTabs.get(tabId);
    if (!wait) throw new MoneyHandError("NOT_WAITING", `Tab ${tabId} is not waiting for instruction`);
    if (params.waitId !== wait.waitId) throw new MoneyHandError("WAIT_ID_MISMATCH", "instruction.resolve waitId does not match");
    if (!["resume", "cancel"].includes(params.action)) {
      throw new MoneyHandError("INVALID_ARGUMENT", "instruction.resolve action must be 'resume' or 'cancel'");
    }
    this.waitingTabs.delete(tabId);
    return { tabId, waitId: wait.waitId, action: params.action, waiting: false };
  }

  async failureContext(params, behaviorOverride) {
    const behavior = this.effectiveBehavior(behaviorOverride);
    let target;
    try {
      target = targetFrom(params);
    } catch {
      for (const step of params?.steps || []) {
        try {
          target = targetFrom(step?.params || {});
          break;
        } catch {
          target = undefined;
        }
      }
    }
    if (!target) {
      const active = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (Number.isInteger(active[0]?.id)) target = { tabId: active[0].id };
    }
    if (!target) return { target: {}, context: { text: "", note: "No tab target was available" } };
    const tab = await this.chrome.tabs.get(target.tabId).catch(() => undefined);
    const base = sanitizeContextValue({
      url: tab?.url || "",
      title: tab?.title || "",
      text: "",
      controls: [],
    }, 0, 0);
    if (behavior.onUnclear === "error") return { target, context: base };
    try {
      const observed = await this.observeContext({ target }, behavior);
      return { target, context: observed };
    } catch (error) {
      return {
        target,
        context: {
          ...base,
          note: clippedString(`Text context unavailable: ${errorMessage(error)}`, 2_048),
        },
      };
    }
  }

  shouldRequestInstruction(error, params) {
    if (DIRECT_ERROR_CODES.has(error?.code)) return false;
    return Boolean(this.tabIdFromParams(params));
  }

  async detachAll(waitMs = 5_000) {
    const tabIds = [...new Set([...this.attachedTabs, ...this.attachmentLocks.keys()])];
    const results = [];
    const tasks = tabIds.map(async (tabId) => {
      try {
        let detached = false;
        await this.withAttachmentLock(tabId, async () => {
          if (this.attachedTabs.has(tabId)) detached = await this.detachLocked(tabId, true);
        });
        results.push({ tabId, detached });
      } catch (error) {
        results.push({ tabId, detached: false, error: errorMessage(error) });
      }
    });
    let timer;
    await Promise.race([Promise.all(tasks), new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
    const settledTabs = new Set(results.map((result) => result.tabId));
    return {
      detachedTabs: results.filter((result) => result.detached).map((result) => result.tabId),
      failedTabs: results.filter((result) => result.error).map(({ tabId, error }) => ({ tabId, error })),
      pendingTabs: tabIds.filter((tabId) => !settledTabs.has(tabId)),
    };
  }
}

export const __test__ = {
  ALLOWED_CHROME_CALLS,
  CHROME_CALLS_SAFE_DURING_WAIT,
  EXCLUSIVE_CHROME_CALLS,
  MAX_CONTEXT_CONTENT_CHARS,
  batchMayContinue,
  DIRECT_ERROR_CODES,
  READ_ONLY_CHROME_CALLS,
  TAB_MUTATIONS_WITH_ID,
  requestIsExclusive,
  sanitizeContextValue,
  targetFrom,
  validateChromeCallScope,
};
