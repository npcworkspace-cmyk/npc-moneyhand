import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

export const TASK_EVIDENCE_SCHEMA = "npc-moneyhand-task-evidence/1";
export const TASK_COMPLETION_GATE_SCHEMA = "npc-moneyhand-task-completion-gate/1";

const MAX_ENTRIES = 2_048;
const MAX_TASK_FACTS = 64;
const MAX_TASK_FACT_BYTES = 4_096;
const TASK_FACT_ID = /^[A-Za-z0-9._:-]{1,100}$/u;
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

function outcomeRequirements(value) {
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

function boundedJsonFact(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { valid: false, value: null };
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_TASK_FACT_BYTES) {
    return { valid: false, value: null };
  }
  const normalized = JSON.parse(encoded);
  return { valid: isDeepStrictEqual(value, normalized), value: normalized };
}

function taskFactEvidence(value) {
  if (value === undefined) return { valid: true, count: 0 };
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length < 1 || entries.length > 32) return { valid: false, count: 0 };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !boundedJsonFact(entry).valid) {
      return { valid: false, count: 0 };
    }
  }
  return { valid: true, count: entries.length };
}

function taskFactEntries(value, field) {
  if (value === undefined) return { valid: true, entries: [] };
  if (!Array.isArray(value) || value.length > MAX_TASK_FACTS) {
    return { valid: false, entries: [] };
  }
  const expectedField = field === "expected";
  const allowed = new Set(expectedField ? ["id", "expected"] : ["id", "actual", "evidence"]);
  const entries = [];
  const ids = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !TASK_FACT_ID.test(entry.id ?? "") || ids.has(entry.id)
      || !Object.hasOwn(entry, field)
      || Object.keys(entry).some((key) => !allowed.has(key))) {
      return { valid: false, entries: [] };
    }
    const fact = boundedJsonFact(entry[field]);
    const evidence = expectedField
      ? { valid: entry.evidence === undefined, count: 0 }
      : taskFactEvidence(entry.evidence);
    if (!fact.valid || !evidence.valid) {
      return { valid: false, entries: [] };
    }
    ids.add(entry.id);
    entries.push({
      id: entry.id,
      value: fact.value,
      evidenceCount: evidence.count,
    });
  }
  return { valid: true, entries };
}

function taskFactMatches(expected, actual) {
  if (isDeepStrictEqual(expected, actual)) return true;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
    || !actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => (
    Object.hasOwn(actual, key) && taskFactMatches(expectedValue, actual[key])
  ));
}

function taskFactRequirements(value) {
  const expected = taskFactEntries(value?.args?.acceptance?.taskFacts, "expected");
  const observed = taskFactEntries(terminalValue(value)?.taskFacts, "actual");
  const expectedIds = new Set(expected.entries.map((entry) => entry.id));
  const observedById = new Map(observed.entries.map((entry) => [entry.id, entry]));
  const exactIds = observed.entries.every((entry) => expectedIds.has(entry.id))
    && observed.entries.length === expected.entries.length;
  const entries = expected.entries.map((entry) => {
    const actual = observedById.get(entry.id);
    return {
      id: `task-fact:${entry.id}`,
      satisfied: actual !== undefined && taskFactMatches(entry.value, actual.value),
      expected: entry.value,
      ...(actual === undefined ? {} : { actual: actual.value }),
      evidenceCount: actual?.evidenceCount ?? 0,
    };
  });
  const matched = entries.filter((entry) => entry.satisfied).length;
  const valid = expected.valid && observed.valid && exactIds;
  return {
    valid,
    entries,
    expectedCount: expected.entries.length,
    matched,
    detail: !expected.valid || !observed.valid
      ? "task fact declarations or observations violate the bounded contract"
      : expected.entries.length === 0 && observed.entries.length === 0
        ? "not applicable because no task-specific facts were declared"
        : valid && matched === entries.length
        ? `${matched}/${entries.length} task facts observed and matched`
        : `${matched}/${expected.entries.length} task facts matched; declarations or observations are missing, extra, invalid, or unequal`,
  };
}

function runtimeBehaviorRequirements(value) {
  if (value?.args?.behavior !== "human") return { valid: true, entries: [] };
  const actual = value?.task?.behavior?.mode;
  return {
    valid: typeof actual === "string",
    entries: [{
      id: "runtime:behavior-mode",
      satisfied: actual === "human",
      expected: "human",
      ...(actual === undefined ? {} : { actual }),
      evidenceCount: 0,
    }],
  };
}

function declaredRequirements(value, taskFacts) {
  const declared = outcomeRequirements(value);
  const behavior = runtimeBehaviorRequirements(value);
  const entries = [...declared.entries, ...behavior.entries, ...taskFacts.entries];
  const ids = new Set(entries.map((entry) => entry.id));
  return {
    valid: declared.valid && behavior.valid && taskFacts.valid
      && entries.length <= 256 && ids.size === entries.length,
    entries,
  };
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
  const taskFacts = taskFactRequirements(value);
  const requirements = declaredRequirements(value, taskFacts);
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
      id: "task-facts-verified",
      passed: !claimedComplete || (taskFacts.valid
        && taskFacts.matched === taskFacts.expectedCount),
      detail: !claimedComplete
        ? "not applicable because the task did not claim complete"
        : taskFacts.detail,
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
