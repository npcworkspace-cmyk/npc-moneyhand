const MAX_CONCURRENCY = 256;
const MAX_DELAY_MS = 86_400_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CHECKPOINT_LENGTH = 2_048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const OPTION_KEYS = new Set([
  "now",
  "random",
  "sleep",
  "minConcurrency",
  "maxConcurrency",
  "pilotConcurrency",
  "pilotCleanBatches",
  "cleanBatchesToIncrease",
  "baseDelayMs",
  "maxDelayMs",
  "jitterRatio",
  "persistent403Threshold",
  "minConcurrencyThrottleThreshold",
  "latencyRegressionFactor",
  "latencyFloorMs",
]);
const SCOPE_KEYS = new Set(["origin", "profile", "account"]);
const PLAN_KEYS = new Set(["scope", "mode"]);
const OBSERVATION_KEYS = new Set([
  "scope",
  "mode",
  "status",
  "headers",
  "throttle",
  "challenge",
  "accountChanged",
  "latencyMs",
  "clean",
  "checkpoint",
]);
const CHECKPOINT_KEYS = new Set(["scope", "token"]);
const SNAPSHOT_KEYS = new Set(["scope"]);
const RESET_KEYS = new Set(["scope"]);
const WAIT_OPTION_KEYS = new Set(["signal"]);
const BEHAVIOR_MODES = new Set(["raw", "human"]);

export const RATE_CONTROL_DEFAULTS = Object.freeze({
  minConcurrency: 1,
  maxConcurrency: 8,
  pilotConcurrency: 1,
  pilotCleanBatches: 2,
  cleanBatchesToIncrease: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 120_000,
  jitterRatio: 0.2,
  persistent403Threshold: 3,
  minConcurrencyThrottleThreshold: 3,
  latencyRegressionFactor: 3,
  latencyFloorMs: 1_500,
});

export class RateControlError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RateControlError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RateControlError("INVALID_RATE_CONTROL_INPUT", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RateControlError(
        "INVALID_RATE_CONTROL_INPUT",
        `Unknown ${label} field '${key}'`,
      );
    }
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function number(value, label, minimum, maximum, exclusiveMinimum = false) {
  const belowMinimum = exclusiveMinimum ? value <= minimum : value < minimum;
  if (!Number.isFinite(value) || belowMinimum || value > maximum) {
    const relation = exclusiveMinimum ? "greater than" : "at least";
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      `${label} must be ${relation} ${minimum} and at most ${maximum}`,
    );
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RateControlError("INVALID_RATE_CONTROL_INPUT", `${label} must be boolean`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > MAX_IDENTIFIER_LENGTH
    || value.trim() !== value
    || CONTROL_CHARACTERS.test(value)) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_SCOPE",
      `${label} must be a trimmed 1-${MAX_IDENTIFIER_LENGTH} character string without controls`,
    );
  }
  return value;
}

function checkpointToken(value) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > MAX_CHECKPOINT_LENGTH
    || CONTROL_CHARACTERS.test(value)) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      `checkpoint token must be a 1-${MAX_CHECKPOINT_LENGTH} character string without controls`,
    );
  }
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_SCOPE",
      "scope.origin must be an http(s) origin string",
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_SCOPE",
      "scope.origin must be an http(s) origin string",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_SCOPE",
      "scope.origin must contain only an http(s) scheme, host and optional port",
    );
  }
  return parsed.origin;
}

function normalizeScope(value) {
  const input = exactKeys(object(value, "scope"), SCOPE_KEYS, "scope");
  const scope = {
    origin: normalizeOrigin(input.origin),
    profile: identifier(input.profile, "scope.profile"),
  };
  if (input.account !== undefined) {
    scope.account = identifier(input.account, "scope.account");
  }
  return scope;
}

function scopeKey(scope) {
  return JSON.stringify([scope.origin, scope.profile, scope.account ?? null]);
}

function behaviorMode(value) {
  const mode = value ?? "raw";
  if (!BEHAVIOR_MODES.has(mode)) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      "mode must be 'raw' or 'human'",
    );
  }
  return mode;
}

function validateFunction(value, label) {
  if (typeof value !== "function") {
    throw new RateControlError("INVALID_RATE_CONTROL_INPUT", `${label} must be a function`);
  }
  return value;
}

