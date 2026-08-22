import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TaskExecutionLedger,
  latestTaskExecutionId,
  readTaskExecutionEntries,
  readTaskExecutionStatus,
} from "../skills/npc-moneyhand/scripts/lib/task-ledger.mjs";
import {
  TaskEffectReceipts,
} from "../skills/npc-moneyhand/scripts/lib/task-effects.mjs";
import {
  planTaskRecovery,
} from "../skills/npc-moneyhand/scripts/lib/task-recovery-state.mjs";
import {
  TaskEvidenceCollector,
  evaluateTaskCompletion,
} from "../skills/npc-moneyhand/scripts/lib/task-evidence.mjs";
import {
  createRateController,
  runMoneyHandTask,
} from "../skills/npc-moneyhand/scripts/moneyhand.mjs";

const build = "a".repeat(64);
const controller = {
  pid: process.pid,
  instanceNonce: "00000000-0000-4000-8000-000000000001",
  build,
};

test("private task ledger reports running, persists evidence, and closes with one terminal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npc-moneyhand-ledger-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const ledger = await TaskExecutionLedger.create({
    root,
    controller,
    taskPath: join(root, "task.mjs"),
    args: { page: 2 },
    now: () => now,
  });
  await ledger.append({
    type: "event",
    event: "moneyhand.task_progress",
    state: "running",
    checkpoint: "page:2",
  });
  const running = await readTaskExecutionStatus({
    root,
    build,
    controller,
    taskExecutionId: ledger.taskExecutionId,
  });
  assert.equal(running.state, "running");
  assert.equal(running.reattachable, true);
  assert.equal(running.lastProgress.checkpoint, "page:2");

  const artifact = await ledger.writeEvidence({
    schema: "npc-moneyhand-task-evidence/1",
    taskExecutionId: ledger.taskExecutionId,
    counts: { progress: 1 },
  });
  assert.equal(artifact.private, true);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);

  now += 1_000;
  await ledger.finish({ ok: true, value: { status: "complete" } });
  await ledger.append({ type: "event", event: "should-not-append" });
  const completed = await readTaskExecutionStatus({
    root,
    build,
    controller,
    taskExecutionId: ledger.taskExecutionId,
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.reattachable, false);
  assert.equal(completed.terminal.ok, true);
  assert.equal(await latestTaskExecutionId({ root, build }), ledger.taskExecutionId);
  const { entries } = await readTaskExecutionEntries({
    root,
    build,
    taskExecutionId: ledger.taskExecutionId,
  });
  assert.equal(entries.length, 2);
});

test("task ledger marks an unterminated execution interrupted under another controller", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npc-moneyhand-ledger-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await TaskExecutionLedger.create({
    root,
    controller,
    taskPath: join(root, "task.mjs"),
  });
  const status = await readTaskExecutionStatus({
    root,
    build,
    controller: { ...controller, instanceNonce: "00000000-0000-4000-8000-000000000002" },
    taskExecutionId: ledger.taskExecutionId,
  });
  assert.equal(status.state, "interrupted");
  assert.equal(status.reattachable, false);
});

test("task ledger derives one compact status summary from progress, rate, visual, and recovery events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npc-moneyhand-ledger-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-21T01:00:00.000Z");
  const ledger = await TaskExecutionLedger.create({
    root,
    controller,
    taskPath: join(root, "task.mjs"),
    now: () => now,
  });
  await ledger.append({
    type: "event",
    event: "moneyhand.task_progress",
    state: "running",
    phase: "collect",
    current: 2,
    total: 5,
    checkpoint: "page:2",
  });
  now += 500;
  await ledger.append({
    type: "event",
    event: "moneyhand.task_rate_control",
    state: "allowed",
    phase: "cooldown",
    waitMs: 2_500,
    stop: false,
    checkpointRequired: false,
  });
  now += 500;
  await ledger.append({
    type: "event",
    event: "moneyhand.task_progress",
    state: "visual_fallback",
    phase: "watchdog",
    visualFallback: {
      captured: true,
      screenshot: { path: "C:\\evidence\\page-2.png" },
    },
  });
  now += 2_000;
  const running = await readTaskExecutionStatus({
    root,
    build,
    controller,
    taskExecutionId: ledger.taskExecutionId,
    now: () => now,
  });
  assert.deepEqual(running.taskSummary, {
    schema: "npc-moneyhand-task-summary/1",
    state: "running",
    phase: "watchdog",
    progress: { current: 2, total: 5 },
    lastCheckpoint: "page:2",
    lastActivityAgoMs: 2_000,
    rate: {
      state: "allowed",
      phase: "cooldown",
      waitMs: 2_500,
      stop: false,
      checkpointRequired: false,
    },
    visual: {
      captured: true,
      path: "C:\\evidence\\page-2.png",
      waitingForInstruction: false,
    },
    nextAction: "wait-for-rate-window",
  });

  now += 1_000;
  await ledger.finish({
    ok: true,
    value: { status: "complete" },
  });
  const completed = await readTaskExecutionStatus({
    root,
    build,
    controller,
    taskExecutionId: ledger.taskExecutionId,
    now: () => now,
  });
  assert.equal(completed.taskSummary.state, "completed");
  assert.equal(completed.taskSummary.phase, "complete");
  assert.equal(completed.taskSummary.nextAction, "none");
  assert.equal(completed.taskSummary.lastActivityAgoMs, 0);
});

