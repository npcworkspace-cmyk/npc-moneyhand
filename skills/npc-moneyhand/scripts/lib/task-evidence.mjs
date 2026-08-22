export const TASK_EVIDENCE_SCHEMA = "npc-moneyhand-task-evidence/1";
export const TASK_COMPLETION_GATE_SCHEMA = "npc-moneyhand-task-completion-gate/1";

const MAX_ENTRIES = 2_048;
const COMPLETE_STATES = new Set(["complete", "completed", "success", "succeeded"]);
const UNRESOLVED_EFFECT_STATES = new Set(["pending", "outcome_unknown"]);

function boundedPush(values, value) {
  if (values.length < MAX_ENTRIES) values.push(value);
}

function terminalValue(value) {
  return value?.outcome && typeof value.outcome === "object" ? value.outcome : value;
}

function taskStatus(value) {
  const status = terminalValue(value)?.status;
  return typeof status === "string" ? status : null;
}

function declaredRequirements(value) {
  const requirements = terminalValue(value)?.requirements;
  if (!Array.isArray(requirements) || requirements.length < 1 || requirements.length > 256) {
    return { valid: false, entries: [] };
  }
  const entries = [];
  for (const entry of requirements) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.id !== "string" || entry.id.length < 1 || entry.id.length > 128
      || typeof entry.satisfied !== "boolean") {
      return { valid: false, entries: [] };
    }
    entries.push({
      id: entry.id,
      satisfied: entry.satisfied,
      ...(entry.expected === undefined ? {} : { expected: entry.expected }),
      ...(entry.actual === undefined ? {} : { actual: entry.actual }),
      evidenceCount: Array.isArray(entry.evidence) ? entry.evidence.length : 0,
    });
  }
  return { valid: true, entries };
}

function bulkOutputEvidence(value, evidence) {
  const output = value?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)
    || !Object.hasOwn(output, "path") || !Object.hasOwn(output, "count")) {
    return {
      passed: true,
      detail: "not applicable because no path-and-count bulk output was declared",
    };
  }
  if (typeof output.path !== "string" || output.path.length < 1
    || !Number.isSafeInteger(output.count) || output.count < 0) {
    return { passed: false, detail: "bulk output path/count contract is invalid" };
  }
  const matches = (evidence?.taskProvidedEvidence ?? []).filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
    && entry.type === "output-file" && entry.path === output.path
  ));
  const exact = matches.some((entry) => (
    entry.count === output.count
    && (output.format === undefined || entry.format === output.format)
  ));
  return {
    passed: exact,
    detail: exact
      ? "bulk output path, format, and count match task evidence"
      : matches.length > 0
        ? "bulk output evidence count or format does not match the output manifest"
        : "bulk output has no matching output-file evidence",
  };
}

export class TaskEvidenceCollector {
  constructor(options = {}) {
    this.taskExecutionId = options.taskExecutionId ?? null;
    this.startedAtMs = options.startedAtMs ?? Date.now();
    this.progress = [];
    this.checkpoints = [];
    this.visuals = [];
    this.effects = [];
    this.recoveries = [];
    this.rateControl = [];
  }

  recordProgress(event) {
    boundedPush(this.progress, {
      sequence: event.sequence,
      state: event.state,
      phase: event.phase,
      elapsedMs: event.elapsedMs,
      message: event.message,
      ...(event.current === undefined ? {} : { current: event.current }),
      ...(event.total === undefined ? {} : { total: event.total }),
      ...(event.checkpoint === undefined ? {} : { checkpoint: event.checkpoint }),
    });
    if (event.checkpoint !== undefined) {
      boundedPush(this.checkpoints, {
        sequence: event.sequence,
        checkpoint: event.checkpoint,
        atElapsedMs: event.elapsedMs,
      });
    }
    if (event.visualFallback !== undefined) this.recordVisual(event.visualFallback, event);
  }

  recordVisual(visual, event = {}) {
    boundedPush(this.visuals, {
      captured: visual?.captured === true,
      path: visual?.screenshot?.path ?? null,
      trigger: visual?.trigger ?? null,
      waitingForInstruction: visual?.waitingForInstruction === true,
      phase: event.phase ?? null,
      elapsedMs: event.elapsedMs ?? null,
    });
  }