function normalizeOptions(value) {
  const input = exactKeys(object(value, "options"), OPTION_KEYS, "options");
  const minConcurrency = input.minConcurrency === undefined
    ? RATE_CONTROL_DEFAULTS.minConcurrency
    : integer(input.minConcurrency, "minConcurrency", 1, MAX_CONCURRENCY);
  const maxConcurrency = input.maxConcurrency === undefined
    ? Math.max(minConcurrency, RATE_CONTROL_DEFAULTS.maxConcurrency)
    : integer(input.maxConcurrency, "maxConcurrency", minConcurrency, MAX_CONCURRENCY);
  const pilotConcurrency = input.pilotConcurrency === undefined
    ? Math.max(minConcurrency, Math.min(RATE_CONTROL_DEFAULTS.pilotConcurrency, maxConcurrency))
    : integer(input.pilotConcurrency, "pilotConcurrency", minConcurrency, maxConcurrency);
  const baseDelayMs = input.baseDelayMs === undefined
    ? RATE_CONTROL_DEFAULTS.baseDelayMs
    : integer(input.baseDelayMs, "baseDelayMs", 1, MAX_DELAY_MS);
  const maxDelayMs = input.maxDelayMs === undefined
    ? Math.max(baseDelayMs, RATE_CONTROL_DEFAULTS.maxDelayMs)
    : integer(input.maxDelayMs, "maxDelayMs", baseDelayMs, MAX_DELAY_MS);
  return {
    minConcurrency,
    maxConcurrency,
    pilotConcurrency,
    pilotCleanBatches: input.pilotCleanBatches === undefined
      ? RATE_CONTROL_DEFAULTS.pilotCleanBatches
      : integer(input.pilotCleanBatches, "pilotCleanBatches", 1, 100),
    cleanBatchesToIncrease: input.cleanBatchesToIncrease === undefined
      ? RATE_CONTROL_DEFAULTS.cleanBatchesToIncrease
      : integer(input.cleanBatchesToIncrease, "cleanBatchesToIncrease", 1, 100),
    baseDelayMs,
    maxDelayMs,
    jitterRatio: input.jitterRatio === undefined
      ? RATE_CONTROL_DEFAULTS.jitterRatio
      : number(input.jitterRatio, "jitterRatio", 0, 1),
    persistent403Threshold: input.persistent403Threshold === undefined
      ? RATE_CONTROL_DEFAULTS.persistent403Threshold
      : integer(input.persistent403Threshold, "persistent403Threshold", 1, 100),
    minConcurrencyThrottleThreshold: input.minConcurrencyThrottleThreshold === undefined
      ? RATE_CONTROL_DEFAULTS.minConcurrencyThrottleThreshold
      : integer(
        input.minConcurrencyThrottleThreshold,
        "minConcurrencyThrottleThreshold",
        1,
        100,
      ),
    latencyRegressionFactor: input.latencyRegressionFactor === undefined
      ? RATE_CONTROL_DEFAULTS.latencyRegressionFactor
      : number(input.latencyRegressionFactor, "latencyRegressionFactor", 1, 100, true),
    latencyFloorMs: input.latencyFloorMs === undefined
      ? RATE_CONTROL_DEFAULTS.latencyFloorMs
      : integer(input.latencyFloorMs, "latencyFloorMs", 0, MAX_DELAY_MS),
  };
}

function defaultSleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(rateControlAbortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(rateControlAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function optionalAbortSignal(value) {
  if (value === undefined) return undefined;
  if (!value
    || typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function") {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      "wait options.signal must be an AbortSignal",
    );
  }
  return value;
}

function rateControlAbortError() {
  return new RateControlError(
    "ABORTED",
    "Rate-control wait was aborted before work was dispatched",
    { actionDispatched: false, retry: "safe-to-recheck" },
  );
}

async function cancellableSleep(sleep, milliseconds, signal) {
  if (signal?.aborted) throw rateControlAbortError();
  if (!signal) return await sleep(milliseconds);
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => settle(rejectPromise, rateControlAbortError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => (settled ? undefined : sleep(milliseconds, signal)))
      .then(
        (value) => settle(resolvePromise, value),
        (error) => settle(rejectPromise, error),
      );
  });
}