test("task summary never labels an incomplete business outcome as completed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npc-moneyhand-ledger-incomplete-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await TaskExecutionLedger.create({
    root,
    controller,
    taskPath: join(root, "task.mjs"),
  });
  await ledger.finish({
    ok: true,
    value: {
      outcome: {
        status: "incomplete",
        reason: "PAGE_RECORD_INVALID",
        visualFallback: {
          captured: true,
          screenshot: { path: "C:\\evidence\\incomplete.png" },
        },
      },
    },
  });
  const status = await readTaskExecutionStatus({
    root,
    build,
    controller,
    taskExecutionId: ledger.taskExecutionId,
  });
  assert.equal(status.state, "completed", "execution lifecycle still reached a terminal record");
  assert.equal(status.taskSummary.state, "incomplete");
  assert.equal(status.taskSummary.visual.captured, true);
  assert.equal(status.taskSummary.visual.path, "C:\\evidence\\incomplete.png");
  assert.equal(status.taskSummary.nextAction, "inspect-visual-fallback");
});

test("effect receipts collapse concurrent and later duplicates without hiding unknown outcomes", async () => {
  const events = [];
  const receipts = new TaskEffectReceipts({
    onReceipt: async (receipt) => events.push(receipt),
  });
  let dispatches = 0;
  let release;
  const first = receipts.execute({
    effectId: "publish:item-1",
    effect: "publish",
    operation: "actSemanticRef",
    input: { text: "hello" },
  }, async () => {
    dispatches += 1;
    await new Promise((resolvePromise) => { release = resolvePromise; });
    return { ok: true };
  });
  const duplicate = receipts.execute({
    effectId: "publish:item-1",
    effect: "publish",
    operation: "actSemanticRef",
    input: { text: "hello" },
  }, async () => {
    dispatches += 1;
    return { ok: false };
  });
  while (!release) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await duplicate, { ok: true });
  assert.equal(dispatches, 1);
  assert.equal(receipts.get("publish:item-1").status, "completed");
  assert.equal(events.some((entry) => entry.replayed === true), true);
  await assert.rejects(
    receipts.execute({
      effectId: "publish:item-1",
      effect: "publish",
      operation: "actSemanticRef",
      input: { text: "changed" },
    }, async () => ({})),
    (error) => error?.code === "EFFECT_ID_CONFLICT"
      && error.details?.actionDispatched === false,
  );

  const unknown = new Error("lost terminal");
  unknown.code = "OUTCOME_UNKNOWN";
  unknown.details = { actionDispatched: true };
  let unknownDispatches = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      receipts.execute({
        effectId: "send:item-2",
        effect: "send",
        operation: "taskRequest",
        input: { body: "same" },
      }, async () => {
        unknownDispatches += 1;
        throw unknown;
      }),
      (error) => error === unknown,
    );
  }
  assert.equal(unknownDispatches, 1);
  assert.equal(receipts.get("send:item-2").status, "outcome_unknown");
});

