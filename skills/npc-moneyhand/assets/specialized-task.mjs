// Copy this file into the specialized Skill and replace its bounded workflow placeholder.
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
    await progress({ phase: "start", message: "Specialized task context is ready" });
    // Replace only this outcome with the specialized Skill's bounded domain workflow.
    // Reuse moneyhand and task; never start or stop another controller here. Call
    // progress({phase,message,current,total,checkpoint}) after every bounded batch.
    // captureSemanticSnapshot needs tabId but no selector in this task runner;
    // selector is a browser-session object, never CSS. Type uses text; select uses options.
    // Navigation helpers inject effect "navigation" and scrollTaskTab injects "input";
    // provide stable effectId values but do not override those fixed effects.
    // Use stable effectId values for replay-sensitive calls and return explicit
    // {id,satisfied,expected,actual} requirements before claiming complete.
    outcome = {
      status: "incomplete",
      reason: "SPECIALIZED_WORKFLOW_NOT_IMPLEMENTED",
      counts: {},
      requirements: [{ id: "specialized-workflow-implemented", satisfied: false }],
      evidence: [],
      checkpoint: null,
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
    lifecycle,
  };
}