function normalizeHeaders(value) {
  if (value === undefined) return {};
  const input = object(value, "headers");
  const entries = Object.entries(input);
  if (entries.length > 64) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      "headers must contain at most 64 fields",
    );
  }
  const normalized = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/u.test(name)
      || !["string", "number"].includes(typeof rawValue)
      || (typeof rawValue === "number" && !Number.isFinite(rawValue))
      || String(rawValue).length > 8_192
      || CONTROL_CHARACTERS.test(String(rawValue))) {
      throw new RateControlError(
        "INVALID_RATE_CONTROL_INPUT",
        `Invalid response header '${rawName}'`,
      );
    }
    if (Object.hasOwn(normalized, name)) {
      throw new RateControlError(
        "INVALID_RATE_CONTROL_INPUT",
        `Duplicate response header '${name}'`,
      );
    }
    normalized[name] = String(rawValue);
  }
  return normalized;
}

function parseRetryAfter(value, nowMs) {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) {
    throw new RateControlError("INVALID_RETRY_AFTER", "Retry-After cannot be empty");
  }
  if (/^\d+$/u.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new RateControlError("INVALID_RETRY_AFTER", "Retry-After is too large");
    }
    return milliseconds;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new RateControlError(
      "INVALID_RETRY_AFTER",
      "Retry-After must be integer seconds or a valid HTTP date",
    );
  }
  return Math.max(0, timestamp - nowMs);
}

function normalizeObservation(value, nowMs) {
  const input = exactKeys(object(value, "observation"), OBSERVATION_KEYS, "observation");
  const scope = normalizeScope(input.scope);
  const mode = behaviorMode(input.mode);
  const headers = normalizeHeaders(input.headers);
  const retryAfterMs = parseRetryAfter(headers["retry-after"], nowMs);
  const status = input.status === undefined
    ? undefined
    : integer(input.status, "status", 100, 599);
  const latencyMs = input.latencyMs === undefined
    ? undefined
    : number(input.latencyMs, "latencyMs", 0, MAX_DELAY_MS);
  optionalBoolean(input.throttle, "throttle");
  optionalBoolean(input.challenge, "challenge");
  optionalBoolean(input.accountChanged, "accountChanged");
  optionalBoolean(input.clean, "clean");
  if (input.checkpoint !== undefined) checkpointToken(input.checkpoint);
  if (status === undefined
    && retryAfterMs === null
    && input.throttle === undefined
    && input.challenge === undefined
    && input.accountChanged === undefined
    && latencyMs === undefined
    && input.clean === undefined) {
    throw new RateControlError(
      "INVALID_RATE_CONTROL_INPUT",
      "observation must include a response or explicit signal",
    );
  }
  return {
    scope,
    mode,
    status,
    retryAfterMs,
    throttle: input.throttle === true,
    challenge: input.challenge === true,
    accountChanged: input.accountChanged === true,
    latencyMs,
    clean: input.clean,
    checkpoint: input.checkpoint,
  };
}

function publicState(state) {
  return {
    scope: { ...state.scope },
    phase: state.phase,
    concurrency: state.concurrency,
    recoveryCeiling: state.recoveryCeiling,
    intervalMs: state.intervalMs,
    backoffLevel: state.backoffLevel,
    pilotCleanBatches: state.pilotCleanBatches,
    cleanBatches: state.cleanBatches,
    throttleCount: state.throttleCount,
    consecutive403: state.consecutive403,
    minConcurrencyThrottles: state.minConcurrencyThrottles,
    latencyBaselineMs: state.latencyBaselineMs,
    latencySamples: state.latencySamples,
    checkpointRequired: state.checkpointRequired,
    checkpoint: state.checkpoint ? { ...state.checkpoint } : null,
    cooldownUntilMs: state.cooldownUntilMs,
    circuit: state.circuit ? { ...state.circuit } : null,
    lastBehaviorMode: state.lastBehaviorMode,
    lastObservation: state.lastObservation
      ? { ...state.lastObservation, signals: [...state.lastObservation.signals] }
      : null,
    createdAtMs: state.createdAtMs,
    updatedAtMs: state.updatedAtMs,
  };
}

function newState(scope, config, nowMs) {
  return {
    scope,
    phase: "pilot",
    concurrency: config.pilotConcurrency,
    recoveryCeiling: config.maxConcurrency,
    intervalMs: 0,
    backoffLevel: 0,
    pilotCleanBatches: 0,
    cleanBatches: 0,
    throttleCount: 0,
    consecutive403: 0,
    minConcurrencyThrottles: 0,
    latencyBaselineMs: null,
    latencySamples: 0,
    checkpointRequired: false,
    checkpoint: null,
    cooldownUntilMs: null,
    circuit: null,
    lastBehaviorMode: "raw",
    lastObservation: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

function exponentialDelay(config, level) {
  if (level < 1) return 0;
  return Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** Math.min(level - 1, 52)));
}

