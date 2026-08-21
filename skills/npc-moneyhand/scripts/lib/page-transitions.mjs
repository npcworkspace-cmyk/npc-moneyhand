const PAGE_WAIT_UNTIL_SET = new Set(["domcontentloaded", "load"]);
const PAGE_URL_MATCH_MODE_SET = new Set([
  "exact",
  "prefix",
  "includes",
  "origin",
  "origin+path",
]);
const PAGE_READY_STATE_SET = new Set(["loading", "interactive", "complete"]);
const PAGE_NAVIGATION_PROTOCOL_SET = new Set(["http:", "https:"]);
const MAX_PAGE_URL_CHARS = 16_384;

export const PAGE_WAIT_UNTILS = Object.freeze(["commit", ...PAGE_WAIT_UNTIL_SET]);
export const PAGE_URL_MATCH_MODES = Object.freeze([...PAGE_URL_MATCH_MODE_SET]);
export const DEFAULT_PAGE_WAIT_UNTIL = "domcontentloaded";
export const MAX_PAGE_WAIT_TIMEOUT_MS = 300_000;
export const MAX_PAGE_WAIT_OBSERVATIONS = 512;
export const READ_TASK_PAGE_STATE_EXPRESSION = "({ readyState: document.readyState })";

export class PageTransitionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PageTransitionError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageTransitionError("INVALID_PAGE_TRANSITION", `${label} must be an object`);
  }
  return value;
}

function integer(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function string(value, label, maximum = MAX_PAGE_URL_CHARS) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `${label} must be a 1-${maximum} character string`,
    );
  }
  return value;
}

function trimTrailingSlash(pathname) {
  return pathname.replace(/\/+$/u, "") || "/";
}

function absoluteUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `${label} must be an absolute URL for this match mode`,
    );
  }
}

function normalizeExpectedUrl(input) {
  if (input.expectedUrl === undefined) {
    if (input.urlMatch !== undefined) {
      throw new PageTransitionError(
        "INVALID_PAGE_TRANSITION",
        "urlMatch requires expectedUrl",
      );
    }
    return {};
  }
  const expectedUrl = string(input.expectedUrl, "expectedUrl");
  const urlMatch = input.urlMatch ?? "exact";
  if (!PAGE_URL_MATCH_MODE_SET.has(urlMatch)) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `urlMatch must be one of: ${PAGE_URL_MATCH_MODES.join(", ")}`,
    );
  }
  if (urlMatch === "origin" || urlMatch === "origin+path") {
    absoluteUrl(expectedUrl, "expectedUrl");
  }
  return { expectedUrl, urlMatch };
}

function normalizeWait(input, options = {}) {
  const value = object(input, options.label ?? "page transition");
  const waitUntil = value.waitUntil ?? DEFAULT_PAGE_WAIT_UNTIL;
  const allowed = options.allowCommit === true
    ? new Set(PAGE_WAIT_UNTILS)
    : PAGE_WAIT_UNTIL_SET;
  if (!allowed.has(waitUntil)) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `waitUntil must be one of: ${[...allowed].join(", ")}`,
    );
  }
  const timeoutMs = integer(
    value.timeoutMs,
    0,
    MAX_PAGE_WAIT_TIMEOUT_MS,
    30_000,
    "timeoutMs",
  );
  const pollIntervalMs = integer(value.pollIntervalMs, 20, 2_000, 100, "pollIntervalMs");
  const stablePolls = integer(value.stablePolls, 1, 8, 2, "stablePolls");
  const expected = normalizeExpectedUrl(value);
  if (waitUntil === "commit" && Object.keys(expected).length > 0) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      "waitUntil 'commit' cannot prove expectedUrl; use domcontentloaded or load",
    );
  }
  const maximumObservations = waitUntil === "commit"
    ? 0
    : Math.ceil(timeoutMs / pollIntervalMs) + 1;
  if (maximumObservations > MAX_PAGE_WAIT_OBSERVATIONS) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      `timeoutMs and pollIntervalMs would exceed ${MAX_PAGE_WAIT_OBSERVATIONS} bounded observations`,
      { maximumObservations: MAX_PAGE_WAIT_OBSERVATIONS },
    );
  }
  if (waitUntil !== "commit" && stablePolls > maximumObservations) {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      "stablePolls exceeds the observations available before timeout",
    );
  }
  const tabId = integer(value.tabId, 1, 2_147_483_647, undefined, "tabId");
  if (tabId === undefined) {
    throw new PageTransitionError("INVALID_PAGE_TRANSITION", "tabId is required");
  }
  return {
    tabId,
    waitUntil,
    timeoutMs,
    pollIntervalMs,
    stablePolls,
    maximumObservations,
    ...expected,
  };
}