test("fixed recovery permits only one proven-not-dispatched transient replay", () => {
  const retry = planTaskRecovery({
    operation: "navigateTaskTab",
    error: { code: "BUSY", details: { actionDispatched: false } },
    attempt: 1,
  });
  assert.equal(retry.state, "probe");
  assert.equal(retry.replayAllowed, true);
  const second = planTaskRecovery({
    operation: "navigateTaskTab",
    error: { code: "BUSY", details: { actionDispatched: false } },
    attempt: 2,
  });
  assert.equal(second.replayAllowed, false);
  const unknown = planTaskRecovery({
    operation: "actSemanticRef",
    error: { code: "OUTCOME_UNKNOWN", details: { actionDispatched: true } },
    attempt: 1,
  });
  assert.equal(unknown.state, "outcome_unknown");
  assert.equal(unknown.replayAllowed, false);
  const stale = planTaskRecovery({
    operation: "actSemanticRef",
    error: { code: "STALE_SEMANTIC_REF", details: { actionDispatched: false } },
    attempt: 1,
  });
  assert.equal(stale.state, "refresh_target");
  assert.equal(stale.replayAllowed, false);
  assert.equal(stale.category, "target-state");
  assert.equal(stale.rootCause.code, "STALE_SEMANTIC_REF");
  assert.equal(stale.retryAllowed, false);
  assert.equal(stale.retryAtMs, null);
  assert.equal(stale.waitingForInstruction, false);
  assert.equal(stale.visualFallback, null);

  const waiting = planTaskRecovery({
    operation: "actSemanticRef",
    error: {
      code: "TAB_WAITING",
      message: "The task tab is waiting for Agent instruction",
      details: { actionDispatched: false, waitId: "wait-1" },
    },
    attempt: 1,
  });
  assert.equal(waiting.category, "waiting-for-instruction");
  assert.equal(waiting.waitingForInstruction, true);
  assert.equal(waiting.nextAction, "resolve-task-blocker");
});

test("completion gate uses latest receipts, rate circuits, cleanup, and declared requirements", () => {
  const collector = new TaskEvidenceCollector({ taskExecutionId: "task-test", startedAtMs: 0 });
  collector.recordEffect({ effectId: "one", status: "pending" });
  collector.recordEffect({ effectId: "one", status: "completed" });
  collector.recordRate({
    scopeKey: "[scope]",
    stop: false,
    checkpointRequired: false,
  });
  const value = {
    status: "complete",
    requirements: [{ id: "five-records", satisfied: true, expected: 5, actual: 5 }],
  };
  const evidence = collector.build({ value, cleanup: { ok: true }, finishedAtMs: 1 });
  assert.equal(evaluateTaskCompletion({ value, cleanup: { ok: true }, evidence }).passed, true);
  collector.recordRate({
    scopeKey: "[scope]",
    stop: true,
    checkpointRequired: true,
  });
  const stoppedEvidence = collector.build({ value, cleanup: { ok: true }, finishedAtMs: 2 });
  const stopped = evaluateTaskCompletion({ value, cleanup: { ok: true }, evidence: stoppedEvidence });
  assert.equal(stopped.passed, false);
  assert.equal(stopped.checks.find((entry) => entry.id === "rate-circuit-closed").passed, false);

  const missingRequirements = evaluateTaskCompletion({
    value: { status: "complete" },
    cleanup: { ok: true },
    evidence: collector.build({ value: { status: "complete" }, cleanup: { ok: true } }),
  });
  assert.equal(missingRequirements.passed, false);
  assert.equal(
    missingRequirements.checks.find((entry) => entry.id === "declared-requirements").passed,
    false,
  );

  const interrupted = evaluateTaskCompletion({
    value: undefined,
    cleanup: { ok: true },
    evidence: collector.build({ value: undefined, cleanup: { ok: true } }),
  });
  assert.equal(interrupted.claimedComplete, false);
  assert.equal(interrupted.enforced, false);
  assert.equal(interrupted.passed, true);
  assert.deepEqual(
    interrupted.checks.find((entry) => entry.id === "declared-requirements"),
    {
      id: "declared-requirements",
      passed: true,
      detail: "not applicable because the task did not claim complete",
    },
  );
});

