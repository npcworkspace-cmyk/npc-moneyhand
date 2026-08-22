import { createHash } from "node:crypto";

// Copy this file into the specialized Skill. Remove the sentinel and replace only
// executeTask(); keep run() and its lifecycle unchanged.
// MoneyHand rejects this sentinel at runtime, including in an unchanged copy.
export const MONEYHAND_TASK_TEMPLATE = "replace-before-running";

export function stableEffectId(prefix, key) {
  const safePrefix = String(prefix ?? "effect")
    .replace(/[^A-Za-z0-9._:-]/gu, "_")
    .slice(0, 32) || "effect";
  const stableKey = String(key ?? "");
  if (!stableKey) {
    const error = new Error("stableEffectId() requires a non-empty canonical key");
    error.code = "INVALID_EFFECT_KEY";
    throw error;
  }
  const digest = createHash("sha256").update(stableKey).digest("hex").slice(0, 24);
  return `${safePrefix}:${digest}`;
}

export function pageExpression(pageFunction, input) {
  if (typeof pageFunction !== "function") {
    const error = new Error("pageExpression() requires an arrow or function expression");
    error.code = "INVALID_PAGE_EXPRESSION";
    throw error;
  }
  let encodedInput;
  try {
    encodedInput = JSON.stringify(input);
  } catch (cause) {
    const error = new Error("pageExpression() input must be JSON-serializable", { cause });
    error.code = "INVALID_PAGE_EXPRESSION_INPUT";
    throw error;
  }
  if (encodedInput === undefined) encodedInput = "null";
  return `(${Function.prototype.toString.call(pageFunction)})(${encodedInput})`;
}

export function recordGroupOrderRequirement(records, expectedPageKeys, key = "pageKey") {
  if (!Array.isArray(records) || !Array.isArray(expectedPageKeys) || expectedPageKeys.length < 1) {
    const error = new Error("recordGroupOrderRequirement() requires records and expected page keys");
    error.code = "INVALID_RECORD_GROUP_ORDER_INPUT";
    throw error;
  }
  const expected = expectedPageKeys.map((value) => String(value));
  const actual = [];
  for (const record of records) {
    const value = record && typeof record === "object" && !Array.isArray(record)
      ? String(record[key] ?? "")
      : "";
    if (!value) {
      const error = new Error(`Every record needs a non-empty '${key}' value`);
      error.code = "INVALID_RECORD_GROUP_ORDER_INPUT";
      throw error;
    }
    if (actual.at(-1) !== value) actual.push(value);
  }
  return {
    id: "record-page-order",
    satisfied: actual.length === expected.length
      && actual.every((value, index) => value === expected[index]),
    expected: expected.join("\n"),
    actual: actual.join("\n"),
  };
}

function taskError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "TASK_FAILED",
    message: String(error?.message ?? error).slice(0, 4_096),
  };
}

async function attachTerminalVisual(moneyhand, task, outcome) {
  if (outcome?.status === "complete" || outcome?.visualFallback?.captured === true) return outcome;
  try {
    const visualFallback = await moneyhand.inspectTaskBlocker({
      taskSpaceId: task.taskSpaceId,
      operation: "task-terminal",
      reason: {
        code: outcome?.error?.code ?? outcome?.reason ?? "TASK_INCOMPLETE",
        message: outcome?.error?.message ?? "Task did not reach a complete outcome",
        retry: "inspect-current-page-before-next-action",
      },
    });
    const evidence = Array.isArray(outcome?.evidence) ? [...outcome.evidence] : [];
    if (visualFallback.captured && !evidence.some((entry) => (
      entry?.type === "visual-fallback" && entry.path === visualFallback.screenshot?.path
    ))) {
      evidence.push({ type: "visual-fallback", path: visualFallback.screenshot.path });
    }
    return { ...outcome, visualFallback, evidence };
  } catch (error) {
    if (outcome?.visualFallback) return outcome;
    return {
      ...outcome,
      visualFallback: {
        captured: false,
        screenshot: { captured: false, error: taskError(error) },
        actionReplayed: false,
      },
    };
  }
}

async function executeTask({
  moneyhand,
  task,
  signal,
  args,
  progress,
  stableEffectId,
  pageExpression,
  recordGroupOrderRequirement,
}) {
  // Replace only this function body with the specialized Skill's bounded domain workflow.
  // Persist bulk domain data in the specialized Skill and return a small output manifest.
  void moneyhand;
  void task;
  void signal;
  void args;
  void progress;
  void stableEffectId;
  void pageExpression;
  void recordGroupOrderRequirement;
  return {
    outcome: {
      status: "incomplete",
      reason: "SPECIALIZED_WORKFLOW_NOT_IMPLEMENTED",
      counts: {},
      requirements: [{ id: "specialized-workflow-implemented", satisfied: false }],
      evidence: [],
      checkpoint: null,
    },
    output: null,
  };
}

function taskResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.outcome || typeof value.outcome !== "object" || Array.isArray(value.outcome)) {
    const error = new Error("executeTask() must return { outcome, output? }");
    error.code = "TASK_RESULT_CONTRACT_INVALID";
    throw error;
  }
  return { outcome: value.outcome, output: value.output ?? null };
}

export async function run({ moneyhand, signal, args = {}, progress, taskExecutionId }) {
  const task = await moneyhand.beginTaskContext({
    ...(args.taskId ? { id: args.taskId } : {}),
    behavior: args.behavior === "human" ? "human" : "raw",
    ...(args.behavior === "human" && args.behaviorOptions
      ? { behaviorOptions: args.behaviorOptions }
      : {}),
    signal,
  });
  let outcome;
  let output = null;
  let lifecycle;
  try {
    await progress({ phase: "start", message: "Specialized task context is ready" });
    ({ outcome, output } = taskResult(await executeTask({
      moneyhand,
      task,
      signal,
      args,
      progress,
      stableEffectId,
      pageExpression,
      recordGroupOrderRequirement,
    })));
  } catch (error) {
    const normalized = taskError(error);
    const visualFallback = error?.details?.visualFallback;
    outcome = {
      status: normalized.code.includes("OUTCOME_UNKNOWN")
        ? "outcome_unknown"
        : "incomplete",
      reason: normalized.code,
      error: normalized,
      counts: {},
      requirements: [{ id: "specialized-workflow-finished-with-proof", satisfied: false }],
      evidence: visualFallback?.captured
        ? [{ type: "visual-fallback", path: visualFallback.screenshot.path }]
        : [],
      ...(visualFallback === undefined ? {} : { visualFallback }),
      checkpoint: null,
    };
  } finally {
    outcome = await attachTerminalVisual(moneyhand, task, outcome);
    lifecycle = await moneyhand.completeTaskContext({
      taskSpaceId: task.taskSpaceId,
      keep: false,
      resetBehavior: true,
    });
  }
  if (!lifecycle.cleanupComplete && outcome.status === "complete") {
    outcome = { ...outcome, status: "incomplete", reason: "TASK_CLEANUP_INCOMPLETE" };
  }
  return {
    taskExecutionId,
    task: { page: task.page, behavior: task.behavior },
    outcome,
    output,
    lifecycle,
  };
}
