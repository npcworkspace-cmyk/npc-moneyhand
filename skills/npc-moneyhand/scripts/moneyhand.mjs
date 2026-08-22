#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once, setMaxListeners } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { arch as osArch, platform as osPlatform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { normalizeAgentJsonlCommandEnvelope } from "./lib/agent-descriptor.mjs";
import { ensureMoneyHandConnection } from "./lib/browser-launch.mjs";
import {
  CONTROLLER_SERVICE_PRODUCT,
  CONTROLLER_SERVICE_PROTOCOL,
  CONTROLLER_SERVICE_VERSION,
  DEFAULT_CONTROLLER_HOST,
  DEFAULT_CONTROLLER_IDLE_MS,
  DEFAULT_CONTROLLER_PORT,
  controllerServiceIdentity,
  ensureControllerService,
  pingControllerService,
  requestControllerService,
  shutdownControllerService,
  startControllerService,
} from "./lib/controller-service.mjs";
import {
  TaskExecutionLedger,
  buildTaskSummary,
  createTaskExecutionId,
  latestTaskExecutionId,
  readLatestTaskExecutionStatus,
  readTaskExecutionEntries,
  readTaskExecutionStatus,
} from "./lib/task-ledger.mjs";
import { TaskEffectReceipts } from "./lib/task-effects.mjs";
import {
  attachRecovery,
  ensureTaskRecovery,
  planTaskRecovery,
} from "./lib/task-recovery-state.mjs";
import {
  TaskEvidenceCollector,
  evaluateTaskCompletion,
} from "./lib/task-evidence.mjs";
import {
  MoneyHandUnknownOutcomeError,
  createMoneyHandPeer,
} from "./lib/peer.mjs";
import {
  INSPECT_SEMANTIC_FILE_INPUT_FUNCTION,
  PREPARE_SEMANTIC_TARGET_FUNCTION,
  READ_SEMANTIC_TARGET_FUNCTION,
  SET_SEMANTIC_SELECT_OPTIONS_FUNCTION,
  SEMANTIC_REF_ACTIONS,
  SEMANTIC_VERIFICATION_KINDS,
  evaluateSemanticVerification,
  normalizeSemanticRefAction,
  semanticActionApprovalRequest,
} from "./lib/semantic-actions.mjs";
import {
  buildFrameSemanticSnapshot,
  buildSemanticSnapshot,
} from "./lib/semantic-snapshot.mjs";
import {
  DEFAULT_PAGE_WAIT_UNTIL,
  MAX_PAGE_WAIT_OBSERVATIONS,
  MAX_PAGE_WAIT_TIMEOUT_MS,
  PAGE_URL_MATCH_MODES,
  PAGE_WAIT_UNTILS,
  READ_TASK_PAGE_STATE_EXPRESSION,
  normalizeTaskPageNavigation,
  normalizeTaskPageState,
  normalizeTaskPageWait,
  taskPageStateMatches,
  taskPageStateStabilityKey,
} from "./lib/page-transitions.mjs";
import {
  SEMANTIC_LOCATOR_KINDS,
  SEMANTIC_LOCATOR_STATES,
  matchSemanticLocator,
  normalizeSemanticLocator,
  normalizeSemanticLocatorState,
  semanticLocatorStabilityKey,
} from "./lib/semantic-locator.mjs";
import { SiteLearningRegistry } from "./lib/site-learnings.mjs";
import { routeSurface as selectSurfaceRoute } from "./lib/surface-router.mjs";
import {
  AdaptiveRateController,
  RATE_CONTROL_DEFAULTS,
  RateControlError,
  createRateController,
} from "./lib/rate-control.mjs";
import {
  HIGH_IMPACT_TASK_EFFECTS,
  TaskApprovalLedger,
  normalizeTaskEffect,
} from "./lib/task-approvals.mjs";
import {
  TaskSpaceRegistry,
  taskSpaceHasUnscopedMutation,
  taskSpaceRequestTabIds,
} from "./lib/task-spaces.mjs";

const SOURCE_PATH = realpathSync(fileURLToPath(import.meta.url));
const HOST_PROCESS = globalThis.process;
const RUNTIME_PLATFORM = osPlatform();
const RUNTIME_ARCH = osArch();

export const MONEYHAND_CONTROL_PROTOCOL = "npc-moneyhand-control/1";
export const AGENT_JSONL_PROTOCOL = "npc-agent-jsonl/1";
export const COORDINATE_SPACE = "css-viewport-v1";
export const DEFAULT_PORT = 19_846;
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
export const DEFAULT_ONCE_TIMEOUT_MS = 120_000;
export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_JSONL_INFLIGHT = 256;
export const MONEYHAND_CONNECT_RESULT_SCHEMA = "npc-moneyhand-connect/1";
const CONNECT_ACCEPTANCE_TASK_PATH = resolve(dirname(SOURCE_PATH), "..", "assets", "connect-acceptance.mjs");
const CONNECT_READY_NEXT_ACTION = "ready_for_tasks";
const CONNECT_ACCEPTANCE_TIMEOUT_MS = 90_000;
export {
  AdaptiveRateController,
  RATE_CONTROL_DEFAULTS,
  RateControlError,
  createRateController,
  ensureMoneyHandConnection,
};

const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_RECENT_COMMAND_IDS = 4_096;
const MAX_EVENT_WRITE_BACKLOG = 256;
const OUTPUT_DRAIN_TIMEOUT_MS = 1_000;
const MAX_SEMANTIC_SNAPSHOTS = 16;
const SEMANTIC_SNAPSHOT_TTL_MS = 120_000;
const DEFAULT_SEMANTIC_FRAMES = 16;
const MAX_SEMANTIC_FRAMES = 32;
const MAX_SEMANTIC_DISCOVERED_FRAMES = 2_048;
const MAX_SEMANTIC_FRAME_DEPTH = 128;
const SEMANTIC_FRAME_DISCOVERY_POLL_MS = 25;
const SEMANTIC_FRAME_DISCOVERY_TIMEOUT_MS = 250;
const SEMANTIC_FRAME_DISCOVERY_STABLE_POLLS = 2;
const TASK_WINDOW_READY_POLL_MS = 100;
const TASK_WINDOW_READY_ATTEMPTS = 30;
const TASK_INTERNAL_BEHAVIOR = Object.freeze({ onUnclear: "error" });
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;
export const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_TASK_PROGRESS_INTERVAL_MS = 10_000;
export const DEFAULT_TASK_VISUAL_SILENCE_MS = 15_000;
export const MAX_TASK_WATCHDOG_POLL_MS = 250;
export const ATTACHED_TASK_MONITOR_INTERVAL_MS = 10_000;
const DEFAULT_TASK_ABORT_GRACE_MS = 30_000;
const MAX_TASK_ABORT_GRACE_MS = 120_000;
const MAX_TASK_PROGRESS_INTERVAL_MS = 60_000;
const MAX_TASK_VISUAL_SILENCE_MS = 5 * 60_000;
const MAX_PARALLEL_TASK_REQUESTS = 64;
const MAX_TASK_REQUEST_CONCURRENCY = 16;
const MAX_TASK_EVALUATION_EXPRESSION_BYTES = 1024 * 1024;
const MAX_AUTOMATIC_VISUAL_FALLBACKS = 120;
const TASK_FOLLOW_POLL_MS = 500;
const TASK_CONCURRENT_VISUAL_OBSERVATION = Symbol("task-concurrent-visual-observation");
const TASK_AUTO_VISUAL_METHODS = new Set([
  "probeTaskContext",
  "scrollTaskTab",
  "waitForTaskPage",
  "navigateTaskTab",
  "navigateSemanticRef",
  "captureViewportBundle",
  "captureSemanticSnapshot",
  "waitForSemanticLocator",
  "resolveSemanticRef",
  "actSemanticRef",
  "actSemanticLocator",
  "captureStableViewport",
  "captureFullPage",
  "evaluateTaskTab",
  "taskRequest",
  "parallelTaskRequests",
  "request",
  "execute",
]);
const TASK_VISUAL_SKIP_CODES = new Set([
  "ABORTED",
  "TASK_TIMEOUT",
  "NOT_RUNNING",
  "NOT_CONNECTED",
  "CONNECTION_LOST",
  "SESSION_REPLACED",
  "CONTROLLER_ABORTED",
  "CONTROLLER_CLIENT_CLOSED",
  "CONTROLLER_SHUTDOWN",
  "CONTROLLER_STOPPING",
  "TASK_PROGRESS_OUTPUT_FAILED",
  "TASK_TEMPLATE_NOT_IMPLEMENTED",
  "INVALID_TASK",
  "RATE_CONTROL_CIRCUIT_OPEN",
  "PAGE_TRANSITION_BUSY",
  "INVALID_OUTPUT_PATH",
  "INVALID_OUTPUT_ROOT",
  "OUTPUT_OUTSIDE_ROOT",
  "OUTPUT_EXISTS",
  "SCREENSHOT_WRITE_FAILED",
]);
const TASK_RATE_GATED_METHODS = new Set([
  "scrollTaskTab",
  "waitForTaskPage",
  "navigateTaskTab",
  "navigateSemanticRef",
  "captureViewportBundle",
  "captureSemanticSnapshot",
  "waitForSemanticLocator",
  "resolveSemanticRef",
  "actSemanticRef",
  "actSemanticLocator",
  "captureStableViewport",
  "captureFullPage",
  "evaluateTaskTab",
  "taskRequest",
  "parallelTaskRequests",
]);
const TASK_SIGNAL_FIRST_ARGUMENT_METHODS = new Set([
  "beginTaskContext",
  "probeTaskContext",
  "scrollTaskTab",
  "waitForTaskPage",
  "navigateTaskTab",
  "navigateSemanticRef",
  "captureViewportBundle",
  "captureSemanticSnapshot",
  "waitForSemanticLocator",
  "resolveSemanticRef",
  "actSemanticRef",
  "actSemanticLocator",
  "captureStableViewport",
  "captureFullPage",
  "evaluateTaskTab",
  "inspectTaskBlocker",
  "resolveTaskBlocker",
  "taskRequest",
  "parallelTaskRequests",
  "confirmUnknown",
  "createTaskSpace",
  "rateControl",
  "execute",
  "wait",
]);
const TASK_WHOLE_DOCUMENT_SELECTOR_HINTS = new Set(["body", "html", ":root", "document"]);
const TASK_FIXED_EFFECTS = Object.freeze({
  evaluateTaskTab: "read-only",
  navigateSemanticRef: "navigation",
  navigateTaskTab: "navigation",
  scrollTaskTab: "input",
});
const CONTROLLER_SHUTDOWN_TASK_ABORT_GRACE_MS = 5_000;
const OUTPUT_WORKER_FLAG = "--internal-output-worker";
const OUTPUT_WORKER_ENV = "NPC_MONEYHAND_INTERNAL_OUTPUT_WORKER";
const CONTROLLER_SERVICE_FLAG = "--internal-controller-service";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SEMANTIC_COORDINATE_ACTIONS = new Set([
  "click",
  "download",
  "hover",
  "scroll",
  "drag",
  "check",
  "uncheck",
]);
const MAX_SEMANTIC_UPLOAD_FILES = 16;
const MAX_SEMANTIC_UPLOAD_FILE_BYTES = 2_147_483_648;
const MAX_SEMANTIC_UPLOAD_TOTAL_BYTES = 4_294_967_296;
const RATE_CONTROL_ACTIONS = Object.freeze([
  "plan",
  "observe",
  "checkpoint",
  "wait",
  "snapshot",
  "reset",
]);
const SEMANTIC_DOWNLOAD_BASELINE_WINDOW_MS = 5_000;
const SEMANTIC_DOWNLOAD_SEARCH_LIMIT = 256;
const SEMANTIC_DOWNLOAD_STATES = new Set(["in_progress", "interrupted", "complete"]);
const TASK_BEHAVIOR_OPTION_FIELDS = new Set([
  "beforeMs",
  "afterMs",
  "betweenStepsMs",
  "typingDelayMs",
  "pointerSteps",
  "pointerDurationMs",
  "onUnclear",
  "ttlMs",
]);
const TASK_MODULE_HELPERS = Object.freeze([
  "beginTaskContext",
  "probeTaskContext",
  "scrollTaskTab",
  "navigateSemanticRef",
  "captureStableViewport",
  "captureFullPage",
  "evaluateTaskTab",
  "inspectTaskBlocker",
  "resolveTaskBlocker",
  "completeTaskContext",
]);
const JSONL_PRODUCT_OPERATIONS = Object.freeze([
  "capabilities",
  "status",
  "wait",
  "request",
  "captureViewportBundle",
  "captureSemanticSnapshot",
  "waitForSemanticLocator",
  "resolveSemanticRef",
  "actSemanticRef",
  "actSemanticLocator",
  "waitForTaskPage",
  "navigateTaskTab",
  "createTaskSpace",
  "listTaskSpaces",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "completeTaskSpace",
  "taskRequest",
  "parallelTaskRequests",
  "routeSurface",
  "registerSiteLearning",
  "listSiteLearnings",
  "removeSiteLearning",
  "resolveSiteLearnings",
  "approveSemanticRefAction",
  "approveTaskEffect",
  "listApprovalActivity",
  "confirmUnknown",
  "rateControl",
]);
const PROGRAMMATIC_OPERATIONS = Object.freeze([
  ...JSONL_PRODUCT_OPERATIONS,
  ...TASK_MODULE_HELPERS,
]);
const JSONL_CONTROL_OPERATIONS = Object.freeze(["cancel", "drain", "shutdown"]);
const JSONL_OPERATIONS = Object.freeze([
  ...JSONL_PRODUCT_OPERATIONS,
  ...JSONL_CONTROL_OPERATIONS,
]);

export const DATA_ACQUISITION_POLICY = Object.freeze({
  objective: "minimum-total-elapsed-time",
  appliesWhen: "user-method-unspecified",
  defaultBehaviorMode: "raw",
  probe: "bounded-sample-before-page-iteration",
  pilot: Object.freeze({
    requiredBeforeScale: true,
    sample: "smallest-representative-batch",
    validate: Object.freeze([
      "authorization-and-access-boundary",
      "required-field-coverage",
      "pagination-and-deduplication",
      "account-state-unchanged",
      "baseline-latency-and-rate-signals",
    ]),
    scale: "gradual-batch-and-concurrency-ramp",
  }),
  rateControl: Object.freeze({
    mode: "adaptive",
    signals: Object.freeze([
      "http-429",
      "retry-after",
      "rate-limit-headers",
      "throttle-payload",
      "http-503",
      "access-challenge",
      "latency-regression",
    ]),
    onThrottle: Object.freeze([
      "honor-retry-after",
      "reduce-concurrency-first",
      "increase-interval-exponentially-with-jitter",
      "retry-known-readonly-only",
      "checkpoint-before-retry",
    ]),
    onRecovery: Object.freeze([
      "require-consecutive-clean-batches",
      "decrease-interval-gradually",
      "do-not-exceed-last-known-safe-rate",
    ]),
    stopSignals: Object.freeze([
      "access-challenge",
      "persistent-403",
      "account-state-change",
      "repeated-throttle-at-minimum-concurrency",
    ]),
  }),
  orderedPlanes: Object.freeze([
    "existing-structured-data",
    "cdp-network-json",
    "same-session-readonly-replay",
    "cdp-runtime-dom-batch",
    "browser-ui-lazy-load",
    "explicit-screenshot",
  ]),
  rules: Object.freeze({
    rankEligiblePlanesOnly: true,
    technicalAccessDoesNotGrantAuthorization: true,
    respectTaskScopeAndDataRights: true,
    stopProbeWhenStableComplete: true,
    fallbackWhenProbeCostsMoreThanDom: true,
    readOnlyByDefault: true,
    reuseCurrentSessionWithoutExportingCredentials: true,
    replayOnlyKnownReadOnlyRequests: true,
    requireAuthorizationForWrites: true,
    neverBypassAccessControls: true,
    respectPlatformLimits: true,
    screenshotLastResort: true,
  }),
});

function dataAcquisitionPolicy() {
  return {
    ...DATA_ACQUISITION_POLICY,
    pilot: {
      ...DATA_ACQUISITION_POLICY.pilot,
      validate: [...DATA_ACQUISITION_POLICY.pilot.validate],
    },
    rateControl: {
      ...DATA_ACQUISITION_POLICY.rateControl,
      signals: [...DATA_ACQUISITION_POLICY.rateControl.signals],
      onThrottle: [...DATA_ACQUISITION_POLICY.rateControl.onThrottle],
      onRecovery: [...DATA_ACQUISITION_POLICY.rateControl.onRecovery],
      stopSignals: [...DATA_ACQUISITION_POLICY.rateControl.stopSignals],
    },
    orderedPlanes: [...DATA_ACQUISITION_POLICY.orderedPlanes],
    rules: { ...DATA_ACQUISITION_POLICY.rules },
  };
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandError("INVALID_COMMAND", `${label} must be an object`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MoneyHandError(
      "INVALID_COMMAND",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requiredInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MoneyHandError(
      "INVALID_COMMAND",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requiredCommandId(value) {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    throw new MoneyHandError(
      "INVALID_COMMAND",
      "command.id must use 1-128 letters, numbers, '.', '_', ':' or '-'",
    );
  }
  return value;
}

function requiredOperation(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new MoneyHandError("INVALID_COMMAND", "command.op must be a non-empty string");
  }
  return value;
}

function requiredTaskSpaceId(value) {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    throw new MoneyHandError(
      "TASK_SPACE_ID_REQUIRED",
      "This command requires taskSpaceId separate from the correlation id",
    );
  }
  return value;
}

function taskBehaviorPlan(input) {
  const mode = input.behavior ?? "raw";
  if (mode !== "raw" && mode !== "human") {
    throw new MoneyHandError(
      "INVALID_TASK_BEHAVIOR",
      "behavior must be 'raw' or 'human'",
    );
  }
  const behaviorOptions = input.behaviorOptions === undefined
    ? {}
    : asObject(input.behaviorOptions, "behaviorOptions");
  for (const field of Object.keys(behaviorOptions)) {
    if (!TASK_BEHAVIOR_OPTION_FIELDS.has(field)) {
      throw new MoneyHandError(
        "INVALID_TASK_BEHAVIOR",
        `Unknown behaviorOptions field '${field}'`,
      );
    }
  }
  if (mode === "raw" && Object.keys(behaviorOptions).length > 0) {
    throw new MoneyHandError(
      "INVALID_TASK_BEHAVIOR",
      "behaviorOptions are only valid for human behavior",
    );
  }
  return mode === "raw"
    ? { mode, method: "behavior.reset", params: {} }
    : {
        mode,
        method: "behavior.set",
        params: { mode, ttlMs: 30 * 60_000, ...behaviorOptions },
      };
}

function taskSpaceTabId(space, value) {
  if (value !== undefined) {
    const tabId = requiredInteger(value, 1, 2_147_483_647, "tabId");
    if (!space.tabIds.includes(tabId)) {
      throw new MoneyHandError(
        "TASK_SPACE_TAB_MISMATCH",
        `tabId ${tabId} is not owned by taskSpace '${space.id}'`,
      );
    }
    return tabId;
  }
  if (space.tabIds.length !== 1) {
    throw new MoneyHandError(
      "TASK_TAB_REQUIRED",
      "The taskSpace must own exactly one tab when tabId is omitted",
    );
  }
  return space.tabIds[0];
}

function semanticNavigationUrl(resolved) {
  const rawHref = resolved?.node?.href ?? resolved?.node?.properties?.url;
  if (typeof rawHref !== "string" || rawHref.length < 1) {
    throw new MoneyHandError(
      "SEMANTIC_LINK_REQUIRED",
      "The semantic ref has no href; capture a fresh snapshot and choose a link node",
    );
  }
  let url;
  try {
    url = new URL(rawHref, resolved.guard?.url).href;
  } catch {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_LINK",
      "The semantic ref href cannot be resolved against its captured page URL",
      { href: rawHref },
    );
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new MoneyHandError(
      "UNSAFE_SEMANTIC_LINK",
      "navigateSemanticRef accepts only http or https links",
      { protocol: new URL(url).protocol },
    );
  }
  return url;
}

function taskScrollDelta(value, fallback, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isFinite(selected) || selected < -100_000 || selected > 100_000) {
    throw new MoneyHandError(
      "INVALID_TASK_SCROLL",
      `${label} must be a finite number between -100000 and 100000`,
    );
  }
  return selected;
}

function taskScrollCoordinate(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new MoneyHandError(
      "INVALID_TASK_SCROLL",
      `${label} must be a finite non-negative CSS viewport coordinate`,
    );
  }
  return value;
}

async function taskRetryDelay(milliseconds, signal) {
  if (signal?.aborted) {
    throw new MoneyHandError("ABORTED", "Task retry was aborted before another dispatch");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new MoneyHandError(
        "ABORTED",
        "Task retry was aborted before another dispatch",
      ));
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function sessionSummary(session) {
  if (!session) return null;
  return {
    serial: session.serial,
    profile: session.identity.profile,
    instanceId: session.identity.instanceId,
    bootId: session.identity.bootId,
    version: session.identity.version,
    browser: session.identity.browser,
    capabilities: session.identity.capabilities,
    focus: { ...session.focus },
    unknownOutcomeIds: [...session.unknownOutcomeIds],
  };
}

function normalizedError(error, fallbackCode = "MONEYHAND_ERROR") {
  const output = {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: typeof error?.message === "string"
      ? error.message.slice(0, 4_096)
      : String(error).slice(0, 4_096),
  };
  if (error?.details !== undefined) output.details = error.details;
  if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
    output.unknownOutcome = true;
    output.handRequestId = error.id ?? error?.details?.id;
  }
  return output;
}

function visualFallbackTrigger(operation, reason) {
  const source = reason && typeof reason === "object" ? reason : {};
  const details = source.details && typeof source.details === "object" ? source.details : {};
  return {
    operation: typeof operation === "string" && operation.length > 0
      ? operation.slice(0, 128)
      : "page-operation",
    code: typeof source.code === "string" && source.code.length > 0
      ? source.code.slice(0, 128)
      : "PAGE_ANOMALY",
    message: typeof source.message === "string" && source.message.length > 0
      ? source.message.slice(0, 4_096)
      : "The current browser page requires visual inspection",
    actionDispatched: source.actionDispatched === true || details.actionDispatched === true,
    retry: typeof source.retry === "string"
      ? source.retry.slice(0, 128)
      : (typeof details.retry === "string" ? details.retry.slice(0, 128) : "inspect-before-next-action"),
  };
}

function taskVisualErrorEligible(operation, error) {
  if (!TASK_AUTO_VISUAL_METHODS.has(operation)) return false;
  const code = typeof error?.code === "string" ? error.code : "MONEYHAND_ERROR";
  return !TASK_VISUAL_SKIP_CODES.has(code);
}

function taskVisualResultReason(operation, result) {
  if (!result || typeof result !== "object") return undefined;
  if (result.status === "needs_instruction") {
    return {
      ...(result.error && typeof result.error === "object" ? result.error : {}),
      actionDispatched: result.error?.details?.actionDispatched === true,
      retry: "inspect-before-next-action",
    };
  }
  if ((operation === "request" || operation === "taskRequest") && result.ok === false) {
    return result.error && typeof result.error === "object"
      ? result.error
      : { code: "HAND_REQUEST_FAILED", message: "The browser request failed" };
  }
  if (operation === "parallelTaskRequests" && Array.isArray(result.results)) {
    const failed = result.results.find((entry) => entry?.ok === false || entry?.value?.ok === false);
    if (failed?.error && typeof failed.error === "object") return failed.error;
    if (failed?.value?.error && typeof failed.value.error === "object") return failed.value.error;
  }
  return undefined;
}

function taskVisibleTerminal(result, visualFallback) {
  const stripNeedInternals = (terminal) => {
    if (!terminal || typeof terminal !== "object" || terminal.status !== "needs_instruction") {
      return terminal;
    }
    const context = terminal.need?.context && typeof terminal.need.context === "object"
      ? { ...terminal.need.context }
      : {};
    delete context.target;
    return {
      ...terminal,
      need: {
        context,
        resolution: "resolveTaskBlocker",
      },
    };
  };
  const visible = stripNeedInternals(result);
  if (Array.isArray(visible?.results)) {
    return {
      ...visible,
      results: visible.results.map((entry) => entry?.value === undefined
        ? entry
        : { ...entry, value: stripNeedInternals(entry.value) }),
      visualFallback,
    };
  }
  return { ...visible, visualFallback };
}

function attachTaskVisualFallback(error, visualFallback) {
  if (!error || typeof error !== "object") {
    return new MoneyHandError(
      "MONEYHAND_ERROR",
      String(error),
      { visualFallback },
    );
  }
  const details = error.details && typeof error.details === "object" ? { ...error.details } : {};
  if (visualFallback.waitingForInstruction === true) {
    delete details.waitId;
    delete details.tabId;
    details.resolution = "resolveTaskBlocker";
  }
  error.details = { ...details, visualFallback };
  return error;
}

function selectedMetrics(metrics) {
  const layout = metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
  const visual = metrics?.cssVisualViewport ?? metrics?.visualViewport;
  const content = metrics?.cssContentSize ?? metrics?.contentSize;
  if (!layout || !visual || !content) {
    throw new MoneyHandError(
      "INVALID_VIEWPORT_BUNDLE",
      "Page.getLayoutMetrics did not return layout, visual, and content metrics",
    );
  }
  return {
    layout: {
      pageX: layout.pageX,
      pageY: layout.pageY,
      clientWidth: layout.clientWidth,
      clientHeight: layout.clientHeight,
    },
    visual: {
      offsetX: visual.offsetX,
      offsetY: visual.offsetY,
      pageX: visual.pageX,
      pageY: visual.pageY,
      clientWidth: visual.clientWidth,
      clientHeight: visual.clientHeight,
      scale: visual.scale,
      zoom: visual.zoom,
    },
    content: {
      x: content.x,
      y: content.y,
      width: content.width,
      height: content.height,
    },
  };
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 24
    || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new MoneyHandError("INVALID_SCREENSHOT", "CDP did not return a valid PNG image");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new MoneyHandError("INVALID_SCREENSHOT", "PNG dimensions must be positive");
  }
  return { width, height };
}

function cdpBatchValue(results, index, expectedMethod, options = {}) {
  const code = options.code ?? "INVALID_VIEWPORT_BUNDLE";
  const label = options.label ?? "Viewport";
  const step = results?.[index];
  if (!step || step.ok !== true || step.method !== "cdp.send") {
    throw new MoneyHandError(
      code,
      `${label} batch step ${index} did not complete`,
    );
  }
  const command = step.result;
  if (command?.method !== expectedMethod || !command.result || typeof command.result !== "object") {
    throw new MoneyHandError(
      code,
      `${label} batch step ${index} did not return ${expectedMethod}`,
    );
  }
  return command.result;
}

function runtimeViewportValue(runtimeResult) {
  const value = runtimeResult?.result?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandError(
      "INVALID_VIEWPORT_BUNDLE",
      "Runtime.evaluate did not return viewport metadata by value",
    );
  }
  return value;
}

function assertStableViewport(beforeFrameTree, afterFrameTree, beforeMetrics, afterMetrics) {
  const beforeLoaderId = beforeFrameTree?.frame?.loaderId;
  const afterLoaderId = afterFrameTree?.frame?.loaderId;
  const beforeUrl = beforeFrameTree?.frame?.url;
  const afterUrl = afterFrameTree?.frame?.url;
  if (typeof beforeLoaderId !== "string"
    || !beforeLoaderId
    || beforeLoaderId !== afterLoaderId
    || typeof beforeUrl !== "string"
    || beforeUrl !== afterUrl
    || JSON.stringify(beforeMetrics) !== JSON.stringify(afterMetrics)) {
    throw new MoneyHandError(
      "STALE_VIEWPORT",
      "Navigation or viewport metrics changed while the screenshot was captured",
    );
  }
  return { loaderId: beforeLoaderId, url: beforeUrl };
}

function assertStableFrame(beforeFrameTree, afterFrameTree, code = "STALE_SEMANTIC_SNAPSHOT") {
  const beforeFrameId = beforeFrameTree?.frame?.id;
  const afterFrameId = afterFrameTree?.frame?.id;
  const beforeLoaderId = beforeFrameTree?.frame?.loaderId;
  const afterLoaderId = afterFrameTree?.frame?.loaderId;
  const beforeUrl = beforeFrameTree?.frame?.url;
  const afterUrl = afterFrameTree?.frame?.url;
  if (typeof beforeFrameId !== "string"
    || !beforeFrameId
    || beforeFrameId !== afterFrameId
    || typeof beforeLoaderId !== "string"
    || !beforeLoaderId
    || beforeLoaderId !== afterLoaderId
    || typeof beforeUrl !== "string"
    || beforeUrl !== afterUrl) {
    throw new MoneyHandError(
      code,
      "Navigation changed while the semantic snapshot was captured",
    );
  }
  return { frameId: beforeFrameId, loaderId: beforeLoaderId, url: beforeUrl };
}

function directHandValue(terminal, options = {}) {
  const fallbackCode = options.code ?? "MONEYHAND_REQUEST_FAILED";
  const label = options.label ?? "MoneyHand request";
  if (terminal?.ok !== true) {
    const error = terminal?.error;
    throw new MoneyHandError(
      typeof error?.code === "string" ? error.code : fallbackCode,
      typeof error?.message === "string" ? error.message : `${label} failed`,
      {
        handRequestId: terminal?.id,
        ...(error?.details === undefined ? {} : { cause: error.details }),
      },
    );
  }
  if (!terminal.result || typeof terminal.result !== "object" || Array.isArray(terminal.result)) {
    throw new MoneyHandError(fallbackCode, `${label} returned an invalid result`);
  }
  return terminal.result;
}

function viewportCaptureWasDispatched(terminal) {
  const details = terminal?.error?.details;
  const candidates = [details, details?.cause];
  return candidates.some((candidate) => Array.isArray(candidate?.results)
    && candidate.results.some((step) => step?.index === 3
      && step?.method === "cdp.send"
      && step?.ok === true
      && step?.result?.method === "Page.captureScreenshot"));
}

function flattenSemanticFrameTree(frameTree) {
  const frames = [];
  const seen = new Set();
  const visit = (entry, parentFrameId, depth) => {
    const frame = entry?.frame;
    if (depth > MAX_SEMANTIC_FRAME_DEPTH
      || frames.length >= MAX_SEMANTIC_DISCOVERED_FRAMES) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_LIMIT_EXCEEDED",
        "Page.getFrameTree exceeds the bounded MoneyHand controller frame or depth limit",
        {
          maximumFrames: MAX_SEMANTIC_DISCOVERED_FRAMES,
          maximumDepth: MAX_SEMANTIC_FRAME_DEPTH,
        },
      );
    }
    if (typeof frame?.id !== "string"
      || !frame.id
      || typeof frame?.loaderId !== "string"
      || !frame.loaderId
      || typeof frame?.url !== "string"
      || seen.has(frame.id)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Page.getFrameTree returned an invalid or cyclic frame tree",
      );
    }
    if (frame.parentId !== undefined
      && (typeof frame.parentId !== "string" || !frame.parentId)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Page.getFrameTree returned an invalid parent frame identity",
      );
    }
    if (parentFrameId !== undefined
      && frame.parentId !== undefined
      && parentFrameId !== frame.parentId) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Page.getFrameTree disagrees with its structural parent frame identity",
      );
    }
    const observedParentFrameId = parentFrameId ?? frame.parentId;
    seen.add(frame.id);
    frames.push({
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      parentFrameId: observedParentFrameId,
      depth,
      topLevel: depth === 0,
    });
    const children = entry.childFrames ?? [];
    if (!Array.isArray(children)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Page.getFrameTree childFrames must be an array",
      );
    }
    for (const child of children) visit(child, frame.id, depth + 1);
  };
  visit(frameTree, undefined, 0);
  return frames;
}

function semanticFrameTreeSignature(frameTree) {
  return JSON.stringify(flattenSemanticFrameTree(frameTree).map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId ?? null,
    loaderId: frame.loaderId,
    url: frame.url,
  })));
}

function normalizeSemanticSessions(value) {
  if (!Array.isArray(value?.sessions) || value.sessions.length > 512) {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_FRAME_SESSIONS",
      "target.sessions returned an invalid session registry",
    );
  }
  const sessions = [];
  const sessionIds = new Set();
  const targetIds = new Set();
  for (const source of value.sessions) {
    if (source?.targetInfo?.type !== "iframe") continue;
    const sessionId = source.sessionId;
    const targetId = source.targetInfo?.targetId;
    if (typeof sessionId !== "string"
      || !sessionId
      || sessionId.length > 256
      || typeof targetId !== "string"
      || !targetId
      || targetId.length > 256
      || sessionIds.has(sessionId)
      || targetIds.has(targetId)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_SESSIONS",
        "target.sessions returned duplicate or invalid iframe identities",
      );
    }
    if (typeof source.autoAttachError === "string" && source.autoAttachError) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_ATTACH_FAILED",
        "MoneyHand could not recursively attach an iframe target",
        { targetId, cause: source.autoAttachError },
      );
    }
    sessionIds.add(sessionId);
    targetIds.add(targetId);
    sessions.push({
      sessionId,
      targetId,
      parentSessionId: typeof source.parentSessionId === "string"
        ? source.parentSessionId
        : undefined,
      parentFrameId: typeof source.targetInfo?.parentFrameId === "string"
        ? source.targetInfo.parentFrameId
        : undefined,
      url: typeof source.targetInfo?.url === "string" ? source.targetInfo.url : "",
      autoAttachConfigured: source.autoAttachConfigured === true,
    });
  }
  return sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function semanticSessionSignature(sessions) {
  return JSON.stringify(sessions.map((session) => ({
    sessionId: session.sessionId,
    targetId: session.targetId,
    parentSessionId: session.parentSessionId ?? null,
    parentFrameId: session.parentFrameId ?? null,
    autoAttachConfigured: session.autoAttachConfigured,
  })));
}

function orderSemanticSessions(sessions) {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const children = new Map();
  for (const session of sessions) {
    if (session.parentSessionId !== undefined && !byId.has(session.parentSessionId)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_SESSIONS",
        "An iframe session is missing its parent session",
        { sessionId: session.sessionId },
      );
    }
    const key = session.parentSessionId ?? "main";
    const list = children.get(key) ?? [];
    list.push(session);
    children.set(key, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }
  const ordered = [];
  const visit = (session) => {
    ordered.push(session);
    for (const child of children.get(session.sessionId) ?? []) visit(child);
  };
  for (const session of children.get("main") ?? []) visit(session);
  if (ordered.length !== sessions.length) {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_FRAME_SESSIONS",
      "The iframe session registry is cyclic or disconnected",
    );
  }
  return ordered;
}

function semanticTargetTreeKey(sessionId) {
  return sessionId ?? "main";
}

function buildSemanticFramePlan(targetTrees, sessions, maxFrames) {
  const rootTree = targetTrees.get("main");
  const rootFrames = flattenSemanticFrameTree(rootTree);
  const rootFrame = rootFrames[0];
  if (rootFrame.parentFrameId !== undefined) {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_FRAME_TREE",
      "The top-level target frame unexpectedly has a parent frame",
    );
  }
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
  const localFramesBySessionId = new Map();
  let discoveredFrameCount = rootFrames.length;
  for (const session of sessions) {
    const tree = targetTrees.get(semanticTargetTreeKey(session.sessionId));
    if (!tree) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "A flattened iframe session is missing its local frame tree",
        { targetId: session.targetId },
      );
    }
    const localFrames = flattenSemanticFrameTree(tree);
    discoveredFrameCount += localFrames.length;
    if (discoveredFrameCount > MAX_SEMANTIC_DISCOVERED_FRAMES) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_LIMIT_EXCEEDED",
        "The discovered multi-target frame graph exceeds the bounded MoneyHand controller limit",
        { maximumFrames: MAX_SEMANTIC_DISCOVERED_FRAMES },
      );
    }
    localFramesBySessionId.set(session.sessionId, localFrames);
  }
  const sessionRootFrameIds = new Map(
    [...localFramesBySessionId].map(([sessionId, frames]) => [sessionId, frames[0].frameId]),
  );
  const records = new Map();
  let order = 0;
  const addFrames = (localFrames, session) => {
    for (const [index, source] of localFrames.entries()) {
      let parentFrameId = source.parentFrameId;
      if (session && index === 0) {
        if (session.parentFrameId !== undefined
          && parentFrameId !== undefined
          && session.parentFrameId !== parentFrameId) {
          throw new MoneyHandError(
            "INVALID_SEMANTIC_FRAME_TREE",
            "The iframe target and Page frame tree disagree about their parent frame",
            {
              targetId: session.targetId,
              targetParentFrameId: session.parentFrameId,
              pageParentFrameId: parentFrameId,
            },
          );
        }
        parentFrameId ??= session.parentFrameId;
        if (parentFrameId === undefined) {
          throw new MoneyHandError(
            "INVALID_SEMANTIC_FRAME_TREE",
            "An iframe session frame tree is missing its Page parent frame identity",
            { targetId: session.targetId, frameId: source.frameId },
          );
        }
      }
      const value = {
        ...source,
        parentFrameId,
        order: order++,
        targetTreeKey: semanticTargetTreeKey(session?.sessionId),
        ...(session ? { sessionId: session.sessionId, targetId: session.targetId } : {}),
        ownsSession: Boolean(session && index === 0),
      };
      const previous = records.get(value.frameId);
      if (previous) {
        if (!value.ownsSession
          || previous.parentFrameId !== value.parentFrameId
          || previous.loaderId !== value.loaderId
          || previous.url !== value.url) {
          throw new MoneyHandError(
            "INVALID_SEMANTIC_FRAME_TREE",
            "Multi-target frame trees contain conflicting frame identities",
            { frameId: value.frameId },
          );
        }
        value.order = previous.order;
      }
      records.set(value.frameId, value);
      if (records.size > MAX_SEMANTIC_DISCOVERED_FRAMES) {
        throw new MoneyHandError(
          "SEMANTIC_FRAME_LIMIT_EXCEEDED",
          "The discovered multi-target frame graph exceeds the bounded MoneyHand controller limit",
          { maximumFrames: MAX_SEMANTIC_DISCOVERED_FRAMES },
        );
      }
    }
  };
  addFrames(rootFrames, undefined);
  for (const iframe of sessions) {
    addFrames(localFramesBySessionId.get(iframe.sessionId), iframe);
  }
  const children = new Map();
  for (const frame of records.values()) {
    if (frame.frameId === rootFrame.frameId) continue;
    if (!frame.parentFrameId || !records.has(frame.parentFrameId)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "A multi-target semantic frame is missing its parent",
        { frameId: frame.frameId, parentFrameId: frame.parentFrameId ?? null },
      );
    }
    const list = children.get(frame.parentFrameId) ?? [];
    list.push(frame);
    children.set(frame.parentFrameId, list);
  }
  for (const list of children.values()) list.sort((left, right) => left.order - right.order);
  const planned = [];
  const visit = (frame, depth) => {
    const parent = frame.parentFrameId ? records.get(frame.parentFrameId) : undefined;
    const ownSession = frame.ownsSession
      ? sessionsById.get(frame.sessionId)
      : undefined;
    if (ownSession
      && (sessionRootFrameIds.get(ownSession.sessionId) !== frame.frameId
        || ownSession.targetId !== frame.targetId
        || ownSession.parentSessionId !== parent?.sessionId)) {
      throw new MoneyHandError(
        "STALE_SEMANTIC_SNAPSHOT",
        "A flattened iframe session moved or changed identity",
        { frameId: frame.frameId },
      );
    }
    planned.push({
      ...frame,
      depth,
      topLevel: depth === 0,
    });
    for (const child of children.get(frame.frameId) ?? []) visit(child, depth + 1);
  };
  visit(records.get(rootFrame.frameId), 0);
  if (planned.length !== records.size) {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_FRAME_TREE",
      "Multi-target semantic frame trees are disconnected or cyclic",
    );
  }
  const frames = planned.slice(0, maxFrames);
  return {
    frames,
    totalFrames: planned.length,
    truncated: planned.length > frames.length,
  };
}

function assertStableSemanticTargetTrees(discovery, before, after) {
  for (const [key, expectedTree] of discovery) {
    if (semanticFrameTreeSignature(before.get(key)) !== semanticFrameTreeSignature(expectedTree)
      || semanticFrameTreeSignature(after.get(key)) !== semanticFrameTreeSignature(expectedTree)) {
      throw new MoneyHandError(
        "STALE_SEMANTIC_SNAPSHOT",
        "A page or iframe frame tree changed while the semantic snapshot was captured",
        { targetTree: key },
      );
    }
  }
}

function semanticFrameById(frameTree, frameId, code = "INVALID_SEMANTIC_ACTION") {
  const frame = flattenSemanticFrameTree(frameTree).find((candidate) => candidate.frameId === frameId);
  if (!frame) {
    throw new MoneyHandError(code, `Page.getFrameTree no longer contains frame '${frameId}'`);
  }
  return frame;
}

function semanticFramePath(framesValue, frameId) {
  const frames = Array.isArray(framesValue) ? framesValue : [];
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const path = [];
  const seen = new Set();
  let current = byId.get(frameId);
  while (current && current.topLevel !== true) {
    if (seen.has(current.frameId)) {
      throw new MoneyHandError("INVALID_SEMANTIC_FRAME_TREE", "Semantic frame path is cyclic");
    }
    seen.add(current.frameId);
    path.push(current);
    current = byId.get(current.parentFrameId);
  }
  if (!current || current.topLevel !== true) {
    throw new MoneyHandError(
      "INVALID_SEMANTIC_FRAME_TREE",
      "Semantic frame path does not reach the top-level frame",
    );
  }
  return path.reverse().map((frame) => ({ ...frame }));
}

function semanticTarget(tabId, frame) {
  return {
    tabId,
    ...(typeof frame?.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
  };
}

function semanticViewport(value, label = "Semantic viewport") {
  const width = value?.width;
  const height = value?.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new MoneyHandError(
      "SEMANTIC_FRAME_MAPPING_FAILED",
      `${label} dimensions are invalid`,
    );
  }
  return { width, height };
}

function semanticContentQuad(value) {
  const quad = value?.quads?.[0];
  if (!Array.isArray(quad)
    || quad.length !== 8
    || quad.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new MoneyHandError(
      "SEMANTIC_FRAME_MAPPING_FAILED",
      "DOM.getContentQuads did not return one finite iframe content quad",
    );
  }
  const points = [
    { x: quad[0], y: quad[1] },
    { x: quad[2], y: quad[3] },
    { x: quad[4], y: quad[5] },
    { x: quad[6], y: quad[7] },
  ];
  const area = Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
  if (!Number.isFinite(area) || area < 1) {
    throw new MoneyHandError(
      "SEMANTIC_FRAME_MAPPING_FAILED",
      "The iframe content quad is degenerate",
    );
  }
  return points;
}

function mapSemanticPointThroughQuad(point, viewportValue, quadValue) {
  const viewport = semanticViewport(viewportValue);
  if (!Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || point.x < 0
    || point.y < 0
    || point.x > viewport.width
    || point.y > viewport.height) {
    throw new MoneyHandError(
      "SEMANTIC_FRAME_MAPPING_FAILED",
      "The child-frame point falls outside its current viewport",
    );
  }
  const quad = semanticContentQuad(quadValue);
  const u = point.x / viewport.width;
  const v = point.y / viewport.height;
  const top = {
    x: quad[0].x + (quad[1].x - quad[0].x) * u,
    y: quad[0].y + (quad[1].y - quad[0].y) * u,
  };
  const bottom = {
    x: quad[3].x + (quad[2].x - quad[3].x) * u,
    y: quad[3].y + (quad[2].y - quad[3].y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

function directCdpValue(terminal, expectedMethod, options = {}) {
  const fallbackCode = options.code ?? "SEMANTIC_ACTION_FAILED";
  const label = options.label ?? "Semantic action";
  if (terminal?.ok !== true) {
    const error = terminal?.error;
    throw new MoneyHandError(
      options.code ?? (typeof error?.code === "string" ? error.code : fallbackCode),
      typeof error?.message === "string"
        ? error.message
        : `${label} did not receive a successful Hand terminal`,
      {
        handRequestId: terminal?.id,
        ...(typeof error?.code === "string" ? { causeCode: error.code } : {}),
        ...(error?.details === undefined ? {} : { cause: error.details }),
      },
    );
  }
  const command = terminal.result;
  if (command?.method !== expectedMethod
    || !command.result
    || typeof command.result !== "object"
    || Array.isArray(command.result)) {
    throw new MoneyHandError(
      fallbackCode,
      `${label} did not return ${expectedMethod}`,
      { handRequestId: terminal?.id },
    );
  }
  return command.result;
}

function taskEvaluationTransportError(error) {
  const cause = normalizedError(error, "TASK_EVALUATION_FAILED");
  let detailsText = "";
  try {
    detailsText = JSON.stringify(cause.details ?? {});
  } catch {
    detailsText = "";
  }
  const diagnostic = `${cause.code} ${cause.message} ${detailsText}`;
  if (/execution context was destroyed|cannot find (?:default )?context with specified id/iu.test(diagnostic)) {
    return new MoneyHandError(
      "TASK_EVALUATION_CONTEXT_DESTROYED",
      "The page execution context changed before Runtime.evaluate returned",
      {
        actionDispatched: "unknown",
        retry: "wait-for-current-page-then-evaluate-once",
        cause,
      },
    );
  }
  if (/inspected target navigated or closed|frame was detached/iu.test(diagnostic)) {
    return new MoneyHandError(
      "TASK_EVALUATION_INTERRUPTED",
      "Navigation or frame replacement interrupted Runtime.evaluate",
      {
        actionDispatched: "unknown",
        retry: "wait-for-current-page-then-evaluate-once",
        cause,
      },
    );
  }
  return error;
}

function taskEvaluationException(result) {
  const details = result?.exceptionDetails ?? {};
  return {
    text: String(details.text ?? "Runtime.evaluate raised an exception").slice(0, 2_048),
    ...(Number.isInteger(details.lineNumber) ? { lineNumber: details.lineNumber } : {}),
    ...(Number.isInteger(details.columnNumber) ? { columnNumber: details.columnNumber } : {}),
    ...(typeof details.url === "string" ? { url: details.url.slice(0, 4_096) } : {}),
    ...(typeof details.exception?.description === "string"
      ? { description: details.exception.description.slice(0, 4_096) }
      : {}),
  };
}

function semanticMainFrame(result, code = "INVALID_SEMANTIC_ACTION") {
  const frame = result?.frameTree?.frame;
  if (typeof frame?.id !== "string"
    || !frame.id
    || typeof frame?.loaderId !== "string"
    || !frame.loaderId
    || typeof frame?.url !== "string") {
    throw new MoneyHandError(code, "Page.getFrameTree did not return a guarded main frame");
  }
  return { frameId: frame.id, loaderId: frame.loaderId, url: frame.url };
}

function assertSemanticFrameGuard(frame, guard) {
  if (frame.frameId !== guard.frameId
    || frame.loaderId !== guard.loaderId
    || frame.url !== guard.url) {
    throw new MoneyHandError(
      "STALE_SEMANTIC_REF",
      "Semantic ref loader or URL changed; capture a new snapshot before acting",
      {
        expected: { frameId: guard.frameId, loaderId: guard.loaderId, url: guard.url },
        observed: frame,
      },
    );
  }
  return frame;
}

function semanticRuntimeValue(result, label) {
  if (result?.exceptionDetails) {
    throw new MoneyHandError(
      "SEMANTIC_TARGET_UNREADABLE",
      `${label} failed in the inspected page`,
      { exception: String(result.exceptionDetails.text ?? "Runtime exception").slice(0, 2_048) },
    );
  }
  const value = result?.result?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandError(
      "SEMANTIC_TARGET_UNREADABLE",
      `${label} did not return target state by value`,
    );
  }
  return value;
}

function assertInteractiveTargetState(value) {
  const rect = value?.rect;
  if (!Number.isFinite(value?.x)
    || value.x < 0
    || !Number.isFinite(value?.y)
    || value.y < 0
    || !rect
    || !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || rect.width <= 0
    || !Number.isFinite(rect.height)
    || rect.height <= 0
    || typeof value.tag !== "string"
    || value.tag.length < 1
    || value.tag.length > 64) {
    throw new MoneyHandError(
      "SEMANTIC_TARGET_UNREADABLE",
      "Semantic target preflight returned invalid viewport geometry",
    );
  }
  return value;
}

function semanticInputRequest(
  plan,
  targetState,
  browser,
  dispatchPoint = targetState,
  destinationPoint,
  sourceObjectId,
) {
  const target = semanticTarget(plan.tabId, plan.frame);
  const rootTarget = { tabId: plan.tabId };
  const action = plan.action;
  if (["click", "download", "check", "uncheck"].includes(action.action)) {
    return {
      method: "input.perform",
      params: {
        target: rootTarget,
        action: "click",
        coordinateSpace: COORDINATE_SPACE,
        x: dispatchPoint.x,
        y: dispatchPoint.y,
        button: action.action === "click" ? action.button : "left",
        clickCount: action.action === "click" ? action.clickCount : 1,
      },
    };
  }
  if (action.action === "hover") {
    return {
      method: "input.perform",
      params: {
        target: rootTarget,
        action: "move",
        coordinateSpace: COORDINATE_SPACE,
        x: dispatchPoint.x,
        y: dispatchPoint.y,
      },
    };
  }
  if (action.action === "scroll") {
    return {
      method: "input.perform",
      params: {
        target: rootTarget,
        action: "scroll",
        coordinateSpace: COORDINATE_SPACE,
        x: dispatchPoint.x,
        y: dispatchPoint.y,
        deltaX: action.deltaX,
        deltaY: action.deltaY,
      },
    };
  }
  if (action.action === "drag") {
    if (!destinationPoint) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_ACTION",
        "Semantic drag requires a prepared destination point",
      );
    }
    return {
      method: "input.perform",
      params: {
        target: rootTarget,
        action: "drag",
        coordinateSpace: COORDINATE_SPACE,
        from: { x: dispatchPoint.x, y: dispatchPoint.y },
        to: { x: destinationPoint.x, y: destinationPoint.y },
      },
    };
  }
  if (action.action === "upload") {
    if (typeof sourceObjectId !== "string" || !sourceObjectId) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_ACTION",
        "Semantic upload requires a prepared file-input object",
      );
    }
    return {
      method: "cdp.send",
      params: {
        target,
        method: "DOM.setFileInputFiles",
        params: {
          files: [...action.files],
          objectId: sourceObjectId,
        },
      },
    };
  }
  if (action.action === "select") {
    if (typeof sourceObjectId !== "string" || !sourceObjectId) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_ACTION",
        "Semantic select requires a prepared select object",
      );
    }
    return {
      method: "cdp.send",
      params: {
        target,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: sourceObjectId,
          functionDeclaration: SET_SEMANTIC_SELECT_OPTIONS_FUNCTION,
          arguments: [{ value: { descriptors: action.options, commit: true } }],
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        },
      },
    };
  }
  const steps = [{
    method: "cdp.send",
    params: {
      target,
      method: "DOM.focus",
      params: { backendNodeId: plan.node.backendNodeId },
    },
  }];
  if (action.action === "type") {
    if (action.replace) {
      const os = String(browser?.platform?.os ?? "").toLowerCase();
      steps.push({
        method: "input.perform",
        params: {
          target,
          action: "key",
          key: "a",
          code: "KeyA",
          modifiers: os.includes("mac") ? 4 : 2,
        },
      });
    }
    steps.push({
      method: "input.perform",
      params: { target, action: "type", text: action.text },
    });
  } else {
    steps.push({
      method: "input.perform",
      params: {
        target,
        action: "key",
        key: action.key,
        ...(action.code === undefined ? {} : { code: action.code }),
        modifiers: action.modifiers,
        ...(action.text === undefined ? {} : { text: action.text }),
      },
    });
  }
  return {
    method: "batch.run",
    params: { steps, continueOnError: false },
  };
}

async function pollDelay(milliseconds, signal) {
  if (signal?.aborted) {
    throw new MoneyHandError(
      "ABORTED",
      "Semantic verification was aborted after the action; inspect before retrying",
      { actionDispatched: true, retry: "inspect-before-retry" },
    );
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new MoneyHandError(
        "ABORTED",
        "Semantic verification was aborted after the action; inspect before retrying",
        { actionDispatched: true, retry: "inspect-before-retry" },
      ));
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function portableDownloadBasename(value) {
  return typeof value === "string"
    ? (value.replaceAll("\\", "/").split("/").at(-1) ?? "")
    : "";
}

function clippedDownloadString(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function publicDownloadUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_768) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`.slice(0, 4_096);
    }
    if (parsed.protocol === "blob:") {
      return `blob:${parsed.origin === "null" ? "" : parsed.origin}`.slice(0, 4_096);
    }
    return parsed.protocol.slice(0, 32);
  } catch {
    return null;
  }
}

function normalizedDownloadItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.id) || value.id < 0
    || typeof value.state !== "string" || !SEMANTIC_DOWNLOAD_STATES.has(value.state)) {
    throw new MoneyHandError(
      "INVALID_DOWNLOAD_OBSERVATION",
      "downloads.search returned an invalid DownloadItem",
    );
  }
  for (const key of ["filename", "url", "finalUrl", "mime", "danger", "startTime", "endTime", "error"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 32_768)) {
      throw new MoneyHandError(
        "INVALID_DOWNLOAD_OBSERVATION",
        `downloads.search returned an invalid ${key}`,
      );
    }
  }
  return value;
}

function publicDownloadReceipt(value) {
  const item = normalizedDownloadItem(value);
  const finiteNumber = (candidate) => Number.isFinite(candidate) ? candidate : null;
  return {
    id: item.id,
    state: item.state,
    filename: clippedDownloadString(portableDownloadBasename(item.filename), 1_024),
    url: publicDownloadUrl(item.url),
    finalUrl: publicDownloadUrl(item.finalUrl),
    mime: clippedDownloadString(item.mime, 256),
    danger: clippedDownloadString(item.danger, 128),
    bytesReceived: finiteNumber(item.bytesReceived),
    totalBytes: finiteNumber(item.totalBytes),
    fileSize: finiteNumber(item.fileSize),
    startTime: clippedDownloadString(item.startTime, 64),
    endTime: clippedDownloadString(item.endTime, 64),
    error: clippedDownloadString(item.error, 128),
    localPathReturned: false,
    fileExistenceVerified: false,
    completionSource: "chrome.downloads.search",
  };
}

function semanticDownloadMatches(item, match) {
  if (match.filename !== undefined
    && portableDownloadBasename(item.filename) !== match.filename) return false;
  if (match.url !== undefined && item.url !== match.url) return false;
  if (match.finalUrl !== undefined && item.finalUrl !== match.finalUrl) return false;
  if (match.mime !== undefined && item.mime !== match.mime) return false;
  return true;
}

async function semanticDownloadPollDelay(milliseconds, signal) {
  if (signal?.aborted) {
    throw new MoneyHandError(
      "ABORTED",
      "Download observation was aborted after the guarded click; inspect before retrying",
      { actionDispatched: true, retry: "inspect-before-retry" },
    );
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new MoneyHandError(
        "ABORTED",
        "Download observation was aborted after the guarded click; inspect before retrying",
        { actionDispatched: true, retry: "inspect-before-retry" },
      ));
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

async function taskPagePollDelay(milliseconds, signal, actionDispatched) {
  const aborted = () => new MoneyHandError(
    "ABORTED",
    actionDispatched
      ? "Page readiness wait was aborted after navigation; inspect before retrying"
      : "Read-only page readiness wait was aborted",
    {
      actionDispatched,
      retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
    },
  );
  if (signal?.aborted) throw aborted();
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(aborted());
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function taskPageStateFromBatch(terminal) {
  const value = directHandValue(terminal, {
    code: "PAGE_STATE_READ_FAILED",
    label: "Page state batch",
  });
  const results = value.results;
  if (!Array.isArray(results) || results.length !== 2) {
    throw new MoneyHandError(
      "INVALID_PAGE_STATE",
      "Page state batch did not return two results",
    );
  }
  const frameTree = cdpBatchValue(results, 0, "Page.getFrameTree", {
    code: "INVALID_PAGE_STATE",
    label: "Page state",
  }).frameTree;
  const frame = frameTree?.frame;
  const runtimeStep = results[1];
  let readyState = null;
  let readinessError;
  if (runtimeStep?.ok === true
    && runtimeStep.method === "cdp.send"
    && runtimeStep.result?.method === "Runtime.evaluate"
    && runtimeStep.result.result
    && typeof runtimeStep.result.result === "object") {
    const runtime = runtimeStep.result.result;
    const valueByCopy = runtime.result?.value;
    if (runtime.exceptionDetails) {
      readinessError = {
        code: "PAGE_READY_STATE_UNAVAILABLE",
        message: String(runtime.exceptionDetails.text ?? "Runtime.evaluate raised an exception")
          .slice(0, 2_048),
      };
    } else if (valueByCopy && typeof valueByCopy === "object" && !Array.isArray(valueByCopy)) {
      readyState = valueByCopy.readyState;
    } else {
      throw new MoneyHandError(
        "INVALID_PAGE_STATE",
        "Runtime.evaluate did not return readyState by value",
      );
    }
  } else {
    readinessError = normalizedError(
      runtimeStep?.error ?? new Error("Runtime.evaluate did not complete"),
      "PAGE_READY_STATE_UNAVAILABLE",
    );
  }
  return normalizeTaskPageState({
    frameId: frame?.id,
    loaderId: frame?.loaderId,
    url: frame?.url,
    readyState,
    ...(readinessError === undefined ? {} : { readinessError }),
  });
}

async function semanticLocatorDelay(milliseconds, signal) {
  if (signal?.aborted) {
    throw new MoneyHandError("ABORTED", "Semantic locator wait was aborted before any action");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new MoneyHandError(
        "ABORTED",
        "Semantic locator wait was aborted before any action",
      ));
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

async function semanticFrameDiscoveryDelay(milliseconds, signal) {
  if (signal?.aborted) {
    throw new MoneyHandError(
      "ABORTED",
      "Semantic frame discovery was aborted before any action",
    );
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new MoneyHandError(
        "ABORTED",
        "Semantic frame discovery was aborted before any action",
      ));
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function networkOrDevicePath(value) {
  return /^\\\\(?:[?.]\\|[^\\])/u.test(value) || /^\/\/[^/]/u.test(value);
}

function windowsDeviceFile(value) {
  if (RUNTIME_PLATFORM !== "win32") return false;
  const name = basename(value);
  const stem = name.split(".")[0].toUpperCase();
  return name.includes(":") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
}

function pathIsInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..\\")
    && !relation.startsWith("../")
    && relation !== ".."
    && !isAbsolute(relation));
}

function validateOutputPath(value, rootValue) {
  if (typeof value !== "string" || !isAbsolute(value) || !/\.png$/iu.test(value)) {
    throw new MoneyHandError(
      "INVALID_OUTPUT_PATH",
      "outputPath must be an absolute path ending in .png",
    );
  }
  if (networkOrDevicePath(value) || windowsDeviceFile(value)) {
    throw new MoneyHandError(
      "INVALID_OUTPUT_PATH",
      "outputPath must not use a network share or device namespace",
    );
  }
  if (typeof rootValue !== "string" || !isAbsolute(rootValue) || networkOrDevicePath(rootValue)) {
    throw new MoneyHandError(
      "INVALID_OUTPUT_ROOT",
      "outputRoot must be an absolute local task directory",
    );
  }
  let root;
  let parent;
  try {
    root = realpathSync(rootValue);
    parent = realpathSync(dirname(value));
  } catch (error) {
    throw new MoneyHandError(
      "INVALID_OUTPUT_ROOT",
      `outputRoot and the output parent must already exist: ${error?.message ?? error}`,
    );
  }
  if (networkOrDevicePath(root) || networkOrDevicePath(parent) || !pathIsInside(root, parent)) {
    throw new MoneyHandError(
      "OUTPUT_OUTSIDE_ROOT",
      "outputPath must stay inside outputRoot after resolving links",
    );
  }
  return resolve(value);
}

function validateSemanticUploadFiles(fileValues, rootValue) {
  if (typeof rootValue !== "string"
    || !isAbsolute(rootValue)
    || networkOrDevicePath(rootValue)
    || windowsDeviceFile(rootValue)) {
    throw new MoneyHandError(
      "INVALID_UPLOAD_ROOT",
      "fileRoot must be an absolute local task directory",
    );
  }
  let root;
  try {
    root = realpathSync(rootValue);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new MoneyHandError(
      "INVALID_UPLOAD_ROOT",
      `fileRoot must identify an existing local directory: ${error?.message ?? error}`,
    );
  }
  if (networkOrDevicePath(root)
    || windowsDeviceFile(root)
    || dirname(root) === root) {
    throw new MoneyHandError(
      "INVALID_UPLOAD_ROOT",
      "fileRoot must be a confined task directory, not a network, device or volume root",
    );
  }
  if (!Array.isArray(fileValues)
    || fileValues.length < 1
    || fileValues.length > MAX_SEMANTIC_UPLOAD_FILES) {
    throw new MoneyHandError(
      "INVALID_UPLOAD_FILES",
      `files must contain 1-${MAX_SEMANTIC_UPLOAD_FILES} paths`,
    );
  }

  const files = [];
  const evidence = [];
  const seen = new Set();
  let totalBytes = 0n;
  for (const [index, value] of fileValues.entries()) {
    if (typeof value !== "string"
      || value.length < 1
      || value.length > 4_096
      || !isAbsolute(value)
      || networkOrDevicePath(value)
      || windowsDeviceFile(value)) {
      throw new MoneyHandError(
        "INVALID_UPLOAD_FILE",
        `files[${index}] must be an absolute local file path`,
      );
    }
    let path;
    let stats;
    try {
      path = realpathSync(value);
      stats = statSync(path, { bigint: true });
    } catch (error) {
      throw new MoneyHandError(
        "INVALID_UPLOAD_FILE",
        `files[${index}] must identify an existing local file: ${error?.message ?? error}`,
      );
    }
    if (networkOrDevicePath(path)
      || windowsDeviceFile(path)
      || !pathIsInside(root, path)) {
      throw new MoneyHandError(
        "UPLOAD_FILE_OUTSIDE_ROOT",
        `files[${index}] must stay inside fileRoot after resolving links`,
      );
    }
    if (!stats.isFile()) {
      throw new MoneyHandError(
        "INVALID_UPLOAD_FILE",
        `files[${index}] must identify a regular file`,
      );
    }
    if (seen.has(path)) {
      throw new MoneyHandError(
        "DUPLICATE_UPLOAD_FILE",
        "files must not resolve to the same local file more than once",
      );
    }
    seen.add(path);
    if (stats.size > BigInt(MAX_SEMANTIC_UPLOAD_FILE_BYTES)) {
      throw new MoneyHandError(
        "UPLOAD_FILE_TOO_LARGE",
        `Each upload file must be at most ${MAX_SEMANTIC_UPLOAD_FILE_BYTES} bytes`,
      );
    }
    totalBytes += stats.size;
    if (totalBytes > BigInt(MAX_SEMANTIC_UPLOAD_TOTAL_BYTES)) {
      throw new MoneyHandError(
        "UPLOAD_TOTAL_TOO_LARGE",
        `Upload files must total at most ${MAX_SEMANTIC_UPLOAD_TOTAL_BYTES} bytes`,
      );
    }
    files.push(path);
    evidence.push({
      path,
      size: Number(stats.size),
      mtimeNs: stats.mtimeNs.toString(),
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
    });
  }
  return {
    fileRoot: root,
    files,
    evidence,
    totalBytes: Number(totalBytes),
  };
}

function uploadEvidenceMatches(expected, observed) {
  return JSON.stringify(expected) === JSON.stringify(observed);
}

function semanticSelectFailureCode(reason) {
  if (reason === "option-not-found") return "SEMANTIC_SELECT_OPTION_NOT_FOUND";
  if (reason === "option-ambiguous") return "SEMANTIC_SELECT_OPTION_AMBIGUOUS";
  if (reason === "option-disabled") return "SEMANTIC_SELECT_OPTION_DISABLED";
  if (reason === "multiple-required") return "SEMANTIC_SELECT_MULTIPLE_REQUIRED";
  if (reason === "not-select") return "SEMANTIC_TARGET_NOT_SELECT";
  if (reason === "disabled") return "SEMANTIC_TARGET_DISABLED";
  if (reason === "detached") return "STALE_SEMANTIC_REF";
  return "SEMANTIC_SELECT_FAILED";
}

function semanticCheckableState(action, targetState) {
  const desired = action.action === "check";
  const role = typeof targetState.role === "string"
    ? targetState.role.trim().split(/\s+/u)[0].toLowerCase()
    : "";
  const native = targetState.tag === "input"
    && (targetState.inputType === "checkbox" || targetState.inputType === "radio");
  const aria = !native && ["checkbox", "radio", "switch"].includes(role);
  if (!native && !aria) {
    throw new MoneyHandError(
      "SEMANTIC_TARGET_NOT_CHECKABLE",
      "Semantic check/uncheck requires a native checkbox/radio or an ARIA checkbox/radio/switch",
      {
        tag: targetState.tag ?? null,
        inputType: targetState.inputType ?? null,
        role: role || null,
      },
    );
  }
  const kind = native ? targetState.inputType : role;
  if (!desired && kind === "radio") {
    throw new MoneyHandError(
      "SEMANTIC_RADIO_CANNOT_UNCHECK",
      "A radio target cannot be unchecked through one guarded user action",
    );
  }
  if (targetState.indeterminate === true || targetState.ariaChecked === "mixed") {
    throw new MoneyHandError(
      "SEMANTIC_CHECKED_STATE_MIXED",
      "Semantic check/uncheck rejects an indeterminate or mixed target; use an explicit click and observe",
    );
  }
  if (typeof targetState.checked !== "boolean") {
    throw new MoneyHandError(
      "SEMANTIC_CHECKED_STATE_UNREADABLE",
      "Semantic check/uncheck requires a current binary checked state",
    );
  }
  return {
    desired,
    before: targetState.checked,
    satisfied: targetState.checked === desired,
    kind,
    source: native ? "native" : "aria",
  };
}

async function writeScreenshot(path, buffer) {
  try {
    await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new MoneyHandError(
        "OUTPUT_EXISTS",
        "Refusing to overwrite an existing screenshot file",
        { path },
      );
    }
    throw new MoneyHandError(
      "SCREENSHOT_WRITE_FAILED",
      `Could not write screenshot: ${error?.message ?? error}`,
      { path },
    );
  }
}

function requestOptions(options, fallbackTimeoutMs) {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    0,
    86_400_000,
    fallbackTimeoutMs,
    "timeoutMs",
  );
  return {
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export class MoneyHandError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MoneyHandError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class MoneyHand extends EventEmitter {
  constructor(options = {}) {
    super();
    const input = asObject(options, "options");
    this.connectTimeoutMs = boundedInteger(
      input.connectTimeoutMs,
      0,
      86_400_000,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.peer = input.peer ?? createMoneyHandPeer({
      host: input.host,
      port: input.port,
      path: input.path,
      pairingToken: input.pairingToken,
      heartbeatMs: input.heartbeatMs,
      maxInflight: input.maxInflight,
      handshakeTimeoutMs: input.handshakeTimeoutMs,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    this.taskSpaces = new TaskSpaceRegistry({ now: input.now });
    this.taskApprovals = new TaskApprovalLedger({ now: input.now });
    this.siteLearnings = new SiteLearningRegistry();
    this.rateController = input.rateController
      ?? createRateController(input.rateControlOptions ?? {});
    this.taskWindows = new Map();
    this.semanticSnapshots = new Map();
    this.taskPageLocks = new Map();
    this.started = false;
    this.#bindPeerEvents();
  }

  async start() {
    const endpoint = await this.peer.start();
    this.started = this.peer.state === "RUNNING";
    return endpoint;
  }

  async stop(options = {}) {
    try {
      await this.cleanupOwnedTaskWindows().catch(() => {});
      return await this.peer.stop(options);
    } finally {
      this.started = this.peer.state === "RUNNING";
    }
  }

  capabilities() {
    return {
      protocol: MONEYHAND_CONTROL_PROTOCOL,
      wireProtocol: "npc-moneyhand/2",
      runtime: {
        node: HOST_PROCESS?.versions?.node ?? "unknown",
        platform: RUNTIME_PLATFORM,
        arch: RUNTIME_ARCH,
        minimumNodeMajor: 20,
        productionNodeMajors: [22, 24],
      },
      automaticConnection: {
        command: "--connect",
        resultSchema: MONEYHAND_CONNECT_RESULT_SCHEMA,
        successNextAction: CONNECT_READY_NEXT_ACTION,
        successTaskRouting: {
          currentConversationHasTask: "continue_immediately_without_reconfirmation",
          noConcreteTask: "ask_user_for_task",
          stopAfterConnectWhenTaskExists: "invalid",
          taskModule: "copy_and_implement_never_run_packaged_template",
        },
        userRetryFlag: "--after-user-action",
        maximumUserConfirmedRetries: 1,
        runsBrowserOperation: true,
        outerOkMeaning: "bounded-result-produced",
        connectedPredicate: "value.connected=true-and-value.status=connected",
        endpoint: "ws://127.0.0.1:19846/extension",
        fixedEndpoint: true,
        portDiscovery: false,
        customEndpoint: false,
        extensionFirstRunAutoEnabled: true,
        popupAction: "immediate-reconnect",
        fullPreflightRequired: false,
        automaticAcceptance: {
          schema: "npc-moneyhand-connect-acceptance/1",
          mandatoryOnNormalConnect: true,
          scope: "localhost-owned-task-window",
          externalWebsiteRequested: false,
          streamsProgress: true,
          closesTaskWindow: true,
          resetsBehaviorToRaw: true,
          removesDownloadArtifact: true,
          checks: [
            "task_context_and_human_mode",
            "localhost_navigation",
            "semantic_snapshot",
            "text_input",
            "pointer_click",
            "checkbox",
            "select",
            "upload",
            "human_scroll",
            "bounded_cdp_read",
            "viewport_screenshot",
            "full_page_screenshot",
            "download",
            "download_cleanup",
            "multi_navigation_evaluate",
            "task_window_and_behavior_cleanup",
          ],
        },
        reusesLiveSession: true,
        startsListener: true,
        startsBrowserWhenNeeded: true,
        closesExistingBrowser: false,
        platforms: ["win32", "darwin", "linux"],
        chromiumFamilies: [
          "chrome",
          "edge",
          "chromium",
          "brave",
          "vivaldi",
          "opera",
          "360",
          "qq-browser",
          "custom-chromium",
        ],
        customBrowserRootFlag: "--browser-root",
        profileSelection: "focused-live-session-else-enabled-installed-profile",
        readiness: "npc-moneyhand-2-handshake",
        extensionDistribution: {
          bundledWithSkill: false,
          automaticDownload: false,
          repositoryUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand",
          releasesUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
          assetName: "npc-moneyhand-extension-1.0.0.zip",
          manualInstallRequired: true,
        },
      },
      transports: {
        programmatic: true,
        jsonl: {
          encoding: "utf-8",
          persistent: true,
          oneShot: true,
          resultOrder: "completion",
          resultsMayBeOutOfOrder: true,
          maxLineBytes: MAX_JSONL_LINE_BYTES,
          maxInflight: MAX_JSONL_INFLIGHT,
        },
        taskModule: {
          flag: "--task",
          requiredExport: "run",
          signature: "run({ moneyhand, signal, args, progress, taskExecutionId })",
          security: "trusted-local-code",
          isolation: "one-built-in-node-worker-per-task-no-external-dependency",
          mutableControllerInternalsExposed: false,
          unresponsiveResourceCleanup: "terminate-task-worker-before-task-window-cleanup",
          resultId: "task",
          submittedEvent: "moneyhand.task_submitted",
          taskExecutionIdSchema: "task-uuid-v4",
          statusFlags: ["--task-last", "--task-status", "--task-follow"],
          terminalEvidenceFields: ["taskEvidence", "completionGate", "taskSummary"],
          timeoutFlag: "--task-timeout-ms",
          defaultTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
          maximumTimeoutMs: MAX_TASK_TIMEOUT_MS,
          timeoutResultCode: "TASK_TIMEOUT",
          unacknowledgedAbort: "fail-closed-controller-exit",
          progressEvent: "moneyhand.task_progress",
          progressSchema: "npc-moneyhand-task-progress/1",
          attachedMonitorEvent: "moneyhand.task_monitor",
          attachedMonitorSchema: "npc-moneyhand-task-monitor/1",
          attachedMonitorIntervalMs: ATTACHED_TASK_MONITOR_INTERVAL_MS,
          automaticProgressIntervalMs: DEFAULT_TASK_PROGRESS_INTERVAL_MS,
          automaticVisualSilenceMs: DEFAULT_TASK_VISUAL_SILENCE_MS,
          watchdogThresholdsCanOnlyTighten: true,
          monitoringStartsBeforeModuleImport: true,
          watchdogPausedAndDrainedBeforeTaskCleanup: true,
          relayField: "relay",
        },
        directCall: {
          connectFlag: "--connect",
          callFlag: "--call",
          parametersFlag: "--params-json",
          autoLaunchBrowser: true,
          stdinRequired: false,
          resultId: "call",
        },
        builtInController: {
          protocol: CONTROLLER_SERVICE_PROTOCOL,
          product: CONTROLLER_SERVICE_PRODUCT,
          version: CONTROLLER_SERVICE_VERSION,
          endpoint: `${DEFAULT_CONTROLLER_HOST}:${DEFAULT_CONTROLLER_PORT}`,
          startup: "implicit-on-connect-call-or-task",
          installation: "bundled-in-the-skill-no-separate-software",
          reuse: "same-runtime-build-across-agent-install-paths-one-controller-process-serializes-local-commands",
          compatibilityFields: ["protocol", "product", "version", "build"],
          auditFields: ["sourceId", "pid", "instanceNonce"],
          buildScope: "package-json-plus-scripts-recursive-mjs",
          privateRequestProof: "32-byte-random-token-from-user-private-state-never-status",
          stateSchema: "npc-moneyhand-controller-state/1",
          stateLocation: "os-temp-user-private-per-port",
          unknownOccupant: "fail-closed-without-stop-or-state-delete",
          staleUpgrade: "valid-owned-state-plus-two-port-refusals",
          halfOpenSocketShutdown: "destroy-accepted-sockets-before-server-close-wait",
          autoLaunchedBrowserCleanup: "close-unchanged-unique-bootstrap-tab-after-task",
          bootstrapCaptureRace: "retain-unique-provisional-marker-after-handshake-exact-cleanup-only",
          taskClientDisconnect: "journal-and-continue-task-for-reattachment",
          nonTaskClientDisconnect: "abort-active-command",
          idleExitMs: DEFAULT_CONTROLLER_IDLE_MS,
          publicStopFlag: "--stop",
          publicStopScope: "this-authenticated-controller-instance-only",
        },
      },
      operations: {
        programmatic: [...PROGRAMMATIC_OPERATIONS],
        jsonl: [...JSONL_OPERATIONS],
        jsonlControl: [...JSONL_CONTROL_OPERATIONS],
      },
      agentInterop: {
        protocol: AGENT_JSONL_PROTOCOL,
        framing: "utf-8-jsonl",
        startupEvent: "moneyhand.listening",
        stoppedEvent: "moneyhand.stopped",
        commandFields: { correlation: "id", operation: "op", arguments: "args" },
        argumentPolicy: {
          shape: "object",
          legacyTopLevelAccepted: true,
          mixedWithTopLevel: "reject",
          reservedFields: ["id", "op", "args"],
        },
        operationCatalog: {
          schema: "npc-agent-operation-catalog/1",
          discovery: "--describe",
          resource: "references/agent-operations.json",
          descriptorField: "operationCatalog",
          operationListField: "capabilities.operations.jsonl",
        },
        resultFields: { type: "result", correlation: "id", success: "ok" },
        lifecycleOperations: ["capabilities", "status", "cancel", "drain", "shutdown"],
        completion: "stopped-event-and-stdout-eof",
      },
      hand: {
        protocol: "npc-moneyhand/2",
        maxInflight: this.peer.maxInflight,
      },
      events: {
        ordinaryDelivery: "best-effort",
        results: "reliable-until-output-timeout",
      },
      artifacts: {
        mode: "local-file",
        screenshotMimeType: "image/png",
        requiresOutputRoot: true,
      },
      semanticObservation: {
        snapshotRefs: true,
        stableLocators: true,
        defaultMode: "accessibility",
        optionalDomSnapshot: true,
        ttlMs: SEMANTIC_SNAPSHOT_TTL_MS,
        maximumSnapshots: MAX_SEMANTIC_SNAPSHOTS,
        oopif: "optional-includeFrames; flattened-session-aware nested refs and guarded clicks",
        frameScope: {
          option: "includeFrames",
          default: false,
          defaultMaximumFrames: DEFAULT_SEMANTIC_FRAMES,
          maximumFrames: MAX_SEMANTIC_FRAMES,
          maximumDiscoveredFrames: MAX_SEMANTIC_DISCOVERED_FRAMES,
          maximumFrameDepth: MAX_SEMANTIC_FRAME_DEPTH,
          sameProcessFrames: true,
          flattenedOopifFrames: true,
          nested: true,
          frameBoundLocators: true,
          sessionRegistrySettledLocally: true,
          sessionRegistryQuietWindowMs:
            SEMANTIC_FRAME_DISCOVERY_POLL_MS * SEMANTIC_FRAME_DISCOVERY_STABLE_POLLS,
          sessionRegistrySettleTimeoutMs: SEMANTIC_FRAME_DISCOVERY_TIMEOUT_MS,
          identityBinding: {
            fieldsStoredSeparately: true,
            targetAndPageFrameIdValuesMayMatch: true,
            fields: ["sessionId", "targetId", "frameId", "parentFrameId", "loaderId", "url"],
          },
          clickMapping: "child-frame-to-target-root-then-cross-session-content-quads-to-top-level",
          finalHitTest: "terminal-frame-or-exact-top-level-frame-owner",
          callerPageJavaScript: false,
        },
        locatorWait: {
          operation: "waitForSemanticLocator",
          kinds: [...SEMANTIC_LOCATOR_KINDS],
          states: [...SEMANTIC_LOCATOR_STATES],
          defaultStablePolls: 2,
          profileBootPinnedAfterFirstSnapshot: true,
          transient: ["missing", "not-actionable", "backend-node-unavailable", "disabled"],
          ambiguity: "fail-closed",
          cssUniqueness: "only-currently-unique-snapshot-locators-match",
          callerPageJavaScript: false,
        },
        locatorAction: {
          operation: "actSemanticLocator",
          workflow: "task-space-pinned-locator-wait-then-fresh-ref-action-and-verification",
          sourceState: "actionable",
          defaultStablePolls: 2,
          taskSpacePinnedBeforeFirstSnapshot: true,
          returnsSnapshotContent: false,
          retainsInternalSnapshot: false,
          dragDestinationField: "toLocator",
          dragDestinationRequirement: "unique-actionable-in-final-source-snapshot-and-live-revalidated",
          highImpact: "explicit-waitForSemanticLocator-approveSemanticRefAction-actSemanticRef-path",
          callerPageJavaScript: false,
        },
        refActions: {
          operation: "actSemanticRef",
          actions: [...SEMANTIC_REF_ACTIONS],
          coordinateActions: [...SEMANTIC_COORDINATE_ACTIONS],
          scrollDeltaRange: [-100_000, 100_000],
          dragDestinationField: "toRef",
          dragRequiresSameSnapshot: true,
          dragRequiresSimultaneousVisibility: true,
          dragVerificationTarget: "source",
          download: {
            effect: "download",
            dispatch: "one-guarded-left-click",
            baseline: "profile-download-ids-before-final-no-scroll-preflight",
            observation: "bounded-chrome-downloads-search-poll",
            eventDependency: false,
            matcherFields: ["filename", "url", "finalUrl", "mime"],
            matcherMode: "exact",
            defaultTimeoutMs: 30_000,
            maximumTimeoutMs: 300_000,
            defaultPollIntervalMs: 250,
            maximumRecentDownloads: SEMANTIC_DOWNLOAD_SEARCH_LIMIT - 1,
            sameProfileConcurrentDownloads: "fail-closed",
            pathsReturned: false,
            urlQueryOrFragmentReturned: false,
            fileExistenceVerified: false,
            resultFields: [
              "id",
              "state",
              "filename",
              "url",
              "finalUrl",
              "mime",
              "danger",
              "bytesReceived",
              "totalBytes",
              "fileSize",
              "startTime",
              "endTime",
            ],
            defaultVerification: "download-complete",
            timeoutOrAmbiguity: "action-dispatched-inspect-before-retry",
          },
          upload: {
            effect: "upload",
            fileRootRequired: true,
            pathPolicy: "existing-regular-files-realpath-confined",
            identityEvidence: ["path", "size", "mtimeNs", "device", "inode"],
            networkOrDevicePathsAllowed: false,
            volumeRootAllowed: false,
            fileContentsReadByController: false,
            pathsReturned: false,
            evidenceRecheckedBeforeApprovalConsumption: true,
            maxFiles: MAX_SEMANTIC_UPLOAD_FILES,
            maxFileBytes: MAX_SEMANTIC_UPLOAD_FILE_BYTES,
            maxTotalBytes: MAX_SEMANTIC_UPLOAD_TOTAL_BYTES,
            hiddenFileInputAllowed: true,
            multipleFilesRequireMultipleInput: true,
            defaultVerification: "target-files-set",
          },
          select: {
            descriptorForms: ["value", "label", "index"],
            primitiveString: "value",
            primitiveInteger: "index",
            maximumDescriptors: 16,
            maximumNativeOptions: 4096,
            exactUniqueMatchRequired: true,
            disabledOptionsAllowed: false,
            multipleDescriptorsRequireMultipleSelect: true,
            callerPageJavaScript: false,
            preflightBeforeDispatch: true,
            dispatch: "fixed-runtime-function",
            events: ["input", "change"],
            trustedEvents: false,
            resultFields: ["index", "value", "label"],
            defaultVerification: "target-options-selected",
          },
          checkable: {
            actions: ["check", "uncheck"],
            nativeTargets: ["input[type=checkbox]", "input[type=radio]"],
            ariaRoles: ["checkbox", "radio", "switch"],
            uncheckRadioAllowed: false,
            mixedOrIndeterminateAllowed: false,
            idempotentNoInput: true,
            finalPreflightBeforeApprovalConsumption: true,
            highImpactNoopConsumesApproval: true,
            dispatchWhenNeeded: "moneyhand-cdp-pointer-click",
            directDomPropertyMutation: false,
            callerPageJavaScript: false,
            verificationKinds: ["target-checked"],
            resultFields: ["actionDispatched", "checkedState", "terminal"],
            defaultVerification: "target-checked",
            noInputPostconditionFailure: "safe-to-recheck",
          },
          taskSpaceRequired: true,
          effectFieldRequired: true,
          optionalApprovalOperation: "approveSemanticRefAction",
          verificationKinds: [...SEMANTIC_VERIFICATION_KINDS],
          defaultPointerAndKeyVerification: "observation-only",
          defaultDownloadVerification: "download-complete",
          defaultTypeVerification: "target-text-inserted",
          defaultUploadVerification: "target-files-set",
          defaultSelectVerification: "target-options-selected",
          defaultCheckVerification: "target-checked",
          preflight: [
            "exact-profile-boot-and-tab",
            "exact-frame-session-path",
            "snapshot-loader-and-url",
            "isolated-world-fixed-functions",
            "live-backend-node",
            "fresh-viewport-hit-test",
            "frame-owner-content-quads-and-top-level-hit-test",
            "visible-not-disabled-not-inert",
            "profile-download-baseline-and-final-no-scroll-target-read",
            "fixed-file-input-inspection",
            "confined-upload-file-identity",
            "fixed-select-option-resolution-and-dispatch",
            "binary-checkable-state-and-idempotent-pointer-dispatch",
          ],
          postconditionFailure: "action-dispatched-inspect-before-retry",
          unknownOutcome: "never-retry-blindly",
        },
      },
      pageTransitions: {
        operations: {
          wait: "waitForTaskPage",
          navigate: "navigateTaskTab",
        },
        taskSpaceRequired: true,
        tabScoped: true,
        effects: {
          wait: "read-only",
          navigate: "navigation",
        },
        waitUntil: [...PAGE_WAIT_UNTILS],
        urlMatchModes: [...PAGE_URL_MATCH_MODES],
        navigationSchemes: ["http", "https", "about:blank"],
        callerPageJavaScript: false,
        readinessProbe: "Page.getFrameTree-plus-fixed-document.readyState-batch",
        eventDependency: false,
        defaultWaitUntil: DEFAULT_PAGE_WAIT_UNTIL,
        defaultTimeoutMs: 30_000,
        maximumTimeoutMs: MAX_PAGE_WAIT_TIMEOUT_MS,
        timeoutMeaning: "document-readiness-budget-after-navigation-dispatch",
        finalProbeRequestTimeout: "min(hand-request-timeout,max(250ms,remaining-readiness-budget))",
        defaultPollIntervalMs: 100,
        defaultStablePolls: 2,
        maximumObservations: MAX_PAGE_WAIT_OBSERVATIONS,
        transientReadRecovery: "retry-within-the-same-bounded-observation-budget",
        sameProfileTabConcurrency: "fail-closed",
        differentProfileOrTabConcurrency: true,
        redirectPolicy: "observe-final-stable-frame-state; optional-fixed-url-match",
        commitClaim: "Page.navigate-or-owned-marker-tabs.update-command-acknowledged-only",
        readyClaim: "document-readiness-only-not-business-success",
        timeoutAfterNavigation: "action-dispatched-inspect-before-retry",
      },
      taskSpaces: {
        ownership: ["agent", "user"],
        pinnedSession: true,
        takeoverConfirmation: "explicit-user-record",
        extensionDependency: false,
        maximumParallelRequests: MAX_PARALLEL_TASK_REQUESTS,
        maximumConcurrency: MAX_TASK_REQUEST_CONCURRENCY,
        highImpactApproval: {
          effects: [...HIGH_IMPACT_TASK_EFFECTS],
          enforcement: "optional-caller-policy",
          token: "optional-backward-compatible-helper",
          confirmation: "owned-by-invoking-agent-or-specialized-skill",
          activity: "bounded-agent-local-ledger",
        },
      },
      taskRuntime: {
        helpers: [...TASK_MODULE_HELPERS],
        targetSelection: "latest-focused-profile-once-then-dedicated-owned-window",
        taskWindow: {
          creation: "one-new-normal-window-with-unique-about-blank-fragment-marker",
          ownership: "controller-task-id-plus-window-id-plus-single-tab-marker",
          cleanup: "close-exact-owned-window-in-finally-never-existing-user-windows",
          changedWindow: "fail-closed-without-window-remove",
        },
        initialPageHealthProbe: "exact-window-and-single-tab-ownership-marker-before-task-binding",
        firstNavigation: "owned-about-blank-marker-tabs.update-then-cdp-readiness",
        healthRecovery: "marker-ownership-before-first-navigation-then-bounded-cdp-probe",
        defaultBehavior: "raw",
        humanInputPath: "input.perform",
        humanJavaScriptScroll: false,
        semanticLinkNavigation: "fresh-ref-href-to-guarded-navigation",
        fixedEffects: {
          navigateTaskTab: "navigation",
          navigateSemanticRef: "navigation",
          scrollTaskTab: "input",
          conflict: "INVALID_TASK_EFFECT-before-dispatch",
        },
        moduleIsolation: {
          runtime: "one-node-worker-per-task-execution",
          externalPackages: 0,
          surface: "async-moneyhand-methods-progress-json-args-abort-signal",
          synchronousSnapshots: ["capabilities", "status"],
          normalCompletion: "terminate-worker-after-result",
          unacknowledgedAbort: "terminate-worker-then-clean-exact-task-windows",
        },
        durableExecution: {
          taskExecutionId: "task-uuid-v4",
          journal: "os-temp-user-private-build-bound-jsonl",
          writeOrder: "journal-before-client-delivery",
          clientDisconnect: "task-continues",
          statusFlags: ["--task-last", "--task-status", "--task-follow"],
        },
        idempotentEffects: {
          field: "effectId",
          scope: "one-task-execution",
          concurrentDuplicates: "join-first-promise",
          laterDuplicates: "reuse-first-result",
          conflictingFingerprint: "EFFECT_ID_CONFLICT-before-dispatch",
          unknownOutcomeReplay: false,
        },
        fixedRecovery: {
          maximumAttempts: 2,
          retryCondition: "whitelisted-transient-and-actionDispatched-false-and-same-page-probe-healthy",
          staleOrOccluded: "fresh-target-no-replay",
          dispatchedOrUnknown: "inspect-no-replay",
          sessionFailure: "terminal-fixed-connect-flow-once",
        },
        currentDocumentEvaluation: {
          operation: "evaluateTaskTab",
          schema: "npc-moneyhand-task-evaluate/1",
          effect: "read-only",
          context: "fresh-current-default-page-on-every-call",
          cachedContextIdentifiersAllowed: false,
          returnByValue: true,
          awaitPromiseDefault: true,
          maximumExpressionBytes: MAX_TASK_EVALUATION_EXPRESSION_BYTES,
          rawCdpEscapeHatch: "taskRequest-cdp.send",
        },
        statusSummary: {
          schema: "npc-moneyhand-task-summary/1",
          fields: [
            "state",
            "phase",
            "progress",
            "lastCheckpoint",
            "lastActivityAgoMs",
            "rate",
            "visual",
            "nextAction",
          ],
          surfaces: ["task-terminal", "--task-status", "--task-follow-status"],
          followStatusTopLevelField: "taskSummary",
        },
        recoveryEnvelope: {
          schema: "npc-moneyhand-task-recovery/1",
          additiveToOriginalError: true,
          fields: [
            "category",
            "rootCause",
            "actionDispatched",
            "retryAllowed",
            "retryAtMs",
            "waitingForInstruction",
            "visualFallback",
            "nextAction",
          ],
        },
        visualFallback: {
          mode: "automatic-broad-page-anomaly",
          operation: "inspectTaskBlocker",
          resolutionOperation: "resolveTaskBlocker",
          triggers: [
            "needs-instruction",
            "navigation-timeout-or-unknown",
            "page-health-or-readiness-failure",
            "semantic-missing-ambiguous-stale-or-occluded",
            "browser-input-or-postcondition-failure",
            "task-progress-silence",
            "task-terminal-failure-timeout-or-incomplete",
            "task-worker-recovery-after-silence",
            "other-task-page-operation-failure",
          ],
          excluded: [
            "connection-not-established",
            "no-pinned-task-page",
            "artifact-filesystem-failure",
            "rate-control-only-state",
          ],
          image: "one-current-viewport-local-png-per-anomaly",
          maximumAutomaticCapturesPerTask: MAX_AUTOMATIC_VISUAL_FALLBACKS,
          returnsBoundedText: true,
          hidesWaitIdTabIdAndBase64: true,
          preservesInstructionWait: true,
          actionReplay: false,
        },
        progress: {
          event: "moneyhand.task_progress",
          schema: "npc-moneyhand-task-progress/1",
          attachedMonitorEvent: "moneyhand.task_monitor",
          attachedMonitorSchema: "npc-moneyhand-task-monitor/1",
          attachedMonitorIntervalMs: ATTACHED_TASK_MONITOR_INTERVAL_MS,
          automaticIntervalMs: DEFAULT_TASK_PROGRESS_INTERVAL_MS,
          visualSilenceMs: DEFAULT_TASK_VISUAL_SILENCE_MS,
          watchdogPollMaximumMs: MAX_TASK_WATCHDOG_POLL_MS,
          thresholdsCanOnlyTighten: true,
          startsBeforeModuleImport: true,
          explicitCallback: "progress({phase,message,current,total,checkpoint})",
          streamsBeforeTaskCompletion: true,
          screenshotOnSilence: true,
          screenshotBeforeTaskTimeoutAbort: true,
          screenshotBeforeCleanupOnTerminalAnomaly: true,
          watchdogPausedAndDrainedBeforeTaskCleanup: true,
          screenshotActionReplay: false,
          relay: {
            field: "relay",
            wakeAgent: true,
            audiences: ["agent", "both"],
            controllerDeadlineMaximumMs: DEFAULT_TASK_PROGRESS_INTERVAL_MS,
            userDeadlineMs: 30_000,
          },
        },
        automaticRateControl: {
          scope: "http-origin-plus-pinned-profile",
          highLevelTaskSpaceGate: true,
          plainRequestGate: false,
          humanBypass: false,
          events: "moneyhand.task_rate_control",
        },
        evidence: {
          schema: "npc-moneyhand-task-evidence/1",
          artifact: "os-temp-user-private-json",
          terminalField: "taskEvidence",
        },
        completionGate: {
          schema: "npc-moneyhand-task-completion-gate/1",
          terminalField: "completionGate",
          failureCode: "TASK_COMPLETION_GATE_FAILED",
          checks: [
            "owned-window-cleanup",
            "effect-outcomes-resolved",
            "rate-circuit-closed",
            "instruction-blockers-resolved",
            "declared-requirements",
          ],
        },
        screenshotRetry: {
          operation: "captureStableViewport",
          successPathField: "path",
          transientCode: "STALE_VIEWPORT",
          defaultMaximumAttempts: 3,
          otherErrorsRetried: false,
        },
        fullPageCapture: {
          operation: "captureFullPage",
          successPathField: "path",
          observationOnly: true,
          coordinateMapping: false,
          maximumDecodedBytes: 4_194_304,
        },
        cleanup: "behavior-reset-owned-window-close-and-task-space-complete",
      },
      siteLearnings: {
        versioned: true,
        executable: false,
        matching: "exact-host-or-leading-wildcard-plus-path-prefix",
        ...this.siteLearnings.status(),
      },
      surfaceRouting: {
        operation: "routeSurface",
        order: [
          "moneyhand-semantic",
          "moneyhand-page-visual",
          "human",
        ],
        browserUnreachable: "human-takeover",
        highImpactRequiresConfirmation: false,
      },
      rateControl: {
        operation: "rateControl",
        actions: [...RATE_CONTROL_ACTIONS],
        scope: ["origin", "profile", "optional-account"],
        state: "task-owned-agent-memory",
        enforcement: "task-runtime-auto-gate-plus-explicit-specialized-scheduler",
        taskRuntimeImplicitGate: true,
        implicitRequestGate: false,
        humanBypassesRateControl: false,
      },
      ownership: {
        model: "single-agent-task",
        sharedPort: false,
      },
      agentPolicy: {
        dataAcquisition: dataAcquisitionPolicy(),
      },
    };
  }

  status() {
    const sessions = this.peer.sessions();
    return {
      protocol: MONEYHAND_CONTROL_PROTOCOL,
      state: this.peer.state,
      endpoint: this.peer.endpoint,
      limits: {
        handMaxInflight: this.peer.maxInflight,
        jsonlMaxInflight: MAX_JSONL_INFLIGHT,
      },
      sessions: sessions.map(sessionSummary),
      activeSession: sessionSummary(this.peer.activeSession()),
      taskSpaces: this.taskSpaces.list(),
      taskApprovals: this.taskApprovals.status(),
      siteLearnings: this.siteLearnings.status(),
      semanticSnapshots: this.#semanticSnapshotStatus(),
    };
  }

  async wait(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "wait options");
    const selector = input.selector === undefined ? {} : asObject(input.selector, "selector");
    const session = await this.peer.waitFor(selector, requestOptions(
      input,
      this.connectTimeoutMs,
    ));
    return sessionSummary(session);
  }

  async request(request, options = {}) {
    this.#assertRunning();
    const input = asObject(options, "request options");
    const value = asObject(request, "request");
    const selector = input.selector === undefined
      ? undefined
      : asObject(input.selector, "selector");
    const connectTimeoutMs = boundedInteger(
      input.connectTimeoutMs,
      0,
      86_400_000,
      this.connectTimeoutMs,
      "connectTimeoutMs",
    );
    const sendOptions = requestOptions(input, this.peer.requestTimeoutMs);
    if (selector !== undefined) {
      const session = await this.peer.waitFor(selector, {
        timeoutMs: connectTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return await session.request(value, sendOptions);
    }
    if (!this.peer.activeSession()) {
      await this.peer.waitFor({}, {
        timeoutMs: connectTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    return await this.peer.request(value, sendOptions);
  }

  async confirmUnknown(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "confirmUnknown options");
    const selector = asObject(input.selector, "selector");
    if (typeof selector.instanceId !== "string" || typeof selector.bootId !== "string") {
      throw new MoneyHandError(
        "INVALID_COMMAND",
        "confirmUnknown selector requires instanceId and bootId",
      );
    }
    if (!Array.isArray(input.ids) || input.ids.length < 1) {
      throw new MoneyHandError("INVALID_COMMAND", "confirmUnknown ids must be a non-empty array");
    }
    const timeoutMs = boundedInteger(
      input.timeoutMs,
      1,
      86_400_000,
      10_000,
      "timeoutMs",
    );
    const session = await this.peer.waitFor(selector, {
      timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const replacement = await session.confirmUnknownOutcomes(input.ids, {
      timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return sessionSummary(replacement);
  }

  async captureViewportBundle(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "captureViewportBundle options");
    const tabId = requiredInteger(input.tabId, 1, 2_147_483_647, "tabId");
    const outputPath = validateOutputPath(input.outputPath, input.outputRoot);
    const selector = input.selector === undefined
      ? undefined
      : asObject(input.selector, "selector");
    const connectTimeoutMs = boundedInteger(
      input.connectTimeoutMs,
      0,
      86_400_000,
      this.connectTimeoutMs,
      "connectTimeoutMs",
    );
    const waitOptions = {
      timeoutMs: connectTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const session = selector === undefined
      ? (this.peer.activeSession() ?? await this.peer.waitFor({}, waitOptions))
      : await this.peer.waitFor(selector, waitOptions);
    if (session.identity.capabilities?.coordinateContract !== COORDINATE_SPACE) {
      throw new MoneyHandError(
        "UNSUPPORTED_COORDINATE_CONTRACT",
        `Extension must advertise coordinateContract '${COORDINATE_SPACE}'`,
      );
    }

    const target = { tabId };
    const terminal = await session.request({
      method: "batch.run",
      params: {
        steps: [
          {
            method: "cdp.send",
            params: { target, method: "Page.getFrameTree", params: {} },
          },
          {
            method: "cdp.send",
            params: { target, method: "Page.getLayoutMetrics", params: {} },
          },
          {
            method: "cdp.send",
            params: {
              target,
              method: "Runtime.evaluate",
              params: {
                expression: `(() => {
                  const viewport = globalThis.visualViewport;
                  return {
                    devicePixelRatio: globalThis.devicePixelRatio,
                    innerWidth: globalThis.innerWidth,
                    innerHeight: globalThis.innerHeight,
                    scrollX: globalThis.scrollX,
                    scrollY: globalThis.scrollY,
                    visualViewport: viewport ? {
                      offsetLeft: viewport.offsetLeft,
                      offsetTop: viewport.offsetTop,
                      pageLeft: viewport.pageLeft,
                      pageTop: viewport.pageTop,
                      width: viewport.width,
                      height: viewport.height,
                      scale: viewport.scale
                    } : null
                  };
                })()`,
                returnByValue: true,
              },
            },
          },
          {
            method: "cdp.send",
            params: {
              target,
              method: "Page.captureScreenshot",
              params: {
                format: "png",
                fromSurface: true,
                captureBeyondViewport: false,
              },
            },
          },
          {
            method: "cdp.send",
            params: { target, method: "Page.getLayoutMetrics", params: {} },
          },
          {
            method: "cdp.send",
            params: { target, method: "Page.getFrameTree", params: {} },
          },
        ],
        continueOnError: false,
      },
    }, requestOptions(input, this.peer.requestTimeoutMs));

    if (terminal.ok !== true) return { terminal };
    const results = terminal.result?.results;
    if (!Array.isArray(results) || results.length !== 6) {
      throw new MoneyHandError(
        "INVALID_VIEWPORT_BUNDLE",
        "Viewport batch did not return six results",
      );
    }
    const beforeFrameTree = cdpBatchValue(results, 0, "Page.getFrameTree").frameTree;
    const beforeMetrics = selectedMetrics(cdpBatchValue(results, 1, "Page.getLayoutMetrics"));
    const runtime = runtimeViewportValue(cdpBatchValue(results, 2, "Runtime.evaluate"));
    const screenshotData = cdpBatchValue(results, 3, "Page.captureScreenshot").data;
    const afterMetrics = selectedMetrics(cdpBatchValue(results, 4, "Page.getLayoutMetrics"));
    const afterFrameTree = cdpBatchValue(results, 5, "Page.getFrameTree").frameTree;
    const frameGuard = assertStableViewport(
      beforeFrameTree,
      afterFrameTree,
      beforeMetrics,
      afterMetrics,
    );
    if (typeof screenshotData !== "string" || screenshotData.length < 1) {
      throw new MoneyHandError("INVALID_SCREENSHOT", "CDP screenshot data is missing");
    }
    const imageBuffer = Buffer.from(screenshotData, "base64");
    const dimensions = pngDimensions(imageBuffer);
    const cssWidth = afterMetrics.visual.clientWidth;
    const cssHeight = afterMetrics.visual.clientHeight;
    if (!(cssWidth > 0) || !(cssHeight > 0)) {
      throw new MoneyHandError(
        "INVALID_VIEWPORT_BUNDLE",
        "Visual viewport dimensions must be positive",
      );
    }
    const pixelsPerCssX = dimensions.width / cssWidth;
    const pixelsPerCssY = dimensions.height / cssHeight;
    const ratioDelta = Math.abs(pixelsPerCssX - pixelsPerCssY);
    if (!Number.isFinite(pixelsPerCssX)
      || !Number.isFinite(pixelsPerCssY)
      || ratioDelta > Math.max(pixelsPerCssX, pixelsPerCssY) * 0.02) {
      throw new MoneyHandError(
        "INVALID_SCREENSHOT_SCALE",
        "PNG dimensions do not map uniformly to the CSS visual viewport",
      );
    }
    await writeScreenshot(outputPath, imageBuffer);
    const sha256 = createHash("sha256").update(imageBuffer).digest("hex");
    return {
      bundle: {
        coordinateSpace: COORDINATE_SPACE,
        tabId,
        handRequestId: terminal.id,
        capturedAt: new Date().toISOString(),
        session: sessionSummary(session),
        sessionSelector: {
          instanceId: session.identity.instanceId,
          bootId: session.identity.bootId,
        },
        guard: {
          ...frameGuard,
          metrics: afterMetrics,
          atomic: false,
        },
        runtime,
        image: {
          path: outputPath,
          format: "png",
          bytes: imageBuffer.length,
          width: dimensions.width,
          height: dimensions.height,
          sha256,
        },
        mapping: {
          cssViewport: { width: cssWidth, height: cssHeight },
          imagePixelsPerCssPixel: { x: pixelsPerCssX, y: pixelsPerCssY },
          imageToCss: {
            scaleX: cssWidth / dimensions.width,
            scaleY: cssHeight / dimensions.height,
          },
        },
      },
    };
  }

  async captureSemanticSnapshot(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "captureSemanticSnapshot options");
    const tabId = requiredInteger(input.tabId, 1, 2_147_483_647, "tabId");
    const maxNodes = boundedInteger(input.maxNodes, 1, 2_000, 400, "maxNodes");
    const includeDomSnapshot = input.includeDomSnapshot === true;
    const session = await this.#sessionFor(input);
    if (input.includeFrames === true) {
      return await this.#captureFrameSemanticSnapshot({
        input,
        session,
        tabId,
        maxNodes,
        includeDomSnapshot,
      });
    }
    const target = { tabId };
    const steps = [
      {
        method: "cdp.send",
        params: { target, method: "Page.getFrameTree", params: {} },
      },
      ...(includeDomSnapshot ? [{
        method: "cdp.send",
        params: {
          target,
          method: "DOMSnapshot.captureSnapshot",
          params: {
            computedStyles: [],
            includeDOMRects: true,
            includePaintOrder: false,
          },
        },
      }] : []),
      {
        method: "cdp.send",
        params: { target, method: "Accessibility.getFullAXTree", params: {} },
      },
      {
        method: "cdp.send",
        params: { target, method: "Page.getFrameTree", params: {} },
      },
    ];
    const terminal = await session.request({
      method: "batch.run",
      params: {
        steps,
        continueOnError: false,
      },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    if (terminal.ok !== true) return { terminal };
    const results = terminal.result?.results;
    if (!Array.isArray(results) || results.length !== steps.length) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_SNAPSHOT",
        `Semantic snapshot batch did not return ${steps.length} results`,
      );
    }
    const semanticResult = (index, method) => cdpBatchValue(results, index, method, {
      code: "INVALID_SEMANTIC_SNAPSHOT",
      label: "Semantic snapshot",
    });
    const beforeFrameTree = semanticResult(0, "Page.getFrameTree").frameTree;
    const domSnapshot = includeDomSnapshot
      ? semanticResult(1, "DOMSnapshot.captureSnapshot")
      : {};
    const axIndex = includeDomSnapshot ? 2 : 1;
    const axTree = semanticResult(axIndex, "Accessibility.getFullAXTree");
    const afterFrameTree = semanticResult(axIndex + 1, "Page.getFrameTree").frameTree;
    const guard = assertStableFrame(beforeFrameTree, afterFrameTree);
    const compact = buildSemanticSnapshot({
      domSnapshot,
      axTree,
      maxNodes,
      includeIgnored: input.includeIgnored === true,
    });
    const capturedAtMs = Date.now();
    const snapshotId = `semantic:${capturedAtMs.toString(36)}:${randomUUID().slice(0, 8)}`;
    const sessionSelector = {
      instanceId: session.identity.instanceId,
      bootId: session.identity.bootId,
    };
    const snapshot = {
      id: snapshotId,
      tabId,
      handRequestId: terminal.id,
      capturedAt: new Date(capturedAtMs).toISOString(),
      expiresAt: new Date(capturedAtMs + SEMANTIC_SNAPSHOT_TTL_MS).toISOString(),
      sessionSelector,
      guard: { ...guard, atomic: false },
      mode: includeDomSnapshot ? "accessibility+dom" : "accessibility",
      totalCandidates: compact.totalCandidates,
      truncated: compact.truncated,
      nodes: compact.nodes,
      content: compact.content,
    };
    this.#rememberSemanticSnapshot(snapshot, capturedAtMs + SEMANTIC_SNAPSHOT_TTL_MS);
    return { snapshot };
  }

  async waitForSemanticLocator(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "waitForSemanticLocator options");
    let locator;
    let state;
    try {
      locator = normalizeSemanticLocator(input.locator);
      state = normalizeSemanticLocatorState(input.state);
    } catch (error) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_LOCATOR",
        error?.message ?? String(error),
      );
    }
    const tabId = requiredInteger(input.tabId, 1, 2_147_483_647, "tabId");
    const timeoutMs = boundedInteger(input.timeoutMs, 1, 120_000, 10_000, "timeoutMs");
    const requestTimeoutMs = boundedInteger(
      input.requestTimeoutMs,
      1,
      120_000,
      Number.isInteger(this.peer.requestTimeoutMs)
        ? Math.min(this.peer.requestTimeoutMs, 120_000)
        : 30_000,
      "requestTimeoutMs",
    );
    const connectTimeoutMs = boundedInteger(
      input.connectTimeoutMs,
      1,
      120_000,
      Math.min(this.connectTimeoutMs, 120_000),
      "connectTimeoutMs",
    );
    const pollIntervalMs = boundedInteger(
      input.pollIntervalMs,
      20,
      5_000,
      250,
      "pollIntervalMs",
    );
    const stablePollsRequired = boundedInteger(
      input.stablePolls,
      1,
      3,
      2,
      "stablePolls",
    );
    const maxNodes = boundedInteger(input.maxNodes, 1, 2_000, 400, "maxNodes");
    const startedAtMs = Date.now();
    const deadline = startedAtMs + timeoutMs;
    let attempts = 0;
    let stablePolls = 0;
    let stableKey;
    let retainedSnapshotId;
    let preserveRetainedSnapshot = false;
    let pinnedSelector = input.selector === undefined
      ? undefined
      : { ...asObject(input.selector, "selector") };
    let lastObservation = { status: "missing", count: 0 };

    try {
      while (true) {
        if (input.signal?.aborted) {
          throw new MoneyHandError("ABORTED", "Semantic locator wait was aborted before any action");
        }
        if (attempts > 0 && Date.now() >= deadline) {
          return {
            matched: false,
            timedOut: true,
            locator,
            state,
            attempts,
            stablePolls,
            stablePollsRequired,
            elapsedMs: Date.now() - startedAtMs,
            lastObservation,
          };
        }
        const remainingBeforeAttempt = Math.max(1, deadline - Date.now());
        const captured = await this.captureSemanticSnapshot({
          tabId,
          maxNodes,
          includeIgnored: input.includeIgnored === true,
          includeDomSnapshot: locator.kind === "css" || input.includeDomSnapshot === true,
          includeFrames: input.includeFrames === true || locator.frameId !== undefined,
          ...(input.maxFrames === undefined ? {} : { maxFrames: input.maxFrames }),
          ...(pinnedSelector === undefined ? {} : { selector: pinnedSelector }),
          connectTimeoutMs: Math.min(connectTimeoutMs, remainingBeforeAttempt),
          timeoutMs: Math.min(requestTimeoutMs, remainingBeforeAttempt),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        attempts += 1;
        if (captured.terminal) {
          return {
            matched: false,
            timedOut: false,
            locator,
            state,
            attempts,
            stablePollsRequired,
            terminal: captured.terminal,
          };
        }
        const snapshot = captured.snapshot;
        if (attempts === 1) pinnedSelector = { ...snapshot.sessionSelector };
        const match = matchSemanticLocator(snapshot.nodes, locator, state);
        lastObservation = {
          status: match.status,
          count: match.count,
          ...(match.reason === undefined ? {} : { reason: match.reason }),
          truncated: snapshot.truncated,
          totalCandidates: snapshot.totalCandidates,
        };

        if (match.status === "ambiguous") {
          this.semanticSnapshots.delete(snapshot.id);
          if (retainedSnapshotId) this.semanticSnapshots.delete(retainedSnapshotId);
          throw new MoneyHandError(
            "SEMANTIC_LOCATOR_AMBIGUOUS",
            "Stable semantic locator matched more than one current node",
            { locator, count: match.count, refs: match.refs, attempts },
          );
        }

        if (match.status === "matched") {
          const nextKey = semanticLocatorStabilityKey(snapshot, match.node, locator, state);
          stablePolls = nextKey === stableKey ? stablePolls + 1 : 1;
          stableKey = nextKey;
          if (retainedSnapshotId && retainedSnapshotId !== snapshot.id) {
            this.semanticSnapshots.delete(retainedSnapshotId);
          }
          retainedSnapshotId = snapshot.id;
          if (stablePolls >= stablePollsRequired) {
            preserveRetainedSnapshot = true;
            return {
              matched: true,
              timedOut: false,
              locator,
              state,
              attempts,
              stablePolls,
              stablePollsRequired,
              elapsedMs: Date.now() - startedAtMs,
              snapshot,
              match: { ref: match.node.ref, node: match.node },
            };
          }
        } else {
          this.semanticSnapshots.delete(snapshot.id);
          if (retainedSnapshotId) this.semanticSnapshots.delete(retainedSnapshotId);
          retainedSnapshotId = undefined;
          stableKey = undefined;
          stablePolls = 0;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            matched: false,
            timedOut: true,
            locator,
            state,
            attempts,
            stablePolls,
            stablePollsRequired,
            elapsedMs: Date.now() - startedAtMs,
            lastObservation,
          };
        }
        await semanticLocatorDelay(Math.min(pollIntervalMs, remaining), input.signal);
      }
    } finally {
      if (!preserveRetainedSnapshot && retainedSnapshotId) {
        this.semanticSnapshots.delete(retainedSnapshotId);
      }
    }
  }

  resolveSemanticRef(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "resolveSemanticRef options");
    if (typeof input.snapshotId !== "string" || typeof input.ref !== "string") {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_REF",
        "resolveSemanticRef requires snapshotId and ref strings",
      );
    }
    this.#pruneSemanticSnapshots();
    const entry = this.semanticSnapshots.get(input.snapshotId);
    if (!entry) {
      throw new MoneyHandError(
        "STALE_SEMANTIC_REF",
        "Semantic snapshot is missing or expired; capture a new snapshot",
      );
    }
    const node = entry.refs.get(input.ref);
    if (!node) {
      throw new MoneyHandError(
        "SEMANTIC_REF_NOT_FOUND",
        `Semantic ref '${input.ref}' is not in snapshot '${input.snapshotId}'`,
      );
    }
    let frame;
    let framePath = [];
    if (typeof node.frame?.frameId === "string") {
      frame = entry.snapshot.frames?.find((candidate) => (
        candidate.frameId === node.frame.frameId
      ));
      if (!frame) {
        throw new MoneyHandError(
          "INVALID_SEMANTIC_FRAME_TREE",
          "Semantic ref frame metadata is missing from its snapshot",
        );
      }
      framePath = semanticFramePath(entry.snapshot.frames, frame.frameId);
    }
    const guard = frame === undefined
      ? entry.snapshot.guard
      : { frameId: frame.frameId, loaderId: frame.loaderId, url: frame.url };
    return {
      snapshotId: input.snapshotId,
      tabId: entry.snapshot.tabId,
      sessionSelector: { ...entry.snapshot.sessionSelector },
      guard: { ...guard },
      rootGuard: { ...entry.snapshot.guard },
      ...(frame === undefined ? {} : {
        frame: { ...frame },
        framePath,
      }),
      node: { ...node },
    };
  }

  approveSemanticRefAction(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "approveSemanticRefAction options");
    const plan = this.#semanticActionPlan(input);
    const space = this.#semanticActionTaskSpace(input, plan);
    return this.taskApprovals.approve({
      taskSpaceId: space.id,
      effect: plan.effect,
      request: plan.approvalRequest,
      confirmation: input.confirmation,
      ttlMs: input.ttlMs,
    });
  }

  async actSemanticRef(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "actSemanticRef options");
    const plan = this.#semanticActionPlan(input);
    const space = this.#semanticActionTaskSpace(input, plan);
    const session = await this.#sessionFor({
      ...input,
      selector: plan.sessionSelector,
    });
    const checkableAction = plan.action.action === "check"
      || plan.action.action === "uncheck";
    const downloadAction = plan.action.action === "download";
    const coordinateAction = SEMANTIC_COORDINATE_ACTIONS.has(plan.action.action);
    if (coordinateAction
      && session.identity.capabilities?.coordinateContract !== COORDINATE_SPACE) {
      throw new MoneyHandError(
        "UNSUPPORTED_COORDINATE_CONTRACT",
        `Extension must advertise coordinateContract '${COORDINATE_SPACE}'`,
      );
    }

    const preparedTargets = [{ kind: "source", plan }];
    if (plan.destination) {
      preparedTargets.push({ kind: "destination", plan: plan.destination });
    }
    for (const prepared of preparedTargets) {
      if (prepared.plan.framePath?.some((frame) => frame.sessionId !== undefined)) {
        await this.#assertSemanticFrameSessionPath(session, prepared.plan, input);
      }
    }
    const source = preparedTargets[0];
    const destination = preparedTargets[1];
    const cleanup = { attempted: false, released: false };
    let outcomeUnknown = false;
    try {
      await this.#resolveSemanticActionTarget(
        session,
        source.plan,
        input,
        source,
        "Semantic source target",
      );
      if (plan.action.action === "type" && source.targetState.editable !== true) {
        throw new MoneyHandError(
          "SEMANTIC_TARGET_NOT_EDITABLE",
          "Semantic type action requires a visible editable input, textarea or contenteditable target",
        );
      }
      if (destination) {
        await this.#resolveSemanticActionTarget(
          session,
          destination.plan,
          input,
          destination,
          "Semantic drag destination",
        );
        // Destination preparation can scroll either document. Recheck both refs
        // without further scrolling so a drag never uses mutually stale points.
        await this.#refreshSemanticActionTarget(
          session,
          source,
          input,
          { label: "Semantic drag source", scroll: false },
        );
        await this.#refreshSemanticActionTarget(
          session,
          destination,
          input,
          { label: "Semantic drag destination", scroll: false },
        );
      }
      if (checkableAction) {
        // Re-read the binary state immediately before mapping/approval so an
        // already-satisfied action never toggles the control merely to verify it.
        await this.#refreshSemanticActionTarget(
          session,
          source,
          input,
          { label: "Semantic checkable target", scroll: false },
        );
      }

      let downloadArm;
      if (downloadAction) {
        downloadArm = await this.#armSemanticDownload(session, plan.action, input);
        // Baseline discovery is deliberately before the last no-scroll target
        // read so no download receipt can be mistaken for target freshness.
        await this.#refreshSemanticActionTarget(
          session,
          source,
          input,
          { label: "Semantic download target", scroll: false },
        );
      }

      const frameGuardPoint = coordinateAction && source.plan.framePath?.length
        ? await this.#mapSemanticFramePoint(
            session,
            source.plan,
            source.targetState,
            input,
            { scrollFrameOwners: destination === undefined },
          )
        : undefined;
      const dispatchPoint = plan.action.action === "upload"
        ? undefined
        : frameGuardPoint
          ? frameGuardPoint
          : { x: source.targetState.x, y: source.targetState.y };
      let destinationFrameGuardPoint;
      let destinationPoint;
      if (destination) {
        destinationFrameGuardPoint = destination.plan.framePath?.length
          ? await this.#mapSemanticFramePoint(
              session,
              destination.plan,
              destination.targetState,
              input,
              { scrollFrameOwners: false },
            )
          : undefined;
        destinationPoint = destinationFrameGuardPoint
          ?? { x: destination.targetState.x, y: destination.targetState.y };
        if (Math.hypot(
          destinationPoint.x - dispatchPoint.x,
          destinationPoint.y - dispatchPoint.y,
        ) < 1) {
          throw new MoneyHandError(
            "SEMANTIC_DRAG_NO_MOVEMENT",
            "Semantic drag source and destination resolve to the same viewport point",
          );
        }
      }
      if (plan.action.action === "upload") {
        let currentUpload;
        try {
          currentUpload = validateSemanticUploadFiles(
            plan.action.files,
            plan.action.fileRoot,
          );
        } catch (error) {
          throw new MoneyHandError(
            "UPLOAD_FILE_CHANGED",
            "A selected upload file became unavailable or unsafe before dispatch",
            { cause: normalizedError(error, "INVALID_UPLOAD_FILE") },
          );
        }
        if (!uploadEvidenceMatches(plan.action.fileEvidence, currentUpload.evidence)) {
          throw new MoneyHandError(
            "UPLOAD_FILE_CHANGED",
            "A selected upload file changed after approval planning; approve the current file again",
          );
        }
      }
      if (input.approvalToken !== undefined
        && HIGH_IMPACT_TASK_EFFECTS.includes(plan.effect)) {
        this.taskApprovals.consume({
          token: input.approvalToken,
          taskSpaceId: space.id,
          effect: plan.effect,
          request: plan.approvalRequest,
        });
      }
      let terminal = null;
      let actionDispatched = false;
      if (!checkableAction || !source.checkableState.satisfied) {
        const actionRequest = semanticInputRequest(
          plan,
          source.targetState,
          session.identity.browser,
          dispatchPoint,
          destinationPoint,
          source.objectId,
        );
        try {
          terminal = await session.request(
            actionRequest,
            requestOptions(input, this.peer.requestTimeoutMs),
          );
        } catch (error) {
          if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
            outcomeUnknown = true;
          }
          throw error;
        }
        actionDispatched = true;
        if (terminal?.ok !== true) {
          const error = terminal?.error;
          throw new MoneyHandError(
            typeof error?.code === "string" ? error.code : "SEMANTIC_ACTION_FAILED",
            typeof error?.message === "string" ? error.message : "Semantic input action failed",
            {
              actionDispatched: true,
              retry: "inspect-before-retry",
              handRequestId: terminal?.id,
              ...(error?.details === undefined ? {} : { cause: error.details }),
            },
          );
        }
      }

      let semanticDispatch;
      if (plan.action?.action === "select") {
        try {
          semanticDispatch = semanticRuntimeValue(
            directCdpValue(terminal, "Runtime.callFunctionOn", {
              code: "SEMANTIC_SELECT_FAILED",
              label: "Semantic select dispatch",
            }),
            "Semantic select dispatch",
          );
        } catch (error) {
          throw new MoneyHandError(
            "SEMANTIC_SELECT_INCONCLUSIVE",
            "Semantic select was dispatched but its fixed page function did not return a result",
            {
              actionDispatched: true,
              retry: "inspect-before-retry",
              cause: normalizedError(error, "SEMANTIC_SELECT_FAILED"),
              handRequestId: terminal.id,
            },
          );
        }
        if (semanticDispatch.ok !== true) {
          throw new MoneyHandError(
            semanticSelectFailureCode(semanticDispatch.reason),
            `Semantic select rejected the current target (${semanticDispatch.reason ?? "unknown"})`,
            {
              actionDispatched: false,
              reason: semanticDispatch.reason ?? null,
              handRequestId: terminal.id,
            },
          );
        }
      }

      let verification;
      let downloadReceipt;
      if (downloadAction) {
        downloadReceipt = await this.#waitForSemanticDownload(session, downloadArm, input);
        verification = evaluateSemanticVerification({
          verification: plan.action.verification,
          frameBefore: source.frameBefore,
          targetBefore: source.targetState,
          downloadReceipt,
        });
      } else {
        try {
          verification = await this.#verifySemanticAction({
            session,
            target: source.target,
            objectId: source.objectId,
            plan,
            frameBefore: source.frameBefore,
            targetBefore: source.targetState,
            input,
          });
        } catch (error) {
          if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
            throw error;
          }
          if (error?.details?.actionDispatched === true) throw error;
          throw new MoneyHandError(
            "SEMANTIC_VERIFICATION_INCONCLUSIVE",
            actionDispatched
              ? "Semantic action was dispatched but its postcondition could not be read"
              : "Semantic idempotent state could not be confirmed without input",
            {
              actionDispatched,
              retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
              cause: normalizedError(error, "SEMANTIC_VERIFICATION_FAILED"),
              handRequestId: terminal?.id ?? null,
            },
          );
        }
      }
      if (verification.matched === false) {
        throw new MoneyHandError(
          actionDispatched
            ? "SEMANTIC_POSTCONDITION_FAILED"
            : "SEMANTIC_IDEMPOTENT_STATE_CHANGED",
          actionDispatched
            ? "Semantic action was dispatched but its declarative postcondition did not match"
            : "Semantic checked state changed before the no-input result could be confirmed",
          {
            actionDispatched,
            retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
            verification,
            handRequestId: terminal?.id ?? null,
          },
        );
      }
      const result = {
        snapshotId: plan.snapshotId,
        ref: plan.ref,
        tabId: plan.tabId,
        taskSpaceId: space.id,
        effect: plan.effect,
        action: plan.action.action,
        actionDispatched,
        target: plan.action.action === "upload"
          ? {
              backendNodeId: plan.node.backendNodeId,
              tag: source.targetState.tag,
              inputType: source.targetState.inputType,
              multiple: source.targetState.multiple === true,
              ...(plan.frame ? { frameId: plan.guard.frameId } : {}),
            }
          : plan.action.action === "select"
            ? {
                backendNodeId: plan.node.backendNodeId,
                tag: source.targetState.tag,
                multiple: source.targetState.multiple === true,
                ...(plan.frame ? { frameId: plan.guard.frameId } : {}),
              }
          : {
              backendNodeId: plan.node.backendNodeId,
              x: dispatchPoint.x,
              y: dispatchPoint.y,
              ...(coordinateAction && plan.framePath?.length ? {
                localPoint: { x: source.targetState.x, y: source.targetState.y },
                topLevelGuardPoint: frameGuardPoint,
                frameId: plan.guard.frameId,
              } : {}),
              rect: source.targetState.rect,
              tag: source.targetState.tag,
              role: source.targetState.role,
            },
        ...(plan.action.action === "upload" ? {
          fileSelection: {
            count: plan.action.files.length,
            totalBytes: plan.action.totalBytes,
            pathsReturned: false,
          },
        } : {}),
        ...(plan.action.action === "select" ? {
          selection: {
            changed: semanticDispatch.changed === true,
            multiple: semanticDispatch.multiple === true,
            count: semanticDispatch.selection?.count ?? 0,
            options: Array.isArray(semanticDispatch.selection?.options)
              ? semanticDispatch.selection.options.map((option) => ({ ...option }))
              : [],
          },
        } : {}),
        ...(checkableAction ? {
          checkedState: {
            source: source.checkableState.source,
            kind: source.checkableState.kind,
            desired: source.checkableState.desired,
            before: source.checkableState.before,
            after: typeof verification.observed?.targetAfter?.checked === "boolean"
              ? verification.observed.targetAfter.checked
              : null,
            initiallySatisfied: source.checkableState.satisfied,
            changed: typeof verification.observed?.targetAfter?.checked === "boolean"
              ? verification.observed.targetAfter.checked !== source.checkableState.before
              : null,
          },
        } : {}),
        ...(downloadReceipt === undefined ? {} : { download: downloadReceipt }),
        ...(destination === undefined ? {} : {
          destination: {
            ref: destination.plan.ref,
            backendNodeId: destination.plan.node.backendNodeId,
            x: destinationPoint.x,
            y: destinationPoint.y,
            ...(destination.plan.framePath?.length ? {
              localPoint: {
                x: destination.targetState.x,
                y: destination.targetState.y,
              },
              topLevelGuardPoint: destinationFrameGuardPoint,
              frameId: destination.plan.guard.frameId,
            } : {}),
            rect: destination.targetState.rect,
            tag: destination.targetState.tag,
            role: destination.targetState.role,
          },
        }),
        terminal,
        verification,
        cleanup,
      };
      return result;
    } catch (error) {
      if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
        outcomeUnknown = true;
      }
      throw error;
    } finally {
      const releasable = preparedTargets.filter((prepared) => prepared.objectId);
      if (releasable.length > 0 && !outcomeUnknown && !input.signal?.aborted) {
        const released = {};
        for (const prepared of releasable) {
          released[prepared.kind] = await this.#releaseSemanticObject(
            session,
            prepared.target,
            prepared.objectId,
          );
        }
        if (releasable.length === 1) {
          Object.assign(cleanup, released[releasable[0].kind]);
        } else {
          cleanup.attempted = Object.values(released).every((entry) => entry.attempted);
          cleanup.released = Object.values(released).every((entry) => entry.released);
          cleanup.objects = released;
        }
      } else if (releasable.length > 0) {
        cleanup.skipped = outcomeUnknown ? "outcome-unknown" : "aborted";
      }
    }
  }

  async actSemanticLocator(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "actSemanticLocator options");
    const taskSpaceId = requiredTaskSpaceId(input.taskSpaceId);
    const space = this.taskSpaces.assertAgentControl(taskSpaceId);
    const tabId = requiredInteger(input.tabId, 1, 2_147_483_647, "tabId");
    if (input.selector !== undefined) {
      throw new MoneyHandError(
        "TASK_SPACE_SELECTOR_OWNED",
        "actSemanticLocator always uses the exact Profile boot owned by its Task Space",
      );
    }
    this.#validateTaskSpaceRequest(space, {
      method: "cdp.send",
      params: {
        target: { tabId },
        method: "Accessibility.getFullAXTree",
        params: {},
      },
    });
    if (input.effect === undefined) {
      throw new MoneyHandError(
        "SEMANTIC_EFFECT_REQUIRED",
        "actSemanticLocator requires an explicit non-read-only effect",
      );
    }
    const effect = normalizeTaskEffect(input.effect);
    if (effect === "read-only" || effect === "focus") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "A semantic locator action must declare input, navigation, download, or its real high-impact effect",
      );
    }
    let locator;
    let destinationLocator;
    let state;
    try {
      locator = normalizeSemanticLocator(input.locator);
      state = normalizeSemanticLocatorState(input.state);
      if (input.action === "drag") {
        destinationLocator = normalizeSemanticLocator(input.toLocator);
      } else if (input.toLocator !== undefined) {
        throw new TypeError("toLocator is valid only for drag actions");
      }
    } catch (error) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_LOCATOR",
        error?.message ?? String(error),
      );
    }
    if (state !== "actionable") {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_LOCATOR",
        "actSemanticLocator requires state 'actionable'",
      );
    }
    if (input.toRef !== undefined) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_ACTION",
        "actSemanticLocator resolves drag destinations through toLocator, not toRef",
      );
    }
    if (destinationLocator && JSON.stringify(destinationLocator) === JSON.stringify(locator)) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_ACTION",
        "Semantic drag source and destination locators must be different",
      );
    }
    const normalizedAction = normalizeSemanticRefAction(
      input.action === "drag" ? { ...input, toRef: "@destination" } : input,
    );
    if (normalizedAction.action === "download" && effect !== "download") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "Semantic download requires the exact effect 'download'",
      );
    }
    if (normalizedAction.action !== "download" && effect === "download") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "The download effect is valid only for a semantic download action",
      );
    }
    if (normalizedAction.action === "upload" && effect !== "upload") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "Semantic upload requires the exact effect 'upload'",
      );
    }

    let internalSnapshotId;
    try {
      const waited = await this.waitForSemanticLocator({
        tabId,
        locator,
        state: "actionable",
        selector: { ...space.selector },
        timeoutMs: input.waitTimeoutMs,
        requestTimeoutMs: input.requestTimeoutMs,
        connectTimeoutMs: input.connectTimeoutMs,
        pollIntervalMs: input.pollIntervalMs,
        stablePolls: input.stablePolls,
        maxNodes: input.maxNodes,
        includeIgnored: input.includeIgnored === true,
        includeDomSnapshot: input.includeDomSnapshot === true
          || destinationLocator?.kind === "css",
        includeFrames: input.includeFrames === true
          || locator.frameId !== undefined
          || destinationLocator?.frameId !== undefined,
        maxFrames: input.maxFrames,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (waited.terminal) {
        throw new MoneyHandError(
          "SEMANTIC_LOCATOR_WAIT_FAILED",
          "The exact Task Space Profile could not produce a semantic snapshot",
          {
            actionDispatched: false,
            handRequestId: waited.terminal.id,
            cause: normalizedError(waited.terminal.error, "SEMANTIC_SNAPSHOT_FAILED"),
          },
        );
      }
      if (waited.matched !== true || !waited.snapshot || !waited.match?.ref) {
        throw new MoneyHandError(
          "SEMANTIC_LOCATOR_NOT_READY",
          "The semantic locator did not become uniquely actionable before the wait budget ended",
          {
            actionDispatched: false,
            timedOut: waited.timedOut === true,
            attempts: waited.attempts,
            stablePolls: waited.stablePolls,
            stablePollsRequired: waited.stablePollsRequired,
            ...(waited.lastObservation === undefined
              ? {}
              : { lastObservation: waited.lastObservation }),
          },
        );
      }
      internalSnapshotId = waited.snapshot.id;

      let destinationMatch;
      if (destinationLocator) {
        destinationMatch = matchSemanticLocator(
          waited.snapshot.nodes,
          destinationLocator,
          "actionable",
        );
        if (destinationMatch.status === "ambiguous") {
          throw new MoneyHandError(
            "SEMANTIC_LOCATOR_AMBIGUOUS",
            "Semantic drag destination locator matched more than one current node",
            {
              actionDispatched: false,
              target: "destination",
              locator: destinationLocator,
              count: destinationMatch.count,
              refs: destinationMatch.refs,
            },
          );
        }
        if (destinationMatch.status !== "matched") {
          throw new MoneyHandError(
            "SEMANTIC_LOCATOR_NOT_READY",
            "Semantic drag destination is not uniquely actionable in the final source snapshot",
            {
              actionDispatched: false,
              target: "destination",
              locator: destinationLocator,
              status: destinationMatch.status,
              reason: destinationMatch.reason ?? null,
              count: destinationMatch.count,
            },
          );
        }
      }

      const actionInput = { ...input };
      for (const field of [
        "locator",
        "toLocator",
        "state",
        "waitTimeoutMs",
        "requestTimeoutMs",
        "connectTimeoutMs",
        "pollIntervalMs",
        "stablePolls",
        "maxNodes",
        "includeIgnored",
        "includeDomSnapshot",
        "includeFrames",
        "maxFrames",
        "selector",
      ]) delete actionInput[field];
      Object.assign(actionInput, {
        taskSpaceId,
        snapshotId: waited.snapshot.id,
        ref: waited.match.ref,
        effect,
        ...(destinationMatch ? { toRef: destinationMatch.node.ref } : {}),
      });
      const result = await this.actSemanticRef(actionInput);
      return {
        ...result,
        locator,
        ...(destinationLocator === undefined ? {} : { toLocator: destinationLocator }),
        locatorWait: {
          attempts: waited.attempts,
          stablePolls: waited.stablePolls,
          stablePollsRequired: waited.stablePollsRequired,
          elapsedMs: waited.elapsedMs,
          destinationCurrentSnapshot: destinationLocator === undefined ? null : true,
        },
        snapshotRetained: false,
      };
    } finally {
      if (internalSnapshotId) this.semanticSnapshots.delete(internalSnapshotId);
    }
  }

  #taskPageSpace(input, plan, expectedEffect, operation) {
    const taskSpaceId = requiredTaskSpaceId(input.taskSpaceId);
    const space = this.taskSpaces.assertAgentControl(taskSpaceId);
    if (input.effect === undefined) {
      throw new MoneyHandError(
        "TASK_EFFECT_REQUIRED",
        `${operation} requires top-level effect '${expectedEffect}' alongside taskSpaceId and tabId`,
      );
    }
    const effect = normalizeTaskEffect(input.effect);
    if (effect !== expectedEffect) {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        `${operation} requires the exact effect '${expectedEffect}'`,
      );
    }
    this.#validateTaskSpaceRequest(space, {
      method: "cdp.send",
      params: {
        target: { tabId: plan.tabId },
        method: expectedEffect === "navigation" ? "Page.navigate" : "Page.getFrameTree",
        params: expectedEffect === "navigation" ? { url: plan.url } : {},
      },
    });
    return space;
  }

  async #withTaskPageLock(space, tabId, operation, callback) {
    const key = `${space.selector.instanceId}\u0000${space.selector.bootId}\u0000${tabId}`;
    if (this.taskPageLocks.has(key)) {
      throw new MoneyHandError(
        "PAGE_TRANSITION_BUSY",
        "Another bounded page transition is active for this exact Profile tab",
        {
          actionDispatched: false,
          retry: "safe-to-recheck",
          taskSpaceId: space.id,
          tabId,
          activeOperation: this.taskPageLocks.get(key).operation,
        },
      );
    }
    const token = { operation };
    this.taskPageLocks.set(key, token);
    try {
      return await callback();
    } finally {
      if (this.taskPageLocks.get(key) === token) this.taskPageLocks.delete(key);
    }
  }

  async #readTaskPageState(session, plan, input, timeoutMs = this.peer.requestTimeoutMs) {
    const target = { tabId: plan.tabId };
    const terminal = await session.request({
      method: "batch.run",
      behavior: TASK_INTERNAL_BEHAVIOR,
      params: {
        steps: [
          {
            method: "cdp.send",
            params: { target, method: "Page.getFrameTree", params: {} },
          },
          {
            method: "cdp.send",
            params: {
              target,
              method: "Runtime.evaluate",
              params: {
                expression: READ_TASK_PAGE_STATE_EXPRESSION,
                returnByValue: true,
                awaitPromise: false,
                silent: true,
              },
            },
          },
        ],
        continueOnError: true,
      },
    }, {
      timeoutMs: Math.max(1, timeoutMs),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return taskPageStateFromBatch(terminal);
  }

  async #waitForTaskPageState(session, plan, input, options = {}) {
    const actionDispatched = options.actionDispatched === true;
    const deadline = Date.now() + plan.timeoutMs;
    const startedAt = Date.now();
    let attempts = 0;
    let observations = 0;
    let stablePolls = 0;
    let previousKey;
    let latest;
    let lastReadError;
    while (attempts < Math.max(1, plan.maximumObservations)) {
      attempts += 1;
      const remaining = Math.max(1, deadline - Date.now());
      const requestTimeoutMs = Math.max(
        1,
        Math.min(this.peer.requestTimeoutMs, Math.max(250, remaining)),
      );
      try {
        latest = await this.#readTaskPageState(session, plan, input, requestTimeoutMs);
      } catch (error) {
        lastReadError = error;
        if (Date.now() >= deadline || attempts >= plan.maximumObservations) break;
        await taskPagePollDelay(
          Math.min(plan.pollIntervalMs, Math.max(1, deadline - Date.now())),
          input.signal,
          actionDispatched,
        );
        continue;
      }
      observations += 1;
      if (taskPageStateMatches(latest, plan, options.transition)) {
        const key = taskPageStateStabilityKey(latest);
        stablePolls = key === previousKey ? stablePolls + 1 : 1;
        previousKey = key;
        if (stablePolls >= plan.stablePolls) {
          return {
            state: latest,
            waitUntil: plan.waitUntil,
            observations,
            stablePolls,
            elapsedMs: Date.now() - startedAt,
            claim: "document-readiness-only",
          };
        }
      } else {
        previousKey = undefined;
        stablePolls = 0;
      }
      if (Date.now() >= deadline || attempts >= plan.maximumObservations) break;
      await taskPagePollDelay(
        Math.min(plan.pollIntervalMs, Math.max(1, deadline - Date.now())),
        input.signal,
        actionDispatched,
      );
    }
    if (latest === undefined && lastReadError !== undefined) {
      throw new MoneyHandError(
        actionDispatched ? "NAVIGATION_OUTCOME_UNKNOWN" : "PAGE_WAIT_FAILED",
        actionDispatched
          ? "Navigation was dispatched but no final page state could be read after bounded recovery"
          : "The read-only page state could not be read after bounded recovery",
        {
          actionDispatched,
          retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
          attempts,
          cause: normalizedError(lastReadError, "PAGE_STATE_READ_FAILED"),
        },
      );
    }
    throw new MoneyHandError(
      actionDispatched ? "NAVIGATION_WAIT_TIMEOUT" : "PAGE_WAIT_TIMEOUT",
      actionDispatched
        ? "Navigation was dispatched but the requested stable document readiness was not proven"
        : "The requested stable document readiness was not proven before timeout",
      {
        actionDispatched,
        retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
        waitUntil: plan.waitUntil,
        observations,
        attempts,
        stablePolls,
        ...(lastReadError === undefined ? {} : {
          lastReadError: normalizedError(lastReadError, "PAGE_STATE_READ_FAILED"),
        }),
        ...(plan.expectedUrl === undefined ? {} : {
          expectedUrl: plan.expectedUrl,
          urlMatch: plan.urlMatch,
        }),
        ...(latest === undefined ? {} : { latest }),
      },
    );
  }

  async #listBrowserWindows(session, input = {}) {
    const terminal = await session.request({
      method: "chrome.call",
      behavior: TASK_INTERNAL_BEHAVIOR,
      params: { method: "windows.getAll", args: [{ populate: true }] },
    }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
    const value = directHandValue(terminal, {
      code: "TASK_WINDOW_INSPECTION_FAILED",
      label: "Task window inspection",
    });
    if (value.method !== "windows.getAll" || !Array.isArray(value.result)) {
      throw new MoneyHandError(
        "INVALID_TASK_WINDOW_RESULT",
        "windows.getAll returned an invalid task-window result",
      );
    }
    return value.result;
  }

  #matchOwnedTaskWindow(windows, record, options = {}) {
    const candidates = windows.filter((window) => window
      && typeof window === "object"
      && Number.isInteger(window.id)
      && (record.windowId === undefined || window.id === record.windowId)
      && window.type === "normal"
      && Array.isArray(window.tabs)
      && window.tabs.length === 1
      && Number.isInteger(window.tabs[0]?.id)
      && window.tabs[0].id > 0
      && window.tabs[0].windowId === window.id
      && (options.requireMarker !== true
        || window.tabs[0].url === record.marker
        || window.tabs[0].pendingUrl === record.marker)
      && (record.tabId === undefined || window.tabs[0].id === record.tabId));
    if (candidates.length === 1) return candidates[0];
    if (options.allowMissing === true && candidates.length === 0) return null;
    throw new MoneyHandError(
      candidates.length === 0 ? "TASK_WINDOW_NOT_FOUND" : "TASK_WINDOW_AMBIGUOUS",
      candidates.length === 0
        ? "The task-owned browser window could not be proven"
        : "More than one browser window matched the task ownership marker",
      { matches: candidates.length },
    );
  }

  async #createOwnedTaskWindow(session, id, input) {
    const marker = `about:blank#npc-moneyhand-task=${randomUUID()}`;
    const selector = {
      profile: session.identity.profile,
      instanceId: session.identity.instanceId,
      bootId: session.identity.bootId,
    };
    const provisionalRecord = {
      id,
      marker,
      selector,
      provisional: true,
      createdAt: new Date().toISOString(),
    };
    let acknowledgedWindowId;
    let activeSession = session;
    try {
      const terminal = await session.request({
        method: "chrome.call",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: {
          method: "windows.create",
          args: [{ url: marker, focused: true, type: "normal" }],
        },
      }, requestOptions(input, this.peer.requestTimeoutMs));
      const value = directHandValue(terminal, {
        code: "TASK_WINDOW_CREATE_FAILED",
        label: "Task window creation",
      });
      if (value.method !== "windows.create"
        || !Number.isInteger(value.result?.id)
        || value.result.id < 0) {
        throw new MoneyHandError(
          "INVALID_TASK_WINDOW_RESULT",
          "windows.create returned an invalid task-window result",
        );
      }
      acknowledgedWindowId = value.result.id;
    } catch (error) {
      if (!(error instanceof MoneyHandUnknownOutcomeError) && error?.code !== "OUTCOME_UNKNOWN") {
        throw new MoneyHandError(
          "TASK_WINDOW_CREATE_FAILED",
          "The dedicated task window was not created",
          { actionDispatched: false, cause: normalizedError(error, "TASK_WINDOW_CREATE_FAILED") },
        );
      }
      this.taskWindows.set(id, provisionalRecord);
      try {
        activeSession = await this.#sessionFor({
          ...input,
          selector,
          signal: undefined,
          connectTimeoutMs: Math.min(this.connectTimeoutMs, 2_000),
        });
      } catch (reconnectError) {
        throw new MoneyHandError(
          "TASK_WINDOW_CREATE_OUTCOME_UNKNOWN",
          "Task window creation lost its result and the same browser boot could not be inspected",
          {
            actionDispatched: true,
            retry: "do-not-replay",
            windowCleanup: {
              attempted: false,
              ok: false,
              owned: false,
              reason: "creation-outcome-unknown",
            },
            provisionalRetained: true,
            cause: normalizedError(reconnectError, "TASK_WINDOW_RECOVERY_FAILED"),
          },
        );
      }
    }
    let window;
    try {
      const windows = await this.#listBrowserWindows(activeSession, input);
      window = this.#matchOwnedTaskWindow(windows, {
        marker,
        ...(acknowledgedWindowId === undefined ? {} : { windowId: acknowledgedWindowId }),
      }, { requireMarker: true });
    } catch (error) {
      if (acknowledgedWindowId !== undefined) {
        provisionalRecord.windowId = acknowledgedWindowId;
      }
      const windowCleanup = acknowledgedWindowId === undefined
        ? {
            attempted: false,
            ok: false,
            owned: false,
            reason: "creation-outcome-unknown",
          }
        : await this.#removeAcknowledgedTaskWindow(
            activeSession,
            provisionalRecord,
            input,
          );
      if (windowCleanup.ok !== true) {
        this.taskWindows.set(id, provisionalRecord);
      } else {
        this.taskWindows.delete(id);
      }
      throw new MoneyHandError(
        acknowledgedWindowId === undefined
          ? "TASK_WINDOW_CREATE_OUTCOME_UNKNOWN"
          : "TASK_WINDOW_VALIDATION_FAILED",
        "The dedicated task window could not be uniquely validated",
        {
          actionDispatched: true,
          retry: "do-not-replay",
          windowCleanup,
          provisionalRetained: windowCleanup.ok !== true,
          cause: normalizedError(error, "TASK_WINDOW_VALIDATION_FAILED"),
        },
      );
    }
    const tab = window.tabs[0];
    const record = {
      id,
      marker,
      windowId: window.id,
      tabId: tab.id,
      selector,
      createdAt: new Date().toISOString(),
    };
    this.taskWindows.set(id, record);
    return { record, tab: { ...tab }, session: activeSession };
  }

  async #removeAcknowledgedTaskWindow(session, record, input) {
    let ownershipVerified = false;
    let closeAttempted = false;
    try {
      const inspected = await session.request({
        method: "chrome.call",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { method: "windows.get", args: [record.windowId, { populate: true }] },
      }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
      const inspectedValue = directHandValue(inspected, {
        code: "TASK_WINDOW_COMPENSATION_INSPECTION_FAILED",
        label: "Task window creation-compensation inspection",
      });
      if (inspectedValue.method !== "windows.get"
        || inspectedValue.result?.id !== record.windowId) {
        throw new MoneyHandError(
          "INVALID_TASK_WINDOW_RESULT",
          "windows.get returned an invalid creation-compensation result",
        );
      }
      const window = inspectedValue.result;
      const exact = window.type === "normal"
        && Array.isArray(window.tabs)
        && window.tabs.length === 1
        && Number.isInteger(window.tabs[0]?.id)
        && window.tabs[0].windowId === record.windowId
        && (window.tabs[0].url === record.marker || window.tabs[0].pendingUrl === record.marker);
      if (!exact) {
        return {
          attempted: true,
          closeAttempted: false,
          ok: false,
          owned: false,
          windowId: record.windowId,
          retry: "inspect-before-cleanup",
          error: {
            code: "TASK_WINDOW_OWNERSHIP_CHANGED",
            message: "The newly created task window changed before validation; it was not closed",
          },
        };
      }
      record.tabId = window.tabs[0].id;
      ownershipVerified = true;
      closeAttempted = true;
      const terminal = await session.request({
        method: "chrome.call",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { method: "windows.remove", args: [record.windowId] },
      }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
      const value = directHandValue(terminal, {
        code: "TASK_WINDOW_COMPENSATION_FAILED",
        label: "Task window creation compensation",
      });
      if (value.method !== "windows.remove" || value.result !== null) {
        throw new MoneyHandError(
          "INVALID_TASK_WINDOW_RESULT",
          "windows.remove returned an invalid creation-compensation result",
        );
      }
      return {
        attempted: true,
        closeAttempted: true,
        ok: true,
        owned: true,
        windowId: record.windowId,
      };
    } catch (error) {
      const outcomeUnknown = error instanceof MoneyHandUnknownOutcomeError
        || error?.code === "OUTCOME_UNKNOWN";
      return {
        attempted: true,
        closeAttempted,
        ok: false,
        owned: ownershipVerified,
        windowId: record.windowId,
        outcomeUnknown,
        retry: outcomeUnknown ? "do-not-replay" : "safe-to-recheck",
        error: normalizedError(error, "TASK_WINDOW_COMPENSATION_FAILED"),
      };
    }
  }

  async #removeOwnedTaskWindow(session, record, input) {
    const remove = async () => {
      const terminal = await session.request({
        method: "chrome.call",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { method: "windows.remove", args: [record.windowId] },
      }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
      const value = directHandValue(terminal, {
        code: "TASK_WINDOW_CLOSE_FAILED",
        label: "Task window close",
      });
      if (value.method !== "windows.remove" || value.result !== null) {
        throw new MoneyHandError(
          "INVALID_TASK_WINDOW_RESULT",
          "windows.remove returned an invalid task-window result",
        );
      }
    };
    try {
      await remove();
    } catch (error) {
      const waiting = error?.code === "TAB_WAITING"
        ? (error.details?.cause ?? error.details)
        : undefined;
      if (waiting?.tabId !== record.tabId || typeof waiting?.waitId !== "string") throw error;
      const terminal = await session.request({
        method: "instruction.resolve",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { tabId: record.tabId, waitId: waiting.waitId, action: "cancel" },
      }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
      const resolved = directHandValue(terminal, {
        code: "TASK_WINDOW_WAIT_CANCEL_FAILED",
        label: "Task window wait cancellation",
      });
      if (resolved.tabId !== record.tabId
        || resolved.waitId !== waiting.waitId
        || resolved.action !== "cancel"
        || resolved.waiting !== false) {
        throw new MoneyHandError(
          "INVALID_TASK_WINDOW_RESULT",
          "instruction.resolve did not cancel the exact task-tab wait",
        );
      }
      const windows = await this.#listBrowserWindows(session, input);
      this.#matchOwnedTaskWindow(windows, record, { requireMarker: record.provisional === true });
      await remove();
    }
  }

  async #closeOwnedTaskWindow(id, input = {}) {
    const record = this.taskWindows.get(id);
    if (!record) {
      return { attempted: false, ok: true, alreadyClosed: false, owned: false };
    }
    let session;
    try {
      session = await this.#sessionFor({
        ...input,
        selector: record.selector,
        signal: undefined,
        connectTimeoutMs: Math.min(this.connectTimeoutMs, 2_000),
      });
      const windows = await this.#listBrowserWindows(session, input);
      if (record.windowId === undefined) {
        const ownedWindow = this.#matchOwnedTaskWindow(windows, record, {
          requireMarker: true,
        });
        record.windowId = ownedWindow.id;
        record.tabId = ownedWindow.tabs[0].id;
        await this.#removeOwnedTaskWindow(session, record, input);
        this.taskWindows.delete(id);
        return {
          attempted: true,
          ok: true,
          alreadyClosed: false,
          owned: true,
          windowId: record.windowId,
          tabId: record.tabId,
        };
      }
      const sameId = windows.find((window) => window?.id === record.windowId);
      if (!sameId) {
        this.taskWindows.delete(id);
        return {
          attempted: true,
          ok: true,
          alreadyClosed: true,
          owned: true,
          windowId: record.windowId,
          tabId: record.tabId,
        };
      }
      const ownedWindow = this.#matchOwnedTaskWindow(windows, record, {
        requireMarker: record.provisional === true,
      });
      const removalRecord = record.tabId === undefined
        ? { ...record, tabId: ownedWindow.tabs[0].id }
        : record;
      await this.#removeOwnedTaskWindow(session, removalRecord, input);
      this.taskWindows.delete(id);
      return {
        attempted: true,
        ok: true,
        alreadyClosed: false,
        owned: true,
        windowId: record.windowId,
        tabId: record.tabId,
      };
    } catch (error) {
      if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
        try {
          session = await this.#sessionFor({
            ...input,
            selector: record.selector,
            signal: undefined,
            connectTimeoutMs: Math.min(this.connectTimeoutMs, 2_000),
          });
          const windows = await this.#listBrowserWindows(session, input);
          if (!windows.some((window) => window?.id === record.windowId)) {
            this.taskWindows.delete(id);
            return {
              attempted: true,
              ok: true,
              alreadyClosed: true,
              owned: true,
              windowId: record.windowId,
              tabId: record.tabId,
            };
          }
        } catch {
          // Preserve the ownership record; a later bounded cleanup may retry inspection.
        }
      }
      return {
        attempted: true,
        ok: false,
        alreadyClosed: false,
        owned: true,
        windowId: record.windowId,
        tabId: record.tabId,
        error: normalizedError(error, "TASK_WINDOW_CLOSE_FAILED"),
      };
    }
  }

  async beginTaskContext(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "beginTaskContext options");
    const id = requiredTaskSpaceId(
      input.id ?? input.taskSpaceId ?? `task-${randomUUID()}`,
    );
    const behaviorPlan = taskBehaviorPlan(input);
    const initialSession = await this.#sessionFor(input);
    if (this.taskSpaces.list().some((space) => space.id === id) || this.taskWindows.has(id)) {
      throw new MoneyHandError("TASK_SPACE_EXISTS", `taskSpace '${id}' already exists`);
    }
    const { tab, session } = await this.#createOwnedTaskWindow(initialSession, id, input);
    // The ownership marker deliberately lives on about:blank so creating a Task
    // Space never requests an external site. Chrome exposes that marker through
    // tabs/windows APIs, but chrome.debugger cannot read its document without a
    // host permission. The exact normal-window + single-tab + marker validation
    // above is therefore the readiness proof until the first real navigation.
    const initialPageGuard = null;
    let taskSpace;
    try {
      taskSpace = this.taskSpaces.create({
        id,
        name: input.name,
        tabIds: [tab.id],
        selector: {
          profile: session.identity.profile,
          instanceId: session.identity.instanceId,
          bootId: session.identity.bootId,
        },
      });
    } catch (error) {
      const windowCleanup = await this.#closeOwnedTaskWindow(id, input);
      throw new MoneyHandError(
        error?.code ?? "TASK_SPACE_CREATE_FAILED",
        String(error?.message ?? "The task context could not be created"),
        { windowCleanup },
      );
    }
    let behavior;
    try {
      const behaviorTerminal = await session.request({
        method: behaviorPlan.method,
        params: behaviorPlan.params,
      }, requestOptions(input, this.peer.requestTimeoutMs));
      behavior = directHandValue(behaviorTerminal, {
        code: "TASK_BEHAVIOR_FAILED",
        label: "Task behavior setup",
      });
      if (behavior.behavior?.mode !== behaviorPlan.mode) {
        throw new MoneyHandError(
          "INVALID_TASK_BEHAVIOR_RESULT",
          "The Extension did not confirm the requested task behavior",
        );
      }
    } catch (error) {
      let behaviorReset = { attempted: true, ok: false, value: null };
      try {
        const resetTerminal = await session.request({
          method: "behavior.reset",
          params: {},
        }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
        const resetValue = directHandValue(resetTerminal, {
          code: "TASK_BEHAVIOR_RESET_FAILED",
          label: "Failed task behavior reset",
        });
        behaviorReset = {
          attempted: true,
          ok: resetValue.behavior?.mode === "raw",
          value: resetValue,
        };
      } catch (resetError) {
        behaviorReset = {
          attempted: true,
          ok: false,
          value: null,
          error: normalizedError(resetError, "TASK_BEHAVIOR_RESET_FAILED"),
        };
      }
      this.taskSpaces.complete(id, { keep: false });
      const windowCleanup = await this.#closeOwnedTaskWindow(id, input);
      throw new MoneyHandError(
        "TASK_BEHAVIOR_FAILED",
        "The dedicated task page was bound, but task behavior could not be established",
        {
          cause: normalizedError(error, "TASK_BEHAVIOR_FAILED"),
          behaviorReset,
          windowCleanup,
        },
      );
    }
    return {
      id,
      taskId: id,
      taskSpaceId: id,
      selector: { ...taskSpace.selector },
      tabId: tab.id,
      page: {
        ownedWindow: true,
        tabId: tab.id,
        windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
        title: typeof tab.title === "string" ? tab.title.slice(0, 2_048) : "",
        url: typeof tab.url === "string" ? tab.url.slice(0, 16_384) : "",
        status: typeof tab.status === "string" ? tab.status : null,
        guard: initialPageGuard,
      },
      behavior: behavior.behavior,
      behaviorExpiresAt: behavior.expiresAt ?? null,
      taskSpace,
    };
  }

  async probeTaskContext(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "probeTaskContext options");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const probeInput = {
      ...input,
      selector: space.selector,
      connectTimeoutMs: input.connectTimeoutMs ?? 1_500,
      timeoutMs: input.timeoutMs ?? 3_000,
    };
    let session;
    try {
      session = await this.#sessionFor(probeInput);
    } catch (error) {
      return {
        healthy: false,
        taskSpaceId: space.id,
        tabId,
        stage: "session",
        nextAction: "end-task-and-run-fixed-connect-flow-once",
        error: normalizedError(error, "TASK_SESSION_UNHEALTHY"),
      };
    }
    try {
      const tabTerminal = await session.request({
        method: "chrome.call",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { method: "tabs.get", args: [tabId] },
      }, requestOptions(probeInput, this.peer.requestTimeoutMs));
      const tabValue = directHandValue(tabTerminal, {
        code: "TASK_TAB_UNHEALTHY",
        label: "Task tab health probe",
      });
      if (tabValue.method !== "tabs.get" || tabValue.result?.id !== tabId) {
        throw new MoneyHandError("TASK_TAB_UNHEALTHY", "tabs.get did not confirm the pinned tab");
      }
      const ownership = this.taskWindows.get(space.id);
      if (ownership?.tabId === tabId
        && ownership.windowId === tabValue.result.windowId
        && (tabValue.result.url === ownership.marker
          || tabValue.result.pendingUrl === ownership.marker)) {
        return {
          healthy: true,
          taskSpaceId: space.id,
          tabId,
          stage: "ownership-marker",
          guard: null,
        };
      }
      const pageTerminal = await session.request({
        method: "cdp.send",
        behavior: TASK_INTERNAL_BEHAVIOR,
        params: { target: { tabId }, method: "Page.getFrameTree", params: {} },
      }, requestOptions(probeInput, this.peer.requestTimeoutMs));
      const guard = semanticMainFrame(directCdpValue(
        pageTerminal,
        "Page.getFrameTree",
        { code: "TASK_PAGE_UNHEALTHY", label: "Task page health probe" },
      ), "TASK_PAGE_UNHEALTHY");
      return {
        healthy: true,
        taskSpaceId: space.id,
        tabId,
        stage: "ready",
        guard,
      };
    } catch (error) {
      return {
        healthy: false,
        taskSpaceId: space.id,
        tabId,
        stage: "page",
        nextAction: "preserve-state-then-end-task-and-run-fixed-connect-flow-once",
        error: normalizedError(error, "TASK_PAGE_UNHEALTHY"),
      };
    }
  }

  async waitForTaskPage(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "waitForTaskPage options");
    const plan = normalizeTaskPageWait(input);
    const space = this.#taskPageSpace(input, plan, "read-only", "waitForTaskPage");
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    return await this.#withTaskPageLock(space, plan.tabId, "waitForTaskPage", async () => ({
      taskSpaceId: space.id,
      tabId: plan.tabId,
      effect: "read-only",
      ...(await this.#waitForTaskPageState(session, plan, input)),
    }));
  }

  async navigateTaskTab(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "navigateTaskTab options");
    const plan = normalizeTaskPageNavigation(input);
    const space = this.#taskPageSpace(input, plan, "navigation", "navigateTaskTab");
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    return await this.#withTaskPageLock(space, plan.tabId, "navigateTaskTab", async () => {
      let before;
      let ownershipMarker = false;
      try {
        const ownership = this.taskWindows.get(space.id);
        if (ownership?.tabId === plan.tabId && Number.isInteger(ownership.windowId)) {
          const tabTerminal = await session.request({
            method: "chrome.call",
            behavior: TASK_INTERNAL_BEHAVIOR,
            params: { method: "tabs.get", args: [plan.tabId] },
          }, requestOptions(input, this.peer.requestTimeoutMs));
          const tabValue = directHandValue(tabTerminal, {
            code: "NAVIGATION_PREFLIGHT_FAILED",
            label: "Task ownership-marker navigation preflight",
          });
          const tab = tabValue.method === "tabs.get" ? tabValue.result : null;
          ownershipMarker = tab?.id === plan.tabId
            && tab.windowId === ownership.windowId
            && (tab.url === ownership.marker || tab.pendingUrl === ownership.marker);
          if (ownershipMarker) {
            before = {
              frameId: null,
              loaderId: null,
              url: ownership.marker,
              readyState: null,
              ownershipMarker: true,
            };
          }
        }
        if (!ownershipMarker) before = await this.#readTaskPageState(session, plan, input);
      } catch (error) {
        throw new MoneyHandError(
          "NAVIGATION_PREFLIGHT_FAILED",
          "The exact Profile tab could not be read before navigation",
          {
            actionDispatched: false,
            retry: "safe-to-recheck",
            cause: normalizedError(error, "PAGE_STATE_READ_FAILED"),
          },
        );
      }

      let terminal;
      try {
        terminal = await session.request(ownershipMarker ? {
          method: "chrome.call",
          behavior: TASK_INTERNAL_BEHAVIOR,
          params: { method: "tabs.update", args: [plan.tabId, { url: plan.url }] },
        } : {
          method: "cdp.send",
          behavior: TASK_INTERNAL_BEHAVIOR,
          params: {
            target: { tabId: plan.tabId },
            method: "Page.navigate",
            params: { url: plan.url },
          },
        }, {
          timeoutMs: this.peer.requestTimeoutMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
          throw new MoneyHandError(
            "NAVIGATION_OUTCOME_UNKNOWN",
            "The navigation request lost its terminal outcome; inspect the tab before retrying",
            {
              actionDispatched: true,
              dispatchState: "unknown",
              retry: "inspect-before-retry",
              cause: normalizedError(error, "OUTCOME_UNKNOWN"),
              before,
            },
          );
        }
        throw new MoneyHandError(
          "NAVIGATION_NOT_DISPATCHED",
          "Navigation was not dispatched",
          {
            actionDispatched: false,
            retry: "safe-to-recheck",
            cause: normalizedError(error, "NAVIGATION_REQUEST_FAILED"),
          },
        );
      }

      let navigation;
      try {
        if (ownershipMarker) {
          const value = directHandValue(terminal, {
            code: "NAVIGATION_REQUEST_FAILED",
            label: "Task ownership-marker navigation",
          });
          if (value.method !== "tabs.update"
            || value.result?.id !== plan.tabId
            || value.result.windowId !== this.taskWindows.get(space.id)?.windowId) {
            throw new MoneyHandError(
              "INVALID_NAVIGATION_RESULT",
              "tabs.update returned a different task tab or window",
            );
          }
          navigation = {
            frameId: null,
            loaderId: null,
            isDownload: false,
            transport: "chrome.tabs.update",
          };
        } else {
          navigation = directCdpValue(terminal, "Page.navigate", {
            code: "NAVIGATION_REQUEST_FAILED",
            label: "Task page navigation",
          });
        }
      } catch (error) {
        const actionDispatched = terminal?.ok === true;
        throw new MoneyHandError(
          actionDispatched ? "NAVIGATION_OUTCOME_UNKNOWN" : "NAVIGATION_NOT_DISPATCHED",
          actionDispatched
            ? "Navigation completed without a valid navigation result"
            : "Chrome rejected navigation before dispatch",
          {
            actionDispatched,
            retry: actionDispatched ? "inspect-before-retry" : "safe-to-recheck",
            cause: normalizedError(error, "NAVIGATION_REQUEST_FAILED"),
          },
        );
      }
      if ((!ownershipMarker && (typeof navigation.frameId !== "string"
          || navigation.frameId.length < 1
          || navigation.frameId !== before.frameId))
        || (navigation.loaderId !== undefined
          && navigation.loaderId !== null
          && (typeof navigation.loaderId !== "string" || navigation.loaderId.length < 1))
        || (navigation.errorText !== undefined && typeof navigation.errorText !== "string")
        || (navigation.isDownload !== undefined && typeof navigation.isDownload !== "boolean")) {
        throw new MoneyHandError(
          "INVALID_NAVIGATION_RESULT",
          "Page.navigate returned an invalid or replaced root-frame identity",
          { actionDispatched: true, retry: "inspect-before-retry", before },
        );
      }
      const publicNavigation = {
        frameId: navigation.frameId,
        loaderId: navigation.loaderId ?? null,
        isDownload: navigation.isDownload === true,
        ...(navigation.transport === undefined ? {} : { transport: navigation.transport }),
        errorText: typeof navigation.errorText === "string"
          ? navigation.errorText.slice(0, 2_048)
          : null,
      };
      if (publicNavigation.errorText) {
        throw new MoneyHandError(
          "NAVIGATION_FAILED",
          "Chrome reported that the navigation failed",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            navigation: publicNavigation,
            before,
          },
        );
      }
      if (publicNavigation.isDownload) {
        throw new MoneyHandError(
          "NAVIGATION_BECAME_DOWNLOAD",
          "Page.navigate started a download instead of a document transition",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            navigation: publicNavigation,
            before,
          },
        );
      }
      const base = {
        taskSpaceId: space.id,
        tabId: plan.tabId,
        effect: "navigation",
        requestedUrl: plan.url,
        actionDispatched: true,
        navigation: publicNavigation,
        before,
        handRequestId: terminal.id,
      };
      if (plan.waitUntil === "commit") {
        return {
          ...base,
          waitUntil: "commit",
          loaded: false,
          state: null,
          observations: 0,
          stablePolls: 0,
          claim: ownershipMarker
            ? "chrome.tabs.update-command-acknowledged-only"
            : "Page.navigate-command-acknowledged-only",
        };
      }
      const waited = await this.#waitForTaskPageState(session, plan, input, {
        actionDispatched: true,
        ...(ownershipMarker ? {} : {
          transition: {
            frameId: navigation.frameId,
            requestedUrl: plan.url,
            before,
          },
        }),
      });
      return { ...base, loaded: true, ...waited };
    });
  }

  async navigateSemanticRef(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "navigateSemanticRef options");
    const taskSpaceId = requiredTaskSpaceId(input.taskSpaceId ?? input.id);
    const space = this.taskSpaces.assertAgentControl(taskSpaceId);
    const resolved = this.resolveSemanticRef({
      snapshotId: input.snapshotId,
      ref: input.ref,
    });
    const tabId = taskSpaceTabId(space, input.tabId ?? resolved.tabId);
    if (resolved.tabId !== tabId) {
      throw new MoneyHandError(
        "TASK_SPACE_TAB_MISMATCH",
        "The semantic ref belongs to a different tab than the Task Space",
      );
    }
    if (space.selector.instanceId !== resolved.sessionSelector.instanceId
      || space.selector.bootId !== resolved.sessionSelector.bootId) {
      throw new MoneyHandError(
        "TASK_SPACE_SESSION_MISMATCH",
        "The semantic ref belongs to a different Profile boot than the Task Space",
      );
    }
    const url = semanticNavigationUrl(resolved);
    const navigation = await this.navigateTaskTab({
      taskSpaceId,
      tabId,
      url,
      effect: "navigation",
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
      ...(input.expectedUrl === undefined ? {} : { expectedUrl: input.expectedUrl }),
      ...(input.urlMatch === undefined ? {} : { urlMatch: input.urlMatch }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.stablePolls === undefined ? {} : { stablePolls: input.stablePolls }),
      ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      taskSpaceId,
      tabId,
      snapshotId: input.snapshotId,
      ref: input.ref,
      href: resolved.node.href ?? resolved.node.properties?.url,
      url,
      navigation,
    };
  }

  async scrollTaskTab(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "scrollTaskTab options");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const deltaX = taskScrollDelta(input.deltaX, 0, "deltaX");
    const deltaY = taskScrollDelta(input.deltaY, 0, "deltaY");
    if (deltaX === 0 && deltaY === 0) {
      throw new MoneyHandError(
        "INVALID_TASK_SCROLL",
        "scrollTaskTab requires a non-zero deltaX or deltaY",
      );
    }
    let x = taskScrollCoordinate(input.x, "x");
    let y = taskScrollCoordinate(input.y, "y");
    if ((x === undefined) !== (y === undefined)) {
      throw new MoneyHandError(
        "INVALID_TASK_SCROLL",
        "x and y must be supplied together or omitted together",
      );
    }
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    if (x === undefined) {
      const metricsTerminal = await session.request({
        method: "cdp.send",
        params: {
          target: { tabId },
          method: "Page.getLayoutMetrics",
          params: {},
        },
      }, requestOptions(input, this.peer.requestTimeoutMs));
      const metrics = selectedMetrics(directCdpValue(
        metricsTerminal,
        "Page.getLayoutMetrics",
        { code: "TASK_SCROLL_PREFLIGHT_FAILED", label: "Task scroll viewport read" },
      ));
      x = metrics.visual.clientWidth / 2;
      y = metrics.visual.clientHeight / 2;
    }
    const request = {
      method: "input.perform",
      params: {
        target: { tabId },
        action: "scroll",
        coordinateSpace: COORDINATE_SPACE,
        x,
        y,
        deltaX,
        deltaY,
      },
    };
    this.#validateTaskSpaceRequest(space, request);
    let terminal;
    try {
      terminal = await session.request(request, requestOptions(input, this.peer.requestTimeoutMs));
    } catch (error) {
      if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
        throw new MoneyHandError(
          "SCROLL_OUTCOME_UNKNOWN",
          "The human-input scroll lost its terminal outcome; inspect the page before retrying",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            cause: normalizedError(error, "OUTCOME_UNKNOWN"),
          },
        );
      }
      throw error;
    }
    const result = directHandValue(terminal, {
      code: "TASK_SCROLL_FAILED",
      label: "Task scroll",
    });
    if (result.ok !== true || result.action !== "scroll" || result.target?.tabId !== tabId) {
      throw new MoneyHandError(
        "INVALID_TASK_SCROLL_RESULT",
        "input.perform did not confirm the exact task-tab scroll",
        { actionDispatched: terminal?.ok === true, retry: "inspect-before-retry" },
      );
    }
    return {
      taskSpaceId: space.id,
      tabId,
      effect: "input",
      actionDispatched: true,
      coordinateSpace: COORDINATE_SPACE,
      point: { x, y },
      delta: { x: deltaX, y: deltaY },
      handRequestId: terminal.id,
    };
  }

  async inspectTaskBlocker(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "inspectTaskBlocker options");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    const generatedOutput = input.outputPath === undefined;
    const outputRoot = generatedOutput
      ? tmpdir()
      : (input.outputRoot === undefined ? dirname(input.outputPath) : input.outputRoot);
    const outputPath = validateOutputPath(
      generatedOutput
        ? resolve(tmpdir(), `npc-moneyhand-visual-${Date.now()}-${randomUUID()}.png`)
        : input.outputPath,
      outputRoot,
    );
    const trigger = visualFallbackTrigger(input.operation, input.reason);

    const inspect = async () => {
      let waitingForInstruction = null;
      let statusError;
      try {
        const statusTerminal = await session.request({
          method: "system.status",
          behavior: TASK_INTERNAL_BEHAVIOR,
          params: {},
        }, requestOptions(input, this.peer.requestTimeoutMs));
        const status = directHandValue(statusTerminal, {
          code: "VISUAL_STATUS_FAILED",
          label: "Visual fallback wait-state inspection",
        });
        waitingForInstruction = Array.isArray(status.waiting)
          ? status.waiting.some((entry) => entry?.tabId === tabId && typeof entry?.waitId === "string")
          : false;
      } catch (error) {
        if (input.signal?.aborted || error?.code === "ABORTED") throw error;
        statusError = normalizedError(error, "VISUAL_STATUS_FAILED");
      }

      let page = null;
      let contextError;
      try {
        const contextTerminal = await session.request({
          method: "observe.context",
          behavior: TASK_INTERNAL_BEHAVIOR,
          params: {
            target: { tabId },
            maxTextChars: 12_000,
            maxElements: 80,
          },
        }, requestOptions(input, this.peer.requestTimeoutMs));
        const context = directHandValue(contextTerminal, {
          code: "VISUAL_CONTEXT_FAILED",
          label: "Visual fallback text context",
        });
        const { target: _target, ...boundedPage } = context;
        page = boundedPage;
      } catch (error) {
        if (input.signal?.aborted || error?.code === "ABORTED") throw error;
        contextError = normalizedError(error, "VISUAL_CONTEXT_FAILED");
      }

      let screenshot;
      try {
        const screenshotTerminal = await session.request({
          method: "observe.screenshot",
          behavior: TASK_INTERNAL_BEHAVIOR,
          params: {
            target: { tabId },
            format: "png",
            fullPage: false,
          },
        }, requestOptions(input, this.peer.requestTimeoutMs));
        const value = directHandValue(screenshotTerminal, {
          code: "VISUAL_CAPTURE_FAILED",
          label: "Visual fallback screenshot",
        });
        if (value.target?.tabId !== tabId
          || value.mimeType !== "image/png"
          || typeof value.data !== "string"
          || value.data.length < 1) {
          throw new MoneyHandError(
            "INVALID_VISUAL_CAPTURE",
            "Visual fallback did not return PNG data for the pinned task tab",
          );
        }
        const imageBuffer = Buffer.from(value.data, "base64");
        const dimensions = pngDimensions(imageBuffer);
        await writeScreenshot(outputPath, imageBuffer);
        screenshot = {
          captured: true,
          path: outputPath,
          mimeType: "image/png",
          width: dimensions.width,
          height: dimensions.height,
          bytes: imageBuffer.length,
          sha256: createHash("sha256").update(imageBuffer).digest("hex"),
          capturedAt: new Date().toISOString(),
          localSensitive: true,
        };
      } catch (error) {
        if (input.signal?.aborted || error?.code === "ABORTED") throw error;
        screenshot = {
          captured: false,
          error: normalizedError(error, "VISUAL_CAPTURE_FAILED"),
        };
      }

      return {
        schema: "npc-moneyhand-visual-fallback/1",
        taskSpaceId: space.id,
        captured: screenshot.captured,
        waitingForInstruction,
        trigger,
        page,
        ...(statusError === undefined ? {} : { statusError }),
        ...(contextError === undefined ? {} : { contextError }),
        screenshot,
        actionReplayed: false,
        nextAction: waitingForInstruction === true
          ? "inspect-screenshot-then-resolveTaskBlocker"
          : "inspect-screenshot-and-current-page-before-next-action",
      };
    };
    return input[TASK_CONCURRENT_VISUAL_OBSERVATION] === true
      ? await inspect()
      : await this.#withTaskPageLock(space, tabId, "inspectTaskBlocker", inspect);
  }

  async resolveTaskBlocker(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "resolveTaskBlocker options");
    const action = input.action;
    if (action !== "resume" && action !== "cancel") {
      throw new MoneyHandError(
        "INVALID_BLOCKER_ACTION",
        "resolveTaskBlocker action must be 'resume' or 'cancel'",
      );
    }
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    const statusTerminal = await session.request({
      method: "system.status",
      behavior: TASK_INTERNAL_BEHAVIOR,
      params: {},
    }, requestOptions(input, this.peer.requestTimeoutMs));
    const status = directHandValue(statusTerminal, {
      code: "BLOCKER_STATUS_FAILED",
      label: "Task blocker wait-state inspection",
    });
    const wait = Array.isArray(status.waiting)
      ? status.waiting.find((entry) => entry?.tabId === tabId && typeof entry?.waitId === "string")
      : undefined;
    if (!wait) {
      return {
        taskSpaceId: space.id,
        resolved: false,
        action,
        waitingForInstruction: false,
      };
    }
    const terminal = await session.request({
      method: "instruction.resolve",
      params: { tabId, waitId: wait.waitId, action },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    const value = directHandValue(terminal, {
      code: "BLOCKER_RESOLUTION_FAILED",
      label: "Task blocker resolution",
    });
    if (value.tabId !== tabId
      || value.waitId !== wait.waitId
      || value.action !== action
      || value.waiting !== false) {
      throw new MoneyHandError(
        "INVALID_BLOCKER_RESOLUTION",
        "instruction.resolve did not resolve the exact pinned task-tab wait",
      );
    }
    return {
      taskSpaceId: space.id,
      resolved: true,
      action,
      waitingForInstruction: false,
    };
  }

  async captureStableViewport(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "captureStableViewport options");
    const captureInput = input.outputRoot === undefined && typeof input.outputPath === "string"
      ? { ...input, outputRoot: dirname(input.outputPath) }
      : input;
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const maxAttempts = boundedInteger(input.maxAttempts, 1, 5, 3, "maxAttempts");
    const retryDelayMs = boundedInteger(input.retryDelayMs, 0, 5_000, 150, "retryDelayMs");
    return await this.#withTaskPageLock(
      space,
      tabId,
      "captureStableViewport",
      async () => {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const result = await this.captureViewportBundle({
              ...captureInput,
              tabId,
              selector: space.selector,
            });
            if (result.bundle === undefined) {
              let failure;
              try {
                directHandValue(result.terminal, {
                  code: "VIEWPORT_CAPTURE_FAILED",
                  label: "Stable viewport capture",
                });
              } catch (error) {
                failure = error;
              }
              throw new MoneyHandError(
                "VIEWPORT_CAPTURE_FAILED",
                "The guarded viewport capture returned a failed terminal result",
                {
                  actionDispatched: viewportCaptureWasDispatched(result.terminal),
                  retry: "safe-to-recheck",
                  attempts: attempt,
                  cause: normalizedError(failure, "VIEWPORT_CAPTURE_FAILED"),
                },
              );
            }
            return {
              ...result,
              taskSpaceId: space.id,
              tabId,
              path: result.bundle.image.path,
              attempts: attempt,
              stable: true,
            };
          } catch (error) {
            if (error?.code !== "STALE_VIEWPORT") throw error;
            if (attempt === maxAttempts) {
              throw new MoneyHandError(
                "VIEWPORT_NOT_STABLE",
                "The task page did not remain stable for one guarded screenshot",
                {
                  actionDispatched: false,
                  retry: "safe-to-recheck",
                  attempts: attempt,
                  cause: normalizedError(error, "STALE_VIEWPORT"),
                },
              );
            }
            await taskRetryDelay(retryDelayMs, input.signal);
          }
        }
        throw new MoneyHandError("VIEWPORT_NOT_STABLE", "Stable screenshot attempts were exhausted");
      },
    );
  }

  async captureFullPage(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "captureFullPage options");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    const tabId = taskSpaceTabId(space, input.tabId);
    const outputRoot = input.outputRoot === undefined && typeof input.outputPath === "string"
      ? dirname(input.outputPath)
      : input.outputRoot;
    const outputPath = validateOutputPath(input.outputPath, outputRoot);
    const maxAttempts = boundedInteger(input.maxAttempts, 1, 3, 2, "maxAttempts");
    const retryDelayMs = boundedInteger(input.retryDelayMs, 0, 5_000, 150, "retryDelayMs");
    const session = await this.#sessionFor({ ...input, selector: space.selector });
    const guardRequest = {
      method: "batch.run",
      params: {
        steps: [
          {
            method: "cdp.send",
            params: { target: { tabId }, method: "Page.getFrameTree", params: {} },
          },
          {
            method: "cdp.send",
            params: { target: { tabId }, method: "Page.getLayoutMetrics", params: {} },
          },
        ],
        continueOnError: false,
      },
    };
    this.#validateTaskSpaceRequest(space, guardRequest);
    return await this.#withTaskPageLock(space, tabId, "captureFullPage", async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const beforeTerminal = await session.request(
          guardRequest,
          requestOptions(input, this.peer.requestTimeoutMs),
        );
        const before = directHandValue(beforeTerminal, {
          code: "FULL_PAGE_PREFLIGHT_FAILED",
          label: "Full-page capture preflight",
        });
        const beforeResults = before.results;
        if (!Array.isArray(beforeResults) || beforeResults.length !== 2) {
          throw new MoneyHandError(
            "INVALID_FULL_PAGE_CAPTURE",
            "Full-page preflight did not return two guarded results",
          );
        }
        const beforeFrameTree = cdpBatchValue(beforeResults, 0, "Page.getFrameTree").frameTree;
        const beforeMetrics = selectedMetrics(cdpBatchValue(
          beforeResults,
          1,
          "Page.getLayoutMetrics",
        ));
        const screenshotTerminal = await session.request({
          method: "observe.screenshot",
          params: {
            target: { tabId },
            format: "png",
            fullPage: true,
          },
        }, requestOptions(input, this.peer.requestTimeoutMs));
        const screenshot = directHandValue(screenshotTerminal, {
          code: "FULL_PAGE_CAPTURE_FAILED",
          label: "Full-page screenshot",
        });
        const afterTerminal = await session.request(
          guardRequest,
          requestOptions(input, this.peer.requestTimeoutMs),
        );
        const after = directHandValue(afterTerminal, {
          code: "FULL_PAGE_POSTFLIGHT_FAILED",
          label: "Full-page capture postflight",
        });
        const afterResults = after.results;
        if (!Array.isArray(afterResults) || afterResults.length !== 2) {
          throw new MoneyHandError(
            "INVALID_FULL_PAGE_CAPTURE",
            "Full-page postflight did not return two guarded results",
          );
        }
        const afterFrameTree = cdpBatchValue(afterResults, 0, "Page.getFrameTree").frameTree;
        const afterMetrics = selectedMetrics(cdpBatchValue(
          afterResults,
          1,
          "Page.getLayoutMetrics",
        ));
        try {
          const frameGuard = assertStableViewport(
            beforeFrameTree,
            afterFrameTree,
            beforeMetrics,
            afterMetrics,
          );
          if (screenshot.target?.tabId !== tabId
            || screenshot.mimeType !== "image/png"
            || typeof screenshot.data !== "string"
            || screenshot.data.length < 1) {
            throw new MoneyHandError(
              "INVALID_FULL_PAGE_CAPTURE",
              "Full-page screenshot did not return PNG data for the pinned tab",
            );
          }
          const imageBuffer = Buffer.from(screenshot.data, "base64");
          const dimensions = pngDimensions(imageBuffer);
          await writeScreenshot(outputPath, imageBuffer);
          return {
            taskSpaceId: space.id,
            tabId,
            path: outputPath,
            attempts: attempt,
            observationOnly: true,
            coordinateMapping: false,
            capturedAt: new Date().toISOString(),
            frameGuard,
            documentCss: {
              width: afterMetrics.content.width,
              height: afterMetrics.content.height,
            },
            image: {
              path: outputPath,
              width: dimensions.width,
              height: dimensions.height,
              bytes: imageBuffer.length,
              sha256: createHash("sha256").update(imageBuffer).digest("hex"),
            },
            handRequestId: screenshotTerminal.id,
          };
        } catch (error) {
          if (error?.code !== "STALE_VIEWPORT") throw error;
          if (attempt === maxAttempts) {
            throw new MoneyHandError(
              "FULL_PAGE_NOT_STABLE",
              "The task page did not remain stable for one full-page screenshot",
              {
                actionDispatched: false,
                retry: "safe-to-recheck",
                attempts: attempt,
                cause: normalizedError(error, "STALE_VIEWPORT"),
              },
            );
          }
          await taskRetryDelay(retryDelayMs, input.signal);
        }
      }
      throw new MoneyHandError("FULL_PAGE_NOT_STABLE", "Full-page screenshot attempts were exhausted");
    });
  }

  async createTaskSpace(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "createTaskSpace options");
    const session = await this.#sessionFor(input);
    return this.taskSpaces.create({
      id: input.id,
      name: input.name,
      tabIds: input.tabIds,
      selector: {
        profile: session.identity.profile,
        instanceId: session.identity.instanceId,
        bootId: session.identity.bootId,
      },
    });
  }

  listTaskSpaces() {
    return this.taskSpaces.list();
  }

  handOffTaskSpace(options = {}) {
    const input = asObject(options, "handOffTaskSpace options");
    return this.taskSpaces.handOff(input.id);
  }

  takeOverTaskSpace(options = {}) {
    const input = asObject(options, "takeOverTaskSpace options");
    return this.taskSpaces.takeOver(input.id, input.confirmation);
  }

  completeTaskSpace(options = {}) {
    const input = asObject(options, "completeTaskSpace options");
    return this.taskSpaces.complete(input.id, input);
  }

  async completeTaskContext(options = {}) {
    this.#assertRunning();
    const input = asObject(options, "completeTaskContext options");
    const id = requiredTaskSpaceId(input.id ?? input.taskSpaceId);
    const space = this.taskSpaces.assertAgentControl(id);
    const windowCleanup = await this.#closeOwnedTaskWindow(id, input);
    const resetBehavior = input.resetBehavior !== false;
    let behaviorReset = { attempted: false, ok: true, value: null };
    if (resetBehavior) {
      behaviorReset = { attempted: true, ok: false, value: null };
      try {
        const session = await this.#sessionFor({
          ...input,
          selector: space.selector,
          signal: undefined,
        });
        let value;
        for (let attempt = 1; attempt <= TASK_WINDOW_READY_ATTEMPTS; attempt += 1) {
          try {
            const terminal = await session.request({
              method: "behavior.reset",
              behavior: TASK_INTERNAL_BEHAVIOR,
              params: {},
            }, requestOptions({ ...input, signal: undefined }, this.peer.requestTimeoutMs));
            value = directHandValue(terminal, {
              code: "TASK_BEHAVIOR_RESET_FAILED",
              label: "Task behavior reset",
            });
            break;
          } catch (error) {
            // BUSY is an explicit before-dispatch rejection from the Extension's
            // exclusive mutation queue. It is the only reset failure safe to
            // replay; timeouts and all other unknown outcomes remain terminal.
            if (error?.code !== "BUSY" || attempt === TASK_WINDOW_READY_ATTEMPTS) throw error;
            await taskRetryDelay(TASK_WINDOW_READY_POLL_MS);
          }
        }
        if (value.behavior?.mode !== "raw") {
          throw new MoneyHandError(
            "INVALID_TASK_BEHAVIOR_RESULT",
            "The Extension did not confirm raw behavior after reset",
          );
        }
        behaviorReset = { attempted: true, ok: true, value };
      } catch (error) {
        behaviorReset = {
          attempted: true,
          ok: false,
          value: null,
          error: normalizedError(error, "TASK_BEHAVIOR_RESET_FAILED"),
        };
      }
    }
    const taskSpace = windowCleanup.ok
      ? this.taskSpaces.complete(id, {
          keep: input.keep === undefined ? false : input.keep,
          confirmation: input.confirmation,
        })
      : space;
    return {
      taskSpaceId: id,
      taskSpace,
      behaviorReset,
      windowCleanup,
      cleanupComplete: behaviorReset.ok && windowCleanup.ok,
    };
  }

  ownedTaskWindowIds() {
    return [...this.taskWindows.keys()];
  }

  async cleanupOwnedTaskWindows(options = {}) {
    const input = asObject(options, "cleanupOwnedTaskWindows options");
    const requested = input.taskIds === undefined
      ? [...this.taskWindows.keys()]
      : input.taskIds;
    if (!Array.isArray(requested)
      || requested.some((id) => typeof id !== "string" || !COMMAND_ID_PATTERN.test(id))) {
      throw new MoneyHandError(
        "INVALID_COMMAND",
        "cleanupOwnedTaskWindows taskIds must be an array of task identifiers",
      );
    }
    const results = [];
    for (const id of [...new Set(requested)]) {
      if (!this.taskWindows.has(id)) continue;
      const space = this.taskSpaces.list().find((candidate) => candidate.id === id);
      if (space?.state === "active" && space.ownership === "agent") {
        try {
          const lifecycle = await this.completeTaskContext({
            taskSpaceId: id,
            keep: false,
            resetBehavior: true,
          });
          results.push({
            id,
            ...lifecycle.windowCleanup,
            ok: lifecycle.cleanupComplete,
            cleanupComplete: lifecycle.cleanupComplete,
            behaviorReset: lifecycle.behaviorReset,
            windowCleanup: lifecycle.windowCleanup,
          });
          continue;
        } catch (error) {
          results.push({
            id,
            attempted: true,
            ok: false,
            error: normalizedError(error, "TASK_WINDOW_CLOSE_FAILED"),
          });
          continue;
        }
      }
      if (space?.ownership === "user") {
        results.push({
          id,
          attempted: false,
          ok: false,
          error: {
            code: "USER_CONTROL_ACTIVE",
            message: "The task window remains open while user control is active",
          },
        });
        continue;
      }
      results.push({ id, ...(await this.#closeOwnedTaskWindow(id, input)) });
    }
    return {
      ok: results.every((result) => result.ok),
      attempted: results.length,
      results,
    };
  }

  registerSiteLearning(options = {}) {
    const input = asObject(options, "registerSiteLearning options");
    return this.siteLearnings.register(input.learning ?? input);
  }

  listSiteLearnings() {
    return this.siteLearnings.list();
  }

  removeSiteLearning(options = {}) {
    const input = asObject(options, "removeSiteLearning options");
    return this.siteLearnings.remove(input.learningId);
  }

  resolveSiteLearnings(options = {}) {
    const input = asObject(options, "resolveSiteLearnings options");
    return this.siteLearnings.resolve(input);
  }

  approveTaskEffect(options = {}) {
    const input = asObject(options, "approveTaskEffect options");
    const request = asObject(input.request, "approveTaskEffect request");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId);
    this.#validateTaskSpaceRequest(space, request);
    return this.taskApprovals.approve({
      taskSpaceId: space.id,
      effect: input.effect,
      request,
      confirmation: input.confirmation,
      ttlMs: input.ttlMs,
    });
  }

  listApprovalActivity(options = {}) {
    return this.taskApprovals.listActivity(asObject(options, "listApprovalActivity options"));
  }

  async taskRequest(options = {}) {
    const input = asObject(options, "taskRequest options");
    const request = asObject(input.request, "taskRequest request");
    const space = this.taskSpaces.assertAgentControl(input.taskSpaceId ?? input.id);
    this.#validateTaskSpaceRequest(space, request);
    if (input.effect === undefined) {
      throw new MoneyHandError(
        "TASK_EFFECT_REQUIRED",
        "taskRequest requires an explicit effect, including 'read-only'",
      );
    }
    const effect = normalizeTaskEffect(input.effect);
    if (input.approvalToken !== undefined && HIGH_IMPACT_TASK_EFFECTS.includes(effect)) {
      this.taskApprovals.consume({
        token: input.approvalToken,
        taskSpaceId: space.id,
        effect,
        request,
      });
    }
    return await this.request(request, {
      ...input,
      selector: space.selector,
    });
  }

  async evaluateTaskTab(options = {}) {
    const input = asObject(options, "evaluateTaskTab options");
    for (const field of ["contextId", "executionContextId", "objectId"]) {
      if (Object.hasOwn(input, field)) {
        throw new MoneyHandError(
          "TASK_EVALUATION_CONTEXT_FORBIDDEN",
          `evaluateTaskTab does not accept '${field}'; every call uses the current default page context`,
          { actionDispatched: false, field },
        );
      }
    }
    const taskSpaceId = requiredTaskSpaceId(input.taskSpaceId ?? input.id);
    const space = this.taskSpaces.assertAgentControl(taskSpaceId);
    const tabId = taskSpaceTabId(space, input.tabId);
    if (typeof input.expression !== "string" || input.expression.length < 1
      || Buffer.byteLength(input.expression, "utf8") > MAX_TASK_EVALUATION_EXPRESSION_BYTES) {
      throw new MoneyHandError(
        "INVALID_TASK_EVALUATION",
        `expression must be 1-${MAX_TASK_EVALUATION_EXPRESSION_BYTES} UTF-8 bytes`,
        { actionDispatched: false },
      );
    }
    if (input.awaitPromise !== undefined && typeof input.awaitPromise !== "boolean") {
      throw new MoneyHandError(
        "INVALID_TASK_EVALUATION",
        "awaitPromise must be a boolean",
        { actionDispatched: false },
      );
    }
    if (input.effect !== undefined && input.effect !== "read-only") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "evaluateTaskTab always uses effect 'read-only'",
        { actionDispatched: false, expectedEffect: "read-only" },
      );
    }
    let runtime;
    try {
      const terminal = await this.taskRequest({
        taskSpaceId,
        effect: "read-only",
        request: {
          method: "cdp.send",
          params: {
            target: { tabId },
            method: "Runtime.evaluate",
            params: {
              expression: input.expression,
              returnByValue: true,
              awaitPromise: input.awaitPromise ?? true,
              silent: true,
            },
          },
        },
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runtime = directCdpValue(terminal, "Runtime.evaluate", {
        code: "TASK_EVALUATION_FAILED",
        label: "Task page evaluation",
      });
    } catch (error) {
      throw taskEvaluationTransportError(error);
    }
    if (runtime.exceptionDetails) {
      throw new MoneyHandError(
        "TASK_EVALUATION_EXCEPTION",
        "Runtime.evaluate raised an exception in the current page",
        {
          actionDispatched: true,
          retry: "inspect-current-page-and-fix-expression",
          exception: taskEvaluationException(runtime),
        },
      );
    }
    const remote = runtime.result;
    if (!remote || typeof remote !== "object" || Array.isArray(remote)
      || typeof remote.type !== "string") {
      throw new MoneyHandError(
        "TASK_EVALUATION_INVALID_RESULT",
        "Runtime.evaluate returned an invalid RemoteObject",
        { actionDispatched: true, retry: "inspect-current-page-before-retry" },
      );
    }
    const hasValue = Object.hasOwn(remote, "value");
    const isUndefined = remote.type === "undefined";
    const hasUnserializableValue = typeof remote.unserializableValue === "string";
    if (!hasValue && !isUndefined && !hasUnserializableValue) {
      throw new MoneyHandError(
        "TASK_EVALUATION_NOT_SERIALIZABLE",
        "Runtime.evaluate did not return a value that can cross the task boundary",
        {
          actionDispatched: true,
          retry: "change-expression-to-return-serializable-data",
          valueType: remote.type,
          ...(typeof remote.subtype === "string" ? { subtype: remote.subtype } : {}),
          ...(typeof remote.description === "string"
            ? { description: remote.description.slice(0, 4_096) }
            : {}),
        },
      );
    }
    return {
      schema: "npc-moneyhand-task-evaluate/1",
      taskSpaceId,
      tabId,
      valueType: remote.type,
      ...(typeof remote.subtype === "string" ? { subtype: remote.subtype } : {}),
      hasValue,
      isUndefined,
      ...(hasValue ? { value: remote.value } : {}),
      ...(hasUnserializableValue ? { unserializableValue: remote.unserializableValue } : {}),
    };
  }

  async parallelTaskRequests(options = {}) {
    const input = asObject(options, "parallelTaskRequests options");
    if (!Array.isArray(input.requests)
      || input.requests.length < 1
      || input.requests.length > MAX_PARALLEL_TASK_REQUESTS) {
      throw new MoneyHandError(
        "INVALID_TASK_BATCH",
        `parallelTaskRequests requires 1-${MAX_PARALLEL_TASK_REQUESTS} requests`,
      );
    }
    const concurrency = boundedInteger(
      input.concurrency,
      1,
      MAX_TASK_REQUEST_CONCURRENCY,
      Math.min(8, input.requests.length),
      "concurrency",
    );
    const results = new Array(input.requests.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < input.requests.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const item = asObject(input.requests[index], `requests[${index}]`);
          results[index] = {
            ok: true,
            value: await this.taskRequest({
              ...asObject(item.options ?? {}, `requests[${index}].options`),
              id: item.taskSpaceId,
              request: asObject(item.request, `requests[${index}].request`),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            }),
          };
        } catch (error) {
          results[index] = {
            ok: false,
            error: normalizedError(error, "TASK_REQUEST_FAILED"),
          };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { concurrency, results };
  }

  routeSurface(options = {}) {
    return selectSurfaceRoute(asObject(options, "routeSurface options"));
  }

  async rateControl(options = {}) {
    const input = asObject(options, "rateControl options");
    const action = typeof input.action === "string" ? input.action : "";
    if (!RATE_CONTROL_ACTIONS.includes(action)) {
      throw new MoneyHandError(
        "INVALID_RATE_CONTROL_ACTION",
        `rateControl.action must be one of: ${RATE_CONTROL_ACTIONS.join(", ")}`,
      );
    }
    const value = input.input === undefined ? {} : asObject(input.input, "rateControl.input");
    if (action === "wait") {
      return await this.rateController.wait(value, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    return this.rateController[action](value);
  }

  async execute(command) {
    const input = asObject(command, "command");
    switch (requiredOperation(input.op)) {
      case "capabilities":
        return this.capabilities();
      case "status":
        return this.status();
      case "wait":
        return await this.wait(input);
      case "request":
        return await this.request(asObject(input.request, "command.request"), input);
      case "captureViewportBundle":
        return await this.captureViewportBundle(input);
      case "captureSemanticSnapshot":
        return await this.captureSemanticSnapshot(input);
      case "waitForSemanticLocator":
        return await this.waitForSemanticLocator(input);
      case "resolveSemanticRef":
        return this.resolveSemanticRef(input);
      case "actSemanticRef":
        return await this.actSemanticRef(input);
      case "actSemanticLocator":
        return await this.actSemanticLocator(input);
      case "waitForTaskPage":
        requiredTaskSpaceId(input.taskSpaceId);
        return await this.waitForTaskPage(input);
      case "navigateTaskTab":
        requiredTaskSpaceId(input.taskSpaceId);
        return await this.navigateTaskTab(input);
      case "createTaskSpace":
        return await this.createTaskSpace({ ...input, id: requiredTaskSpaceId(input.taskSpaceId) });
      case "listTaskSpaces":
        return this.listTaskSpaces();
      case "handOffTaskSpace":
        return this.handOffTaskSpace({ ...input, id: requiredTaskSpaceId(input.taskSpaceId) });
      case "takeOverTaskSpace":
        return this.takeOverTaskSpace({ ...input, id: requiredTaskSpaceId(input.taskSpaceId) });
      case "completeTaskSpace":
        return this.completeTaskSpace({ ...input, id: requiredTaskSpaceId(input.taskSpaceId) });
      case "taskRequest":
        return await this.taskRequest({ ...input, id: requiredTaskSpaceId(input.taskSpaceId) });
      case "parallelTaskRequests":
        return await this.parallelTaskRequests(input);
      case "routeSurface":
        return this.routeSurface(input);
      case "registerSiteLearning":
        return this.registerSiteLearning(input);
      case "listSiteLearnings":
        return this.listSiteLearnings();
      case "removeSiteLearning":
        return this.removeSiteLearning(input);
      case "resolveSiteLearnings":
        return this.resolveSiteLearnings(input);
      case "approveSemanticRefAction":
        requiredTaskSpaceId(input.taskSpaceId);
        return this.approveSemanticRefAction(input);
      case "approveTaskEffect":
        requiredTaskSpaceId(input.taskSpaceId);
        return this.approveTaskEffect(input);
      case "listApprovalActivity":
        return this.listApprovalActivity(input);
      case "confirmUnknown":
        return await this.confirmUnknown(input);
      case "rateControl":
        return await this.rateControl(input);
      default:
        throw new MoneyHandError("UNKNOWN_OPERATION", `Unknown operation '${input.op}'`);
    }
  }

  #assertRunning() {
    if (!this.started || this.peer.state !== "RUNNING") {
      throw new MoneyHandError("NOT_RUNNING", "MoneyHand is not running");
    }
  }

  #validateTaskSpaceRequest(space, request) {
    const requestedTabs = taskSpaceRequestTabIds(request);
    if (space.tabIds.length > 0 && taskSpaceHasUnscopedMutation(request)) {
      throw new MoneyHandError(
        "TASK_SPACE_UNSCOPED_MUTATION",
        "A tab-allowlisted taskSpace cannot run an unscoped Chrome mutation",
        { taskSpace: space.id },
      );
    }
    if (space.tabIds.length > 0 && requestedTabs.some((tabId) => !space.tabIds.includes(tabId))) {
      throw new MoneyHandError(
        "TASK_SPACE_TAB_MISMATCH",
        "Request targets a tab outside the taskSpace",
        { taskSpace: space.id, allowedTabIds: space.tabIds, requestedTabIds: requestedTabs },
      );
    }
  }

  async #readSemanticFrameSessions(session, tabId, input) {
    const terminal = await session.request({
      method: "target.sessions",
      params: { tabId },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    const value = directHandValue(terminal, {
      code: "INVALID_SEMANTIC_FRAME_SESSIONS",
      label: "Semantic iframe session discovery",
    });
    if (value.tabId !== tabId) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_SESSIONS",
        "target.sessions returned a different tab",
      );
    }
    return normalizeSemanticSessions(value);
  }

  async #settleSemanticFrameSessions(session, tabId, input) {
    const deadline = Date.now() + SEMANTIC_FRAME_DISCOVERY_TIMEOUT_MS;
    let previousSignature;
    let stablePolls = 0;
    while (true) {
      const sessions = await this.#readSemanticFrameSessions(session, tabId, input);
      const signature = semanticSessionSignature(sessions);
      const recursivelyAttached = sessions.every((entry) => entry.autoAttachConfigured === true);
      stablePolls = recursivelyAttached && signature === previousSignature
        ? stablePolls + 1
        : 0;
      if (stablePolls >= SEMANTIC_FRAME_DISCOVERY_STABLE_POLLS) return sessions;
      previousSignature = signature;
      if (Date.now() >= deadline) {
        throw new MoneyHandError(
          "SEMANTIC_FRAME_DISCOVERY_UNSTABLE",
          "Flattened iframe sessions did not settle before the bounded discovery deadline",
        );
      }
      await semanticFrameDiscoveryDelay(
        Math.min(SEMANTIC_FRAME_DISCOVERY_POLL_MS, Math.max(1, deadline - Date.now())),
        input.signal,
      );
    }
  }

  async #discoverSemanticTargetTrees(session, tabId, rootTree, sessions, input) {
    const trees = new Map([["main", rootTree]]);
    if (sessions.length === 0) return trees;
    const steps = sessions.map((iframe) => ({
      method: "cdp.send",
      params: {
        target: { tabId, sessionId: iframe.sessionId },
        method: "Page.getFrameTree",
        params: {},
      },
    }));
    const terminal = await session.request({
      method: "batch.run",
      params: { steps, continueOnError: false },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    if (terminal.ok !== true) {
      directHandValue(terminal, {
        code: "INVALID_SEMANTIC_FRAME_TREE",
        label: "Semantic iframe frame-tree discovery",
      });
    }
    const results = terminal.result?.results;
    if (!Array.isArray(results) || results.length !== steps.length) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Iframe frame-tree discovery returned an invalid batch",
      );
    }
    for (const [index, iframe] of sessions.entries()) {
      const value = cdpBatchValue(results, index, "Page.getFrameTree", {
        code: "INVALID_SEMANTIC_FRAME_TREE",
        label: "Semantic iframe frame-tree discovery",
      });
      semanticFrameTreeSignature(value.frameTree);
      trees.set(semanticTargetTreeKey(iframe.sessionId), value.frameTree);
    }
    return trees;
  }

  async #captureFrameSemanticSnapshot({
    input,
    session,
    tabId,
    maxNodes,
    includeDomSnapshot,
  }) {
    const maxFrames = boundedInteger(
      input.maxFrames,
      1,
      MAX_SEMANTIC_FRAMES,
      DEFAULT_SEMANTIC_FRAMES,
      "maxFrames",
    );
    const rootTarget = { tabId };
    const attached = await session.request({
      method: "target.attach",
      params: { tabId, autoAttachFrames: true },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    const attachment = directHandValue(attached, {
      code: "SEMANTIC_FRAME_ATTACH_FAILED",
      label: "Semantic frame auto-attach",
    });
    if (attachment.tabId !== tabId
      || attachment.attached !== true
      || attachment.autoAttachFrames !== true) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_ATTACH_FAILED",
        "MoneyHand did not confirm recursive iframe auto-attach for the requested tab",
      );
    }
    const discovered = await this.#sendSemanticCdp(
      session,
      rootTarget,
      "Page.getFrameTree",
      {},
      input,
      { code: "INVALID_SEMANTIC_FRAME_TREE", label: "Semantic frame discovery" },
    );
    const discoveryTree = discovered.frameTree;
    semanticFrameTreeSignature(discoveryTree);
    const sessions = await this.#settleSemanticFrameSessions(session, tabId, input);
    const orderedSessions = orderSemanticSessions(sessions);
    const selectedSessions = orderedSessions.slice(0, Math.max(0, maxFrames - 1));
    const targetTrees = await this.#discoverSemanticTargetTrees(
      session,
      tabId,
      discoveryTree,
      selectedSessions,
      input,
    );
    const framePlan = buildSemanticFramePlan(targetTrees, selectedSessions, maxFrames);
    const omittedSessions = sessions.length - selectedSessions.length;
    framePlan.totalFrames += omittedSessions;
    framePlan.truncated ||= omittedSessions > 0;

    const operations = [];
    const addOperation = (kind, frame, method, params = {}) => {
      const index = operations.length;
      operations.push({ kind, frame, method, params, index });
      return index;
    };
    const targetFrames = new Map();
    for (const frame of framePlan.frames) {
      const key = frame.targetTreeKey;
      if (!targetFrames.has(key)) targetFrames.set(key, frame);
    }
    for (const frame of targetFrames.values()) {
      addOperation("tree-before", frame, "Page.getFrameTree");
    }
    if (includeDomSnapshot) {
      for (const frame of targetFrames.values()) {
        addOperation("dom", frame, "DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includeDOMRects: true,
          includePaintOrder: false,
        });
      }
    }
    for (const frame of framePlan.frames) {
      addOperation("ax", frame, "Accessibility.getFullAXTree", {
        frameId: frame.frameId,
      });
    }
    for (const frame of targetFrames.values()) {
      addOperation("tree-after", frame, "Page.getFrameTree");
    }
    const terminal = await session.request({
      method: "batch.run",
      params: {
        steps: operations.map((operation) => ({
          method: "cdp.send",
          params: {
            target: semanticTarget(tabId, operation.frame),
            method: operation.method,
            params: operation.params,
          },
        })),
        continueOnError: false,
      },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    if (terminal.ok !== true) return { terminal };
    const results = terminal.result?.results;
    if (!Array.isArray(results) || results.length !== operations.length) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_SNAPSHOT",
        `Multi-frame semantic snapshot batch did not return ${operations.length} results`,
      );
    }
    const semanticResult = (operation) => cdpBatchValue(
      results,
      operation.index,
      operation.method,
      { code: "INVALID_SEMANTIC_SNAPSHOT", label: "Multi-frame semantic snapshot" },
    );
    const beforeTrees = new Map();
    const afterTrees = new Map();
    const guardedTargetTrees = new Map();
    for (const [key] of targetFrames) guardedTargetTrees.set(key, targetTrees.get(key));
    for (const operation of operations) {
      if (operation.kind === "tree-before") {
        beforeTrees.set(operation.frame.targetTreeKey, semanticResult(operation).frameTree);
      } else if (operation.kind === "tree-after") {
        afterTrees.set(operation.frame.targetTreeKey, semanticResult(operation).frameTree);
      }
    }
    assertStableSemanticTargetTrees(guardedTargetTrees, beforeTrees, afterTrees);
    const afterSessions = await this.#readSemanticFrameSessions(session, tabId, input);
    if (semanticSessionSignature(afterSessions) !== semanticSessionSignature(sessions)) {
      throw new MoneyHandError(
        "STALE_SEMANTIC_SNAPSHOT",
        "The flattened iframe session registry changed while the snapshot was captured",
      );
    }

    const domByTarget = new Map();
    const axByFrame = new Map();
    for (const operation of operations) {
      if (operation.kind === "dom") {
        domByTarget.set(operation.frame.targetTreeKey, semanticResult(operation));
      } else if (operation.kind === "ax") {
        axByFrame.set(operation.frame.frameId, semanticResult(operation));
      }
    }
    const capturedFrames = framePlan.frames.map((frame) => {
      const guarded = semanticFrameById(
        beforeTrees.get(frame.targetTreeKey),
        frame.frameId,
        "STALE_SEMANTIC_SNAPSHOT",
      );
      return {
        ...frame,
        loaderId: guarded.loaderId,
        url: guarded.url,
        domSnapshot: domByTarget.get(frame.targetTreeKey) ?? {},
        axTree: axByFrame.get(frame.frameId) ?? {},
      };
    });
    const compact = buildFrameSemanticSnapshot({
      frames: capturedFrames,
      maxNodes,
      includeIgnored: input.includeIgnored === true,
    });
    const capturedAtMs = Date.now();
    const snapshotId = `semantic:${capturedAtMs.toString(36)}:${randomUUID().slice(0, 8)}`;
    const sessionSelector = {
      instanceId: session.identity.instanceId,
      bootId: session.identity.bootId,
    };
    const frames = capturedFrames.map((frame) => ({
      frameId: frame.frameId,
      loaderId: frame.loaderId,
      url: frame.url,
      depth: frame.depth,
      topLevel: frame.topLevel,
      ...(frame.parentFrameId === undefined ? {} : { parentFrameId: frame.parentFrameId }),
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      ...(frame.targetId === undefined ? {} : { targetId: frame.targetId }),
    }));
    const rootFrame = frames[0];
    const snapshot = {
      id: snapshotId,
      tabId,
      handRequestId: terminal.id,
      capturedAt: new Date(capturedAtMs).toISOString(),
      expiresAt: new Date(capturedAtMs + SEMANTIC_SNAPSHOT_TTL_MS).toISOString(),
      sessionSelector,
      guard: {
        frameId: rootFrame.frameId,
        loaderId: rootFrame.loaderId,
        url: rootFrame.url,
        atomic: false,
      },
      mode: includeDomSnapshot ? "accessibility+dom+frames" : "accessibility+frames",
      frameScope: {
        included: true,
        totalFrames: framePlan.totalFrames,
        totalFramesExact: omittedSessions === 0,
        omittedTargets: omittedSessions,
        selectedFrames: frames.length,
        truncated: framePlan.truncated,
        maxFrames,
      },
      frames,
      totalCandidates: compact.totalCandidates,
      truncated: compact.truncated,
      nodes: compact.nodes,
      content: compact.content,
    };
    this.#rememberSemanticSnapshot(snapshot, capturedAtMs + SEMANTIC_SNAPSHOT_TTL_MS);
    return { snapshot };
  }

  #semanticActionPlan(input) {
    const resolved = this.resolveSemanticRef({
      snapshotId: input.snapshotId,
      ref: input.ref,
    });
    if (!Number.isInteger(resolved.node.backendNodeId) || resolved.node.backendNodeId < 1) {
      throw new MoneyHandError(
        "SEMANTIC_BACKEND_NODE_REQUIRED",
        "Semantic ref does not contain a live backendNodeId; capture a new AX snapshot",
      );
    }
    if (input.effect === undefined) {
      throw new MoneyHandError(
        "SEMANTIC_EFFECT_REQUIRED",
        "actSemanticRef requires top-level effect alongside taskSpaceId, snapshotId, ref and action",
      );
    }
    const effect = normalizeTaskEffect(input.effect);
    if (effect === "read-only" || effect === "focus") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "A semantic ref action must declare input, navigation, or its real high-impact effect",
      );
    }
    const action = normalizeSemanticRefAction(input);
    if (action.action === "download" && effect !== "download") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "Semantic download requires the exact effect 'download'",
      );
    }
    if (action.action !== "download" && effect === "download") {
      throw new MoneyHandError(
        "INVALID_TASK_EFFECT",
        "The download effect is valid only for a semantic download action",
      );
    }
    if (action.action === "upload") {
      if (effect !== "upload") {
        throw new MoneyHandError(
          "INVALID_TASK_EFFECT",
          "Semantic upload requires the exact high-impact effect 'upload'",
        );
      }
      const upload = validateSemanticUploadFiles(action.files, action.fileRoot);
      action.fileRoot = upload.fileRoot;
      action.files = upload.files;
      action.fileEvidence = upload.evidence;
      action.totalBytes = upload.totalBytes;
      if (action.verification.kind === "target-files-set") {
        action.verification.value = upload.files.map((file) => basename(file));
      }
    }
    let resolvedDestination;
    if (action.action === "drag") {
      if (action.toRef === input.ref) {
        throw new MoneyHandError(
          "INVALID_SEMANTIC_ACTION",
          "Semantic drag source and destination refs must be different",
        );
      }
      resolvedDestination = this.resolveSemanticRef({
        snapshotId: input.snapshotId,
        ref: action.toRef,
      });
      if (!Number.isInteger(resolvedDestination.node.backendNodeId)
        || resolvedDestination.node.backendNodeId < 1) {
        throw new MoneyHandError(
          "SEMANTIC_BACKEND_NODE_REQUIRED",
          "Semantic drag destination lacks a live backendNodeId; capture a new AX snapshot",
        );
      }
      if (resolvedDestination.tabId !== resolved.tabId
        || resolvedDestination.sessionSelector.instanceId
          !== resolved.sessionSelector.instanceId
        || resolvedDestination.sessionSelector.bootId !== resolved.sessionSelector.bootId) {
        throw new MoneyHandError(
          "INVALID_SEMANTIC_ACTION",
          "Semantic drag destination must belong to the same snapshot and Profile boot",
        );
      }
    }
    const snapshot = {
      id: resolved.snapshotId,
      tabId: resolved.tabId,
      sessionSelector: resolved.sessionSelector,
      guard: resolved.guard,
    };
    const plan = {
      snapshotId: resolved.snapshotId,
      ref: input.ref,
      tabId: resolved.tabId,
      sessionSelector: { ...resolved.sessionSelector },
      guard: { ...resolved.guard },
      rootGuard: { ...resolved.rootGuard },
      ...(resolved.frame === undefined ? {} : {
        frame: { ...resolved.frame },
        framePath: resolved.framePath.map((frame) => ({ ...frame })),
      }),
      node: { ...resolved.node },
      action,
      effect,
    };
    if (resolvedDestination) {
      plan.destination = {
        snapshotId: resolvedDestination.snapshotId,
        ref: action.toRef,
        tabId: resolvedDestination.tabId,
        sessionSelector: { ...resolvedDestination.sessionSelector },
        guard: { ...resolvedDestination.guard },
        rootGuard: { ...resolvedDestination.rootGuard },
        ...(resolvedDestination.frame === undefined ? {} : {
          frame: { ...resolvedDestination.frame },
          framePath: resolvedDestination.framePath.map((frame) => ({ ...frame })),
        }),
        node: { ...resolvedDestination.node },
      };
    }
    plan.approvalRequest = semanticActionApprovalRequest({
      snapshot,
      node: plan.node,
      action,
      destination: plan.destination,
    });
    return plan;
  }

  #semanticActionTaskSpace(input, plan) {
    const taskSpaceId = requiredTaskSpaceId(input.taskSpaceId);
    const space = this.taskSpaces.assertAgentControl(taskSpaceId);
    this.#validateTaskSpaceRequest(space, plan.approvalRequest);
    if (space.selector.instanceId !== plan.sessionSelector.instanceId
      || space.selector.bootId !== plan.sessionSelector.bootId) {
      throw new MoneyHandError(
        "TASK_SPACE_SESSION_MISMATCH",
        "Semantic snapshot belongs to a different Profile boot than the Task Space",
        {
          taskSpaceId: space.id,
          taskSpaceSelector: space.selector,
          snapshotSelector: plan.sessionSelector,
        },
      );
    }
    return space;
  }

  async #sendSemanticCdp(session, target, method, params, input, options = {}) {
    const terminal = await session.request({
      method: "cdp.send",
      params: { target, method, params },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    return directCdpValue(terminal, method, options);
  }

  async #searchSemanticDownloads(session, query, input) {
    const terminal = await session.request({
      method: "chrome.call",
      params: {
        method: "downloads.search",
        args: [query],
      },
    }, requestOptions(input, this.peer.requestTimeoutMs));
    const value = directHandValue(terminal, {
      code: "DOWNLOAD_OBSERVATION_FAILED",
      label: "Download observation",
    });
    if (value.method !== "downloads.search" || !Array.isArray(value.result)) {
      throw new MoneyHandError(
        "INVALID_DOWNLOAD_OBSERVATION",
        "downloads.search returned an invalid result envelope",
      );
    }
    return value.result.map(normalizedDownloadItem);
  }

  async #armSemanticDownload(session, action, input) {
    const armedAtMs = Date.now();
    const query = {
      startedAfter: new Date(armedAtMs - SEMANTIC_DOWNLOAD_BASELINE_WINDOW_MS).toISOString(),
      orderBy: ["-startTime"],
      limit: SEMANTIC_DOWNLOAD_SEARCH_LIMIT,
    };
    let baseline;
    try {
      baseline = await this.#searchSemanticDownloads(session, query, input);
    } catch (error) {
      throw new MoneyHandError(
        "DOWNLOAD_BASELINE_FAILED",
        "The Profile download baseline could not be established before input",
        {
          actionDispatched: false,
          retry: "safe-to-recheck",
          cause: normalizedError(error, "DOWNLOAD_OBSERVATION_FAILED"),
        },
      );
    }
    if (baseline.length >= SEMANTIC_DOWNLOAD_SEARCH_LIMIT) {
      throw new MoneyHandError(
        "DOWNLOAD_BASELINE_OVERFLOW",
        "Too many recent Profile downloads to establish an unambiguous pre-click baseline",
        {
          actionDispatched: false,
          maximumRecentDownloads: SEMANTIC_DOWNLOAD_SEARCH_LIMIT - 1,
        },
      );
    }
    return {
      query,
      baselineIds: new Set(baseline.map((item) => item.id)),
      match: action.download.match,
      timeoutMs: action.download.timeoutMs,
      pollIntervalMs: action.download.pollIntervalMs,
    };
  }

  async #waitForSemanticDownload(session, armed, input) {
    const deadline = Date.now() + armed.timeoutMs;
    let latestNew = [];
    let latestMatching = [];
    do {
      let items;
      try {
        items = await this.#searchSemanticDownloads(session, armed.query, input);
      } catch (error) {
        if (error?.details?.actionDispatched === true) throw error;
        throw new MoneyHandError(
          "DOWNLOAD_OUTCOME_UNKNOWN",
          "The guarded click was dispatched but download history could not be read",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            cause: normalizedError(error, "DOWNLOAD_OBSERVATION_FAILED"),
          },
        );
      }
      if (items.length >= SEMANTIC_DOWNLOAD_SEARCH_LIMIT) {
        throw new MoneyHandError(
          "DOWNLOAD_CANDIDATE_OVERFLOW",
          "The guarded click was dispatched but recent Profile downloads exceed the bounded uniqueness window",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            maximumRecentDownloads: SEMANTIC_DOWNLOAD_SEARCH_LIMIT - 1,
          },
        );
      }
      latestNew = items.filter((item) => !armed.baselineIds.has(item.id));
      latestMatching = latestNew.filter((item) => semanticDownloadMatches(item, armed.match));
      if (latestNew.length > 1) {
        throw new MoneyHandError(
          "DOWNLOAD_AMBIGUOUS",
          "The guarded click was dispatched but multiple new Profile downloads prevent one-to-one attribution",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            matchedCandidates: latestMatching.length,
            candidates: latestNew.slice(0, 8).map(publicDownloadReceipt),
          },
        );
      }
      const candidate = latestMatching[0];
      if (candidate?.state === "interrupted") {
        throw new MoneyHandError(
          "DOWNLOAD_INTERRUPTED",
          "The guarded click started a download that Chrome marked interrupted",
          {
            actionDispatched: true,
            retry: "inspect-before-retry",
            download: publicDownloadReceipt(candidate),
          },
        );
      }
      if (candidate?.state === "complete") return publicDownloadReceipt(candidate);
      if (Date.now() >= deadline) break;
      await semanticDownloadPollDelay(
        Math.min(armed.pollIntervalMs, Math.max(1, deadline - Date.now())),
        input.signal,
      );
    } while (Date.now() <= deadline);

    const hasMatch = Object.keys(armed.match).length > 0;
    throw new MoneyHandError(
      hasMatch && latestNew.length > 0
        ? "DOWNLOAD_EXPECTATION_MISMATCH"
        : "DOWNLOAD_OUTCOME_UNKNOWN",
      hasMatch && latestNew.length > 0
        ? "The guarded click was dispatched, but no new download matched the declared receipt"
        : "The guarded click was dispatched, but no completed download could be proven before timeout",
      {
        actionDispatched: true,
        retry: "inspect-before-retry",
        ...(latestMatching.length === 0 ? {} : {
          candidate: publicDownloadReceipt(latestMatching[0]),
        }),
        ...(latestNew.length === 0 ? {} : {
          observedNewDownloads: latestNew.slice(0, 8).map(publicDownloadReceipt),
        }),
      },
    );
  }

  async #resolveSemanticActionTarget(session, plan, input, prepared, label) {
    prepared.plan = plan;
    prepared.target = semanticTarget(plan.tabId, plan.frame);
    prepared.frameBefore = assertSemanticFrameGuard(
      await this.#readSemanticFrame(
        session,
        prepared.target,
        input,
        plan.guard.frameId,
      ),
      plan.guard,
    );
    const isolatedWorld = await this.#sendSemanticCdp(
      session,
      prepared.target,
      "Page.createIsolatedWorld",
      {
        frameId: prepared.frameBefore.frameId,
        worldName: "npc-moneyhand.semantic-ref",
        grantUniveralAccess: false,
      },
      input,
      { code: "SEMANTIC_TARGET_UNREADABLE", label: `${label} isolated world` },
    );
    const executionContextId = isolatedWorld.executionContextId;
    if (!Number.isInteger(executionContextId) || executionContextId < 1) {
      throw new MoneyHandError(
        "SEMANTIC_TARGET_UNREADABLE",
        `${label} isolated world did not return an execution context`,
      );
    }
    const resolved = await this.#sendSemanticCdp(
      session,
      prepared.target,
      "DOM.resolveNode",
      {
        backendNodeId: plan.node.backendNodeId,
        executionContextId,
        objectGroup: "npc-moneyhand.semantic-ref",
      },
      input,
      { code: "STALE_SEMANTIC_REF", label: `${label} backend node resolution` },
    );
    prepared.objectId = resolved?.object?.objectId;
    if (typeof prepared.objectId !== "string" || !prepared.objectId) {
      prepared.objectId = undefined;
      throw new MoneyHandError(
        "STALE_SEMANTIC_REF",
        `${label} backend node no longer resolves to a live object`,
      );
    }
    await this.#refreshSemanticActionTarget(
      session,
      prepared,
      input,
      { label, scroll: true },
    );
    return prepared;
  }

  async #refreshSemanticActionTarget(session, prepared, input, options = {}) {
    const { plan, target, objectId } = prepared;
    const label = options.label ?? "Semantic target";
    const upload = plan.action?.action === "upload";
    assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, target, input, plan.guard.frameId),
      plan.guard,
    );
    const targetState = await this.#readSemanticTarget(
      session,
      target,
      objectId,
      upload ? INSPECT_SEMANTIC_FILE_INPUT_FUNCTION : PREPARE_SEMANTIC_TARGET_FUNCTION,
      input,
      `${label} preflight`,
      upload ? undefined : { scroll: options.scroll !== false },
    );
    if (targetState.ok !== true) {
      const code = targetState.reason === "detached"
        ? "STALE_SEMANTIC_REF"
        : targetState.reason === "disabled"
          ? "SEMANTIC_TARGET_DISABLED"
          : targetState.reason === "not-file-input"
            ? "SEMANTIC_TARGET_NOT_FILE_INPUT"
            : "SEMANTIC_TARGET_NOT_INTERACTABLE";
      throw new MoneyHandError(
        code,
        `${label} is not safely interactable (${targetState.reason ?? "unknown"}${
          targetState.hitTag ? ` by <${targetState.hitTag}>` : ""
        })`,
        { reason: targetState.reason, hitTag: targetState.hitTag ?? null },
      );
    }
    if (upload) {
      if (plan.action.files.length > 1 && targetState.multiple !== true) {
        throw new MoneyHandError(
          "SEMANTIC_FILE_INPUT_MULTIPLE_REQUIRED",
          "Semantic upload selected multiple files but the target input is not multiple",
        );
      }
    } else {
      assertInteractiveTargetState(targetState);
      if (plan.action?.action === "select") {
        if (targetState.tag !== "select") {
          throw new MoneyHandError(
            "SEMANTIC_TARGET_NOT_SELECT",
            "Semantic select requires a visible native select element",
          );
        }
        if (plan.action.options.length > 1 && targetState.multiple !== true) {
          throw new MoneyHandError(
            "SEMANTIC_SELECT_MULTIPLE_REQUIRED",
            "Semantic select received multiple descriptors for a non-multiple select",
          );
        }
      }
    }
    if (targetState.url !== plan.guard.url) {
      throw new MoneyHandError(
        "STALE_SEMANTIC_REF",
        `${label} URL changed during live target preparation; capture a new snapshot`,
        { expectedUrl: plan.guard.url, observedUrl: targetState.url ?? null },
      );
    }
    if (plan.action?.action === "check" || plan.action?.action === "uncheck") {
      prepared.checkableState = semanticCheckableState(plan.action, targetState);
    }
    if (plan.action?.action === "select") {
      const selectState = await this.#readSemanticTarget(
        session,
        target,
        objectId,
        SET_SEMANTIC_SELECT_OPTIONS_FUNCTION,
        input,
        `${label} select-option preflight`,
        { descriptors: plan.action.options, commit: false },
      );
      if (selectState.ok !== true) {
        throw new MoneyHandError(
          semanticSelectFailureCode(selectState.reason),
          `${label} cannot resolve the exact select options (${selectState.reason ?? "unknown"})`,
          { reason: selectState.reason ?? null },
        );
      }
      prepared.selectState = selectState;
    }
    prepared.targetState = targetState;
    return targetState;
  }

  async #assertSemanticFrameSessionPath(session, plan, input) {
    const sessions = await this.#readSemanticFrameSessions(session, plan.tabId, input);
    const bySessionId = new Map(sessions.map((entry) => [entry.sessionId, entry]));
    let parentSessionId;
    for (const frame of plan.framePath) {
      if (frame.sessionId === parentSessionId) continue;
      const current = bySessionId.get(frame.sessionId);
      if (!current
        || current.targetId !== frame.targetId
        || current.parentSessionId !== parentSessionId
        || (current.parentFrameId !== undefined
          && current.parentFrameId !== frame.parentFrameId)) {
        throw new MoneyHandError(
          "STALE_SEMANTIC_REF",
          "The semantic ref iframe session path detached or moved; capture a new snapshot",
          { frameId: frame.frameId },
        );
      }
      parentSessionId = frame.sessionId;
    }
  }

  async #readSemanticFrame(session, target, input, frameId) {
    const result = await this.#sendSemanticCdp(
      session,
      target,
      "Page.getFrameTree",
      {},
      input,
      { code: "INVALID_SEMANTIC_ACTION", label: "Semantic frame guard" },
    );
    return frameId === undefined
      ? semanticMainFrame(result)
      : semanticFrameById(result.frameTree, frameId);
  }

  async #readSemanticViewport(session, target, frameId, input) {
    const isolatedWorld = await this.#sendSemanticCdp(
      session,
      target,
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "npc-moneyhand.semantic-frame-map",
        grantUniveralAccess: false,
      },
      input,
      { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic frame viewport world" },
    );
    const executionContextId = isolatedWorld.executionContextId;
    if (!Number.isInteger(executionContextId) || executionContextId < 1) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_MAPPING_FAILED",
        "Semantic frame viewport world did not return an execution context",
      );
    }
    const evaluated = await this.#sendSemanticCdp(
      session,
      target,
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: "({width: globalThis.innerWidth, height: globalThis.innerHeight})",
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      },
      input,
      { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic frame viewport" },
    );
    return semanticViewport(semanticRuntimeValue(evaluated, "Semantic frame viewport"));
  }

  async #mapSemanticOwnerPoint({
    session,
    childFrame,
    childTarget,
    parentFrame,
    parentTarget,
    point,
    viewport,
    input,
    scrollFrameOwner = true,
  }) {
    const childBefore = assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, childTarget, input, childFrame.frameId),
      childFrame,
    );
    const parentBefore = assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, parentTarget, input, parentFrame.frameId),
      parentFrame,
    );
    const owner = await this.#sendSemanticCdp(
      session,
      parentTarget,
      "DOM.getFrameOwner",
      { frameId: childFrame.frameId },
      input,
      { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic iframe owner" },
    );
    if (!Number.isInteger(owner.backendNodeId) || owner.backendNodeId < 1) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_MAPPING_FAILED",
        "DOM.getFrameOwner did not return a live iframe owner",
      );
    }
    if (scrollFrameOwner) {
      await this.#sendSemanticCdp(
        session,
        parentTarget,
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: owner.backendNodeId },
        input,
        { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic iframe scroll" },
      );
    }
    const quads = await this.#sendSemanticCdp(
      session,
      parentTarget,
      "DOM.getContentQuads",
      { backendNodeId: owner.backendNodeId },
      input,
      { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic iframe content quad" },
    );
    const mapped = mapSemanticPointThroughQuad(point, viewport, quads);
    assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, childTarget, input, childFrame.frameId),
      childBefore,
    );
    assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, parentTarget, input, parentFrame.frameId),
      parentBefore,
    );
    return {
      point: mapped,
      ownerGuard: {
        backendNodeId: owner.backendNodeId,
        childFrameId: childFrame.frameId,
        parentFrameId: parentFrame.frameId,
      },
    };
  }

  async #mapSemanticFramePoint(session, plan, targetState, input, options = {}) {
    let point = { x: targetState.x, y: targetState.y };
    let viewport = semanticViewport(targetState.viewport, "Semantic target viewport");
    let mappedRootViewport;
    let topLevelOwnerGuard;
    const rootFrame = {
      frameId: plan.rootGuard.frameId,
      loaderId: plan.rootGuard.loaderId,
      url: plan.rootGuard.url,
      topLevel: true,
    };
    const framesById = new Map([
      [rootFrame.frameId, rootFrame],
      ...plan.framePath.map((frame) => [frame.frameId, frame]),
    ]);
    const groups = [];
    for (const frame of plan.framePath) {
      const current = groups.at(-1);
      if (!current || current.sessionId !== frame.sessionId) {
        groups.push({ sessionId: frame.sessionId, frames: [frame] });
      } else {
        current.frames.push(frame);
      }
    }
    const targetGroup = groups.at(-1);
    if (!targetGroup || targetGroup.frames.at(-1)?.frameId !== plan.frame.frameId) {
      throw new MoneyHandError(
        "INVALID_SEMANTIC_FRAME_TREE",
        "Semantic target frame is not the terminal frame in its guarded path",
      );
    }
    const targetSessionRoot = targetGroup.sessionId === undefined
      ? rootFrame
      : targetGroup.frames[0];
    const target = semanticTarget(plan.tabId, plan.frame);
    if (plan.frame.frameId !== targetSessionRoot.frameId) {
      const parentFrame = framesById.get(plan.frame.parentFrameId);
      if (!parentFrame || parentFrame.sessionId !== plan.frame.sessionId) {
        throw new MoneyHandError(
          "INVALID_SEMANTIC_FRAME_TREE",
          "A same-target semantic frame is missing its guarded parent",
        );
      }
      const mapped = await this.#mapSemanticOwnerPoint({
        session,
        childFrame: plan.frame,
        childTarget: target,
        parentFrame,
        parentTarget: target,
        point,
        viewport,
        input,
        scrollFrameOwner: options.scrollFrameOwners !== false,
      });
      point = mapped.point;
      if (parentFrame.frameId === rootFrame.frameId && parentFrame.sessionId === undefined) {
        topLevelOwnerGuard = mapped.ownerGuard;
      }
      viewport = await this.#readSemanticViewport(
        session,
        target,
        targetSessionRoot.frameId,
        input,
      );
      if (targetSessionRoot.frameId === rootFrame.frameId) mappedRootViewport = viewport;
    }

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (group.sessionId === undefined) continue;
      const childRoot = group.frames[0];
      const parentFrame = framesById.get(childRoot.parentFrameId);
      if (!parentFrame || parentFrame.sessionId === group.sessionId) {
        throw new MoneyHandError(
          "INVALID_SEMANTIC_FRAME_TREE",
          "A flattened semantic frame is missing its parent-target frame",
        );
      }
      const childTarget = semanticTarget(plan.tabId, childRoot);
      const parentTarget = semanticTarget(plan.tabId, parentFrame);
      const mapped = await this.#mapSemanticOwnerPoint({
        session,
        childFrame: childRoot,
        childTarget,
        parentFrame,
        parentTarget,
        point,
        viewport,
        input,
        scrollFrameOwner: options.scrollFrameOwners !== false,
      });
      point = mapped.point;
      if (parentFrame.frameId === rootFrame.frameId && parentFrame.sessionId === undefined) {
        topLevelOwnerGuard = mapped.ownerGuard;
      }
      if (parentFrame.sessionId !== undefined) {
        const parentGroup = groups[index - 1];
        if (!parentGroup || parentGroup.sessionId !== parentFrame.sessionId) {
          throw new MoneyHandError(
            "INVALID_SEMANTIC_FRAME_TREE",
            "Nested flattened semantic sessions are not contiguous in the frame path",
          );
        }
        viewport = await this.#readSemanticViewport(
          session,
          parentTarget,
          parentGroup.frames[0].frameId,
          input,
        );
      }
    }
    const rootTarget = { tabId: plan.tabId };
    const rootViewport = mappedRootViewport ?? await this.#readSemanticViewport(
      session,
      rootTarget,
      plan.rootGuard.frameId,
      input,
    );
    point = { x: Math.round(point.x), y: Math.round(point.y) };
    if (point.x < 0
      || point.y < 0
      || point.x >= rootViewport.width
      || point.y >= rootViewport.height) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_MAPPING_FAILED",
        "The mapped iframe point falls outside the top-level viewport",
      );
    }
    assertSemanticFrameGuard(
      await this.#readSemanticFrame(session, rootTarget, input, plan.rootGuard.frameId),
      plan.rootGuard,
    );
    assertSemanticFrameGuard(
      await this.#readSemanticFrame(
        session,
        semanticTarget(plan.tabId, plan.frame),
        input,
        plan.guard.frameId,
      ),
      plan.guard,
    );
    const hit = await this.#sendSemanticCdp(
      session,
      rootTarget,
      "DOM.getNodeForLocation",
      {
        x: point.x,
        y: point.y,
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      },
      input,
      { code: "SEMANTIC_FRAME_MAPPING_FAILED", label: "Semantic top-level frame hit test" },
    );
    const directChildFrameHit = hit.frameId === plan.guard.frameId;
    const exactTopLevelOwnerHit = topLevelOwnerGuard !== undefined
      && hit.frameId === topLevelOwnerGuard.parentFrameId
      && hit.backendNodeId === topLevelOwnerGuard.backendNodeId;
    if (!directChildFrameHit && !exactTopLevelOwnerHit) {
      throw new MoneyHandError(
        "SEMANTIC_FRAME_OCCLUDED",
        "The mapped top-level point no longer hits the semantic ref iframe",
        {
          expectedFrameId: plan.guard.frameId,
          expectedTopLevelOwner: topLevelOwnerGuard ?? null,
          observedFrameId: hit.frameId ?? null,
          observedBackendNodeId: hit.backendNodeId ?? null,
        },
      );
    }
    return point;
  }

  async #readSemanticTarget(
    session,
    target,
    objectId,
    functionDeclaration,
    input,
    label,
    callArgument,
  ) {
    const result = await this.#sendSemanticCdp(
      session,
      target,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        returnByValue: true,
        awaitPromise: false,
        silent: true,
        ...(callArgument === undefined ? {} : { arguments: [{ value: callArgument }] }),
      },
      input,
      { code: "SEMANTIC_TARGET_UNREADABLE", label },
    );
    return semanticRuntimeValue(result, label);
  }

  async #verifySemanticAction({
    session,
    target,
    objectId,
    plan,
    frameBefore,
    targetBefore,
    input,
  }) {
    const verification = plan.action.verification;
    const frameOnly = [
      "url-equals",
      "url-includes",
      "url-changed",
      "loader-changed",
    ].includes(verification.kind);
    const deadline = Date.now() + verification.timeoutMs;
    let latest;
    do {
      const frameAfter = await this.#readSemanticFrame(
        session,
        target,
        input,
        plan.guard.frameId,
      );
      let targetAfter;
      let targetError;
      if (!frameOnly) {
        try {
          targetAfter = await this.#readSemanticTarget(
            session,
            target,
            objectId,
            READ_SEMANTIC_TARGET_FUNCTION,
            input,
            "Semantic postcondition target read",
          );
        } catch (error) {
          if (error instanceof MoneyHandUnknownOutcomeError || error?.code === "OUTCOME_UNKNOWN") {
            throw error;
          }
          targetError = normalizedError(error, "SEMANTIC_TARGET_UNREADABLE");
        }
      }
      latest = evaluateSemanticVerification({
        verification,
        frameBefore,
        frameAfter,
        targetBefore,
        targetAfter,
        targetError,
      });
      if (latest.matched === true || latest.matched === null) return latest;
      if (targetError && verification.kind !== "target-detached") return latest;
      if (Date.now() >= deadline) return latest;
      await pollDelay(
        Math.min(verification.pollIntervalMs, Math.max(1, deadline - Date.now())),
        input.signal,
      );
    } while (Date.now() <= deadline);
    return latest;
  }

  async #releaseSemanticObject(session, target, objectId) {
    const cleanup = { attempted: true, released: false };
    try {
      const terminal = await session.request({
        method: "cdp.send",
        params: {
          target,
          method: "Runtime.releaseObject",
          params: { objectId },
        },
      }, { timeoutMs: 1_000 });
      directCdpValue(terminal, "Runtime.releaseObject", {
        code: "SEMANTIC_CLEANUP_FAILED",
        label: "Semantic remote-object cleanup",
      });
      cleanup.released = true;
    } catch (error) {
      cleanup.error = normalizedError(error, "SEMANTIC_CLEANUP_FAILED");
    }
    return cleanup;
  }

  async #sessionFor(input) {
    const selector = input.selector === undefined
      ? undefined
      : asObject(input.selector, "selector");
    const connectTimeoutMs = boundedInteger(
      input.connectTimeoutMs,
      0,
      86_400_000,
      this.connectTimeoutMs,
      "connectTimeoutMs",
    );
    const waitOptions = {
      timeoutMs: connectTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    return selector === undefined
      ? (this.peer.activeSession() ?? await this.peer.waitFor({}, waitOptions))
      : await this.peer.waitFor(selector, waitOptions);
  }

  #rememberSemanticSnapshot(snapshot, expiresAt) {
    this.#pruneSemanticSnapshots();
    this.semanticSnapshots.set(snapshot.id, {
      snapshot,
      expiresAt,
      refs: new Map(snapshot.nodes.map((node) => [node.ref, node])),
    });
    while (this.semanticSnapshots.size > MAX_SEMANTIC_SNAPSHOTS) {
      this.semanticSnapshots.delete(this.semanticSnapshots.keys().next().value);
    }
  }

  #pruneSemanticSnapshots() {
    const now = Date.now();
    for (const [id, entry] of this.semanticSnapshots) {
      if (entry.expiresAt <= now) this.semanticSnapshots.delete(id);
    }
  }

  #semanticSnapshotStatus() {
    this.#pruneSemanticSnapshots();
    return [...this.semanticSnapshots.values()].map((entry) => ({
      id: entry.snapshot.id,
      tabId: entry.snapshot.tabId,
      capturedAt: entry.snapshot.capturedAt,
      expiresAt: entry.snapshot.expiresAt,
      nodeCount: entry.snapshot.nodes.length,
      sessionSelector: { ...entry.snapshot.sessionSelector },
    }));
  }

  #bindPeerEvents() {
    this.peer.on("session", (session) => {
      this.emit("event", {
        type: "event",
        event: "session.ready",
        session: sessionSummary(session),
      });
    });
    this.peer.on("sessionClose", (session, details) => {
      this.emit("event", {
        type: "event",
        event: "session.closed",
        session: sessionSummary(session),
        details,
      });
    });
    this.peer.on("activeSession", (next, previous) => {
      this.emit("event", {
        type: "event",
        event: "active_session.changed",
        session: sessionSummary(next),
        previous: sessionSummary(previous),
      });
    });
    this.peer.on("event", (session, message) => {
      this.emit("event", {
        type: "event",
        event: "hand.event",
        session: sessionSummary(session),
        message,
      });
    });
    this.peer.on("lateResponse", (session, message) => {
      this.emit("event", {
        type: "event",
        event: "hand.late_response",
        session: sessionSummary(session),
        message,
      });
    });
    this.peer.on("orphanResponse", (session, message) => {
      this.emit("event", {
        type: "event",
        event: "hand.orphan_response",
        session: sessionSummary(session),
        message,
      });
    });
  }
}

class JsonlWriter {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.droppedEvents = 0;
    this.closed = false;
    this.drainTimeoutMs = options.drainTimeoutMs ?? OUTPUT_DRAIN_TIMEOUT_MS;
    this.abortController = new AbortController();
    this.failure = undefined;
  }

  write(message, options = {}) {
    const ordinaryEvent = options.ordinaryEvent === true;
    if (this.closed
      || this.abortController.signal.aborted
      || this.stream.destroyed
      || this.stream.writable === false) {
      return Promise.reject(this.failure
        ?? new MoneyHandError("OUTPUT_CLOSED", "JSONL output is closed"));
    }
    if (ordinaryEvent && this.pending >= MAX_EVENT_WRITE_BACKLOG) {
      this.droppedEvents += 1;
      return Promise.resolve(false);
    }
    const lines = [];
    if (!ordinaryEvent && this.droppedEvents > 0) {
      lines.push(JSON.stringify({
        type: "event",
        event: "moneyhand.events_dropped",
        count: this.droppedEvents,
      }));
      this.droppedEvents = 0;
    }
    lines.push(JSON.stringify(message));
    this.pending += lines.length;
    const operation = this.queue.then(async () => {
      for (const line of lines) {
        try {
          if (this.abortController.signal.aborted) throw this.failure;
          if (!this.stream.write(`${line}\n`, "utf8")) await this.#waitForDrain();
        } finally {
          this.pending -= 1;
        }
      }
      return true;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async flush() {
    await this.queue;
  }

  close() {
    this.closed = true;
  }

  abort(error = new MoneyHandError("OUTPUT_CLOSED", "JSONL output was aborted")) {
    if (this.abortController.signal.aborted) return;
    this.failure = error;
    this.abortController.abort(error);
  }

  async #waitForDrain() {
    const signal = this.abortController.signal;
    await new Promise((resolvePromise, rejectPromise) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.stream.off("drain", onDrain);
        this.stream.off("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (callback, value) => {
        cleanup();
        callback(value);
      };
      const onDrain = () => finish(resolvePromise);
      const onError = (error) => finish(rejectPromise, error);
      const onAbort = () => finish(
        rejectPromise,
        this.failure ?? new MoneyHandError("OUTPUT_CLOSED", "JSONL output was aborted"),
      );
      this.stream.once("drain", onDrain);
      this.stream.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new MoneyHandError(
          "OUTPUT_BACKPRESSURE_TIMEOUT",
          `JSONL output did not drain within ${this.drainTimeoutMs}ms`,
        );
        this.abort(error);
      }, this.drainTimeoutMs);
      if (signal.aborted) onAbort();
    });
  }
}

function rememberCommandId(recent, active, id) {
  if (recent.has(id) || active.has(id)) {
    throw new MoneyHandError("ID_CONFLICT", `command.id '${id}' was already used`);
  }
  recent.set(id, true);
  while (recent.size > MAX_RECENT_COMMAND_IDS) recent.delete(recent.keys().next().value);
}

function refreshCompletedCommandId(recent, id) {
  recent.delete(id);
  recent.set(id, true);
  while (recent.size > MAX_RECENT_COMMAND_IDS) recent.delete(recent.keys().next().value);
}

async function allSettledUntilAbort(promises, signal) {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new MoneyHandError("ABORTED", "Drain was aborted");
  }
  let onAbort;
  const aborted = new Promise((resolvePromise, rejectPromise) => {
    onAbort = () => rejectPromise(signal.reason instanceof Error
      ? signal.reason
      : new MoneyHandError("ABORTED", "Drain was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.allSettled(promises), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class BoundedJsonlTransform extends Transform {
  constructor(maxLineBytes = MAX_JSONL_LINE_BYTES) {
    super({ readableObjectMode: true });
    this.maxLineBytes = maxLineBytes;
    this.parts = [];
    this.lineBytes = 0;
    this.discarding = false;
  }

  _transform(chunk, encoding, callback) {
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let offset = 0;
      while (offset < data.length) {
        const newline = data.indexOf(0x0a, offset);
        const end = newline < 0 ? data.length : newline;
        this.#append(data.subarray(offset, end));
        if (newline < 0) break;
        this.#finishLine();
        offset = newline + 1;
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.discarding || this.lineBytes > 0) this.#finishLine();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #append(segment) {
    if (this.discarding || segment.length === 0) return;
    if (this.lineBytes + segment.length > this.maxLineBytes) {
      this.discarding = true;
      this.parts = [];
      this.lineBytes = 0;
      return;
    }
    this.parts.push(segment);
    this.lineBytes += segment.length;
    if (this.parts.length > 64) {
      this.parts = [Buffer.concat(this.parts, this.lineBytes)];
    }
  }

  #finishLine() {
    if (this.discarding) {
      this.push({
        error: new MoneyHandError(
          "LINE_TOO_LARGE",
          `JSONL input exceeds ${this.maxLineBytes} bytes`,
        ),
      });
    } else {
      this.push({
        data: this.parts.length === 0
          ? Buffer.alloc(0)
          : Buffer.concat(this.parts, this.lineBytes),
      });
    }
    this.parts = [];
    this.lineBytes = 0;
    this.discarding = false;
  }
}

function parseJsonlCommand(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new MoneyHandError("INVALID_JSON", "Input line is not valid JSON");
  }
  const command = asObject(parsed, "command");
  requiredCommandId(command.id);
  requiredOperation(command.op);
  try {
    return normalizeAgentJsonlCommandEnvelope(command);
  } catch (error) {
    error.commandId = command.id;
    throw error;
  }
}

export async function runJsonlMoneyHand(options = {}) {
  const input = options.input ?? HOST_PROCESS?.stdin;
  const output = options.output ?? HOST_PROCESS?.stdout;
  if (!input || !output) {
    throw new MoneyHandError(
      "INVALID_OPTION",
      "runJsonlMoneyHand requires explicit input and output in a sandboxed runtime",
    );
  }
  const signal = options.signal;
  const moneyhand = options.moneyhand ?? createMoneyHand(options);
  const onceMode = options.once === true;
  const onceTimeoutMs = boundedInteger(
    options.onceTimeoutMs,
    1,
    86_400_000,
    DEFAULT_ONCE_TIMEOUT_MS,
    "onceTimeoutMs",
  );
  const outputDrainTimeoutMs = boundedInteger(
    options.outputDrainTimeoutMs,
    50,
    60_000,
    OUTPUT_DRAIN_TIMEOUT_MS,
    "outputDrainTimeoutMs",
  );
  const writer = new JsonlWriter(output, { drainTimeoutMs: outputDrainTimeoutMs });
  const recentIds = new Map();
  const activeIds = new Set();
  const pending = new Map();
  const lifecycle = new AbortController();
  setMaxListeners(MAX_JSONL_INFLIGHT + 1, lifecycle.signal);
  let shutdownCommand;
  let writerFailure;
  let accepting = true;
  let onceCommandAccepted = false;
  let onceTimer;
  let lines;
  let onAbort;
  let onInputError;
  let onOutputClose;
  let onOutputError;

  const stopReading = () => {
    accepting = false;
    if (lines) {
      input.unpipe(lines);
      lines.end();
    }
    input.pause?.();
  };
  const failWriter = (error) => {
    writerFailure ??= error;
    writer.abort(error);
    lifecycle.abort();
    stopReading();
  };
  onOutputError = (error) => failWriter(
    error instanceof Error
      ? error
      : new MoneyHandError("OUTPUT_CLOSED", "JSONL output failed"),
  );
  onOutputClose = () => failWriter(
    new MoneyHandError("OUTPUT_CLOSED", "JSONL output closed unexpectedly"),
  );
  output.on?.("error", onOutputError);
  output.on?.("close", onOutputClose);
  const onMoneyHandEvent = (message) => {
    const ordinaryEvent = message.event === "hand.event";
    writer.write(message, { ordinaryEvent }).catch(failWriter);
  };
  moneyhand.on("event", onMoneyHandEvent);

  try {
    const endpoint = await moneyhand.start();
    await writer.write({
      type: "event",
      event: "moneyhand.listening",
      protocol: MONEYHAND_CONTROL_PROTOCOL,
      endpoint,
      pid: HOST_PROCESS?.pid ?? null,
      capabilities: moneyhand.capabilities(),
    });
    lines = new BoundedJsonlTransform();
    onInputError = (error) => lines.destroy(error);
    input.once("error", onInputError);
    input.pipe(lines);
    onAbort = () => {
      lifecycle.abort();
      stopReading();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (onceMode) {
      onceTimer = setTimeout(() => {
        lifecycle.abort(new MoneyHandError(
          "ONE_SHOT_TIMEOUT",
          `One-shot command exceeded ${onceTimeoutMs}ms`,
        ));
        stopReading();
      }, onceTimeoutMs);
      onceTimer.unref?.();
    }
    for await (const record of lines) {
      if (!accepting) break;
      if (record.error) {
        await writer.write({
          type: "result",
          id: null,
          ok: false,
          error: normalizedError(record.error, "INVALID_COMMAND"),
        });
        continue;
      }
      let line;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(record.data);
      } catch {
        await writer.write({
          type: "result",
          id: null,
          ok: false,
          error: normalizedError(
            new MoneyHandError("INVALID_UTF8", "Input line is not valid UTF-8"),
          ),
        });
        continue;
      }
      if (!line.trim()) continue;
      let command;
      try {
        command = parseJsonlCommand(line);
        rememberCommandId(recentIds, activeIds, command.id);
      } catch (error) {
        await writer.write({
          type: "result",
          id: typeof command?.id === "string"
            ? command.id
            : typeof error?.commandId === "string" ? error.commandId : null,
          ok: false,
          error: normalizedError(error, "INVALID_COMMAND"),
        });
        continue;
      }
      if (onceMode) onceCommandAccepted = true;
      if (command.op === "shutdown") {
        try {
          const control = command.args ?? command;
          command.graceMs = boundedInteger(
            control.graceMs,
            0,
            5_000,
            250,
            "graceMs",
          );
        } catch (error) {
          await writer.write({
            type: "result",
            id: command.id,
            ok: false,
            error: normalizedError(error, "INVALID_COMMAND"),
          });
          if (onceMode) stopReading();
          continue;
        }
        shutdownCommand = command;
        lifecycle.abort();
        stopReading();
        break;
      }
      if (command.op === "cancel") {
        try {
          const control = command.args ?? command;
          const targetId = requiredCommandId(control.targetId);
          if (targetId === command.id) {
            throw new MoneyHandError("INVALID_COMMAND", "cancel cannot target itself");
          }
          const target = pending.get(targetId);
          if (!target) {
            throw new MoneyHandError(
              "NOT_FOUND",
              `No active command '${targetId}' can be cancelled`,
            );
          }
          target.controller.abort(new MoneyHandError(
            "CANCELLED_BY_AGENT",
            `Command '${targetId}' was cancelled by '${command.id}'`,
          ));
          await writer.write({
            type: "result",
            id: command.id,
            ok: true,
            value: {
              targetId,
              signalled: true,
              outcome: "target-result-defines-state",
            },
          });
        } catch (error) {
          await writer.write({
            type: "result",
            id: command.id,
            ok: false,
            error: normalizedError(error),
          });
        }
        if (onceMode) stopReading();
        continue;
      }
      if (activeIds.size >= MAX_JSONL_INFLIGHT) {
        await writer.write({
          type: "result",
          id: command.id,
          ok: false,
          error: normalizedError(new MoneyHandError(
            "BUSY",
            `JSONL maxInflight limit ${MAX_JSONL_INFLIGHT} reached`,
          )),
        });
        if (onceMode) stopReading();
        continue;
      }

      const controller = new AbortController();
      const abortCommand = () => controller.abort(lifecycle.signal.reason);
      if (lifecycle.signal.aborted) abortCommand();
      else lifecycle.signal.addEventListener("abort", abortCommand, { once: true });
      const prior = command.op === "drain"
        ? [...pending.values()].map((entry) => entry.promise)
        : undefined;
      const entry = { controller, promise: undefined };
      const operation = (async () => {
        let envelope;
        try {
          const value = command.op === "drain"
            ? { drained: (await allSettledUntilAbort(prior, controller.signal)).length }
            : await moneyhand.execute({
                ...(command.args === undefined
                  ? command
                  : { id: command.id, op: command.op, ...command.args }),
                signal: controller.signal,
              });
          envelope = {
            type: "result",
            id: command.id,
            ok: true,
            value,
          };
        } catch (error) {
          envelope = {
            type: "result",
            id: command.id,
            ok: false,
            error: normalizedError(error),
          };
        }
        await writer.write(envelope);
      })().finally(() => {
        lifecycle.signal.removeEventListener("abort", abortCommand);
        activeIds.delete(command.id);
        refreshCompletedCommandId(recentIds, command.id);
        if (pending.get(command.id) === entry) pending.delete(command.id);
      });
      entry.promise = operation;
      activeIds.add(command.id);
      pending.set(command.id, entry);
      operation.catch(failWriter);
      if (onceMode) stopReading();
    }
    if (!onceMode || !onceCommandAccepted || shutdownCommand || signal?.aborted || writerFailure) {
      lifecycle.abort();
    }
    await Promise.allSettled([...pending.values()].map((entry) => entry.promise));
    await moneyhand.stop({
      graceMs: shutdownCommand?.graceMs ?? 250,
    });
    if (shutdownCommand) {
      await writer.write({
        type: "result",
        id: shutdownCommand.id,
        ok: true,
        value: { stopped: true },
      });
    }
    await writer.write({
      type: "event",
      event: "moneyhand.stopped",
      protocol: MONEYHAND_CONTROL_PROTOCOL,
    });
    await writer.flush();
    if (writerFailure) throw writerFailure;
  } finally {
    accepting = false;
    clearTimeout(onceTimer);
    lifecycle.abort();
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (onInputError) input.off("error", onInputError);
    if (lines) {
      input.unpipe(lines);
      lines.destroy();
    }
    output.off?.("error", onOutputError);
    output.off?.("close", onOutputClose);
    moneyhand.off("event", onMoneyHandEvent);
    await moneyhand.stop({ graceMs: 0 }).catch(() => {});
    await writer.flush().catch(() => {});
    writer.close();
  }
}

function numericEnvironment(name, fallback) {
  const value = HOST_PROCESS?.env?.[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new MoneyHandError("INVALID_OPTION", `${name} must be an integer`);
  }
  return parsed;
}

function connectResult(value) {
  return {
    schema: MONEYHAND_CONNECT_RESULT_SCHEMA,
    connected: value.status === "connected",
    ...value,
  };
}

function boundedConnectFailure(error, afterUserAction = false) {
  const code = typeof error?.code === "string" ? error.code : "CONNECT_FAILED";
  if (code === "EADDRINUSE") {
    return connectResult({
      status: "blocked",
      code: "CONTROLLER_BUSY",
      action: "stop",
      nextAction: "report_and_stop",
      userMessage: "MoneyHand 当前被另一个本地 Agent 任务占用。请结束那个任务后再试。",
    });
  }
  if (afterUserAction) {
    return connectResult({
      status: "blocked",
      code: "CONNECT_RETRY_EXHAUSTED",
      action: "stop",
      nextAction: "report_and_stop",
      userMessage: "MoneyHand 在规定的一次人工恢复后仍未连接。当前已停止继续尝试，避免扰乱浏览器环境。",
    });
  }
  if (code === "MONEYHAND_EXTENSION_NOT_FOUND") {
    return connectResult({
      status: "user_action_required",
      code,
      action: "install_extension",
      nextAction: "wait_for_user_then_retry_once",
      retryCommand: "node scripts/moneyhand.mjs --connect --after-user-action",
      releasesUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
      releaseAsset: "npc-moneyhand-extension-1.0.0.zip",
      userMessage: "未发现 MoneyHand 插件。请从项目 GitHub Releases 下载 npc-moneyhand-extension-1.0.0.zip，解压后在 Chromium 扩展管理页加载该目录；随后打开这个浏览器，点击工具栏里的 MoneyHand 图标和‘立即连接’。完成后告诉我‘好了’。",
    });
  }
  if (["TIMEOUT", "BROWSER_EXECUTABLE_NOT_FOUND"].includes(code)) {
    return connectResult({
      status: "user_action_required",
      code: "EXTENSION_NOT_CONNECTED",
      action: "open_browser_and_click_extension",
      nextAction: "wait_for_user_then_retry_once",
      retryCommand: "node scripts/moneyhand.mjs --connect --after-user-action",
      userMessage: "请打开装有 MoneyHand 的 Chromium 浏览器，点击工具栏里的 MoneyHand 图标，再点击‘立即连接’。完成后告诉我‘好了’。",
    });
  }
  return connectResult({
    status: "blocked",
    code: "CONNECT_FAILED",
    action: "stop",
    nextAction: "report_and_stop",
    userMessage: "MoneyHand 未能建立连接，当前已停止继续尝试，避免扰乱浏览器环境。",
  });
}

async function runConnectAcceptanceFlow(options = {}) {
  const {
    moneyhand,
    signal,
    onProgress,
    acceptanceTaskPath = CONNECT_ACCEPTANCE_TASK_PATH,
  } = options;
  if (typeof moneyhand?.request !== "function") {
    throw new MoneyHandError("INVALID_CONNECT_ACCEPTANCE", "connect acceptance requires a MoneyHand instance");
  }
  if (typeof acceptanceTaskPath !== "string" || acceptanceTaskPath.length < 1) {
    throw new MoneyHandError("INVALID_CONNECT_ACCEPTANCE", "connect acceptance task path missing");
  }
  return await runMoneyHandTask({
    moneyhand,
    taskPath: acceptanceTaskPath,
    args: {
      taskId: `connect-acceptance-${randomUUID()}`,
    },
    signal,
    timeoutMs: CONNECT_ACCEPTANCE_TIMEOUT_MS,
    progressIntervalMs: 5_000,
    visualSilenceMs: 10_000,
    onProgress,
  });
}

function connectAcceptanceResult(value = {}) {
  const acceptance = value?.outcome ?? {};
  const checks = Array.isArray(acceptance.checks)
    ? acceptance.checks.map((check) => ({
        name: typeof check?.name === "string" ? check.name.slice(0, 128) : "unknown",
        status: check?.status === "passed" ? "passed" : "failed",
        ...(check?.error === undefined ? {} : { error: normalizedError(check.error, "CONNECT_ACCEPTANCE_FAILED") }),
      }))
    : [];
  const passed = checks.filter((check) => check.status === "passed").length;
  const total = Number.isInteger(acceptance.total) && acceptance.total > 0
    ? acceptance.total
    : checks.length;
  const cleanup = {
    cleanupComplete: value?.lifecycle?.cleanupComplete === true,
    windowClosed: value?.lifecycle?.windowClosed === true,
    behaviorReset: value?.lifecycle?.behaviorReset === "raw" ? "raw" : null,
  };
  return {
    schema: "npc-moneyhand-connect-acceptance/1",
    status: acceptance.status === "complete" && passed === total && checks.length === total
      && cleanup.cleanupComplete
      ? "passed"
      : "failed",
    passed,
    total,
    checks,
    cleanup,
    ...(acceptance.reason === undefined || acceptance.reason === null
      ? {}
      : { reason: String(acceptance.reason).slice(0, 128) }),
    ...(acceptance.error === undefined
      ? {}
      : { error: normalizedError(acceptance.error, "CONNECT_ACCEPTANCE_FAILED") }),
  };
}

function skippedConnectAcceptance() {
  return {
    schema: "npc-moneyhand-connect-acceptance/1",
    status: "not_run",
    reason: "isolated-test-port",
    passed: 0,
    total: 0,
    checks: [],
    cleanup: { cleanupComplete: true, windowClosed: true, behaviorReset: "raw" },
  };
}

function failedConnectAcceptance(error) {
  return {
    schema: "npc-moneyhand-connect-acceptance/1",
    status: "failed",
    passed: 0,
    total: 0,
    checks: [],
    cleanup: { cleanupComplete: false, windowClosed: false, behaviorReset: null },
    error: normalizedError(error, "CONNECT_ACCEPTANCE_FAILED"),
  };
}

function acceptedConnectResult(acceptance) {
  if (acceptance.status !== "passed" && acceptance.status !== "not_run") {
    return connectResult({
      status: "blocked",
      code: "CONNECT_ACCEPTANCE_FAILED",
      action: "stop",
      nextAction: "report_and_stop",
      transportConnected: true,
      acceptance,
      userMessage: `MoneyHand 已连接，但自动全功能验收未通过（${acceptance.passed}/${acceptance.total}）。测试窗口已尝试关闭，当前不进入任务状态。`,
    });
  }
  return connectResult({
    status: "connected",
    nextAction: CONNECT_READY_NEXT_ACTION,
    taskRouting: {
      currentConversationHasTask: "continue_immediately_without_reconfirmation",
      noConcreteTask: "ask_user_for_task",
      stopAfterConnectWhenTaskExists: "invalid",
      taskModule: "copy_and_implement_never_run_packaged_template",
    },
    acceptance,
    userMessage: acceptance.status === "passed"
      ? `MoneyHand 已连接，自动全功能验收 ${acceptance.passed}/${acceptance.total} 通过；测试窗口已关闭，行为已重置为 raw。若当前对话已经给出具体浏览器任务，必须立即继续执行且不能在此结束：先复制并实现临时任务模块，禁止原样运行资产模板；只有尚未给出任务时才询问用户。`
      : "MoneyHand 已在隔离测试端口连接，当前测试未运行浏览器验收；若当前对话已有具体任务，必须立即继续执行：先复制并实现临时任务模块，禁止原样运行资产模板。",
  });
}

function parseCliOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--once") {
      values.once = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      values.help = true;
      continue;
    }
    if (flag === "--version") {
      values.version = true;
      continue;
    }
    if (flag === "--describe") {
      values.describe = true;
      continue;
    }
    if (flag === "--connect") {
      values.connect = true;
      continue;
    }
    if (flag === "--ensure") {
      values.ensure = true;
      continue;
    }
    if (flag === "--stop") {
      values.stopController = true;
      continue;
    }
    if (flag === "--task-last") {
      values.taskLast = true;
      continue;
    }
    if (flag === CONTROLLER_SERVICE_FLAG) {
      values.controllerService = true;
      continue;
    }
    if (flag === "--internal-stop-controller") {
      values.stopController = true;
      continue;
    }
    if (flag === "--after-user-action") {
      values.afterUserAction = true;
      continue;
    }
    if (flag === "--no-browser-launch") {
      values.autoLaunchBrowser = false;
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new MoneyHandError("INVALID_OPTION", `Expected a value after '${flag}'`);
    }
    index += 1;
    switch (flag) {
      // Undocumented ephemeral listener support for isolated test/conformance harnesses only.
      case "--internal-test-port":
        values.port = Number(value);
        break;
      case "--internal-controller-port":
        values.controllerPort = Number(value);
        break;
      case "--internal-controller-idle-ms":
        values.controllerIdleMs = Number(value);
        break;
      case "--connect-timeout-ms":
        values.connectTimeoutMs = Number(value);
        break;
      case "--request-timeout-ms":
        values.requestTimeoutMs = Number(value);
        break;
      case "--heartbeat-ms":
        values.heartbeatMs = Number(value);
        break;
      case "--handshake-timeout-ms":
        values.handshakeTimeoutMs = Number(value);
        break;
      case "--max-inflight":
        values.maxInflight = Number(value);
        break;
      case "--once-timeout-ms":
        values.onceTimeoutMs = Number(value);
        break;
      case "--output-drain-timeout-ms":
        values.outputDrainTimeoutMs = Number(value);
        break;
      case "--task-timeout-ms":
        values.taskTimeoutMs = Number(value);
        break;
      case "--internal-task-abort-grace-ms":
        values.taskAbortGraceMs = Number(value);
        break;
      case "--task":
        values.taskPath = value;
        break;
      case "--task-status":
        values.taskStatus = value;
        break;
      case "--task-follow":
        values.taskFollow = value;
        break;
      case "--args-json":
        try {
          values.taskArgs = JSON.parse(value);
        } catch {
          throw new MoneyHandError("INVALID_OPTION", "--args-json must be valid JSON");
        }
        break;
      case "--call":
        values.callMethod = value;
        break;
      case "--params-json":
        try {
          values.callParams = JSON.parse(value);
        } catch {
          throw new MoneyHandError("INVALID_OPTION", "--params-json must be valid JSON");
        }
        break;
      case "--browser-root":
        values.browserRoot = value;
        break;
      case "--profile-directory":
        values.profileDirectory = value;
        break;
      case "--browser-executable":
        values.browserExecutable = value;
        break;
      case "--launch-grace-ms":
        values.launchGraceMs = Number(value);
        break;
      default:
        throw new MoneyHandError("INVALID_OPTION", `Unknown option '${flag}'`);
    }
  }
  const oneShotModes = [
    values.once,
    values.taskPath,
    values.callMethod,
    values.connect,
    values.ensure,
    values.stopController,
    values.taskLast,
    values.taskStatus,
    values.taskFollow,
  ]
    .filter(Boolean).length;
  if (oneShotModes > 1) {
    throw new MoneyHandError(
      "INVALID_OPTION",
      "--once, --task, --call, --connect, --ensure, --stop, and task ledger modes are mutually exclusive",
    );
  }
  if (values.afterUserAction && !values.connect) {
    throw new MoneyHandError(
      "INVALID_OPTION",
      "--after-user-action is valid only with --connect",
    );
  }
  if (values.callParams !== undefined && !values.callMethod) {
    throw new MoneyHandError("INVALID_OPTION", "--params-json requires --call or --connect");
  }
  if (values.taskArgs !== undefined && !values.taskPath) {
    throw new MoneyHandError("INVALID_OPTION", "--args-json requires --task");
  }
  if (values.taskTimeoutMs !== undefined && !values.taskPath) {
    throw new MoneyHandError("INVALID_OPTION", "--task-timeout-ms requires --task");
  }
  if (values.describe) {
    const incompatible = Object.keys(values).filter((key) => key !== "describe");
    if (incompatible.length) {
      throw new MoneyHandError(
        "INVALID_OPTION",
        "--describe cannot be combined with runtime or alternate output modes",
      );
    }
  }
  return values;
}

export function createMoneyHand(options = {}) {
  return new MoneyHand(options);
}

export const createMoneyHandController = createMoneyHand;

export async function describeMoneyHand() {
  const { createAgentCliDescriptor } = await import("./lib/agent-descriptor.mjs");
  return await createAgentCliDescriptor({
    name: "MoneyHand",
    packageName: "npc-moneyhand",
    executable: "moneyhand",
    contractUrl: new URL("../references/moneyhand-contract.json", import.meta.url),
    operationCatalogUrl: new URL("../references/agent-operations.json", import.meta.url),
    capabilities: createMoneyHand().capabilities(),
  });
}

async function automaticTaskVisualFallback(moneyhand, state, operation, options, reason, signal) {
  const taskSpaceId = options?.taskSpaceId ?? options?.id ?? state.activeTaskSpaceId;
  const trigger = visualFallbackTrigger(operation, reason);
  if (typeof taskSpaceId !== "string" || typeof moneyhand.inspectTaskBlocker !== "function") {
    return {
      schema: "npc-moneyhand-visual-fallback/1",
      captured: false,
      trigger,
      screenshot: { captured: false },
      skipped: "no-pinned-task-page",
      actionReplayed: false,
    };
  }
  if (state.visualFallbacks >= MAX_AUTOMATIC_VISUAL_FALLBACKS) {
    return {
      schema: "npc-moneyhand-visual-fallback/1",
      captured: false,
      trigger,
      screenshot: { captured: false },
      skipped: "automatic-task-visual-limit",
      limit: MAX_AUTOMATIC_VISUAL_FALLBACKS,
      actionReplayed: false,
    };
  }
  state.visualFallbacks += 1;
  const remember = (value) => {
    state.lastVisualAt = Date.now();
    state.lastVisualFallback = value;
    return value;
  };
  try {
    return remember(await moneyhand.inspectTaskBlocker({
      taskSpaceId,
      operation,
      reason: trigger,
      ...(options?.[TASK_CONCURRENT_VISUAL_OBSERVATION] === true
        ? { [TASK_CONCURRENT_VISUAL_OBSERVATION]: true, timeoutMs: 5_000 }
        : {}),
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    return remember({
      schema: "npc-moneyhand-visual-fallback/1",
      captured: false,
      trigger,
      screenshot: {
        captured: false,
        error: normalizedError(error, "VISUAL_FALLBACK_FAILED"),
      },
      actionReplayed: false,
    });
  }
}

function taskEventRelay(details, now = Date.now()) {
  const terminal = ["completed", "failed", "incomplete", "interrupted"].includes(details.state)
    || details.phase === "complete";
  const warning = details.state === "visual_fallback"
    || details.phase === "recovery"
    || details.importance === "warning";
  const checkpoint = details.checkpoint !== undefined
    || (details.current !== undefined && details.total !== undefined);
  const heartbeat = details.phase === "heartbeat" || details.phase === "attached-client";
  const notifyUser = terminal || warning || checkpoint || details.notifyUser === true;
  return {
    audience: notifyUser ? "both" : "agent",
    importance: terminal
      ? "terminal"
      : warning ? "warning" : checkpoint ? "checkpoint" : heartbeat ? "heartbeat" : "progress",
    wakeAgent: true,
    notifyUser,
    nextControllerUpdateBy: new Date(now + DEFAULT_TASK_PROGRESS_INTERVAL_MS).toISOString(),
    nextUserUpdateBy: new Date(now + 30_000).toISOString(),
  };
}

function taskRateScope(state, operation, options) {
  const taskSpaceId = options?.taskSpaceId ?? options?.id ?? state.activeTaskSpaceId;
  if (typeof taskSpaceId !== "string") return null;
  const context = state.taskContexts?.get(taskSpaceId);
  if (!context) return null;
  if (operation === "navigateTaskTab" && typeof options?.url === "string") {
    try {
      const parsed = new URL(options.url);
      if (["http:", "https:"].includes(parsed.protocol)) {
        state.rateScopes.set(taskSpaceId, {
          scope: {
            origin: parsed.origin,
            profile: context.selector.profile ?? context.selector.instanceId,
          },
          mode: context.behavior,
        });
      }
    } catch {
      // Navigation validation reports malformed URLs; rate control does not replace it.
    }
  }
  return state.rateScopes?.get(taskSpaceId) ?? null;
}

function taskRateErrorObservation(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const status = Number.isInteger(error?.details?.status) ? error.details.status
    : code.includes("429") ? 429
      : code.includes("503") ? 503
        : code.includes("403") ? 403 : undefined;
  const challenge = code.includes("CAPTCHA") || code.includes("CHALLENGE");
  const accountChanged = code.includes("ACCOUNT_CHANGED") || code.includes("ACCOUNT_CHANGE");
  const throttle = code.includes("THROTTL") || code.includes("RATE_LIMIT");
  if (status === undefined && !challenge && !accountChanged && !throttle) return null;
  return { status, challenge, accountChanged, throttle };
}

async function taskRateGate(target, state, operation, options, signal) {
  if (!TASK_RATE_GATED_METHODS.has(operation)) return null;
  const scoped = taskRateScope(state, operation, options);
  if (!scoped || typeof target.rateControl !== "function") return null;
  const startedAt = Date.now();
  try {
    const decision = await target.rateControl({
      action: "wait",
      input: scoped,
      ...(signal === undefined ? {} : { signal }),
    });
    await state.emitRate?.({
      state: "allowed",
      scopeKey: JSON.stringify([
        scoped.scope.origin,
        scoped.scope.profile,
        scoped.scope.account ?? null,
      ]),
      scope: scoped.scope,
      operation,
      allowed: decision.allowed,
      stop: decision.stop,
      checkpointRequired: decision.checkpointRequired,
      concurrency: decision.concurrency,
      intervalMs: decision.intervalMs,
      waitMs: decision.waitMs,
      phase: decision.phase,
      startedAt,
    });
    return { ...scoped, startedAt };
  } catch (error) {
    await state.emitRate?.({
      state: "blocked",
      scopeKey: JSON.stringify([
        scoped.scope.origin,
        scoped.scope.profile,
        scoped.scope.account ?? null,
      ]),
      scope: scoped.scope,
      operation,
      allowed: false,
      stop: error?.code === "RATE_CONTROL_CIRCUIT_OPEN",
      checkpointRequired: true,
      error: normalizedError(error, "RATE_CONTROL_FAILED"),
      startedAt,
    });
    throw error;
  }
}

async function taskRateObserve(target, state, operation, gate, error) {
  if (!gate || typeof target.rateControl !== "function") return;
  const latencyMs = Math.max(0, Date.now() - gate.startedAt);
  const failure = error ? taskRateErrorObservation(error) : null;
  if (error && failure === null) return;
  const checkpoint = typeof state.latestCheckpoint === "string"
    ? state.latestCheckpoint.slice(0, 2_048)
    : undefined;
  const observed = await target.rateControl({
    action: "observe",
    input: {
      scope: gate.scope,
      mode: gate.mode,
      latencyMs,
      ...(error ? failure : { clean: true }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
  });
  await state.emitRate?.({
    state: observed.decision.stop
      ? "circuit_open"
      : observed.decision.waitMs > 0 ? "cooldown" : "observed",
    scopeKey: JSON.stringify([
      gate.scope.origin,
      gate.scope.profile,
      gate.scope.account ?? null,
    ]),
    scope: gate.scope,
    operation,
    allowed: observed.decision.allowed,
    stop: observed.decision.stop,
    checkpointRequired: observed.decision.checkpointRequired,
    concurrency: observed.decision.concurrency,
    intervalMs: observed.decision.intervalMs,
    waitMs: observed.decision.waitMs,
    phase: observed.decision.phase,
    signals: observed.signals,
    actions: observed.actions,
    latencyMs,
  });
}

async function taskOperationWithRecovery(target, state, operation, options, signal, invoke) {
  try {
    return await invoke();
  } catch (error) {
    const firstPlan = planTaskRecovery({
      operation,
      error,
      attempt: 1,
      hasTaskPage: typeof (options?.taskSpaceId ?? state.activeTaskSpaceId) === "string",
    });
    await state.emitRecovery?.({ ...firstPlan, state: "classified" });
    const taskSpaceId = options?.taskSpaceId ?? options?.id ?? state.activeTaskSpaceId;
    if (!firstPlan.replayAllowed || typeof taskSpaceId !== "string"
      || typeof target.probeTaskContext !== "function") {
      throw attachRecovery(error, { ...firstPlan, terminalState: firstPlan.state });
    }
    let probe;
    try {
      probe = await target.probeTaskContext({
        taskSpaceId,
        timeoutMs: 3_000,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (probeError) {
      probe = {
        healthy: false,
        stage: "probe",
        error: normalizedError(probeError, "TASK_RECOVERY_PROBE_FAILED"),
      };
    }
    await state.emitRecovery?.({
      ...firstPlan,
      state: probe.healthy === true ? "retrying" : "terminal",
      probe,
    });
    if (probe.healthy !== true) {
      throw attachRecovery(error, { ...firstPlan, probe, terminalState: "terminal" });
    }
    try {
      const value = await invoke();
      await state.emitRecovery?.({
        ...firstPlan,
        state: "recovered",
        attempt: 2,
        replayed: true,
        probe,
      });
      return value;
    } catch (retryError) {
      const secondPlan = planTaskRecovery({
        operation,
        error: retryError,
        attempt: 2,
        hasTaskPage: true,
      });
      const recovery = {
        ...secondPlan,
        probe,
        replayed: true,
        terminalState: secondPlan.state,
      };
      await state.emitRecovery?.({ ...recovery, state: "terminal" });
      throw attachRecovery(retryError, recovery);
    }
  }
}

function taskScopedMoneyHand(moneyhand, signal, state = {}) {
  if (!signal) return moneyhand;
  state.activeTaskSpaceId ??= undefined;
  state.visualFallbacks ??= 0;
  state.taskContexts ??= new Map();
  state.rateScopes ??= new Map();
  state.effectReceipts ??= new TaskEffectReceipts({
    onReceipt: async (receipt) => state.emitEffectReceipt?.(receipt),
  });
  return new Proxy(moneyhand, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const taskAware = property === "request"
        || property === "completeTaskContext"
        || TASK_SIGNAL_FIRST_ARGUMENT_METHODS.has(property);
      if (!taskAware) return value.bind(target);
      return (...originalArgs) => {
        const args = [...originalArgs];
        let requestedEffectId;
        if (property === "request") {
          const options = args[1] ?? {};
          requestedEffectId = options.effectId;
          const { effectId: _effectId, ...requestOptionsWithoutEffectId } = options;
          args[1] = {
            ...requestOptionsWithoutEffectId,
            ...(options.signal === undefined ? { signal } : {}),
          };
        } else if (property !== "completeTaskContext") {
          let options = args[0] ?? {};
          if (property === "captureSemanticSnapshot") {
            const context = state.activeTaskSpaceId === undefined
              ? undefined
              : state.taskContexts.get(state.activeTaskSpaceId);
            const wholeDocumentHint = typeof options.selector === "string"
              && TASK_WHOLE_DOCUMENT_SELECTOR_HINTS.has(options.selector.trim().toLowerCase());
            if (context?.selector && (options.selector === undefined || wholeDocumentHint)) {
              options = { ...options, selector: { ...context.selector } };
            }
          }
          const fixedEffect = TASK_FIXED_EFFECTS[property];
          if (fixedEffect !== undefined) {
            if (options.effect !== undefined && options.effect !== fixedEffect) {
              throw new MoneyHandError(
                "INVALID_TASK_EFFECT",
                `${String(property)} always uses effect '${fixedEffect}'`,
                { actionDispatched: false, expectedEffect: fixedEffect },
              );
            }
            options = { ...options, effect: fixedEffect };
          }
          requestedEffectId = options.effectId;
          const { effectId: _effectId, ...requestOptionsWithoutEffectId } = options;
          args[0] = {
            ...requestOptionsWithoutEffectId,
            ...(options.signal === undefined ? { signal } : {}),
          };
        }
        const operation = String(property);
        const callOptions = property === "request" ? args[1] : args[0];
        return (async () => {
          if (property === "completeTaskContext") {
            await state.beginCleanup?.({ taskSpaceId: callOptions?.taskSpaceId });
          }
          await state.noteActivity?.({
            operation,
            operationState: "started",
            taskSpaceId: callOptions?.taskSpaceId,
          });
          try {
            const executeOperation = async () => {
              const gate = await taskRateGate(
                target,
                state,
                operation,
                callOptions,
                signal,
              );
              try {
                const result = TASK_AUTO_VISUAL_METHODS.has(operation)
                  ? await taskOperationWithRecovery(
                      target,
                      state,
                      operation,
                      callOptions,
                      signal,
                      () => value.apply(target, args),
                    )
                  : await value.apply(target, args);
                await taskRateObserve(target, state, operation, gate);
                return result;
              } catch (error) {
                await taskRateObserve(target, state, operation, gate, error);
                throw error;
              }
            };
            const result = requestedEffectId === undefined
              ? await executeOperation()
              : await state.effectReceipts.execute({
                  effectId: requestedEffectId,
                  effect: callOptions?.effect,
                  operation,
                  input: args,
                }, executeOperation);
            if (property === "beginTaskContext" && typeof result?.taskSpaceId === "string") {
              state.activeTaskSpaceId = result.taskSpaceId;
              state.taskContexts.set(result.taskSpaceId, {
                selector: result.selector,
                behavior: result.behavior?.mode ?? "raw",
              });
            }
            if (property === "inspectTaskBlocker" && result?.captured === true) {
              state.lastVisualAt = Date.now();
              state.lastVisualFallback = result;
            }
            await state.noteActivity?.({ operation, operationState: "completed" });
            const reason = taskVisualResultReason(operation, result);
            if (!reason) return result;
            const recovery = planTaskRecovery({
              operation,
              error: reason,
              attempt: 1,
              hasTaskPage: true,
            });
            await state.emitRecovery?.({
              ...recovery,
              state: result.status === "needs_instruction" ? "needs_instruction" : recovery.state,
            });
            const visualFallback = await automaticTaskVisualFallback(
              target,
              state,
              operation,
              callOptions,
              reason,
              signal,
            );
            await state.emit?.({
              state: "visual_fallback",
              phase: "exception",
              operation,
              message: "MoneyHand captured the current page after a browser anomaly",
              visualFallback,
            });
            return {
              ...taskVisibleTerminal(result, visualFallback),
              recovery,
            };
          } catch (error) {
            await state.noteActivity?.({ operation, operationState: "failed" });
            if (!taskVisualErrorEligible(operation, error)) throw error;
            const visualFallback = await automaticTaskVisualFallback(
              target,
              state,
              operation,
              callOptions,
              normalizedError(error),
              signal,
            );
            await state.emit?.({
              state: "visual_fallback",
              phase: "exception",
              operation,
              message: "MoneyHand captured the current page after a browser operation failed",
              visualFallback,
            });
            throw attachTaskVisualFallback(error, visualFallback);
          }
        })();
      };
    },
  });
}

function taskProgressDetails(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoneyHandError("INVALID_TASK_PROGRESS", "Task progress must be an object");
  }
  const allowed = new Set(["phase", "message", "current", "total", "checkpoint"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new MoneyHandError(
      "INVALID_TASK_PROGRESS",
      `Unknown task progress field '${unknown[0]}'`,
    );
  }
  const output = {};
  for (const [key, maximum] of [["phase", 64], ["message", 1_000], ["checkpoint", 256]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > maximum) {
      throw new MoneyHandError(
        "INVALID_TASK_PROGRESS",
        `Task progress ${key} must be a non-empty string no longer than ${maximum} characters`,
      );
    }
    output[key] = value[key];
  }
  for (const key of ["current", "total"]) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new MoneyHandError(
        "INVALID_TASK_PROGRESS",
        `Task progress ${key} must be a non-negative safe integer`,
      );
    }
    output[key] = value[key];
  }
  if (output.current !== undefined && output.total !== undefined && output.current > output.total) {
    throw new MoneyHandError(
      "INVALID_TASK_PROGRESS",
      "Task progress current must not exceed total",
    );
  }
  return output;
}

function taskWatchdogPolicy(input = {}) {
  const requestedProgressIntervalMs = boundedInteger(
    input.progressIntervalMs,
    10,
    MAX_TASK_PROGRESS_INTERVAL_MS,
    DEFAULT_TASK_PROGRESS_INTERVAL_MS,
    "taskProgressIntervalMs",
  );
  const requestedVisualSilenceMs = boundedInteger(
    input.visualSilenceMs,
    10,
    MAX_TASK_VISUAL_SILENCE_MS,
    DEFAULT_TASK_VISUAL_SILENCE_MS,
    "taskVisualSilenceMs",
  );
  return Object.freeze({
    progressIntervalMs: Math.min(
      requestedProgressIntervalMs,
      DEFAULT_TASK_PROGRESS_INTERVAL_MS,
    ),
    visualSilenceMs: Math.min(
      requestedVisualSilenceMs,
      DEFAULT_TASK_VISUAL_SILENCE_MS,
    ),
  });
}

function taskTerminalVisualReason(outcome, abortReason, silenceMs, visualSilenceMs) {
  const terminalError = abortReason ?? (outcome?.ok === false ? outcome.error : undefined);
  if (TASK_VISUAL_SKIP_CODES.has(terminalError?.code)) return undefined;
  if (abortReason) {
    return {
      ...normalizedError(abortReason, "TASK_FAILED"),
      actionDispatched: abortReason?.details?.actionDispatched ?? "task-dependent",
      retry: abortReason?.details?.retry ?? "inspect-current-page-before-retry",
    };
  }
  if (outcome?.ok === false) {
    return {
      ...normalizedError(outcome.error, "TASK_FAILED"),
      actionDispatched: outcome.error?.details?.actionDispatched ?? "task-dependent",
      retry: outcome.error?.details?.retry ?? "inspect-current-page-before-retry",
    };
  }
  const value = outcome?.value;
  const terminal = value?.outcome && typeof value.outcome === "object"
    ? value.outcome
    : value;
  const status = typeof terminal?.status === "string" ? terminal.status : undefined;
  if (["blocked", "failed", "incomplete", "needs_instruction", "outcome_unknown"].includes(status)) {
    const reason = terminal?.error && typeof terminal.error === "object"
      ? terminal.error
      : {
          code: typeof terminal?.reason === "string" ? terminal.reason : `TASK_${status.toUpperCase()}`,
          message: `MoneyHand task returned ${status}`,
        };
    return {
      ...normalizedError(reason, "TASK_INCOMPLETE"),
      actionDispatched: reason?.details?.actionDispatched ?? "task-dependent",
      retry: reason?.details?.retry ?? "inspect-current-page-before-next-action",
    };
  }
  if (silenceMs >= visualSilenceMs) {
    return {
      code: "TASK_PROGRESS_SILENCE",
      message: `No browser-task activity completed within ${visualSilenceMs}ms before task settlement`,
      actionDispatched: "task-dependent",
      retry: "do-not-replay-inspect-current-page",
    };
  }
  return undefined;
}

function taskWorkerError(value, fallbackCode = "MONEYHAND_TASK_FAILED") {
  const error = new MoneyHandError(
    typeof value?.code === "string" ? value.code : fallbackCode,
    typeof value?.message === "string" ? value.message : "MoneyHand task worker failed",
  );
  if (value?.details !== undefined) error.details = value.details;
  return error;
}

function taskWorkerRuntime({ taskModuleUrl, moneyhand, signal, args, progress, taskExecutionId }) {
  let worker;
  let finishing;
  let readySettled = false;
  let resolveOutcome;
  let rejectOutcome;
  let resolveReady;
  const outcome = new Promise((resolvePromise, rejectPromise) => {
    resolveOutcome = resolvePromise;
    rejectOutcome = rejectPromise;
  });
  const ready = new Promise((resolvePromise) => { resolveReady = resolvePromise; });
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };

  const workerPath = new URL("./lib/task-worker.mjs", import.meta.url);
  try {
    const synchronousMethods = Object.fromEntries(
      ["capabilities", "status"]
        .filter((method) => typeof moneyhand[method] === "function")
        .map((method) => [method, moneyhand[method]()]),
    );
    worker = new Worker(workerPath, {
      workerData: { taskModuleUrl, args, taskExecutionId, synchronousMethods },
    });
  } catch (error) {
    rejectOutcome(new MoneyHandError(
      "TASK_WORKER_START_FAILED",
      "MoneyHand could not start the isolated task worker",
      { cause: normalizedError(error, "TASK_WORKER_START_FAILED"), actionDispatched: false },
    ));
    markReady();
    return { ready, outcome, terminate: async () => {} };
  }

  const send = (message) => {
    if (finishing) return false;
    try {
      worker.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };
  const onAbort = () => send({
    type: "abort",
    reason: normalizedError(
      signal.reason instanceof Error ? signal.reason : new MoneyHandError("ABORTED", "MoneyHand task was aborted"),
      "ABORTED",
    ),
  });
  const detach = () => {
    signal.removeEventListener("abort", onAbort);
    worker.off("online", markReady);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const finish = (result, terminateWorker = true) => {
    if (finishing) return finishing;
    finishing = (async () => {
      markReady();
      detach();
      if (terminateWorker) await worker.terminate().catch(() => {});
      if (result.ok) resolveOutcome(result.value);
      else rejectOutcome(result.error);
    })();
    return finishing;
  };
  const respond = (id, result) => {
    const message = result.ok
      ? { type: "response", id, ok: true, value: result.value }
      : {
          type: "response",
          id,
          ok: false,
          error: normalizedError(result.error, "TASK_WORKER_CALL_FAILED"),
        };
    if (send(message)) return;
    if (result.ok) {
      send({
        type: "response",
        id,
        ok: false,
        error: {
          code: "TASK_WORKER_CALL_RESULT_NOT_SERIALIZABLE",
          message: "MoneyHand task call returned a value that cannot cross the isolated task boundary",
        },
      });
      return;
    }
    send({
      type: "response",
      id,
      ok: false,
      error: {
        code: typeof result.error?.code === "string" ? result.error.code : "TASK_WORKER_CALL_FAILED",
        message: String(result.error?.message ?? result.error),
      },
    });
  };
  async function onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "settled") {
      await finish(message.ok === true
        ? { ok: true, value: message.value }
        : { ok: false, error: taskWorkerError(message.error) });
      return;
    }
    if (message.type !== "call" || typeof message.id !== "string") return;
    try {
      if (!Array.isArray(message.args)) {
        throw new MoneyHandError("INVALID_TASK_WORKER_CALL", "Task worker call args must be an array");
      }
      let value;
      if (message.kind === "progress" && message.method === "progress") {
        value = await progress(message.args[0]);
      } else if (message.kind === "moneyhand" && typeof message.method === "string") {
        const method = moneyhand[message.method];
        if (typeof method !== "function") {
          throw new MoneyHandError(
            "INVALID_TASK_WORKER_CALL",
            `MoneyHand has no task method '${message.method}'`,
            { actionDispatched: false },
          );
        }
        value = await method(...message.args);
      } else {
        throw new MoneyHandError("INVALID_TASK_WORKER_CALL", "Task worker call is invalid");
      }
      respond(message.id, { ok: true, value });
    } catch (error) {
      respond(message.id, { ok: false, error });
    }
  }
  const onError = (error) => finish({
    ok: false,
    error: new MoneyHandError(
      "TASK_WORKER_FAILED",
      "MoneyHand isolated task worker failed",
      { cause: normalizedError(error, "TASK_WORKER_FAILED") },
    ),
  });
  const onExit = (code) => {
    if (finishing) return;
    finish({
      ok: false,
      error: new MoneyHandError(
        "TASK_WORKER_EXITED",
        `MoneyHand isolated task worker exited before returning a result (code ${code})`,
      ),
    }, false);
  };
  worker.on("message", onMessage);
  worker.once("online", markReady);
  worker.once("error", onError);
  worker.once("exit", onExit);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return {
    ready,
    outcome,
    async terminate(reason = new MoneyHandError(
      "TASK_WORKER_TERMINATED",
      "MoneyHand terminated an unresponsive isolated task worker",
    )) {
      await finish({ ok: false, error: reason });
    },
  };
}

export async function runMoneyHandTask(options = {}) {
  const input = asObject(options, "runMoneyHandTask options");
  const moneyhand = input.moneyhand;
  if (!moneyhand || typeof moneyhand.request !== "function") {
    throw new MoneyHandError("INVALID_TASK", "runMoneyHandTask requires a MoneyHand instance");
  }
  if (typeof input.taskPath !== "string" || !isAbsolute(input.taskPath)) {
    throw new MoneyHandError("INVALID_TASK", "taskPath must be an absolute local module path");
  }
  let taskPath;
  try {
    taskPath = realpathSync(input.taskPath);
  } catch {
    throw new MoneyHandError("INVALID_TASK", "taskPath must identify an existing local module");
  }
  const taskModuleUrl = `${pathToFileURL(taskPath).href}?task=${randomUUID()}`;
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    10,
    MAX_TASK_TIMEOUT_MS,
    DEFAULT_TASK_TIMEOUT_MS,
    "taskTimeoutMs",
  );
  const abortGraceMs = boundedInteger(
    input.abortGraceMs,
    10,
    MAX_TASK_ABORT_GRACE_MS,
    DEFAULT_TASK_ABORT_GRACE_MS,
    "taskAbortGraceMs",
  );
  const { progressIntervalMs, visualSilenceMs } = taskWatchdogPolicy(input);
  const taskExecutionId = input.taskExecutionId ?? createTaskExecutionId();
  const baselineTaskWindows = new Set(
    typeof moneyhand.ownedTaskWindowIds === "function"
      ? moneyhand.ownedTaskWindowIds()
      : [],
  );
  const taskController = new AbortController();
  const progressStartedAt = Date.now();
  const evidenceCollector = new TaskEvidenceCollector({
    taskExecutionId,
    startedAtMs: progressStartedAt,
  });
  const progressState = {
    taskExecutionId,
    activeTaskSpaceId: undefined,
    visualFallbacks: 0,
    lastActivityAt: progressStartedAt,
    lastProgressAt: 0,
    lastVisualAt: 0,
    lastVisualFallback: undefined,
    visualSilenceMs,
    latestOperation: undefined,
    latestOperationState: undefined,
    latestCheckpoint: undefined,
    recoverySequence: 0,
    effectSequence: 0,
    rateSequence: 0,
    sequence: 0,
    taskSettled: false,
    finished: false,
    visualWatchdogEnabled: false,
    silenceVisualWork: undefined,
  };
  let progressQueue = Promise.resolve();
  const emitTaskOutput = async (event) => {
    if (typeof input.onProgress !== "function") return event;
    progressQueue = progressQueue.then(() => input.onProgress(event));
    try {
      await progressQueue;
    } catch (error) {
      const failure = new MoneyHandError(
        "TASK_PROGRESS_OUTPUT_FAILED",
        "MoneyHand could not return mandatory task progress",
        { cause: normalizedError(error, "TASK_PROGRESS_OUTPUT_FAILED") },
      );
      taskController.abort(failure);
      throw failure;
    }
    return event;
  };
  const emitProgress = async (details = {}) => {
    const now = Date.now();
    const event = {
      type: "event",
      event: "moneyhand.task_progress",
      schema: "npc-moneyhand-task-progress/1",
      taskExecutionId,
      sequence: ++progressState.sequence,
      state: details.state ?? "running",
      phase: details.phase ?? "task",
      elapsedMs: Math.max(0, now - progressStartedAt),
      silenceMs: Math.max(0, now - progressState.lastActivityAt),
      ...(details.operation === undefined ? {} : { operation: details.operation }),
      ...(details.operationState === undefined ? {} : { operationState: details.operationState }),
      ...(details.message === undefined ? {} : { message: details.message }),
      ...(details.current === undefined ? {} : { current: details.current }),
      ...(details.total === undefined ? {} : { total: details.total }),
      ...(details.checkpoint === undefined ? {} : { checkpoint: details.checkpoint }),
      ...(details.visualFallback === undefined ? {} : { visualFallback: details.visualFallback }),
      relay: taskEventRelay(details, now),
    };
    progressState.lastProgressAt = now;
    evidenceCollector.recordProgress(event);
    return await emitTaskOutput(event);
  };
  progressState.emit = emitProgress;
  progressState.emitRecovery = async (recovery) => {
    const now = Date.now();
    const event = {
      type: "event",
      event: "moneyhand.task_recovery",
      schema: "npc-moneyhand-task-recovery/1",
      taskExecutionId,
      sequence: ++progressState.recoverySequence,
      ...recovery,
      relay: taskEventRelay({
        state: recovery.state,
        phase: "recovery",
        importance: recovery.state === "recovered" ? "progress" : "warning",
      }, now),
    };
    evidenceCollector.recordRecovery(event);
    return await emitTaskOutput(event);
  };
  progressState.emitEffectReceipt = async (receipt) => {
    const now = Date.now();
    const event = {
      type: "event",
      event: "moneyhand.task_effect_receipt",
      schema: "npc-moneyhand-task-effect-receipt/1",
      taskExecutionId,
      sequence: ++progressState.effectSequence,
      receipt,
      relay: taskEventRelay({
        state: receipt.status,
        phase: "effect",
        importance: receipt.status === "outcome_unknown" ? "warning" : "progress",
      }, now),
    };
    evidenceCollector.recordEffect(receipt);
    return await emitTaskOutput(event);
  };
  progressState.emitRate = async (rate) => {
    const now = Date.now();
    const event = {
      type: "event",
      event: "moneyhand.task_rate_control",
      schema: "npc-moneyhand-task-rate-control/1",
      taskExecutionId,
      sequence: ++progressState.rateSequence,
      ...rate,
      relay: taskEventRelay({
        state: rate.state,
        phase: "rate-control",
        importance: rate.stop || rate.waitMs > 0 ? "warning" : "progress",
      }, now),
    };
    evidenceCollector.recordRate(event);
    return await emitTaskOutput(event);
  };
  progressState.inspectRecoveredSilence = async ({ operation, taskSpaceId } = {}) => {
    const pinnedTaskSpaceId = taskSpaceId ?? progressState.activeTaskSpaceId;
    if (progressState.visualWatchdogEnabled !== true || progressState.taskSettled
      || typeof pinnedTaskSpaceId !== "string") return undefined;
    const now = Date.now();
    const silenceMs = Math.max(0, now - progressState.lastActivityAt);
    const recentSuccessfulVisual = progressState.lastVisualFallback?.captured === true
      && now - progressState.lastVisualAt < visualSilenceMs;
    if (silenceMs < visualSilenceMs || recentSuccessfulVisual) return undefined;
    if (progressState.silenceVisualWork) {
      return await progressState.silenceVisualWork;
    }
    const silenceVisualWork = (async () => {
      const visualFallback = await automaticTaskVisualFallback(
        moneyhand,
        progressState,
        "task-recovered-silence",
        {
          taskSpaceId: pinnedTaskSpaceId,
          [TASK_CONCURRENT_VISUAL_OBSERVATION]: true,
        },
        {
          code: "TASK_PROGRESS_SILENCE",
          message: `The controller recovered after ${silenceMs}ms without browser-task activity`,
          actionDispatched: "task-dependent",
          retry: "do-not-replay-inspect-current-page",
        },
        undefined,
      );
      await emitProgress({
        state: "visual_fallback",
        phase: "recovery",
        operation,
        message: "MoneyHand captured the current page immediately after recovering from overdue task silence",
        visualFallback,
      });
      return visualFallback;
    })();
    progressState.silenceVisualWork = silenceVisualWork;
    try {
      return await silenceVisualWork;
    } finally {
      if (progressState.silenceVisualWork === silenceVisualWork) {
        progressState.silenceVisualWork = undefined;
      }
    }
  };
  progressState.noteActivity = async ({ operation, operationState, force = false, taskSpaceId }) => {
    await progressState.inspectRecoveredSilence({ operation, taskSpaceId });
    const now = Date.now();
    progressState.lastActivityAt = now;
    progressState.latestOperation = operation;
    progressState.latestOperationState = operationState;
    if (force || now - progressState.lastProgressAt >= progressIntervalMs) {
      await emitProgress({
        state: "running",
        phase: operation === "task-cleanup" ? "cleanup" : "browser",
        operation,
        operationState,
        message: operation === "task-cleanup"
          ? "MoneyHand is cleaning up the task-owned browser window"
          : `MoneyHand browser operation ${operationState}`,
      });
    }
  };
  const reportProgress = async (value = {}) => {
    const details = taskProgressDetails(value);
    await progressState.inspectRecoveredSilence({ operation: "task-progress" });
    progressState.lastActivityAt = Date.now();
    if (details.checkpoint !== undefined) progressState.latestCheckpoint = details.checkpoint;
    return await emitProgress({
      state: "running",
      phase: details.phase ?? "task",
      message: details.message ?? "MoneyHand task is making progress",
      ...(details.current === undefined ? {} : { current: details.current }),
      ...(details.total === undefined ? {} : { total: details.total }),
      ...(details.checkpoint === undefined ? {} : { checkpoint: details.checkpoint }),
    });
  };
  const timeoutError = new MoneyHandError(
    "TASK_TIMEOUT",
    `MoneyHand task exceeded its ${timeoutMs}ms execution budget`,
    { timeoutMs, actionDispatched: "task-dependent", retry: "inspect-checkpoint-before-retry" },
  );
  let deadlineTimer;
  let deadlineWork = Promise.resolve();
  let removeAbortListener = () => {};
  const aborted = new Promise((resolvePromise) => {
    const onAbort = () => resolvePromise({
      kind: "aborted",
      reason: taskController.signal.reason instanceof Error
        ? taskController.signal.reason
        : new MoneyHandError("ABORTED", "MoneyHand task was aborted"),
    });
    if (taskController.signal.aborted) onAbort();
    else {
      taskController.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => taskController.signal.removeEventListener("abort", onAbort);
    }
  });
  const forwardAbort = () => taskController.abort(
    input.signal?.reason instanceof Error
      ? input.signal.reason
      : new MoneyHandError("ABORTED", "MoneyHand task was aborted by its caller"),
  );
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });
  const armDeadline = () => {
    if (deadlineTimer !== undefined || taskController.signal.aborted) return;
    deadlineTimer = setTimeout(() => {
      deadlineWork = (async () => {
        if (progressState.taskSettled || taskController.signal.aborted) return;
        const visualFallback = await automaticTaskVisualFallback(
          moneyhand,
          progressState,
          "task-deadline",
          {
            taskSpaceId: progressState.activeTaskSpaceId,
            [TASK_CONCURRENT_VISUAL_OBSERVATION]: true,
          },
          timeoutError,
          undefined,
        );
        timeoutError.details = { ...timeoutError.details, visualFallback };
        await emitProgress({
          state: "visual_fallback",
          phase: "timeout",
          operation: progressState.latestOperation,
          operationState: progressState.latestOperationState,
          message: "MoneyHand inspected the current page before aborting the timed-out task",
          visualFallback,
        });
        if (!progressState.taskSettled && !taskController.signal.aborted) {
          taskController.abort(timeoutError);
        }
      })().catch((error) => {
        if (!taskController.signal.aborted) taskController.abort(error);
      });
    }, timeoutMs);
  };
  let progressTickQueue = Promise.resolve();
  const tickProgress = async () => {
    if (progressState.finished) return;
    const now = Date.now();
    if (now - progressState.lastProgressAt >= progressIntervalMs) {
      await emitProgress({
        state: "running",
        phase: progressState.visualWatchdogEnabled ? "heartbeat" : "cleanup",
        operation: progressState.latestOperation,
        operationState: progressState.latestOperationState,
        message: progressState.visualWatchdogEnabled
          ? "MoneyHand task is still running"
          : "MoneyHand is finishing task cleanup",
      });
    }
    if (!progressState.visualWatchdogEnabled
      || typeof progressState.activeTaskSpaceId !== "string"
      || now - progressState.lastActivityAt < visualSilenceMs
      || now - progressState.lastVisualAt < visualSilenceMs) {
      return;
    }
    if (progressState.silenceVisualWork) {
      await progressState.silenceVisualWork;
      return;
    }
    progressState.lastVisualAt = now;
    const silenceVisualWork = (async () => {
      const visualFallback = await automaticTaskVisualFallback(
        moneyhand,
        progressState,
        "task-silence-watchdog",
        {
          taskSpaceId: progressState.activeTaskSpaceId,
          [TASK_CONCURRENT_VISUAL_OBSERVATION]: true,
        },
        {
          code: "TASK_PROGRESS_SILENCE",
          message: `No browser-task activity completed within ${visualSilenceMs}ms`,
          actionDispatched: "task-dependent",
          retry: "do-not-replay-inspect-current-page",
        },
        taskController.signal,
      );
      await emitProgress({
        state: "visual_fallback",
        phase: "watchdog",
        operation: progressState.latestOperation,
        operationState: progressState.latestOperationState,
        message: "MoneyHand captured the current page because task feedback was silent",
        visualFallback,
      });
      return visualFallback;
    })();
    progressState.silenceVisualWork = silenceVisualWork;
    try {
      await silenceVisualWork;
    } finally {
      if (progressState.silenceVisualWork === silenceVisualWork) {
        progressState.silenceVisualWork = undefined;
      }
    }
  };
  const progressTimer = setInterval(() => {
    progressTickQueue = progressTickQueue
      .then(tickProgress)
      .catch((error) => {
        if (!taskController.signal.aborted) taskController.abort(error);
      });
  }, Math.max(10, Math.min(
    progressIntervalMs,
    visualSilenceMs,
    MAX_TASK_WATCHDOG_POLL_MS,
  )));
  progressTimer.unref?.();
  progressState.beginCleanup = async ({ taskSpaceId } = {}) => {
    if (progressState.visualWatchdogEnabled !== true) return;
    const pausedAt = Date.now();
    const silenceMs = Math.max(0, pausedAt - progressState.lastActivityAt);
    progressState.visualWatchdogEnabled = false;
    clearInterval(progressTimer);
    await progressTickQueue.catch(() => {});
    await progressState.silenceVisualWork?.catch(() => {});
    const recentSuccessfulVisual = progressState.lastVisualFallback?.captured === true
      && Date.now() - progressState.lastVisualAt < visualSilenceMs;
    if (silenceMs < visualSilenceMs || recentSuccessfulVisual) return;
    const visualFallback = await automaticTaskVisualFallback(
      moneyhand,
      progressState,
      "task-pre-cleanup-silence",
      {
        taskSpaceId: taskSpaceId ?? progressState.activeTaskSpaceId,
        [TASK_CONCURRENT_VISUAL_OBSERVATION]: true,
      },
      {
        code: "TASK_PROGRESS_SILENCE",
        message: `No browser-task activity completed within ${visualSilenceMs}ms before cleanup`,
        actionDispatched: "task-dependent",
        retry: "do-not-replay-inspect-current-page",
      },
      undefined,
    );
    await emitProgress({
      state: "visual_fallback",
      phase: "pre-cleanup",
      operation: "completeTaskContext",
      operationState: "started",
      message: "MoneyHand inspected the current page before task cleanup",
      visualFallback,
    });
  };
  const scopedMoneyHand = taskScopedMoneyHand(moneyhand, taskController.signal, progressState);
  let taskRuntime;
  const taskOutcome = Promise.resolve()
    .then(async () => {
      await emitProgress({
        state: "started",
        phase: "task",
        message: "MoneyHand task started",
      });
      taskRuntime = taskWorkerRuntime({
        taskModuleUrl,
        moneyhand: scopedMoneyHand,
        signal: taskController.signal,
        args: input.args,
        progress: reportProgress,
        taskExecutionId,
      });
      await taskRuntime.ready;
      progressState.lastActivityAt = Date.now();
      progressState.visualWatchdogEnabled = true;
      armDeadline();
      return await taskRuntime.outcome;
    })
    .then(
      (value) => {
        progressState.taskSettled = true;
        return { kind: "settled", ok: true, value };
      },
      (error) => {
        progressState.taskSettled = true;
        return { kind: "settled", ok: false, error };
      },
    );
  let outcome;
  let abortReason;
  let taskAcknowledgedAbort = true;
  let effectiveAbortGraceMs = abortGraceMs;
  try {
    outcome = await Promise.race([taskOutcome, aborted]);
    if (outcome.kind === "aborted") {
      abortReason = outcome.reason;
      if (abortReason?.code === "CONTROLLER_SHUTDOWN") {
        effectiveAbortGraceMs = Math.min(
          abortGraceMs,
          CONTROLLER_SHUTDOWN_TASK_ABORT_GRACE_MS,
        );
      }
      clearTimeout(deadlineTimer);
      const abortGraceExpired = Symbol("task-abort-grace-expired");
      let graceTimer;
      try {
        outcome = await Promise.race([
          taskOutcome,
          new Promise((resolvePromise) => {
            graceTimer = setTimeout(() => resolvePromise(abortGraceExpired), effectiveAbortGraceMs);
          }),
        ]);
      } finally {
        clearTimeout(graceTimer);
      }
      if (outcome === abortGraceExpired) {
        taskAcknowledgedAbort = false;
        await taskRuntime?.terminate(abortReason).catch(() => {});
        outcome = await taskOutcome;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    removeAbortListener();
    input.signal?.removeEventListener("abort", forwardAbort);
  }
  await deadlineWork.catch(() => {});
  const preliminaryTaskError = abortReason ?? (outcome?.ok === false ? outcome.error : undefined);
  const terminalSilenceMs = Math.max(0, Date.now() - progressState.lastActivityAt);
  const terminalVisualReason = taskTerminalVisualReason(
    outcome,
    abortReason,
    terminalSilenceMs,
    visualSilenceMs,
  );
  const returnedSuccessfulVisual = outcome?.ok === true && (
    outcome.value?.visualFallback?.captured === true
      || outcome.value?.outcome?.visualFallback?.captured === true
  );
  const recentSuccessfulVisual = returnedSuccessfulVisual || (
    progressState.lastVisualFallback?.captured === true
      && Date.now() - progressState.lastVisualAt < visualSilenceMs
  );
  if (terminalVisualReason && !recentSuccessfulVisual) {
    const visualFallback = await automaticTaskVisualFallback(
      moneyhand,
      progressState,
      "task-terminal",
      {
        taskSpaceId: progressState.activeTaskSpaceId,
        [TASK_CONCURRENT_VISUAL_OBSERVATION]: true,
      },
      terminalVisualReason,
      undefined,
    );
    await emitProgress({
      state: "visual_fallback",
      phase: "terminal",
      operation: progressState.latestOperation,
      operationState: progressState.latestOperationState,
      message: "MoneyHand inspected the current page before task cleanup",
      visualFallback,
    }).catch(() => {});
    if (preliminaryTaskError && typeof preliminaryTaskError === "object"
      && preliminaryTaskError.details?.visualFallback === undefined) {
      preliminaryTaskError.details = {
        ...(preliminaryTaskError.details ?? {}),
        visualFallback,
      };
    } else if (outcome?.ok === true && outcome.value && typeof outcome.value === "object"
      && !Array.isArray(outcome.value) && outcome.value.visualFallback === undefined) {
      outcome.value = { ...outcome.value, visualFallback };
    }
  }
  progressState.visualWatchdogEnabled = false;
  await progressState.noteActivity({
    operation: "task-cleanup",
    operationState: "started",
    force: true,
  }).catch(() => {});
  const taskIds = typeof moneyhand.ownedTaskWindowIds === "function"
    ? moneyhand.ownedTaskWindowIds().filter((id) => !baselineTaskWindows.has(id))
    : [];
  let cleanup;
  if (typeof moneyhand.cleanupOwnedTaskWindows !== "function") {
    cleanup = { ok: true, attempted: 0, results: [] };
  } else {
    const cleanupGraceExpired = Symbol("task-cleanup-grace-expired");
    let cleanupTimer;
    const cleanupOutcome = Promise.resolve()
      .then(() => moneyhand.cleanupOwnedTaskWindows({ taskIds }))
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    let boundedCleanup;
    try {
      boundedCleanup = await Promise.race([
        cleanupOutcome,
        new Promise((resolvePromise) => {
          cleanupTimer = setTimeout(() => resolvePromise(cleanupGraceExpired), effectiveAbortGraceMs);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (boundedCleanup === cleanupGraceExpired) {
      cleanup = {
        ok: false,
        attempted: taskIds.length,
        results: [],
        error: {
          code: "TASK_WINDOW_CLEANUP_TIMEOUT",
          message: `Task-owned window cleanup exceeded ${effectiveAbortGraceMs}ms`,
        },
      };
    } else if (boundedCleanup.ok) {
      cleanup = boundedCleanup.value;
    } else {
      cleanup = {
        ok: false,
        attempted: taskIds.length,
        results: [],
        error: normalizedError(boundedCleanup.error, "TASK_WINDOW_CLEANUP_FAILED"),
      };
    }
  }
  if (!taskAcknowledgedAbort || !cleanup.ok) {
    try {
      await input.onUnresponsive?.({ reason: abortReason, cleanup, taskIds });
    } catch (error) {
      cleanup.onUnresponsiveError = normalizedError(error, "TASK_FAIL_CLOSED_FAILED");
    }
  }
  let taskError = preliminaryTaskError;
  progressState.finished = true;
  clearInterval(progressTimer);
  await progressTickQueue.catch(() => {});
  if (!taskError && !cleanup.ok) {
    taskError = new MoneyHandError(
      "TASK_WINDOW_CLEANUP_FAILED",
      "The task finished but one task-owned browser window could not be safely closed",
      { taskWindowCleanup: cleanup },
    );
  }
  let taskValue = outcome?.value;
  const preliminaryEvidence = evidenceCollector.build({
    value: taskValue,
    cleanup,
  });
  const completionGate = evaluateTaskCompletion({
    value: taskValue,
    cleanup,
    evidence: preliminaryEvidence,
  });
  if (!taskError && completionGate.enforced && !completionGate.passed) {
    taskError = new MoneyHandError(
      "TASK_COMPLETION_GATE_FAILED",
      "The task claimed completion without satisfying every hard completion check",
      { completionGate, actionDispatched: false },
    );
  }
  if (taskError) {
    taskError = ensureTaskRecovery(taskError, {
      operation: progressState.latestOperation ?? "task",
      attempt: 1,
      hasTaskPage: typeof progressState.activeTaskSpaceId === "string",
    });
  }
  let evidenceArtifact;
  if (typeof input.onEvidence === "function") {
    try {
      evidenceArtifact = await input.onEvidence(preliminaryEvidence);
    } catch (error) {
      taskError ??= new MoneyHandError(
        "TASK_EVIDENCE_WRITE_FAILED",
        "MoneyHand could not persist the standard private task evidence bundle",
        {
          cause: normalizedError(error, "TASK_EVIDENCE_WRITE_FAILED"),
          actionDispatched: false,
        },
      );
    }
  }
  const terminalProgress = taskError
    ? {
        state: "failed",
        phase: "complete",
        message: taskError.code === "TASK_COMPLETION_GATE_FAILED"
          ? "MoneyHand blocked an unsupported completion claim"
          : "MoneyHand task failed after bounded cleanup",
      }
    : {
        state: "completed",
        phase: "complete",
        message: "MoneyHand task completed and cleanup succeeded",
      };
  await emitProgress(terminalProgress).catch(() => {});
  const taskEvidence = evidenceCollector.build({
    value: taskValue,
    cleanup,
    ...(evidenceArtifact === undefined ? {} : { artifact: evidenceArtifact }),
  });
  const summaryAtMs = Date.now();
  const taskSummary = buildTaskSummary({
    state: taskError ? "failed" : "completed",
    evidence: taskEvidence,
    terminal: taskError
      ? { ok: false, error: normalizedError(taskError) }
      : { ok: true, value: taskValue },
    updatedAt: new Date(summaryAtMs).toISOString(),
    now: () => summaryAtMs,
  });
  await input.onFinal?.({ taskEvidence, completionGate, taskSummary });
  if (taskError) {
    if (typeof taskError === "object") {
      taskError.details = {
        ...(taskError.details ?? {}),
        taskAcknowledgedAbort,
        cleanupComplete: cleanup.ok,
        controllerReusable: taskAcknowledgedAbort && cleanup.ok,
        taskWindowCleanup: cleanup,
        taskEvidence,
        completionGate,
      };
    }
    throw taskError;
  }
  return taskValue;
}

function cliMoneyHandOptions(cli = {}) {
  const {
    once: _once,
    onceTimeoutMs: _onceTimeoutMs,
    outputDrainTimeoutMs: _outputDrainTimeoutMs,
    taskPath: _taskPath,
    taskArgs: _taskArgs,
    taskTimeoutMs: _taskTimeoutMs,
    taskAbortGraceMs: _taskAbortGraceMs,
    taskExecutionId: _taskExecutionId,
    taskLast: _taskLast,
    taskStatus: _taskStatus,
    taskFollow: _taskFollow,
    callMethod: _callMethod,
    callParams: _callParams,
    connect: _connect,
    ensure: _ensure,
    stopController: _stopController,
    controllerService: _controllerService,
    controllerPort: _controllerPort,
    controllerIdleMs: _controllerIdleMs,
    afterUserAction: _afterUserAction,
    autoLaunchBrowser: _autoLaunchBrowser,
    browserRoot: _browserRoot,
    profileDirectory: _profileDirectory,
    browserExecutable: _browserExecutable,
    launchGraceMs: _launchGraceMs,
    help: _help,
    version: _version,
    describe: _describe,
    ...moneyhandCli
  } = cli;
  return {
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    pairingToken: HOST_PROCESS.env.NPC_MONEYHAND_PAIRING_TOKEN ?? "",
    connectTimeoutMs: numericEnvironment(
      "NPC_MONEYHAND_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    requestTimeoutMs: numericEnvironment(
      "NPC_MONEYHAND_REQUEST_TIMEOUT_MS",
      30_000,
    ),
    heartbeatMs: numericEnvironment("NPC_MONEYHAND_HEARTBEAT_MS", 20_000),
    handshakeTimeoutMs: numericEnvironment(
      "NPC_MONEYHAND_HANDSHAKE_TIMEOUT_MS",
      4_000,
    ),
    maxInflight: numericEnvironment("NPC_MONEYHAND_MAX_INFLIGHT", 64),
    ...moneyhandCli,
  };
}

function resolvedTaskTimeoutMs(value) {
  return boundedInteger(
    value ?? numericEnvironment("NPC_MONEYHAND_TASK_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS),
    10,
    MAX_TASK_TIMEOUT_MS,
    DEFAULT_TASK_TIMEOUT_MS,
    "taskTimeoutMs",
  );
}

function resolvedTaskAbortGraceMs(value) {
  return boundedInteger(
    value ?? DEFAULT_TASK_ABORT_GRACE_MS,
    10,
    MAX_TASK_ABORT_GRACE_MS,
    DEFAULT_TASK_ABORT_GRACE_MS,
    "taskAbortGraceMs",
  );
}

function controllerSpawnArguments(cli) {
  const argumentsList = [];
  const valueOptions = [
    ["port", "--internal-test-port"],
    ["controllerIdleMs", "--internal-controller-idle-ms"],
    ["connectTimeoutMs", "--connect-timeout-ms"],
    ["requestTimeoutMs", "--request-timeout-ms"],
    ["heartbeatMs", "--heartbeat-ms"],
    ["handshakeTimeoutMs", "--handshake-timeout-ms"],
    ["maxInflight", "--max-inflight"],
    ["taskAbortGraceMs", "--internal-task-abort-grace-ms"],
  ];
  for (const [key, flag] of valueOptions) {
    if (cli[key] !== undefined) argumentsList.push(flag, String(cli[key]));
  }
  if (cli.autoLaunchBrowser === false) argumentsList.push("--no-browser-launch");
  return argumentsList;
}

async function ensureCliController(cli) {
  return await ensureControllerService({
    sourcePath: SOURCE_PATH,
    port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
    spawnArguments: controllerSpawnArguments(cli),
  });
}

async function currentCliController(cli) {
  try {
    return await pingControllerService({
      sourcePath: SOURCE_PATH,
      port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
      timeoutMs: 500,
    });
  } catch (error) {
    if ([
      "ECONNREFUSED",
      "CONTROLLER_UNAVAILABLE",
      "CONTROLLER_TIMEOUT",
    ].includes(error?.code)) return undefined;
    throw error;
  }
}

function taskStatusEvent(status) {
  const now = Date.now();
  return {
    type: "event",
    event: "moneyhand.task_status",
    schema: "npc-moneyhand-task-status/1",
    taskExecutionId: status.taskExecutionId,
    taskSummary: status.taskSummary,
    status,
    relay: taskEventRelay({
      state: status.state,
      phase: "reattach",
      importance: status.state === "running" ? "progress" : "terminal",
      notifyUser: status.state !== "running",
    }, now),
  };
}

async function taskLedgerStatus(cli) {
  const build = controllerServiceIdentity(SOURCE_PATH).build;
  const controller = await currentCliController(cli);
  if (cli.taskLast) {
    return await readLatestTaskExecutionStatus({ build, controller });
  }
  return await readTaskExecutionStatus({
    build,
    controller,
    taskExecutionId: cli.taskStatus ?? cli.taskFollow,
  });
}

async function runTaskLedgerCli(cli, cliOutput) {
  const output = cliOutput.stream;
  let status = await taskLedgerStatus(cli);
  if (!cli.taskFollow) {
    await writeFatalLine(output, JSON.stringify({
      type: "result",
      id: cli.taskLast ? "task-last" : "task-status",
      ok: true,
      value: status,
    }));
    await closeCliOutput(cliOutput);
    return;
  }
  await writeFatalLine(output, JSON.stringify(taskStatusEvent(status)));
  if (status.terminal) {
    await writeFatalLine(output, JSON.stringify({
      ...status.terminal,
      taskExecutionId: status.taskExecutionId,
      reattached: true,
    }));
    await closeCliOutput(cliOutput);
    return;
  }
  if (status.state !== "running") {
    await writeFatalLine(output, JSON.stringify({
      type: "result",
      id: "task",
      ok: false,
      taskExecutionId: status.taskExecutionId,
      reattached: true,
      error: {
        code: "TASK_EXECUTION_INTERRUPTED",
        message: "The recorded controller instance ended before a terminal task result was journaled",
      },
    }));
    await closeCliOutput(cliOutput);
    return;
  }
  const build = controllerServiceIdentity(SOURCE_PATH).build;
  let afterSequence = status.lastSequence;
  while (true) {
    if (cliOutput.failure.aborted) throw cliOutput.failure.reason;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, TASK_FOLLOW_POLL_MS));
    const { entries } = await readTaskExecutionEntries({
      build,
      taskExecutionId: status.taskExecutionId,
      afterSequence,
    });
    let terminal = false;
    for (const entry of entries) {
      afterSequence = entry.sequence;
      const message = {
        ...entry.message,
        taskExecutionId: status.taskExecutionId,
        reattached: true,
      };
      await writeFatalLine(output, JSON.stringify(message));
      if (message.type === "result" && message.id === "task") terminal = true;
    }
    if (terminal) break;
    const controller = await currentCliController(cli);
    status = await readTaskExecutionStatus({
      build,
      controller,
      taskExecutionId: status.taskExecutionId,
    });
    if (status.state === "interrupted") {
      await writeFatalLine(output, JSON.stringify({
        type: "result",
        id: "task",
        ok: false,
        taskExecutionId: status.taskExecutionId,
        reattached: true,
        error: {
          code: "TASK_EXECUTION_INTERRUPTED",
          message: "The recorded controller instance ended before a terminal task result was journaled",
        },
      }));
      break;
    }
  }
  await closeCliOutput(cliOutput);
}

async function connectControllerMoneyHand(moneyhand, request, signal) {
  const connectTimeoutMs = request.connectTimeoutMs
    ?? numericEnvironment("NPC_MONEYHAND_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
  return request.autoLaunchBrowser === false
    ? {
        session: await moneyhand.wait({ timeoutMs: connectTimeoutMs, signal }),
        launched: false,
        browser: null,
      }
    : await ensureMoneyHandConnection({
        moneyhand,
        timeoutMs: connectTimeoutMs,
        graceMs: boundedInteger(request.launchGraceMs, 0, 60_000, 1_000, "launchGraceMs"),
        signal,
        browserRoot: request.browserRoot,
        profileDirectory: request.profileDirectory,
        browserExecutable: request.browserExecutable,
      });
}

function provisionalControllerBootstrapWindow(connection) {
  const marker = connection.browser?.bootstrapMarker;
  if (connection.launched !== true || typeof marker !== "string") return null;
  return {
    marker,
    selector: {
      profile: connection.session.profile,
      instanceId: connection.session.instanceId,
      bootId: connection.session.bootId,
    },
    provisional: true,
  };
}

function exactControllerBootstrapTabs(windows, record) {
  return windows.flatMap((window) => {
    if (window?.type !== "normal"
      || !Number.isInteger(window.id)
      || (record.windowId !== undefined && window.id !== record.windowId)
      || !Array.isArray(window.tabs)) {
      return [];
    }
    return window.tabs
      .filter((tab) => Number.isInteger(tab?.id)
        && (record.tabId === undefined || tab.id === record.tabId)
        && tab.windowId === window.id
        && (tab.url === record.marker || tab.pendingUrl === record.marker))
      .map((tab) => ({ window, tab }));
  });
}

async function captureControllerBootstrapWindow(moneyhand, record, signal) {
  if (!record) return null;
  let lastWindows = [];
  for (let attempt = 1; attempt <= TASK_WINDOW_READY_ATTEMPTS; attempt += 1) {
    const terminal = await moneyhand.request({
      method: "chrome.call",
      params: { method: "windows.getAll", args: [{ populate: true }] },
    }, { selector: record.selector, signal, connectTimeoutMs: 0 });
    const value = directHandValue(terminal, {
      code: "BOOTSTRAP_WINDOW_INSPECTION_FAILED",
      label: "Controller bootstrap-tab inspection",
    });
    if (value.method !== "windows.getAll" || !Array.isArray(value.result)) {
      throw new MoneyHandError(
        "INVALID_BOOTSTRAP_WINDOW_RESULT",
        "windows.getAll returned an invalid bootstrap-tab result",
      );
    }
    lastWindows = value.result;
    const matches = exactControllerBootstrapTabs(lastWindows, record);
    if (matches.length === 1) {
      return {
        ...record,
        windowId: matches[0].window.id,
        tabId: matches[0].tab.id,
        provisional: false,
      };
    }
    if (matches.length > 1) {
      throw new MoneyHandError(
        "BOOTSTRAP_WINDOW_AMBIGUOUS",
        "More than one browser tab matched the controller bootstrap marker",
      );
    }
    if (attempt < TASK_WINDOW_READY_ATTEMPTS) {
      await taskRetryDelay(TASK_WINDOW_READY_POLL_MS, signal);
    }
  }
  throw new MoneyHandError(
    "BOOTSTRAP_WINDOW_NOT_FOUND",
    "The browser launched for MoneyHand did not expose its unique bootstrap tab",
    { inspectedWindows: lastWindows.length },
  );
}

async function captureControllerBootstrapWindowForCommand(
  moneyhand,
  record,
  signal,
  command,
) {
  try {
    return await captureControllerBootstrapWindow(moneyhand, record, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error?.code === "BOOTSTRAP_WINDOW_AMBIGUOUS") throw error;
    // The Extension handshake proves connection readiness for connect, task, and call.
    // Keep the unique marker as provisional cleanup ownership when the just-opened
    // bootstrap tab is not readable yet; later cleanup still requires an exact match.
    return record;
  }
}

async function closeControllerBootstrapWindowOnce(moneyhand, record) {
  if (!record) return { attempted: false, ok: true };
  const terminal = await moneyhand.request({
    method: "chrome.call",
    params: { method: "windows.getAll", args: [{ populate: true }] },
  }, { selector: record.selector, connectTimeoutMs: 0 });
  const value = directHandValue(terminal, {
    code: "BOOTSTRAP_WINDOW_INSPECTION_FAILED",
    label: "Controller bootstrap-tab cleanup inspection",
  });
  if (value.method !== "windows.getAll" || !Array.isArray(value.result)) {
    throw new MoneyHandError(
      "INVALID_BOOTSTRAP_WINDOW_RESULT",
      "windows.getAll returned an invalid bootstrap-tab cleanup result",
    );
  }
  let owned;
  if (record.windowId === undefined) {
    const matches = exactControllerBootstrapTabs(value.result, record);
    if (matches.length === 0) {
      return { attempted: true, ok: true, alreadyClosed: true, provisional: true };
    }
    if (matches.length > 1) {
      return {
        attempted: true,
        ok: false,
        error: {
          code: "BOOTSTRAP_WINDOW_AMBIGUOUS",
          message: "More than one tab matched the provisional MoneyHand bootstrap marker; no tab was closed",
        },
      };
    }
    [owned] = matches;
  } else {
    const sameId = value.result.find((window) => window?.id === record.windowId);
    if (!sameId) return { attempted: true, ok: true, alreadyClosed: true };
    const sameTab = Array.isArray(sameId.tabs)
      ? sameId.tabs.find((tab) => tab?.id === record.tabId)
      : undefined;
    if (!sameTab) return { attempted: true, ok: true, alreadyClosed: true };
    [owned] = exactControllerBootstrapTabs([sameId], record);
  }
  if (!owned) {
    return {
      attempted: true,
      ok: false,
      error: {
        code: "BOOTSTRAP_TAB_OWNERSHIP_CHANGED",
        message: "The MoneyHand bootstrap tab changed; it was not closed",
      },
    };
  }
  const windowId = owned.window.id;
  const tabId = owned.tab.id;
  const removed = await moneyhand.request({
    method: "chrome.call",
    params: { method: "tabs.remove", args: [tabId] },
  }, { selector: record.selector, connectTimeoutMs: 0 });
  const removedValue = directHandValue(removed, {
    code: "BOOTSTRAP_TAB_CLOSE_FAILED",
    label: "Controller bootstrap-tab cleanup",
  });
  if (removedValue.method !== "tabs.remove" || removedValue.result !== null) {
    throw new MoneyHandError(
      "INVALID_BOOTSTRAP_WINDOW_RESULT",
      "tabs.remove returned an invalid bootstrap-tab cleanup result",
    );
  }
  return { attempted: true, ok: true, alreadyClosed: false, windowId, tabId };
}

async function closeControllerBootstrapWindow(moneyhand, record) {
  let lastError;
  for (let attempt = 1; attempt <= TASK_WINDOW_READY_ATTEMPTS; attempt += 1) {
    try {
      return await closeControllerBootstrapWindowOnce(moneyhand, record);
    } catch (error) {
      lastError = error;
      // A just-finished task-window removal can still occupy the Extension's
      // exclusive queue for a few event-loop turns after its terminal result is
      // delivered. BUSY proves this cleanup was not dispatched, so a bounded
      // settle-and-retry is safe and cannot replay tabs.remove.
      if (error?.code !== "BUSY" || attempt === TASK_WINDOW_READY_ATTEMPTS) throw error;
      await taskRetryDelay(TASK_WINDOW_READY_POLL_MS);
    }
  }
  throw lastError;
}

async function boundedControllerStopStep(operation, timeoutMs) {
  const timedOut = Symbol("controller-stop-timeout");
  let timer;
  const settled = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
  try {
    return await Promise.race([
      settled,
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(timedOut), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopControllerMoneyHand(moneyhand, bootstrapWindow, timeoutMs) {
  const stepTimeoutMs = Math.max(10, Math.floor(timeoutMs / 2));
  if (bootstrapWindow) {
    await boundedControllerStopStep(
      () => closeControllerBootstrapWindow(moneyhand, bootstrapWindow),
      stepTimeoutMs,
    );
  }
  await boundedControllerStopStep(
    () => moneyhand.stop({ graceMs: 0 }),
    stepTimeoutMs,
  );
}

export const __test__ = Object.freeze({
  acceptedConnectResult,
  provisionalControllerBootstrapWindow,
  connectAcceptanceResult,
  captureControllerBootstrapWindow,
  captureControllerBootstrapWindowForCommand,
  closeControllerBootstrapWindow,
  stopControllerMoneyHand,
  taskWatchdogPolicy,
});

function controllerCommandError(error, fallbackCode = "MONEYHAND_TASK_FAILED") {
  const normalized = normalizedError(error, fallbackCode);
  const failure = new MoneyHandError(normalized.code, normalized.message);
  if (normalized.details !== undefined) failure.details = normalized.details;
  return { failure, normalized };
}

function taskTerminalFailure(error, taskFinal, operation = "task-terminal") {
  const recovered = ensureTaskRecovery(error, { operation, attempt: 1, hasTaskPage: false });
  const normalized = normalizedError(recovered, "MONEYHAND_TASK_FAILED");
  const atMs = Date.now();
  const taskSummary = buildTaskSummary({
    state: "failed",
    evidence: taskFinal?.taskEvidence,
    terminal: { ok: false, error: normalized },
    updatedAt: new Date(atMs).toISOString(),
    now: () => atMs,
  });
  return {
    recovered,
    normalized,
    final: { ...(taskFinal ?? {}), taskSummary },
  };
}

async function runControllerServiceProcess(cli) {
  const moneyhand = createMoneyHand(cliMoneyHandOptions(cli));
  const taskAbortGraceMs = resolvedTaskAbortGraceMs(cli.taskAbortGraceMs);
  let bootstrapWindow = null;
  let started = false;
  const ensureStarted = async () => {
    if (!started) {
      await moneyhand.start();
      started = true;
    }
  };
  let service;
  try {
    service = await startControllerService({
      sourcePath: SOURCE_PATH,
      port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
      idleTimeoutMs: cli.controllerIdleMs ?? DEFAULT_CONTROLLER_IDLE_MS,
      onStop: async () => stopControllerMoneyHand(
        moneyhand,
        bootstrapWindow,
        taskAbortGraceMs,
      ),
      async handle(request, context) {
        if (!["connect", "task", "call"].includes(request.command)) {
          throw new MoneyHandError(
            "INVALID_CONTROLLER_COMMAND",
            `Unknown controller command '${request.command}'`,
          );
        }
        let taskLedger;
        let taskFinal;
        let send = context.send;
        if (request.command === "task") {
          taskLedger = await TaskExecutionLedger.create({
            taskExecutionId: request.taskExecutionId,
            controller: context.status(),
            taskPath: request.taskPath,
            args: request.taskArgs,
          });
          send = async (message) => {
            const enriched = {
              ...message,
              taskExecutionId: taskLedger.taskExecutionId,
            };
            await taskLedger.append(enriched);
            return await context.send(enriched);
          };
          await send({
            type: "event",
            event: "moneyhand.task_registered",
            schema: "npc-moneyhand-task-registered/1",
            taskExecutionId: taskLedger.taskExecutionId,
            state: "registered",
            message: "MoneyHand accepted the task into its private durable journal",
            relay: taskEventRelay({
              state: "registered",
              phase: "task",
              notifyUser: true,
            }),
          });
        }
        try {
          await ensureStarted();
          const connection = await connectControllerMoneyHand(moneyhand, request, context.signal);
          if (connection.launched === true) {
            bootstrapWindow = provisionalControllerBootstrapWindow(connection);
            bootstrapWindow = await captureControllerBootstrapWindowForCommand(
              moneyhand,
              bootstrapWindow,
              context.signal,
              request.command,
            );
          }
          if (request.command === "connect") {
            let acceptance;
            if (cli.port !== undefined) {
              acceptance = skippedConnectAcceptance();
            } else {
              try {
                acceptance = connectAcceptanceResult(await runConnectAcceptanceFlow({
                  moneyhand,
                  signal: context.signal,
                  onProgress: context.send,
                }));
              } catch (error) {
                acceptance = failedConnectAcceptance(error);
              }
            }
            const result = acceptedConnectResult(acceptance);
            if (result.status === "blocked") context.stopAfterCommand();
            await send({
              type: "result",
              id: "connect",
              ok: true,
              value: result,
            });
            return;
          }
          await send({
            type: "event",
            event: "moneyhand.connected",
            protocol: MONEYHAND_CONTROL_PROTOCOL,
            session: connection.session,
            launchedBrowser: connection.launched,
            ...(connection.browser === null ? {} : {
              browser: {
                browserId: connection.browser.browserId,
                profileDirectory: connection.browser.profileDirectory,
                pid: connection.browser.pid,
              },
            }),
          });
          let value;
          if (request.command === "task") {
            let taskError;
            try {
              value = await runMoneyHandTask({
                moneyhand,
                taskExecutionId: taskLedger.taskExecutionId,
                taskPath: request.taskPath,
                args: request.taskArgs,
                signal: context.signal,
                timeoutMs: request.taskTimeoutMs,
                abortGraceMs: request.taskAbortGraceMs,
                onProgress: send,
                onEvidence: (bundle) => taskLedger.writeEvidence(bundle),
                onFinal: (final) => { taskFinal = final; },
                onUnresponsive: () => context.stopAfterCommand(),
              });
            } catch (error) {
              taskError = error;
            }
            let bootstrapCleanup;
            try {
              bootstrapCleanup = await closeControllerBootstrapWindow(
                moneyhand,
                bootstrapWindow,
              );
            } catch (error) {
              if (!taskError) throw error;
              bootstrapCleanup = {
                ok: false,
                error: normalizedError(error, "BOOTSTRAP_WINDOW_CLEANUP_FAILED"),
              };
            }
            if (bootstrapCleanup.ok) bootstrapWindow = null;
            else {
              await send({
                type: "event",
                event: "moneyhand.bootstrap_cleanup_incomplete",
                protocol: MONEYHAND_CONTROL_PROTOCOL,
                error: bootstrapCleanup.error,
              });
            }
            if (taskError) {
              if (!bootstrapCleanup.ok && typeof taskError === "object") {
                taskError.details = {
                  ...(taskError.details ?? {}),
                  bootstrapWindowCleanup: bootstrapCleanup,
                };
              }
              throw taskError;
            }
          } else {
            let callError;
            try {
              value = await moneyhand.request({
                  method: request.callMethod,
                  params: request.callParams === undefined
                    ? {}
                    : asObject(request.callParams, "call params"),
                }, {
                  signal: context.signal,
                  connectTimeoutMs: 0,
                });
            } catch (error) {
              callError = error;
            }
            const bootstrapCleanup = await closeControllerBootstrapWindow(
              moneyhand,
              bootstrapWindow,
            );
            if (bootstrapCleanup.ok) bootstrapWindow = null;
            else {
              await send({
                type: "event",
                event: "moneyhand.bootstrap_cleanup_incomplete",
                protocol: MONEYHAND_CONTROL_PROTOCOL,
                error: bootstrapCleanup.error,
              });
            }
            if (callError) throw callError;
          }
          await send({
            type: "result",
            id: request.command,
            ok: true,
            value: value ?? null,
            ...(taskFinal === undefined ? {} : taskFinal),
            ...(request.command === "task" ? {
              relay: taskEventRelay({
                state: "completed",
                phase: "complete",
                importance: "terminal",
                notifyUser: true,
              }),
            } : {}),
          });
        } catch (error) {
          if (request.command === "connect") {
            const value = boundedConnectFailure(error, request.afterUserAction === true);
            if (value.status === "blocked") context.stopAfterCommand();
            await send({
              type: "result",
              id: "connect",
              ok: true,
              value,
            });
            return;
          }
          const taskFailure = request.command === "task"
            ? taskTerminalFailure(error, taskFinal, "controller-task-terminal")
            : undefined;
          const { failure, normalized } = controllerCommandError(taskFailure?.recovered ?? error);
          await send({
            type: "result",
            id: request.command,
            ok: false,
            error: normalized,
            ...(taskFailure?.final ?? (taskFinal === undefined ? {} : taskFinal)),
            ...(request.command === "task" ? {
              relay: taskEventRelay({
                state: "failed",
                phase: "complete",
                importance: "terminal",
                notifyUser: true,
              }),
            } : {}),
          });
          throw failure;
        }
      },
    });
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    await pingControllerService({
      sourcePath: SOURCE_PATH,
      port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
      timeoutMs: 500,
    });
    return;
  }
  let serviceError;
  service.on("error", (error) => {
    serviceError ??= error;
    service.stop().catch(() => {});
  });
  await once(service, "close");
  if (serviceError) throw serviceError;
}

function controllerRequestFromCli(cli) {
  const base = {
    connectTimeoutMs: cli.connectTimeoutMs,
    autoLaunchBrowser: cli.autoLaunchBrowser !== false,
    browserRoot: cli.browserRoot,
    profileDirectory: cli.profileDirectory,
    browserExecutable: cli.browserExecutable,
    launchGraceMs: cli.launchGraceMs,
    afterUserAction: cli.afterUserAction === true,
  };
  if (cli.connect) return { command: "connect", ...base };
  if (cli.taskPath) {
    return {
      command: "task",
      taskExecutionId: cli.taskExecutionId,
      taskPath: cli.taskPath,
      taskArgs: cli.taskArgs,
      taskTimeoutMs: resolvedTaskTimeoutMs(cli.taskTimeoutMs),
      taskAbortGraceMs: resolvedTaskAbortGraceMs(cli.taskAbortGraceMs),
      ...base,
    };
  }
  return {
    command: "call",
    callMethod: cli.callMethod,
    callParams: cli.callParams,
    ...base,
  };
}

async function runControllerCli(cli, cliOutput) {
  const output = cliOutput.stream;
  if (cli.taskPath && cli.taskExecutionId === undefined) {
    cli.taskExecutionId = createTaskExecutionId();
  }
  const resolvedOutputDrainTimeoutMs = cli.outputDrainTimeoutMs ?? numericEnvironment(
    "NPC_MONEYHAND_OUTPUT_DRAIN_TIMEOUT_MS",
    OUTPUT_DRAIN_TIMEOUT_MS,
  );
  if (cli.stopController) {
    let response;
    try {
      response = await shutdownControllerService({
        sourcePath: SOURCE_PATH,
        port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
        timeoutMs: (2 * MAX_TASK_ABORT_GRACE_MS) + DEFAULT_TASK_ABORT_GRACE_MS + 10_000,
      });
    } catch (error) {
      if (!["ECONNREFUSED", "CONTROLLER_UNAVAILABLE"].includes(error?.code)) throw error;
      response = {
        ok: true,
        messages: [{ type: "result", id: "shutdown", ok: true, value: { stopped: false } }],
      };
    }
    for (const message of response.messages) {
      await writeFatalLine(output, JSON.stringify(message));
    }
    await closeCliOutput(cliOutput, resolvedOutputDrainTimeoutMs);
    return response.ok ? undefined : response.error;
  }
  const status = await ensureCliController(cli);
  if (cli.ensure) {
    await writeFatalLine(output, JSON.stringify({
      type: "result",
      id: "ensure",
      ok: true,
      value: status,
    }));
    await closeCliOutput(cliOutput, resolvedOutputDrainTimeoutMs);
    return;
  }
  if (cli.taskPath) {
    await writeFatalLine(output, JSON.stringify({
      type: "event",
      event: "moneyhand.task_submitted",
      schema: "npc-moneyhand-task-submitted/1",
      taskExecutionId: cli.taskExecutionId,
      state: "submitted",
      message: "MoneyHand submitted the task to the built-in controller",
      relay: taskEventRelay({
        state: "submitted",
        phase: "task",
        notifyUser: true,
      }),
    }));
  }
  const controllerRequestTimeoutMs = cli.taskPath
    ? resolvedTaskTimeoutMs(cli.taskTimeoutMs)
      + (2 * resolvedTaskAbortGraceMs(cli.taskAbortGraceMs))
      + 5_000
    : MAX_TASK_TIMEOUT_MS;
  let streamedMessages = Promise.resolve();
  const monitorStartedAt = Date.now();
  let lastControllerMessageAt = monitorStartedAt;
  let lastAttachedMonitorAt = 0;
  let taskTerminalSeen = false;
  const enqueueMessage = (message) => {
    streamedMessages = streamedMessages.then(() => (
      writeFatalLine(output, JSON.stringify(message))
    ));
  };
  const attachedMonitorTimer = cli.taskPath
    ? setInterval(() => {
        if (taskTerminalSeen) return;
        const now = Date.now();
        const silenceMs = Math.max(0, now - lastControllerMessageAt);
        if (silenceMs < ATTACHED_TASK_MONITOR_INTERVAL_MS
          || now - lastAttachedMonitorAt < ATTACHED_TASK_MONITOR_INTERVAL_MS) {
          return;
        }
        lastAttachedMonitorAt = now;
        enqueueMessage({
          type: "event",
          event: "moneyhand.task_monitor",
          schema: "npc-moneyhand-task-monitor/1",
          taskExecutionId: cli.taskExecutionId,
          state: "waiting",
          phase: "attached-client",
          elapsedMs: Math.max(0, now - monitorStartedAt),
          silenceMs,
          message: "MoneyHand task command is still attached while controller progress is overdue",
          relay: taskEventRelay({
            state: "waiting",
            phase: "attached-client",
          }, now),
        });
      }, MAX_TASK_WATCHDOG_POLL_MS)
    : undefined;
  attachedMonitorTimer?.unref?.();
  let response;
  try {
    response = await requestControllerService({
      sourcePath: SOURCE_PATH,
      port: cli.controllerPort ?? DEFAULT_CONTROLLER_PORT,
      request: controllerRequestFromCli(cli),
      timeoutMs: controllerRequestTimeoutMs,
      signal: cliOutput.failure,
      onMessage(message) {
        lastControllerMessageAt = Date.now();
        if (message?.type === "result" && message.id === "task") taskTerminalSeen = true;
        enqueueMessage(message);
      },
    });
  } finally {
    clearInterval(attachedMonitorTimer);
    await streamedMessages;
  }
  if (!response.ok && response.messages.every((message) => message.ok !== false)) {
    await writeFatalLine(output, JSON.stringify({
      type: "result",
      id: cli.taskPath ? "task" : cli.callMethod ? "call" : "connect",
      ok: false,
      error: response.error,
    }));
  }
  await closeCliOutput(cliOutput, resolvedOutputDrainTimeoutMs);
  return response.ok ? undefined : response.error;
}

async function main(cliOutput) {
  const { stream: output } = cliOutput;
  const cli = parseCliOptions(HOST_PROCESS.argv.slice(2));
  if (cli.help) {
    output.write([
      "npc-moneyhand",
      "",
      "Usage:",
      "  node moneyhand.mjs [options]",
      "",
      "Fixed endpoint:",
      "  ws://127.0.0.1:19846/extension",
      "",
      "Options:",
      "  --once",
      "  --once-timeout-ms <ms>",
      "  --connect-timeout-ms <ms>",
      "  --request-timeout-ms <ms>",
      "  --heartbeat-ms <ms>",
      "  --handshake-timeout-ms <ms>",
      "  --max-inflight <1-256>",
      "  --output-drain-timeout-ms <ms>",
      "  --ensure  Ensure the built-in local controller is running",
      "  --stop  Gracefully stop only the built-in local controller",
      "  --connect  Connect and return one bounded npc-moneyhand-connect/1 result",
      "  --after-user-action  Allow the single user-confirmed connection retry",
      "  --call <extension-method>",
      "  --params-json <json>",
      "  --task <absolute-module.mjs>",
      "  --task-timeout-ms <10-86400000>",
      "  --args-json <json>",
      "  --task-last  Read the latest private task execution status",
      "  --task-status <task-execution-id>",
      "  --task-follow <task-execution-id>",
      "  --browser-root <absolute-user-data-root>",
      "  --profile-directory <name>",
      "  --browser-executable <absolute-path>",
      "  --launch-grace-ms <ms>",
      "  --no-browser-launch",
      "  --describe  Print one offline npc-agent-cli-descriptor/1 JSON line",
      "  --version",
      "",
    ].join("\n"));
    await closeCliOutput(cliOutput);
    return;
  }
  if (cli.describe) {
    await writeFatalLine(output, JSON.stringify(await describeMoneyHand()));
    await closeCliOutput(cliOutput);
    return;
  }
  if (cli.version) {
    output.write(`${MONEYHAND_CONTROL_PROTOCOL}\n`);
    await closeCliOutput(cliOutput);
    return;
  }
  if (cli.taskLast || cli.taskStatus || cli.taskFollow) {
    return await runTaskLedgerCli(cli, cliOutput);
  }
  const controllerMode = cli.ensure
    || cli.stopController
    || ((cli.connect || cli.taskPath || cli.callMethod)
      && (cli.port === undefined || cli.controllerPort !== undefined));
  if (controllerMode) return await runControllerCli(cli, cliOutput);
  const controller = new AbortController();
  const stopForSignal = () => controller.abort();
  const stopForOutputFailure = () => controller.abort(cliOutput.failure.reason);
  const gracefulSignals = RUNTIME_PLATFORM === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of gracefulSignals) HOST_PROCESS.once(name, stopForSignal);
  if (cliOutput.failure.aborted) stopForOutputFailure();
  else cliOutput.failure.addEventListener("abort", stopForOutputFailure, { once: true });
  if (controller.signal.aborted) {
    HOST_PROCESS.stdin.destroy();
    cliOutput.failure.removeEventListener("abort", stopForOutputFailure);
    for (const name of gracefulSignals) HOST_PROCESS.off(name, stopForSignal);
    await closeCliOutput(cliOutput);
    return;
  }
  const {
    once,
    onceTimeoutMs,
    outputDrainTimeoutMs,
    taskPath,
    taskArgs,
    taskTimeoutMs,
    taskAbortGraceMs,
    callMethod,
    callParams,
    connect,
    afterUserAction = false,
    autoLaunchBrowser = true,
    browserRoot,
    profileDirectory,
    browserExecutable,
    launchGraceMs,
    help: _help,
    version: _version,
    ...moneyhandCli
  } = cli;
  const moneyhand = createMoneyHand(cliMoneyHandOptions(moneyhandCli));
  const onAbort = () => HOST_PROCESS.stdin.pause();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const resolvedOutputDrainTimeoutMs = outputDrainTimeoutMs ?? numericEnvironment(
    "NPC_MONEYHAND_OUTPUT_DRAIN_TIMEOUT_MS",
    OUTPUT_DRAIN_TIMEOUT_MS,
  );
  if (taskPath || callMethod || connect) {
    let taskError;
    let directTaskFinal;
    try {
      try {
        const endpoint = await moneyhand.start();
        if (!connect) {
          await writeFatalLine(output, JSON.stringify({
            type: "event",
            event: "moneyhand.listening",
            protocol: MONEYHAND_CONTROL_PROTOCOL,
            endpoint,
            pid: HOST_PROCESS?.pid ?? null,
            capabilities: moneyhand.capabilities(),
          }));
        }
        const connectTimeoutMs = moneyhandCli.connectTimeoutMs
          ?? numericEnvironment("NPC_MONEYHAND_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
        const connection = autoLaunchBrowser
          ? await ensureMoneyHandConnection({
              moneyhand,
              timeoutMs: connectTimeoutMs,
              graceMs: boundedInteger(
                launchGraceMs,
                0,
                60_000,
                1_000,
                "launchGraceMs",
              ),
              signal: controller.signal,
              browserRoot,
              profileDirectory,
              browserExecutable,
            })
          : {
              session: await moneyhand.wait({
                timeoutMs: connectTimeoutMs,
                signal: controller.signal,
              }),
              launched: false,
              browser: null,
            };
        if (connect) {
          let acceptance;
          if (cli.port !== undefined) {
            acceptance = skippedConnectAcceptance();
          } else {
            try {
              acceptance = connectAcceptanceResult(await runConnectAcceptanceFlow({
                moneyhand,
                signal: controller.signal,
                onProgress: async (event) => {
                  await writeFatalLine(output, JSON.stringify(event));
                },
              }));
            } catch (error) {
              acceptance = failedConnectAcceptance(error);
            }
          }
          await writeFatalLine(output, JSON.stringify({
            type: "result",
            id: "connect",
            ok: true,
            value: acceptedConnectResult(acceptance),
          }));
        } else {
          await writeFatalLine(output, JSON.stringify({
            type: "event",
            event: "moneyhand.connected",
            protocol: MONEYHAND_CONTROL_PROTOCOL,
            session: connection.session,
            launchedBrowser: connection.launched,
            ...(connection.browser === null ? {} : {
              browser: {
                browserId: connection.browser.browserId,
                profileDirectory: connection.browser.profileDirectory,
                pid: connection.browser.pid,
              },
            }),
          }));
          const value = taskPath
            ? await runMoneyHandTask({
                moneyhand,
                taskPath,
                args: taskArgs,
                signal: controller.signal,
                timeoutMs: resolvedTaskTimeoutMs(taskTimeoutMs),
                abortGraceMs: resolvedTaskAbortGraceMs(taskAbortGraceMs),
                onProgress: async (event) => {
                  await writeFatalLine(output, JSON.stringify(event));
                },
                onFinal: (final) => { directTaskFinal = final; },
              })
            : await moneyhand.request({
                method: callMethod,
                params: callParams === undefined ? {} : asObject(callParams, "call params"),
              }, {
                signal: controller.signal,
                connectTimeoutMs: 0,
              });
          await writeFatalLine(output, JSON.stringify({
            type: "result",
            id: taskPath ? "task" : "call",
            ok: true,
            value: value ?? null,
            ...(directTaskFinal === undefined ? {} : directTaskFinal),
            ...(taskPath ? {
              relay: taskEventRelay({
                state: "completed",
                phase: "complete",
                importance: "terminal",
                notifyUser: true,
              }),
            } : {}),
          }));
        }
      } catch (error) {
        if (connect) {
          await writeFatalLine(output, JSON.stringify({
            type: "result",
            id: "connect",
            ok: true,
            value: boundedConnectFailure(error, afterUserAction),
          }));
        } else {
          const taskFailure = taskPath
            ? taskTerminalFailure(error, directTaskFinal, "direct-task-terminal")
            : undefined;
          taskError = taskFailure?.normalized ?? normalizedError(error, "MONEYHAND_TASK_FAILED");
          await writeFatalLine(output, JSON.stringify({
            type: "result",
            id: taskPath ? "task" : "call",
            ok: false,
            error: taskError,
            ...(taskFailure?.final ?? (directTaskFinal === undefined ? {} : directTaskFinal)),
            ...(taskPath ? {
              relay: taskEventRelay({
                state: "failed",
                phase: "complete",
                importance: "terminal",
                notifyUser: true,
              }),
            } : {}),
          }));
        }
      }
    } finally {
      await moneyhand.stop({ graceMs: 0 }).catch(() => {});
      await writeFatalLine(output, JSON.stringify({
        type: "event",
        event: "moneyhand.stopped",
        protocol: MONEYHAND_CONTROL_PROTOCOL,
      })).catch(() => {});
      controller.signal.removeEventListener("abort", onAbort);
      cliOutput.failure.removeEventListener("abort", stopForOutputFailure);
      for (const name of gracefulSignals) HOST_PROCESS.off(name, stopForSignal);
      HOST_PROCESS.stdin.destroy();
    }
    await closeCliOutput(cliOutput, resolvedOutputDrainTimeoutMs);
    return taskError;
  }
  try {
    await runJsonlMoneyHand({
      moneyhand,
      output,
      signal: controller.signal,
      once,
      onceTimeoutMs: onceTimeoutMs ?? numericEnvironment(
        "NPC_MONEYHAND_ONCE_TIMEOUT_MS",
        DEFAULT_ONCE_TIMEOUT_MS,
      ),
      outputDrainTimeoutMs: resolvedOutputDrainTimeoutMs,
    });
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    cliOutput.failure.removeEventListener("abort", stopForOutputFailure);
    for (const name of gracefulSignals) HOST_PROCESS.off(name, stopForSignal);
    HOST_PROCESS.stdin.destroy();
  }
  await closeCliOutput(cliOutput, resolvedOutputDrainTimeoutMs);
}

function isMainModule() {
  if (!HOST_PROCESS?.argv?.[1]) return false;
  try {
    return realpathSync(HOST_PROCESS.argv[1]) === SOURCE_PATH;
  } catch {
    return false;
  }
}

async function writeFatalLine(output, line) {
  if (output.destroyed || output.writable === false) {
    throw new MoneyHandError("OUTPUT_CLOSED", "JSONL output is already closed");
  }
  if (output.write(`${line}\n`, "utf8")) return;
  let timer;
  try {
    await Promise.race([
      once(output, "drain"),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise("timeout"), OUTPUT_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (output.writableNeedDrain) output.destroy();
}

async function closeOutputBounded(output, timeoutMs = OUTPUT_DRAIN_TIMEOUT_MS) {
  if (output.destroyed) return output.writableFinished === true;
  let timer;
  let onError;
  try {
    return await new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value, destroy = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        output.off("error", onError);
        if (destroy && !output.destroyed) output.destroy();
        resolvePromise(value);
      };
      onError = () => finish(false, true);
      output.once("error", onError);
      timer = setTimeout(() => finish(false, true), timeoutMs);
      output.end(() => finish(true));
    });
  } catch {
    if (!output.destroyed) output.destroy();
    return false;
  } finally {
    clearTimeout(timer);
    if (onError) output.off("error", onError);
  }
}

function outputWorkerEnvironment() {
  const env = { [OUTPUT_WORKER_ENV]: "1" };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (HOST_PROCESS.env[name] !== undefined) env[name] = HOST_PROCESS.env[name];
  }
  return env;
}

function createCliOutput() {
  const failure = new AbortController();
  if (RUNTIME_PLATFORM !== "win32") {
    const stream = HOST_PROCESS.stdout;
    const cliOutput = {
      stream,
      worker: undefined,
      failure: failure.signal,
      closing: false,
    };
    stream.on("error", (error) => {
      if (!cliOutput.closing) failure.abort(error);
    });
    stream.on("close", () => {
      if (!cliOutput.closing) {
        failure.abort(new MoneyHandError(
          "OUTPUT_CLOSED",
          "JSONL output closed unexpectedly",
        ));
      }
    });
    return cliOutput;
  }
  const worker = spawn(HOST_PROCESS.execPath, [SOURCE_PATH, OUTPUT_WORKER_FLAG], {
    env: outputWorkerEnvironment(),
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const cliOutput = {
    stream: worker.stdin,
    worker,
    failure: failure.signal,
    closing: false,
  };
  const fail = (error) => {
    if (!cliOutput.closing) failure.abort(
      error instanceof Error
        ? error
        : new MoneyHandError("OUTPUT_WORKER_FAILED", "JSONL output worker failed"),
    );
  };
  worker.on("error", fail);
  worker.on("close", (code, signal) => {
    fail(new MoneyHandError(
      "OUTPUT_WORKER_FAILED",
      `JSONL output worker exited with code ${code ?? "null"}`
        + ` and signal ${signal ?? "null"}`,
    ));
  });
  worker.stdin.on("error", fail);
  worker.stdin.on("close", () => fail(
    new MoneyHandError("OUTPUT_CLOSED", "JSONL output worker input closed"),
  ));
  return cliOutput;
}

async function waitForWorker(worker, timeoutMs) {
  if (worker.exitCode !== null || worker.signalCode !== null) return true;
  let timer;
  try {
    return await Promise.race([
      once(worker, "close").then(() => true, () => false),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeCliOutput(cliOutput, timeoutMs = OUTPUT_DRAIN_TIMEOUT_MS) {
  cliOutput.closing = true;
  const streamClosed = await closeOutputBounded(cliOutput.stream, timeoutMs);
  const { worker } = cliOutput;
  if (!worker) {
    if (!streamClosed) {
      throw new MoneyHandError(
        "OUTPUT_BACKPRESSURE_TIMEOUT",
        `JSONL output did not close within ${timeoutMs}ms`,
      );
    }
    return;
  }
  if (streamClosed && await waitForWorker(worker, timeoutMs)) {
    if (worker.exitCode === 0 && worker.signalCode === null) return;
    throw new MoneyHandError(
      "OUTPUT_WORKER_FAILED",
      `JSONL output worker exited with code ${worker.exitCode ?? "null"}`
        + ` and signal ${worker.signalCode ?? "null"}`,
    );
  }
  worker.kill();
  await waitForWorker(worker, OUTPUT_DRAIN_TIMEOUT_MS);
  throw new MoneyHandError(
    "OUTPUT_BACKPRESSURE_TIMEOUT",
    `JSONL output worker did not close within ${timeoutMs}ms`,
  );
}

function runOutputWorker() {
  const fail = () => HOST_PROCESS.exit(1);
  HOST_PROCESS.stdin.on("error", fail);
  HOST_PROCESS.stdout.on("error", fail);
  HOST_PROCESS.stdin.pipe(HOST_PROCESS.stdout);
}

const isOutputWorker = HOST_PROCESS?.env?.[OUTPUT_WORKER_ENV] === "1"
  && HOST_PROCESS.argv?.length === 3
  && HOST_PROCESS.argv[2] === OUTPUT_WORKER_FLAG;

const isControllerService = HOST_PROCESS?.argv?.includes(CONTROLLER_SERVICE_FLAG) === true;

export function runMoneyHandCli() {
  const cliOutput = createCliOutput();
  return main(cliOutput).then(
    (failure) => HOST_PROCESS.exit(failure ? 1 : 0),
    async (error) => {
      HOST_PROCESS.stdin.destroy();
      const fatalError = normalizedError(error, "MONEYHAND_FATAL");
      const line = JSON.stringify({
        type: "fatal",
        ok: false,
        error: fatalError,
      });
      try {
        await writeFatalLine(cliOutput.stream, line);
      } catch {
        if (RUNTIME_PLATFORM !== "win32" || HOST_PROCESS.stderr.isTTY) {
          HOST_PROCESS.stderr.write(`npc-moneyhand fatal: ${fatalError.message}\n`);
        }
      } finally {
        await closeCliOutput(cliOutput).catch(() => {});
      }
      HOST_PROCESS.exit(1);
    },
  );
}

if (isOutputWorker) {
  runOutputWorker();
} else if (isControllerService) {
  runControllerServiceProcess(parseCliOptions(HOST_PROCESS.argv.slice(2))).then(
    () => HOST_PROCESS.exit(0),
    () => HOST_PROCESS.exit(1),
  );
} else if (isMainModule()) {
  runMoneyHandCli();
}