function updateLatencyBaseline(state, latencyMs) {
  if (latencyMs === undefined) return;
  state.latencyBaselineMs = state.latencyBaselineMs === null
    ? latencyMs
    : Math.round(((state.latencyBaselineMs * 4) + latencyMs) / 5);
  state.latencySamples += 1;
}

function saveCheckpoint(state, token, nowMs) {
  state.checkpoint = { token, savedAtMs: nowMs };
  state.checkpointRequired = false;
  state.updatedAtMs = nowMs;
}

export class AdaptiveRateController {
  constructor(options = {}) {
    const input = exactKeys(object(options, "options"), OPTION_KEYS, "options");
    this.config = Object.freeze(normalizeOptions(input));
    this.now = input.now === undefined ? Date.now : validateFunction(input.now, "now");
    this.random = input.random === undefined ? Math.random : validateFunction(input.random, "random");
    this.sleep = input.sleep === undefined ? defaultSleep : validateFunction(input.sleep, "sleep");
    this.states = new Map();
  }

  time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RateControlError(
        "INVALID_RATE_CONTROL_CLOCK",
        "now() must return a non-negative safe integer epoch in milliseconds",
      );
    }
    return value;
  }

  randomValue() {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RateControlError(
        "INVALID_RATE_CONTROL_RANDOM",
        "random() must return a number in [0, 1)",
      );
    }
    return value;
  }

  state(scope, nowMs, create = true) {
    const key = scopeKey(scope);
    let state = this.states.get(key);
    if (!state && create) {
      state = newState(scope, this.config, nowMs);
      this.states.set(key, state);
    }
    return state ?? null;
  }

  refresh(state, nowMs) {
    if (!state.circuit
      && state.cooldownUntilMs !== null
      && nowMs >= state.cooldownUntilMs) {
      state.cooldownUntilMs = null;
      state.phase = "recovery";
      state.updatedAtMs = nowMs;
    }
  }

  decision(state, mode, nowMs) {
    this.refresh(state, nowMs);
    const waitMs = state.cooldownUntilMs === null
      ? 0
      : Math.max(0, state.cooldownUntilMs - nowMs);
    const stop = state.circuit !== null;
    return {
      allowed: !stop && waitMs === 0,
      stop,
      reason: stop ? state.circuit.reason : waitMs > 0 ? "cooldown" : state.phase,
      behaviorMode: mode,
      humanBypassesRateControl: false,
      concurrency: state.concurrency,
      intervalMs: state.intervalMs,
      waitMs,
      retryAtMs: waitMs > 0 ? state.cooldownUntilMs : null,
      checkpointRequired: state.checkpointRequired,
      phase: state.phase,
    };
  }

  plan(value) {
    const input = exactKeys(object(value, "plan"), PLAN_KEYS, "plan");
    const scope = normalizeScope(input.scope);
    const mode = behaviorMode(input.mode);
    const nowMs = this.time();
    return this.decision(this.state(scope, nowMs), mode, nowMs);
  }

  observe(value) {
    const nowMs = this.time();
    const observation = normalizeObservation(value, nowMs);
    const existingState = this.state(observation.scope, nowMs, false);

    const signals = [];
    if (observation.status === 429) signals.push("http-429");
    if (observation.status === 503) signals.push("http-503");
    if (observation.status === 403) signals.push("http-403");
    if (observation.retryAfterMs !== null) signals.push("retry-after");
    if (observation.throttle) signals.push("throttle");
    if (observation.challenge) signals.push("challenge");
    if (observation.accountChanged) signals.push("account-change");

    const latencyRegression = observation.latencyMs !== undefined
      && existingState?.latencyBaselineMs !== null
      && existingState?.latencyBaselineMs !== undefined
      && observation.latencyMs >= this.config.latencyFloorMs
      && observation.latencyMs
        > existingState.latencyBaselineMs * this.config.latencyRegressionFactor;
    if (latencyRegression) signals.push("latency-regression");

    const throttle = signals.some((signal) => [
      "http-429",
      "http-503",
      "http-403",
      "retry-after",
      "throttle",
      "latency-regression",
    ].includes(signal));
    const inferredClean = observation.clean === true
      || (observation.clean === undefined
        && observation.status !== undefined
        && observation.status >= 200
        && observation.status < 400
        && !throttle
        && !observation.challenge
        && !observation.accountChanged);
    if (observation.clean === true && signals.length > 0) {
      throw new RateControlError(
        "CONFLICTING_RATE_CONTROL_SIGNAL",
        "clean:true cannot be combined with a throttle or stop signal",
      );
    }

    const state = existingState ?? this.state(observation.scope, nowMs);
    this.refresh(state, nowMs);
    const actions = [];
    if (state.circuit) {
      if (observation.checkpoint !== undefined) {
        saveCheckpoint(state, observation.checkpoint, nowMs);
      }
      state.lastBehaviorMode = observation.mode;
      state.lastObservation = {
        atMs: nowMs,
        status: observation.status ?? null,
        latencyMs: observation.latencyMs ?? null,
        signals,
      };
      state.updatedAtMs = nowMs;
      return {
        signals,
        actions: ["circuit-remains-open"],
        decision: this.decision(state, observation.mode, nowMs),
        state: publicState(state),
      };
    }

    const nextConsecutive403 = observation.status === 403
      ? state.consecutive403 + 1
      : observation.status !== undefined || inferredClean
        ? 0
        : state.consecutive403;

    if (observation.challenge || observation.accountChanged) {
      state.consecutive403 = nextConsecutive403;
      if (observation.checkpoint !== undefined) {
        saveCheckpoint(state, observation.checkpoint, nowMs);
      }
      state.checkpointRequired = observation.checkpoint === undefined;
      if (state.checkpointRequired) actions.push("checkpoint-required");
      const reason = observation.challenge ? "challenge" : "account-change";
      state.circuit = { reason, openedAtMs: nowMs };
      state.phase = "circuit-open";
      state.cooldownUntilMs = null;
      actions.push("open-circuit");
    } else if (throttle) {
      const previousConcurrency = state.concurrency;
      const nextConcurrency = previousConcurrency > this.config.minConcurrency
        ? Math.max(this.config.minConcurrency, Math.floor(previousConcurrency / 2))
        : previousConcurrency;
      const nextMinConcurrencyThrottles = previousConcurrency === this.config.minConcurrency
        ? state.minConcurrencyThrottles + 1
        : 0;
      const stopReason = nextConsecutive403 >= this.config.persistent403Threshold
        ? "persistent-403"
        : nextMinConcurrencyThrottles >= this.config.minConcurrencyThrottleThreshold
          ? "repeated-throttle-at-minimum-concurrency"
          : null;
      let backoffLevel = state.backoffLevel;
      let intervalMs = state.intervalMs;
      let cooldownMs = 0;
      if (!stopReason) {
        backoffLevel += 1;
        const exponentialMs = exponentialDelay(this.config, backoffLevel);
        const jitter = 1 + (((this.randomValue() * 2) - 1) * this.config.jitterRatio);
        intervalMs = Math.max(1, Math.min(this.config.maxDelayMs, Math.round(exponentialMs * jitter)));
        cooldownMs = Math.max(intervalMs, observation.retryAfterMs ?? 0);
      }

      state.throttleCount += 1;
      state.consecutive403 = nextConsecutive403;
      state.cleanBatches = 0;
      state.pilotCleanBatches = state.phase === "pilot" ? 0 : state.pilotCleanBatches;
      state.minConcurrencyThrottles = nextMinConcurrencyThrottles;
      state.recoveryCeiling = Math.min(
        state.recoveryCeiling,
        Math.max(this.config.minConcurrency, previousConcurrency - 1),
      );
      if (nextConcurrency !== previousConcurrency) {
        state.concurrency = nextConcurrency;
        actions.push("reduce-concurrency");
      }
      if (observation.checkpoint !== undefined) {
        saveCheckpoint(state, observation.checkpoint, nowMs);
      }
      state.checkpointRequired = observation.checkpoint === undefined;
      if (state.checkpointRequired) actions.push("checkpoint-required");

      if (stopReason) {
        state.circuit = { reason: stopReason, openedAtMs: nowMs };
        state.phase = "circuit-open";
        state.cooldownUntilMs = null;
        actions.push("open-circuit");
      } else {
        state.backoffLevel = backoffLevel;
        state.intervalMs = intervalMs;
        state.cooldownUntilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + cooldownMs);
        state.phase = "cooldown";
        actions.push("cooldown");
      }
    } else if (inferredClean) {
      state.consecutive403 = 0;
      if (observation.checkpoint !== undefined) {
        saveCheckpoint(state, observation.checkpoint, nowMs);
      }
      state.minConcurrencyThrottles = 0;
      updateLatencyBaseline(state, observation.latencyMs);
      if (state.phase === "cooldown") {
        state.cleanBatches = 0;
      } else if (state.phase === "pilot") {
        state.pilotCleanBatches += 1;
        if (state.pilotCleanBatches >= this.config.pilotCleanBatches) {
          state.phase = "steady";
          state.cleanBatches = 0;
          actions.push("pilot-complete");
          if (state.concurrency < state.recoveryCeiling) {
            state.concurrency += 1;
            actions.push("increase-concurrency");
          }
        }
      } else {
        state.cleanBatches += 1;
        if (state.cleanBatches >= this.config.cleanBatchesToIncrease) {
          state.cleanBatches = 0;
          if (state.backoffLevel > 0) state.backoffLevel -= 1;
          state.intervalMs = exponentialDelay(this.config, state.backoffLevel);
          if (state.concurrency < state.recoveryCeiling) {
            state.concurrency += 1;
            actions.push("increase-concurrency");
          }
          state.phase = state.backoffLevel > 0
            || state.concurrency < state.recoveryCeiling
            ? "recovery"
            : "steady";
          actions.push("relax-backoff");
        }
      }
    } else {
      state.consecutive403 = nextConsecutive403;
      if (observation.checkpoint !== undefined) {
        saveCheckpoint(state, observation.checkpoint, nowMs);
      }
      state.cleanBatches = 0;
      if (state.phase === "pilot") state.pilotCleanBatches = 0;
    }

    state.lastBehaviorMode = observation.mode;
    state.lastObservation = {
      atMs: nowMs,
      status: observation.status ?? null,
      latencyMs: observation.latencyMs ?? null,
      signals,
    };
    state.updatedAtMs = nowMs;
    return {
      signals,
      actions,
      decision: this.decision(state, observation.mode, nowMs),
      state: publicState(state),
    };
  }

  checkpoint(value) {
    const input = exactKeys(object(value, "checkpoint"), CHECKPOINT_KEYS, "checkpoint");
    const scope = normalizeScope(input.scope);
    const token = checkpointToken(input.token);
    const nowMs = this.time();
    const state = this.state(scope, nowMs);
    saveCheckpoint(state, token, nowMs);
    return publicState(state);
  }

  async wait(value, options = {}) {
    const waitOptions = exactKeys(object(options, "wait options"), WAIT_OPTION_KEYS, "wait option");
    const signal = optionalAbortSignal(waitOptions.signal);
    if (signal?.aborted) throw rateControlAbortError();
    const input = exactKeys(object(value, "wait"), PLAN_KEYS, "wait");
    const first = this.plan(input);
    if (first.stop) {
      throw new RateControlError(
        "RATE_CONTROL_CIRCUIT_OPEN",
        `Rate-control circuit is open: ${first.reason}`,
      );
    }
    if (first.waitMs > 0) await cancellableSleep(this.sleep, first.waitMs, signal);
    if (signal?.aborted) throw rateControlAbortError();
    return this.plan(input);
  }

  snapshot(value = {}) {
    const input = exactKeys(object(value, "snapshot"), SNAPSHOT_KEYS, "snapshot");
    const nowMs = this.time();
    if (input.scope !== undefined) {
      const scope = normalizeScope(input.scope);
      const state = this.state(scope, nowMs, false);
      if (!state) return null;
      this.refresh(state, nowMs);
      return publicState(state);
    }
    const scopes = [...this.states.values()];
    for (const state of scopes) this.refresh(state, nowMs);
    return {
      version: 1,
      generatedAtMs: nowMs,
      config: { ...this.config },
      scopes: scopes
        .map(publicState)
        .sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope))),
    };
  }

  reset(value) {
    const input = exactKeys(object(value, "reset"), RESET_KEYS, "reset");
    const scope = normalizeScope(input.scope);
    return { reset: this.states.delete(scopeKey(scope)), scope };
  }
}

export function createRateController(options = {}) {
  return new AdaptiveRateController(options);
}