test("completion gate rejects a bulk output whose file evidence disagrees with its manifest", () => {
  const collector = new TaskEvidenceCollector({ taskExecutionId: "task-output-proof", startedAtMs: 0 });
  const makeValue = (evidenceCount) => ({
    outcome: {
      status: "complete",
      requirements: [{ id: "six-records", satisfied: true, expected: 6, actual: 6 }],
      evidence: [{
        type: "output-file",
        path: "C:\\task\\records.jsonl",
        format: "jsonl",
        count: evidenceCount,
      }],
    },
    output: {
      path: "C:\\task\\records.jsonl",
      format: "jsonl",
      count: 6,
    },
  });
  const matchingValue = makeValue(6);
  const matching = evaluateTaskCompletion({
    value: matchingValue,
    cleanup: { ok: true },
    evidence: collector.build({ value: matchingValue, cleanup: { ok: true } }),
  });
  assert.equal(matching.passed, true);
  assert.deepEqual(
    matching.checks.find((entry) => entry.id === "bulk-output-evidence-consistent"),
    {
      id: "bulk-output-evidence-consistent",
      passed: true,
      detail: "bulk output path, format, and count match task evidence",
    },
  );

  const mismatchedValue = makeValue(3);
  const mismatched = evaluateTaskCompletion({
    value: mismatchedValue,
    cleanup: { ok: true },
    evidence: collector.build({ value: mismatchedValue, cleanup: { ok: true } }),
  });
  assert.equal(mismatched.passed, false);
  assert.equal(
    mismatched.checks.find((entry) => entry.id === "bulk-output-evidence-consistent").passed,
    false,
  );
});

test("task wrapper hard-codes idempotent effects and one bounded recovery retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-runtime-hardening-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const request = { method: 'cdp.send', params: { method: 'Runtime.evaluate', params: {} } };",
    "  const first = await moneyhand.taskRequest({ taskSpaceId: 'task-space', effect: 'input', effectId: 'input:one', request });",
    "  const duplicate = await moneyhand.taskRequest({ taskSpaceId: 'task-space', effect: 'input', effectId: 'input:one', request });",
    "  const navigation = await moneyhand.navigateTaskTab({ taskSpaceId: 'task-space', effect: 'navigation', url: 'https://example.test/' });",
    "  return { status: 'complete', first, duplicate, navigation, requirements: [{ id: 'done', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  let requestDispatches = 0;
  let navigationDispatches = 0;
  let probes = 0;
  const events = [];
  const moneyhand = {
    request: async () => ({}),
    taskRequest: async () => {
      requestDispatches += 1;
      return { ok: true };
    },
    navigateTaskTab: async () => {
      navigationDispatches += 1;
      if (navigationDispatches === 1) {
        const error = new Error("busy");
        error.code = "BUSY";
        error.details = { actionDispatched: false };
        throw error;
      }
      return { ok: true };
    },
    probeTaskContext: async () => {
      probes += 1;
      return { healthy: true, stage: "ready" };
    },
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
  };
  let final;
  const value = await runMoneyHandTask({
    moneyhand,
    taskPath,
    onProgress: async (event) => events.push(event),
    onFinal: (result) => { final = result; },
  });
  assert.equal(value.status, "complete");
  assert.equal(requestDispatches, 1);
  assert.equal(navigationDispatches, 2);
  assert.equal(probes, 1);
  assert.equal(events.some((event) => event.event === "moneyhand.task_effect_receipt"
    && event.receipt.replayed === true), true);
  assert.equal(events.some((event) => event.event === "moneyhand.task_recovery"
    && event.state === "recovered"), true);
  assert.equal(final.completionGate.passed, true);
  assert.equal(final.taskEvidence.counts.effects >= 3, true);
  assert.equal(final.taskEvidence.counts.recoveries >= 3, true);
  assert.equal(final.taskSummary.schema, "npc-moneyhand-task-summary/1");
  assert.equal(final.taskSummary.state, "completed");
  assert.equal(final.taskSummary.phase, "complete");
  assert.equal(final.taskSummary.nextAction, "none");
});

test("task wrapper pins semantic snapshots and normalizes whole-document hints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-selector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'selector-space' });",
    "  const first = await moneyhand.captureSemanticSnapshot({ tabId: 42 });",
    "  const second = await moneyhand.captureSemanticSnapshot({ tabId: 42, selector: 'body' });",
    "  await moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });",
    "  return { status: 'complete', first, second, requirements: [{ id: 'done', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  const calls = [];
  const moneyhand = {
    request: async () => ({}),
    beginTaskContext: async () => ({
      taskSpaceId: "selector-space",
      selector: { profile: "pinned-profile", instanceId: "instance-1", bootId: "boot-id-1" },
      behavior: { mode: "raw" },
    }),
    captureSemanticSnapshot: async (options) => {
      calls.push(options);
      return { snapshot: { id: `snapshot-${calls.length}` } };
    },
    completeTaskContext: async () => ({ cleanupComplete: true }),
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
  };
  const value = await runMoneyHandTask({ moneyhand, taskPath });
  assert.equal(value.status, "complete");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.selector, {
      profile: "pinned-profile",
      instanceId: "instance-1",
      bootId: "boot-id-1",
    });
  }
});

