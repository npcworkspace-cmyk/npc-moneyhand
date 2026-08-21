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
    visualRequired: input.hasTaskPage !== false,
    replayAllowed: false,
    state: "inspect",
    nextAction: "inspect-current-page-then-decide",
  };
  if (actionDispatched === true || actionDispatched === "unknown") {
    return {
      ...base,
      state: "outcome_unknown",
      nextAction: "inspect-current-state-never-replay-blindly",
    };
  }
  if (SESSION_TERMINAL_CODES.has(code)) {
    return {
      ...base,
      state: "terminal",
      visualRequired: false,
      nextAction: "end-task-and-run-fixed-connect-flow-once",
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
  error.details = {
    ...(error.details && typeof error.details === "object" ? error.details : {}),
    recovery,
  };
  return error;
}
