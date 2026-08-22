export const TASK_RECOVERY_SCHEMA = "npc-moneyhand-task-recovery/1";

const SAFE_RETRY_CODES = new Set([
  "BUSY",
  "NAVIGATION_PREFLIGHT_FAILED",
  "PAGE_TRANSITION_BUSY",
  "TASK_PAGE_UNHEALTHY",
  "TASK_TAB_UNHEALTHY",
]);
const REFRESH_TARGET_CODES = new Set([
  "SEMANTIC_FRAME_OCCLUDED",
  "SEMANTIC_LOCATOR_AMBIGUOUS",
  "SEMANTIC_LOCATOR_NOT_READY",
  "STALE_SEMANTIC_REF",
  "STALE_SEMANTIC_SNAPSHOT",
  "STALE_VIEWPORT",
]);
const SESSION_TERMINAL_CODES = new Set([
  "CONNECTION_LOST",
  "NOT_CONNECTED",
  "SESSION_REPLACED",
  "TASK_SESSION_UNHEALTHY",
]);
const WAITING_CODES = new Set(["TAB_WAITING", "TASK_NEEDS_INSTRUCTION"]);

function recoveryCategory(code) {
  if (WAITING_CODES.has(code)) return "waiting-for-instruction";
  if (code === "OUTCOME_UNKNOWN" || code.includes("OUTCOME_UNKNOWN")) return "outcome-unknown";
  if (SESSION_TERMINAL_CODES.has(code)) return "connection";
  if (REFRESH_TARGET_CODES.has(code) || code.includes("OCCLUDED")) return "target-state";
  if (code === "RATE_CONTROL_CIRCUIT_OPEN" || /(?:RATE|THROTTL|HTTP_(?:403|429|503))/u.test(code)) {
    return "rate-control";
  }
  if (code === "TASK_COMPLETION_GATE_FAILED") return "completion-gate";
  if (code.includes("TIMEOUT") || code.includes("WAIT_TIMEOUT")) return "timeout";
  if (code.includes("CLEANUP")) return "cleanup";
  if (code.startsWith("TASK_EVALUATION_")) return "page-script";
  if (code.startsWith("INVALID_") || code.endsWith("_REQUIRED")) return "invalid-request";
  return "operation";
}

function rootCause(error, code) {
  const cause = error?.details?.cause;
  return {
    code: typeof cause?.code === "string"
      ? cause.code
      : typeof error?.details?.causeCode === "string" ? error.details.causeCode : code,
    message: String(cause?.message ?? error?.message ?? code).slice(0, 2_048),
  };
}

function visualFallbackSummary(value) {
  if (!value || typeof value !== "object") return null;
  return {
    captured: value.captured === true,
    path: typeof value.screenshot?.path === "string" ? value.screenshot.path : null,
    waitingForInstruction: value.waitingForInstruction === true,
  };
}

function dispatchState(error) {
  if (error?.details?.actionDispatched === true) return true;
  if (error?.details?.actionDispatched === false) return false;
  if (error?.code === "OUTCOME_UNKNOWN" || error?.code?.includes?.("OUTCOME_UNKNOWN")) return "unknown";
  return "unknown";
}

export function planTaskRecovery(input = {}) {
  const code = typeof input.error?.code === "string" ? input.error.code : "TASK_OPERATION_FAILED";
  const actionDispatched = dispatchState(input.error);
  const attempt = Number.isSafeInteger(input.attempt) ? input.attempt : 1;
  const base = {
    schema: TASK_RECOVERY_SCHEMA,
    operation: String(input.operation ?? "page-operation").slice(0, 128),
    code,
    attempt,
    maximumAttempts: 2,
    actionDispatched,
    category: recoveryCategory(code),
    rootCause: rootCause(input.error, code),
    retryAllowed: false,
    retryAtMs: Number.isFinite(input.error?.details?.retryAtMs)
      ? Math.max(0, input.error.details.retryAtMs)
      : null,
    waitingForInstruction: WAITING_CODES.has(code)
      || typeof input.error?.details?.waitId === "string",
    visualFallback: visualFallbackSummary(input.error?.details?.visualFallback),
    visualRequired: input.hasTaskPage !== false,
    replayAllowed: false,
    state: "inspect",
    nextAction: "inspect-current-page-then-decide",
  };
  if (base.waitingForInstruction) {
    return {
      ...base,
      state: "needs_instruction",
      nextAction: "resolve-task-blocker",
    };
  }
  if (base.category === "completion-gate") {
    return {
      ...base,
      state: "blocked",
      nextAction: "inspect-completion-gate",
    };
  }
  if (base.category === "rate-control") {
    return {
      ...base,
      state: "blocked",
      nextAction: base.retryAtMs === null
        ? "preserve-checkpoint-and-wait-for-instruction"
        : "wait-until-retry-at",
    };
  }
  if (base.category === "page-script") {
    return {
      ...base,
      state: "inspect",
      nextAction: "inspect-current-page-and-fix-expression",
    };
  }
  if (SESSION_TERMINAL_CODES.has(code)) {
    return {
      ...base,
      state: "terminal",
      visualRequired: false,
      nextAction: actionDispatched === false
        ? "end-task-and-run-fixed-connect-flow-once"
        : "preserve-state-end-task-and-run-fixed-connect-flow-once",
    };
  }
  if (actionDispatched === true || actionDispatched === "unknown") {
    return {
      ...base,
      state: "outcome_unknown",
      nextAction: "inspect-current-state-never-replay-blindly",
    };
  }
  if (REFRESH_TARGET_CODES.has(code)) {
    return {
      ...base,
      state: "refresh_target",
      nextAction: "inspect-then-acquire-fresh-target",
    };
  }
  if (SAFE_RETRY_CODES.has(code) && attempt === 1) {
    return {
      ...base,
      state: "probe",
      replayAllowed: true,
      retryAllowed: true,
      nextAction: "probe-same-task-page-then-retry-once",
    };
  }
  return base;
}

export function attachRecovery(error, recovery) {
  if (!error || typeof error !== "object") {
    const wrapped = new Error(String(error));
    wrapped.code = "TASK_OPERATION_FAILED";
    wrapped.details = { recovery };
    return wrapped;
  }
  const details = error.details && typeof error.details === "object" ? error.details : {};
  error.details = {
    ...details,
    recovery: {
      ...recovery,
      waitingForInstruction: recovery.waitingForInstruction === true
        || typeof details.waitId === "string"
        || details.visualFallback?.waitingForInstruction === true,
      visualFallback: visualFallbackSummary(details.visualFallback)
        ?? recovery.visualFallback
        ?? null,
    },
  };
  return error;
}

export function ensureTaskRecovery(error, input = {}) {
  const existing = error?.details?.recovery;
  return attachRecovery(error, existing && typeof existing === "object"
    ? existing
    : planTaskRecovery({ ...input, error }));
}