test("task wrapper injects fixed navigation and scroll effects and rejects conflicts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-scroll-effect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'scroll-space' });",
    "  const scrolled = await moneyhand.scrollTaskTab({ taskSpaceId: task.taskSpaceId, deltaY: 700, effectId: 'scroll:page-1' });",
    "  const navigated = await moneyhand.navigateTaskTab({ taskSpaceId: task.taskSpaceId, url: 'https://example.test/', effectId: 'navigate:page-1' });",
    "  const refNavigation = await moneyhand.navigateSemanticRef({ taskSpaceId: task.taskSpaceId, snapshotId: 'snapshot-1', ref: '@1', effectId: 'navigate:ref-1' });",
    "  let conflict;",
    "  try {",
    "    await moneyhand.scrollTaskTab({ taskSpaceId: task.taskSpaceId, deltaY: 700, effect: 'navigation', effectId: 'scroll:bad' });",
    "  } catch (error) { conflict = error.code; }",
    "  await moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });",
    "  return { status: 'complete', scrolled, navigated, refNavigation, conflict, requirements: [{ id: 'fixed-effects-done', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  const calls = [];
  const navigations = [];
  const events = [];
  const moneyhand = {
    request: async () => ({}),
    beginTaskContext: async () => ({
      taskSpaceId: "scroll-space",
      selector: { profile: "scroll-profile" },
      behavior: { mode: "raw" },
    }),
    scrollTaskTab: async (options) => {
      calls.push(options);
      return { actionDispatched: true, effect: "input" };
    },
    navigateTaskTab: async (options) => {
      navigations.push(options);
      return { actionDispatched: true, effect: "navigation" };
    },
    navigateSemanticRef: async (options) => {
      navigations.push(options);
      return { actionDispatched: true, effect: "navigation" };
    },
    completeTaskContext: async () => ({ cleanupComplete: true }),
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
  };
  const value = await runMoneyHandTask({
    moneyhand,
    taskPath,
    onProgress: async (event) => events.push(event),
  });
  assert.equal(value.status, "complete");
  assert.equal(value.conflict, "INVALID_TASK_EFFECT");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].effect, "input");
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.equal(navigations.length, 2);
  assert.equal(navigations.every((options) => options.effect === "navigation"), true);
  assert.equal(events.some((event) => event.event === "moneyhand.task_effect_receipt"
    && event.receipt.effect === "input"
    && event.receipt.status === "completed"), true);
});

test("task wrapper automatically opens and enforces a site circuit before another dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-runtime-rate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const context = await moneyhand.beginTaskContext({ id: 'rate-space' });",
    "  const failures = [];",
    "  for (let attempt = 0; attempt < 2; attempt += 1) {",
    "    try {",
    "      await moneyhand.navigateTaskTab({ taskSpaceId: context.taskSpaceId, effect: 'navigation', url: 'https://rate.example/items' });",
    "    } catch (error) {",
    "      failures.push(error.code);",
    "    }",
    "  }",
    "  await moneyhand.completeTaskContext({ taskSpaceId: context.taskSpaceId });",
    "  return { status: 'incomplete', failures, reason: 'rate-circuit-test' };",
    "}",
  ].join("\n"), "utf8");
  const rateController = createRateController({
    persistent403Threshold: 1,
    random: () => 0.5,
    sleep: async () => {},
  });
  let navigationDispatches = 0;
  const moneyhand = {
    request: async () => ({}),
    beginTaskContext: async () => ({
      taskSpaceId: "rate-space",
      selector: { profile: "rate-profile" },
      behavior: { mode: "raw" },
    }),
    navigateTaskTab: async () => {
      navigationDispatches += 1;
      const error = new Error("site returned 403");
      error.code = "HTTP_403";
      error.details = { status: 403, actionDispatched: true };
      throw error;
    },
    completeTaskContext: async () => ({ ok: true }),
    rateControl: async ({ action, input, signal }) => (
      action === "wait"
        ? await rateController.wait(input, { signal })
        : rateController[action](input)
    ),
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
  };
  let final;
  const events = [];
  const value = await runMoneyHandTask({
    moneyhand,
    taskPath,
    onProgress: async (event) => events.push(event),
    onFinal: (result) => { final = result; },
  });
  assert.equal(navigationDispatches, 1);
  assert.deepEqual(value.failures, ["HTTP_403", "RATE_CONTROL_CIRCUIT_OPEN"]);
  assert.equal(events.some((event) => event.event === "moneyhand.task_rate_control"
    && event.state === "circuit_open"), true);
  assert.equal(events.some((event) => event.event === "moneyhand.task_rate_control"
    && event.state === "blocked"), true);
  assert.equal(final.taskEvidence.rateControl.at(-1).stop, true);
});