  recordEffect(receipt) {
    boundedPush(this.effects, { ...receipt });
  }

  recordRecovery(recovery) {
    boundedPush(this.recoveries, { ...recovery });
  }

  recordRate(event) {
    boundedPush(this.rateControl, { ...event });
  }

  build({ value, cleanup, finishedAtMs = Date.now(), artifact } = {}) {
    const taskProvidedEvidence = Array.isArray(terminalValue(value)?.evidence)
      ? terminalValue(value).evidence.slice(0, MAX_ENTRIES)
      : [];
    return {
      schema: TASK_EVIDENCE_SCHEMA,
      taskExecutionId: this.taskExecutionId,
      timing: {
        startedAt: new Date(this.startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        elapsedMs: Math.max(0, finishedAtMs - this.startedAtMs),
      },
      claimedStatus: taskStatus(value),
      counts: {
        progress: this.progress.length,
        checkpoints: this.checkpoints.length,
        visuals: this.visuals.length,
        effects: this.effects.length,
        recoveries: this.recoveries.length,
        rateControl: this.rateControl.length,
        taskProvidedEvidence: taskProvidedEvidence.length,
      },
      progress: [...this.progress],
      checkpoints: [...this.checkpoints],
      visuals: [...this.visuals],
      effects: [...this.effects],
      recoveries: [...this.recoveries],
      rateControl: [...this.rateControl],
      taskProvidedEvidence,
      cleanup: cleanup ?? null,
      ...(artifact === undefined ? {} : { artifact }),
    };
  }
}

export function evaluateTaskCompletion({ value, cleanup, evidence } = {}) {
  const status = taskStatus(value);
  const claimedComplete = COMPLETE_STATES.has(status);
  const requirements = declaredRequirements(value);
  const outputEvidence = bulkOutputEvidence(value, evidence);
  const latestRateByScope = new Map();
  const latestEffectById = new Map();
  for (const entry of evidence?.effects ?? []) {
    if (typeof entry.effectId === "string") latestEffectById.set(entry.effectId, entry);
  }
  for (const entry of evidence?.rateControl ?? []) {
    if (typeof entry.scopeKey === "string") latestRateByScope.set(entry.scopeKey, entry);
  }
  const checks = [
    {
      id: "owned-window-cleanup",
      passed: cleanup?.ok === true,
      detail: cleanup?.ok === true ? "complete" : "incomplete",
    },
    {
      id: "effect-outcomes-resolved",
      passed: ![...latestEffectById.values()]
        .some((entry) => UNRESOLVED_EFFECT_STATES.has(entry.status)),
      detail: "no pending or outcome-unknown idempotent effect receipt",
    },
    {
      id: "rate-circuit-closed",
      passed: ![...latestRateByScope.values()].some((entry) => (
        entry.stop === true || entry.checkpointRequired === true
      )),
      detail: "no used scope has an open circuit or missing checkpoint",
    },
    {
      id: "instruction-blockers-resolved",
      passed: terminalValue(value)?.status !== "needs_instruction",
      detail: "no unresolved instruction wait",
    },
    {
      id: "declared-requirements",
      passed: !claimedComplete || (
        requirements.valid && requirements.entries.every((entry) => entry.satisfied)
      ),
      detail: !claimedComplete
        ? "not applicable because the task did not claim complete"
        : requirements.valid
        ? `${requirements.entries.filter((entry) => entry.satisfied).length}/${requirements.entries.length} satisfied`
        : "requirements contract is invalid",
    },
    {
      id: "bulk-output-evidence-consistent",
      passed: !claimedComplete || outputEvidence.passed,
      detail: !claimedComplete
        ? "not applicable because the task did not claim complete"
        : outputEvidence.detail,
    },
  ];
  return {
    schema: TASK_COMPLETION_GATE_SCHEMA,
    claimedComplete,
    claimedStatus: status,
    enforced: claimedComplete,
    passed: !claimedComplete || checks.every((check) => check.passed),
    checks,
    requirements: requirements.entries,
  };
}
