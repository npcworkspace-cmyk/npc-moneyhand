export const PRODUCT = "npc-moneyhand";
export const PROTOCOL = "npc-moneyhand/2", PROTOCOL_VERSION = 2;
export const DEFAULT_ADDRESS = "127.0.0.1", DEFAULT_PORT = 19_846, DEFAULT_PATH = "/extension";
export const DEFAULT_ENDPOINT = `ws://${DEFAULT_ADDRESS}:${DEFAULT_PORT}${DEFAULT_PATH}`;
export const MAX_MESSAGE_BYTES = 1024 * 1024, MAX_QUEUE_DEPTH = 500, MAX_BATCH_STEPS = 200;
export const MAX_CONTEXT_BYTES = 512 * 1024, MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_UNKNOWN_OUTCOME_IDS = 512, MAX_FOCUS_FUTURE_MS = 60_000, INPUT_COORDINATE_SPACE = "css-viewport-v1";

export const DEFAULT_BEHAVIOR = Object.freeze({
  mode: "raw",
  beforeMs: 0, afterMs: 0, betweenStepsMs: 0,
  typingDelayMs: 0, pointerSteps: 1, pointerDurationMs: 0,
  onUnclear: "ask",
  ttlMs: 300_000,
});

export const HUMAN_BEHAVIOR = Object.freeze({
  mode: "human",
  beforeMs: 90, afterMs: 120, betweenStepsMs: 80,
  typingDelayMs: 55, pointerSteps: 12, pointerDurationMs: 420,
  onUnclear: "ask",
  ttlMs: 300_000,
});

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9_.-]{1,80}$/;
const PROFILE_PATTERN = /^[\p{L}\p{N}_-]{1,64}$/u;
const BEHAVIOR_KEYS = new Set(Object.keys(DEFAULT_BEHAVIOR));
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "localhost", "::1"]);

export class MoneyHandError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MoneyHandError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asObject(value, label = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandError("INVALID_ARGUMENT", `${label} must be an object`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MoneyHandError("INVALID_BEHAVIOR", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeBehavior(base = DEFAULT_BEHAVIOR, patch = {}) {
  const input = asObject(patch, "behavior");
  for (const key of Object.keys(input)) {
    if (!BEHAVIOR_KEYS.has(key)) throw new MoneyHandError("INVALID_BEHAVIOR", `Unknown behavior field '${key}'`);
  }
  const mode = input.mode ?? base.mode ?? "raw";
  if (!["raw", "human"].includes(mode)) {
    throw new MoneyHandError("INVALID_BEHAVIOR", "behavior.mode must be 'raw' or 'human'");
  }
  const modeChanged = input.mode !== undefined && input.mode !== base.mode;
  const preset = mode === "human" ? HUMAN_BEHAVIOR : DEFAULT_BEHAVIOR;
  const next = { ...(modeChanged ? preset : base), ...input, mode };
  if (!["ask", "error"].includes(next.onUnclear)) {
    throw new MoneyHandError("INVALID_BEHAVIOR", "behavior.onUnclear must be 'ask' or 'error'");
  }
  next.beforeMs = integer(next.beforeMs, 0, 30_000, "behavior.beforeMs");
  next.afterMs = integer(next.afterMs, 0, 30_000, "behavior.afterMs");
  next.betweenStepsMs = integer(next.betweenStepsMs, 0, 30_000, "behavior.betweenStepsMs");
  next.typingDelayMs = integer(next.typingDelayMs, 0, 2_000, "behavior.typingDelayMs");
  next.pointerSteps = integer(next.pointerSteps, 1, 100, "behavior.pointerSteps");
  next.pointerDurationMs = integer(next.pointerDurationMs, 0, 30_000, "behavior.pointerDurationMs");
  next.ttlMs = integer(next.ttlMs, 1_000, 86_400_000, "behavior.ttlMs");
  return next;
}

export function parseWireMessage(data) {
  if (typeof data !== "string") throw new MoneyHandError("INVALID_MESSAGE", "Only JSON text frames are supported");
  if (data.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
    throw new MoneyHandError("MESSAGE_TOO_LARGE", "Message exceeds the 1 MiB UTF-8 limit");
  }
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    throw new MoneyHandError("INVALID_JSON", "Message is not valid JSON");
  }
  return asObject(message, "message");
}

export function parseRequest(message) {
  const value = asObject(message, "request");
  if (value.v !== PROTOCOL_VERSION) {
    throw new MoneyHandError("UNSUPPORTED_PROTOCOL", `Expected protocol version ${PROTOCOL_VERSION}`);
  }
  if (value.type !== "request") throw new MoneyHandError("INVALID_MESSAGE", "Expected a request message");
  if (!requestIdIsValid(value.id)) {
    throw new MoneyHandError("INVALID_ID", "request.id must use 1-128 letters, numbers, '.', '_', ':' or '-'");
  }
  if (typeof value.method !== "string" || !METHOD_PATTERN.test(value.method)) {
    throw new MoneyHandError("INVALID_METHOD", "request.method is invalid");
  }
  const request = {
    v: PROTOCOL_VERSION,
    type: "request",
    id: value.id,
    method: value.method,
    params: value.params === undefined ? {} : asObject(value.params, "request.params"),
  };
  if (value.behavior !== undefined) request.behavior = asObject(value.behavior, "request.behavior");
  return request;
}

export function requestIdIsValid(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function profileIsValid(profile) {
  return typeof profile === "string" && PROFILE_PATTERN.test(profile);
}

export function pairingTokenIsValid(token) {
  return token === "" || (typeof token === "string" && token.length >= 16 && token.length <= 512);
}

export function addressIsAllowed(address) {
  return typeof address === "string"
    && LOOPBACK_ADDRESSES.has(address.trim().replace(/^\[(.*)\]$/u, "$1").toLowerCase());
}

export function portIsValid(port) {
  const text = typeof port === "number" ? String(port) : port?.trim();
  if (typeof text !== "string" || !/^\d{1,5}$/u.test(text)) return false;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export function endpointFromAddressPort(address, port) {
  if (!addressIsAllowed(address) || !portIsValid(port)) {
    throw new MoneyHandError("INVALID_ENDPOINT", "Address and port must identify a local WebSocket");
  }
  const normalized = address.trim().replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const host = normalized === "::1" ? "[::1]" : normalized;
  return `ws://${host}:${Number(port)}${DEFAULT_PATH}`;
}

export function endpointAddressPort(endpoint) {
  if (!endpointIsAllowed(endpoint)) return undefined;
  const url = new URL(endpoint);
  return {
    address: url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase(),
    port: Number(url.port || 80),
  };
}

export function endpointIsAllowed(endpoint) {
  if (typeof endpoint !== "string") return false;
  const match = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/extension$/iu.exec(endpoint);
  return Boolean(match && addressIsAllowed(match[1]) && portIsValid(match[2]));
}

export function responseMessage(id, result, durationMs = 0) {
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
    meta: { durationMs },
  };
}

export function errorObject(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "COMMAND_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

export function errorMessage(id, error, durationMs = 0) {
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: errorObject(error),
    meta: { durationMs },
  };
}

export function needInstructionMessage(id, waitId, target, error, context, durationMs = 0) {
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    status: "needs_instruction",
    error: errorObject(error),
    need: {
      waitId,
      target,
      context: {
        ...context,
        untrustedPageContent: true,
      },
    },
    meta: { durationMs },
  };
}

export function compileMethodPattern(pattern) {
  if (pattern === "*") return /^.*$/u;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u");
}

export function methodMatches(pattern, method) {
  return compileMethodPattern(pattern).test(method);
}

export function sleep(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
