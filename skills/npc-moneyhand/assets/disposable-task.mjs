// Copy this file to a task-owned temporary path and replace the bounded placeholder below.
// MoneyHand rejects this sentinel at runtime, including in an unchanged copy.
export const MONEYHAND_TASK_TEMPLATE = "replace-before-running";

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
  let lifecycle;
  try {
    await progress({ phase: "start", message: "Task context is ready" });
    // Replace this bounded placeholder with task-specific logic. Prefer:
    // navigateTaskTab, semantic actions, scrollTaskTab and captureStableViewport.
    // In this task runner, captureSemanticSnapshot needs tabId but no selector;
    // selector is a browser-session object, never CSS. Type uses text; select uses options.
    // navigateTaskTab/navigateSemanticRef inject effect "navigation" and scrollTaskTab
    // injects effect "input"; provide a stable effectId but do not guess those effects.
    // Give each replay-sensitive call a stable effectId such as
    // `collect:${canonicalItemId}:open`; never derive it from a loop attempt number.
    outcome = {
      status: "incomplete",
      reason: "TASK_LOGIC_NOT_IMPLEMENTED",
      requirements: [{ id: "task-logic-implemented", satisfied: false }],
      evidence: [],
    };
  } catch (error) {
    const normalized = taskError(error);
    const visualFallback = error?.details?.visualFallback;
    outcome = {
      status: normalized.code.includes("OUTCOME_UNKNOWN")
        ? "outcome_unknown"
        : "incomplete",
      reason: normalized.code,
      error: normalized,
      requirements: [{ id: "task-finished-with-proof", satisfied: false }],
      evidence: visualFallback?.captured
        ? [{ type: "visual-fallback", path: visualFallback.screenshot.path }]
        : [],
      ...(visualFallback === undefined ? {} : { visualFallback }),
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
    args,
    task: { page: task.page, behavior: task.behavior },
    outcome,
    lifecycle,
  };
}