export function normalizeTaskPageWait(input) {
  return normalizeWait(input, { label: "waitForTaskPage options", allowCommit: false });
}

export function normalizeTaskPageNavigation(input) {
  const value = object(input, "navigateTaskTab options");
  const wait = normalizeWait(value, { label: "navigateTaskTab options", allowCommit: true });
  const rawUrl = string(value.url, "url");
  if (rawUrl === "about:blank") return { ...wait, url: rawUrl };
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      "url must be an absolute HTTP(S) URL or about:blank",
    );
  }
  if (!PAGE_NAVIGATION_PROTOCOL_SET.has(parsed.protocol)
    || parsed.username !== "" || parsed.password !== "") {
    throw new PageTransitionError(
      "INVALID_PAGE_TRANSITION",
      "url must be credential-free HTTP(S) or about:blank; raw taskRequest remains available for trusted advanced schemes",
    );
  }
  return { ...wait, url: parsed.href };
}

export function pageUrlMatches(actual, expected, mode = "exact") {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (mode === "exact") return actual === expected;
  if (mode === "prefix") return actual.startsWith(expected);
  if (mode === "includes") return actual.includes(expected);
  if (mode !== "origin" && mode !== "origin+path") return false;
  let actualUrl;
  let expectedUrl;
  try {
    actualUrl = new URL(actual);
    expectedUrl = new URL(expected);
  } catch {
    return false;
  }
  if (actualUrl.origin !== expectedUrl.origin) return false;
  return mode === "origin"
    || trimTrailingSlash(actualUrl.pathname) === trimTrailingSlash(expectedUrl.pathname);
}

export function normalizeTaskPageState(value) {
  const input = object(value, "page state");
  if (typeof input.frameId !== "string" || input.frameId.length < 1
    || typeof input.loaderId !== "string" || input.loaderId.length < 1
    || typeof input.url !== "string" || input.url.length > 32_768
    || (input.readyState !== null && !PAGE_READY_STATE_SET.has(input.readyState))) {
    throw new PageTransitionError(
      "INVALID_PAGE_STATE",
      "Page state requires frameId, loaderId, URL and loading/interactive/complete/null readyState",
    );
  }
  return {
    frameId: input.frameId,
    loaderId: input.loaderId,
    url: input.url,
    readyState: input.readyState,
    ...(input.readinessError === undefined ? {} : { readinessError: input.readinessError }),
  };
}

export function taskPageStateMatches(state, wait, transition) {
  const current = normalizeTaskPageState(state);
  if (wait.expectedUrl !== undefined
    && !pageUrlMatches(current.url, wait.expectedUrl, wait.urlMatch)) return false;
  if (transition) {
    if (current.frameId !== transition.frameId) return false;
    const sameRequestedUrl = transition.requestedUrl === transition.before.url;
    const loaderChanged = current.loaderId !== transition.before.loaderId;
    const urlChanged = current.url !== transition.before.url;
    if (sameRequestedUrl ? !loaderChanged : !loaderChanged && !urlChanged) return false;
  }
  return wait.waitUntil === "domcontentloaded"
    ? current.readyState === "interactive" || current.readyState === "complete"
    : current.readyState === "complete";
}

export function taskPageStateStabilityKey(state) {
  const current = normalizeTaskPageState(state);
  return JSON.stringify({
    frameId: current.frameId,
    loaderId: current.loaderId,
    url: current.url,
    readyState: current.readyState,
  });
}