test("task wrapper rejects an unsupported completion claim after cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-runtime-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run() {",
    "  return {",
    "    status: 'complete',",
    "    requirements: [{ id: 'five-records', satisfied: false, expected: 5, actual: 4 }],",
    "  };",
    "}",
  ].join("\n"), "utf8");
  let final;
  const moneyhand = {
    request: async () => ({}),
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
  };
  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      onFinal: (result) => { final = result; },
    }),
    (error) => error?.code === "TASK_COMPLETION_GATE_FAILED"
      && error.details?.completionGate?.passed === false
      && error.details?.cleanupComplete === true
      && error.details?.recovery?.category === "completion-gate"
      && error.details?.recovery?.nextAction === "inspect-completion-gate",
  );
  assert.equal(final.completionGate.enforced, true);
  assert.equal(final.completionGate.passed, false);
  assert.equal(final.taskEvidence.cleanup.ok, true);
  assert.equal(final.taskSummary.state, "failed");
  assert.equal(final.taskSummary.nextAction, "inspect-completion-gate");
});

test("isolated task worker termination releases task-owned resources and leaves unrelated resources alive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-worker-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  const portPath = join(directory, "worker-port.txt");
  await writeFile(taskPath, [
    "import { createServer } from 'node:net';",
    "import { writeFile } from 'node:fs/promises';",
    "export async function run({ args }) {",
    "  const server = createServer((socket) => socket.end('worker'));",
    "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });",
    "  await writeFile(args.portPath, String(server.address().port), 'utf8');",
    "  await new Promise(() => {});",
    "}",
  ].join("\n"), "utf8");
  const sentinel = createServer((socket) => socket.end("sentinel"));
  await new Promise((resolvePromise, rejectPromise) => {
    sentinel.once("error", rejectPromise);
    sentinel.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => sentinel.close(resolvePromise)));
  const moneyhand = {
    request: async () => ({}),
    ownedTaskWindowIds: () => ["owned-worker-window"],
    cleanupOwnedTaskWindows: async ({ taskIds }) => ({
      ok: true,
      attempted: taskIds.length,
      results: taskIds.map((id) => ({ id, closed: true })),
    }),
  };
  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      args: { portPath },
      timeoutMs: 100,
      abortGraceMs: 20,
    }),
    (error) => error.code === "TASK_TIMEOUT"
      && error.details.taskAcknowledgedAbort === false
      && error.details.cleanupComplete === true,
  );
  const workerPort = Number(await readFile(portPath, "utf8"));
  assert.equal(Number.isInteger(workerPort), true);
  assert.equal(sentinel.listening, true);
  await assert.rejects(new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: "127.0.0.1", port: workerPort });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", rejectPromise);
  }));
});

test("isolated task worker reports a non-serializable call result without hanging", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-worker-clone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  try {",
    "    await moneyhand.nonSerializable();",
    "  } catch (error) {",
    "    return { code: error.code, message: error.message };",
    "  }",
    "  throw new Error('Expected a serialization error');",
    "}",
  ].join("\n"), "utf8");
  const moneyhand = {
    request: async () => ({}),
    ownedTaskWindowIds: () => [],
    cleanupOwnedTaskWindows: async () => ({ ok: true, attempted: 0, results: [] }),
    nonSerializable: async () => ({ callback() {} }),
  };
  const value = await runMoneyHandTask({
    moneyhand,
    taskPath,
    timeoutMs: 1_000,
  });
  assert.deepEqual(value, {
    code: "TASK_WORKER_CALL_RESULT_NOT_SERIALIZABLE",
    message: "MoneyHand task call returned a value that cannot cross the isolated task boundary",
  });
});
