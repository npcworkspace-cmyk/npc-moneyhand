import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  COORDINATE_SPACE,
  MAX_JSONL_LINE_BYTES,
  MoneyHandError,
  __test__ as moneyhandTest,
  createMoneyHand,
  runMoneyHandTask,
  runJsonlMoneyHand,
} from "../skills/npc-moneyhand/scripts/moneyhand.mjs";
import {
  openRawWebSocket,
  waitFor,
} from "./helpers/raw-websocket.js";
import { TaskSpaceRegistry } from "../skills/npc-moneyhand/scripts/lib/task-spaces.mjs";

const PROTOCOL = "npc-moneyhand/2";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("connect acceptance keeps the fixed checklist total after an early failure", () => {
  const acceptance = moneyhandTest.connectAcceptanceResult({
    outcome: {
      status: "incomplete",
      total: 15,
      reason: "FULL_PAGE_CAPTURE_FAILED",
      checks: Array.from({ length: 12 }, (_, index) => ({
        name: `check-${index + 1}`,
        status: index === 11 ? "failed" : "passed",
      })),
    },
    lifecycle: {
      cleanupComplete: true,
      windowClosed: true,
      behaviorReset: "raw",
    },
  });
  assert.equal(acceptance.passed, 11);
  assert.equal(acceptance.total, 15);
  assert.equal(acceptance.status, "failed");
});

test("MoneyHand task modules compose multiple steps in one trusted local code pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, args }) {",
    "  const first = await moneyhand.request({ method: 'target.list', params: {} });",
    "  const second = await moneyhand.request({ method: 'behavior.get', params: {} });",
    "  return { args, methods: [first.method, second.method] };",
    "}",
  ].join("\n"), "utf8");
  const calls = [];
  const moneyhand = {
    async request(request) {
      calls.push(request.method);
      return { method: request.method };
    },
  };
  const value = await runMoneyHandTask({
    moneyhand,
    taskPath,
    args: { source: "agent-cli" },
  });
  assert.deepEqual(value, {
    args: { source: "agent-cli" },
    methods: ["target.list", "behavior.get"],
  });
  assert.deepEqual(calls, ["target.list", "behavior.get"]);
});

test("runMoneyHandTask rejects an unchanged packaged template before browser dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-unchanged-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(
    taskPath,
    await readFile(new URL(
      "../skills/npc-moneyhand/assets/disposable-task.mjs",
      import.meta.url,
    )),
  );
  const progressEvents = [];
  let browserRequests = 0;
  let visualInspections = 0;
  const moneyhand = {
    async request() { browserRequests += 1; },
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async inspectTaskBlocker() { visualInspections += 1; },
  };

  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      onProgress: async (event) => progressEvents.push(event),
    }),
    (error) => error?.code === "TASK_TEMPLATE_NOT_IMPLEMENTED"
      && error?.details?.actionDispatched === false
      && error?.details?.cleanupComplete === true,
  );
  assert.equal(browserRequests, 0);
  assert.equal(visualInspections, 0);
  assert.equal(progressEvents.some((event) => event.state === "visual_fallback"), false);
  assert.equal(progressEvents.at(-1).state, "failed");
});

test("runMoneyHandTask automatically attaches visual evidence to page-operation failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-visual-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'visual-error-task' });",
    "  await moneyhand.navigateTaskTab({ taskSpaceId: task.taskSpaceId, effect: 'navigation', url: 'https://example.test/' });",
    "}",
  ].join("\n"), "utf8");
  const inspections = [];
  const moneyhand = {
    async request() {},
    async beginTaskContext() {
      return { taskSpaceId: "visual-error-task" };
    },
    async navigateTaskTab() {
      throw new MoneyHandError(
        "NAVIGATION_WAIT_TIMEOUT",
        "Navigation readiness was not proven",
        { actionDispatched: true, retry: "inspect-before-retry" },
      );
    },
    async inspectTaskBlocker(options) {
      inspections.push(options);
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: join(directory, "navigation-timeout.png") },
        actionReplayed: false,
      };
    },
  };

  await assert.rejects(
    runMoneyHandTask({ moneyhand, taskPath }),
    (error) => error.code === "NAVIGATION_WAIT_TIMEOUT"
      && error.details?.visualFallback?.captured === true
      && error.details.visualFallback.actionReplayed === false
      && error.details.cleanupComplete === true,
  );
  assert.equal(inspections.length, 1);
  assert.equal(inspections[0].taskSpaceId, "visual-error-task");
  assert.equal(inspections[0].operation, "navigateTaskTab");
  assert.equal(inspections[0].reason.code, "NAVIGATION_WAIT_TIMEOUT");
  assert.equal(inspections[0].reason.actionDispatched, true);
});

test("runMoneyHandTask automatically screenshots needs_instruction without exposing wait internals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-visual-wait-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'visual-wait-task' });",
    "  return await moneyhand.taskRequest({",
    "    taskSpaceId: task.taskSpaceId,",
    "    effect: 'input',",
    "    request: { method: 'input.perform', params: { target: { tabId: 42 }, action: 'click' } },",
    "  });",
    "}",
  ].join("\n"), "utf8");
  const moneyhand = {
    async request() {},
    async beginTaskContext() {
      return { taskSpaceId: "visual-wait-task" };
    },
    async taskRequest() {
      return {
        ok: false,
        status: "needs_instruction",
        error: { code: "TARGET_OCCLUDED", message: "The element is covered" },
        need: { waitId: "wait_private", target: { tabId: 42 } },
      };
    },
    async inspectTaskBlocker() {
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        waitingForInstruction: true,
        screenshot: { path: join(directory, "occluded.png") },
        nextAction: "inspect-screenshot-then-resolveTaskBlocker",
        actionReplayed: false,
      };
    },
  };

  const result = await runMoneyHandTask({ moneyhand, taskPath });
  assert.equal(result.status, "needs_instruction");
  assert.equal(result.visualFallback.captured, true);
  assert.equal(result.visualFallback.waitingForInstruction, true);
  assert.equal("waitId" in result.need, false);
  assert.equal("target" in result.need, false);
  assert.equal(result.need.resolution, "resolveTaskBlocker");
  assert.equal("waitId" in result.visualFallback, false);
  assert.equal("tabId" in result.visualFallback, false);
  assert.equal("data" in result.visualFallback, false);
});

test("runMoneyHandTask visually inspects repeated semantic occlusion without masking errors or exceeding its cap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-visual-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'visual-cap-task' });",
    "  const outcomes = [];",
    "  for (let index = 0; index < 121; index += 1) {",
    "    try {",
    "      await moneyhand.actSemanticRef({ taskSpaceId: task.taskSpaceId, snapshotId: 'snapshot', ref: 'ref', action: 'click', effect: 'input' });",
    "    } catch (error) {",
    "      outcomes.push({ code: error.code, visualFallback: error.details?.visualFallback });",
    "    }",
    "  }",
    "  return outcomes;",
    "}",
  ].join("\n"), "utf8");
  let inspections = 0;
  const moneyhand = {
    async request() {},
    async beginTaskContext() {
      return { taskSpaceId: "visual-cap-task" };
    },
    async actSemanticRef() {
      throw new MoneyHandError(
        "TARGET_OCCLUDED",
        "The semantic target is covered",
        { actionDispatched: false, retry: "inspect-before-next-action" },
      );
    },
    async inspectTaskBlocker() {
      inspections += 1;
      if (inspections === 1) {
        throw new MoneyHandError("VISUAL_CAPTURE_FAILED", "Screenshot capture failed");
      }
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: join(directory, `occluded-${inspections}.png`) },
        actionReplayed: false,
      };
    },
  };

  const results = await runMoneyHandTask({ moneyhand, taskPath });
  assert.equal(results.length, 121);
  assert.equal(inspections, 120);
  assert.deepEqual(new Set(results.map((result) => result.code)), new Set(["TARGET_OCCLUDED"]));
  assert.equal(results[0].visualFallback.captured, false);
  assert.equal(results[0].visualFallback.screenshot.error.code, "VISUAL_CAPTURE_FAILED");
  assert.equal(results[119].visualFallback.captured, true);
  assert.equal(results[120].visualFallback.captured, false);
  assert.equal(results[120].visualFallback.skipped, "automatic-task-visual-limit");
  assert.equal(results[120].visualFallback.limit, 120);
  assert.equal(results.every((result) => result.visualFallback.actionReplayed === false), true);
});

test("runMoneyHandTask emits mandatory progress and visually inspects a silent active page", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, progress }) {",
    "  await moneyhand.beginTaskContext({ id: 'progress-task' });",
    "  await progress({ phase: 'collect', current: 1, total: 3, message: 'Collected the first item' });",
    "  await new Promise((resolve) => setTimeout(resolve, 65));",
    "  return { status: 'complete', requirements: [{ id: 'progress-complete', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  const inspections = [];
  const moneyhand = {
    async request() {},
    async beginTaskContext() {
      return { taskSpaceId: "progress-task" };
    },
    async inspectTaskBlocker(options) {
      inspections.push(options);
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: join(directory, `silent-${inspections.length}.png`) },
        actionReplayed: false,
      };
    },
  };

  const result = await runMoneyHandTask({
    moneyhand,
    taskPath,
    progressIntervalMs: 10,
    visualSilenceMs: 20,
    onProgress: async (event) => progressEvents.push(event),
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(result.requirements, [{ id: "progress-complete", satisfied: true }]);
  if (result.visualFallback !== undefined) {
    assert.equal(result.visualFallback.schema, "npc-moneyhand-visual-fallback/1");
    assert.equal(result.visualFallback.captured, true);
    assert.equal(result.visualFallback.actionReplayed, false);
  }
  assert.equal(progressEvents[0].event, "moneyhand.task_progress");
  assert.equal(progressEvents[0].state, "started");
  assert.equal(progressEvents.some((event) => (
    event.state === "running"
      && event.phase === "collect"
      && event.current === 1
      && event.total === 3
  )), true);
  const visual = progressEvents.find((event) => event.state === "visual_fallback");
  assert.equal(visual.visualFallback.captured, true);
  assert.equal(visual.visualFallback.actionReplayed, false);
  assert.equal(visual.silenceMs >= 20, true);
  assert.equal(inspections.length >= 1, true);
  assert.equal(inspections.length <= 120, true);
  assert.equal(inspections[0].operation, "task-silence-watchdog");
  assert.equal(progressEvents.at(-1).state, "completed");
});

test("task watchdog hard limits can be tightened but never weakened by an embedding caller", () => {
  assert.deepEqual(moneyhandTest.taskWatchdogPolicy({
    progressIntervalMs: 60_000,
    visualSilenceMs: 5 * 60_000,
  }), {
    progressIntervalMs: 10_000,
    visualSilenceMs: 15_000,
  });
  assert.deepEqual(moneyhandTest.taskWatchdogPolicy({
    progressIntervalMs: 25,
    visualSilenceMs: 40,
  }), {
    progressIntervalMs: 25,
    visualSilenceMs: 40,
  });
});

test("runMoneyHandTask captures a task-timeout page before cleanup even below the silence threshold", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-timeout-visual-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, signal }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'terminal-timeout-task' });",
    "  try {",
    "    await new Promise((resolve, reject) => {",
    "      const abort = () => reject(signal.reason);",
    "      signal.addEventListener('abort', abort, { once: true });",
    "      if (signal.aborted) abort();",
    "    });",
    "  } finally {",
    "    await moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });",
    "  }",
    "}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  const inspections = [];
  const ordering = [];
  const moneyhand = {
    async request() {},
    async beginTaskContext() { return { taskSpaceId: "terminal-timeout-task" }; },
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async completeTaskContext() {
      ordering.push("cleanup");
      return { cleanupComplete: true };
    },
    async inspectTaskBlocker(options) {
      inspections.push(options);
      ordering.push("visual");
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: join(directory, "terminal-timeout.png") },
        actionReplayed: false,
      };
    },
  };

  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      timeoutMs: 30,
      abortGraceMs: 100,
      onProgress: async (event) => progressEvents.push(event),
    }),
    (error) => error?.code === "TASK_TIMEOUT"
      && error?.details?.visualFallback?.captured === true
      && error?.details?.cleanupComplete === true,
  );
  assert.equal(inspections.length, 1);
  assert.deepEqual(ordering, ["visual", "cleanup"]);
  assert.equal(inspections[0].operation, "task-deadline");
  assert.equal(inspections[0].reason.code, "TASK_TIMEOUT");
  assert.equal(progressEvents.some((event) => (
    event.state === "visual_fallback" && event.phase === "timeout"
  )), true);
  assert.equal(progressEvents.at(-1).state, "failed");
});

test("runMoneyHandTask captures an incomplete terminal result before closing its task page", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-incomplete-visual-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  await moneyhand.beginTaskContext({ id: 'terminal-incomplete-task' });",
    "  return { outcome: { status: 'incomplete', reason: 'EXPECTED_RECORD_MISSING' } };",
    "}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  const moneyhand = {
    async request() {},
    async beginTaskContext() { return { taskSpaceId: "terminal-incomplete-task" }; },
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async inspectTaskBlocker(options) {
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        trigger: options.reason,
        screenshot: { path: join(directory, "terminal-incomplete.png") },
        actionReplayed: false,
      };
    },
  };

  const result = await runMoneyHandTask({
    moneyhand,
    taskPath,
    onProgress: async (event) => progressEvents.push(event),
  });
  assert.equal(result.outcome.status, "incomplete");
  assert.equal(result.visualFallback.captured, true);
  assert.equal(result.visualFallback.trigger.code, "EXPECTED_RECORD_MISSING");
  assert.equal(progressEvents.some((event) => event.phase === "terminal"), true);
  assert.equal(progressEvents.at(-1).state, "completed");
});

test("runMoneyHandTask does not repeat a successful template terminal screenshot after cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-template-visual-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'template-incomplete-task' });",
    "  const visualFallback = await moneyhand.inspectTaskBlocker({",
    "    taskSpaceId: task.taskSpaceId,",
    "    operation: 'task-terminal',",
    "    reason: { code: 'EXPECTED_RECORD_MISSING', message: 'Expected record missing' },",
    "  });",
    "  await moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });",
    "  return { outcome: { status: 'incomplete', reason: 'EXPECTED_RECORD_MISSING', visualFallback } };",
    "}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  let inspections = 0;
  const moneyhand = {
    async request() {},
    async beginTaskContext() { return { taskSpaceId: "template-incomplete-task" }; },
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async completeTaskContext() { return { cleanupComplete: true }; },
    async inspectTaskBlocker(options) {
      inspections += 1;
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        trigger: options.reason,
        screenshot: { path: join(directory, "template-incomplete.png") },
        actionReplayed: false,
      };
    },
  };

  const result = await runMoneyHandTask({
    moneyhand,
    taskPath,
    onProgress: async (event) => progressEvents.push(event),
  });
  assert.equal(result.outcome.status, "incomplete");
  assert.equal(result.outcome.visualFallback.captured, true);
  assert.equal(inspections, 1);
  assert.equal(progressEvents.some((event) => event.phase === "terminal"), false);
  assert.equal(progressEvents.at(-1).state, "completed");
});

test("runMoneyHandTask keeps the watchdog responsive while synchronous task code is isolated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-blocked-loop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, progress }) {",
    "  const task = await moneyhand.beginTaskContext({ id: 'blocked-loop-task' });",
    "  try {",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45);",
    "    await progress({ phase: 'recovered', message: 'Task resumed after a synchronous block' });",
    "    return { status: 'complete', requirements: [{ id: 'recovered-complete', satisfied: true }] };",
    "  } finally {",
    "    await moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });",
    "  }",
    "}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  let inspections = 0;
  let activeInspections = 0;
  const ordering = [];
  const moneyhand = {
    async request() {},
    async beginTaskContext() { return { taskSpaceId: "blocked-loop-task" }; },
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async completeTaskContext() {
      assert.equal(activeInspections, 0);
      ordering.push("cleanup");
      return { cleanupComplete: true };
    },
    async inspectTaskBlocker() {
      inspections += 1;
      activeInspections += 1;
      ordering.push("visual");
      await new Promise((resolve) => setTimeout(resolve, inspections === 1 ? 25 : 80));
      activeInspections -= 1;
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: join(directory, "blocked-loop.png") },
        actionReplayed: false,
      };
    },
  };

  const result = await runMoneyHandTask({
    moneyhand,
    taskPath,
    progressIntervalMs: 10,
    visualSilenceMs: 20,
    onProgress: async (event) => progressEvents.push(event),
  });
  assert.equal(result.status, "complete");
  assert.equal(inspections, 1);
  assert.deepEqual(ordering, ["visual", "cleanup"]);
  assert.equal(progressEvents.some((event) => (
    event.state === "visual_fallback" && event.phase === "watchdog"
  )), true);
  assert.equal(progressEvents.at(-1).state, "completed");
});

test("runMoneyHandTask starts monitoring before a task module import can hang", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-import-watchdog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "await new Promise(() => {});",
    "export async function run() {}",
  ].join("\n"), "utf8");
  const progressEvents = [];
  const moneyhand = {
    async request() {},
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
  };

  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      timeoutMs: 40,
      abortGraceMs: 20,
      progressIntervalMs: 10,
      visualSilenceMs: 20,
      onProgress: async (event) => progressEvents.push(event),
    }),
    (error) => error?.code === "TASK_TIMEOUT"
      && error?.details?.taskAcknowledgedAbort === false
      && error?.details?.controllerReusable === false,
  );
  assert.equal(progressEvents[0].state, "started");
  assert.equal(progressEvents.some((event) => event.phase === "heartbeat"), true);
  assert.equal(progressEvents.at(-1).state, "failed");
});

test("runMoneyHandTask fails closed when mandatory progress cannot be delivered", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-progress-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run() {",
    "  await new Promise((resolve) => setTimeout(resolve, 50));",
    "  return { status: 'complete', requirements: [{ id: 'output-complete', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  const moneyhand = { async request() {} };

  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      onProgress: async () => {
        throw new Error("host progress channel closed");
      },
    }),
    (error) => error?.code === "TASK_PROGRESS_OUTPUT_FAILED"
      && error?.details?.cause?.message === "host progress channel closed",
  );
});

test("runMoneyHandTask always reclaims task windows created by the task module", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  await moneyhand.createTaskSpace({ id: 'task-window' });",
    "  return { status: 'complete', requirements: [{ id: 'cleanup-complete', satisfied: true }] };",
    "}",
  ].join("\n"), "utf8");
  const cleanups = [];
  const moneyhand = {
    created: [],
    async request() {},
    async createTaskSpace(options) {
      this.created.push(options.id);
      return { id: options.id };
    },
    ownedTaskWindowIds() {
      return [...this.created];
    },
    async cleanupOwnedTaskWindows(options) {
      cleanups.push(options);
      this.created = this.created.filter((id) => !options.taskIds.includes(id));
      return { ok: true, attempted: options.taskIds.length, results: [] };
    },
  };
  const result = await runMoneyHandTask({ moneyhand, taskPath });
  assert.deepEqual(result, {
    status: "complete",
    requirements: [{ id: "cleanup-complete", satisfied: true }],
  });
  assert.deepEqual(cleanups, [{ taskIds: ["task-window"] }]);
  assert.deepEqual(moneyhand.created, []);
});

test("controller stop adopts an exact bootstrap marker after capture throws", async () => {
  const connection = {
    launched: true,
    session: {
      profile: "bootstrap-profile",
      instanceId: "bootstrap-instance",
      bootId: "bootstrap-boot",
    },
    browser: {
      bootstrapMarker: "about:blank#npc-moneyhand-bootstrap=fixture-marker",
    },
  };
  let bootstrapWindow = moneyhandTest.provisionalControllerBootstrapWindow(connection);
  assert.deepEqual(bootstrapWindow, {
    marker: connection.browser.bootstrapMarker,
    selector: {
      profile: connection.session.profile,
      instanceId: connection.session.instanceId,
      bootId: connection.session.bootId,
    },
    provisional: true,
  });
  const calls = [];
  let phase = "capture";
  let stopped = false;
  const moneyhand = {
    async request(request, options) {
      calls.push({ request, options });
      if (phase === "capture") throw new Error("capture inspection failed");
      if (request.params.method === "windows.getAll") {
        return {
          ok: true,
          result: {
            method: "windows.getAll",
            result: [{
              id: 17,
              type: "normal",
              tabs: [{ id: 71, windowId: 17, url: connection.browser.bootstrapMarker }],
            }],
          },
        };
      }
      assert.equal(request.params.method, "tabs.remove");
      assert.deepEqual(request.params.args, [71]);
      return { ok: true, result: { method: "tabs.remove", result: null } };
    },
    async stop(options) {
      assert.deepEqual(options, { graceMs: 0 });
      stopped = true;
    },
  };

  await assert.rejects(
    async () => {
      bootstrapWindow = await moneyhandTest.captureControllerBootstrapWindow(
        moneyhand,
        bootstrapWindow,
      );
    },
    /capture inspection failed/u,
  );
  assert.equal(bootstrapWindow.provisional, true);
  assert.equal(bootstrapWindow.windowId, undefined);
  phase = "stop";
  await moneyhandTest.stopControllerMoneyHand(moneyhand, bootstrapWindow, 1_000);
  assert.equal(stopped, true);
  assert.deepEqual(
    calls.slice(1).map((entry) => entry.request.params.method),
    ["windows.getAll", "tabs.remove"],
  );
  assert.deepEqual(calls[1].options.selector, bootstrapWindow.selector);

  const changedCalls = [];
  const changed = await moneyhandTest.closeControllerBootstrapWindow({
    async request(request) {
      changedCalls.push(request.params.method);
      if (request.params.method === "tabs.remove") {
        assert.deepEqual(request.params.args, [72]);
        return { ok: true, result: { method: "tabs.remove", result: null } };
      }
      return {
        ok: true,
        result: {
          method: "windows.getAll",
          result: [{
            id: 18,
            type: "normal",
            tabs: [
              { id: 72, windowId: 18, url: connection.browser.bootstrapMarker },
              { id: 73, windowId: 18, url: "https://user.example/" },
            ],
          }],
        },
      };
    },
  }, moneyhandTest.provisionalControllerBootstrapWindow(connection));
  assert.equal(changed.ok, true);
  assert.equal(changed.windowId, 18);
  assert.equal(changed.tabId, 72);
  assert.deepEqual(changedCalls, ["windows.getAll", "tabs.remove"]);
});

test("controller commands retain provisional bootstrap ownership when first inspection is unreadable", async () => {
  const connection = {
    launched: true,
    session: {
      profile: "bootstrap-profile",
      instanceId: "bootstrap-instance",
      bootId: "bootstrap-boot",
    },
    browser: {
      bootstrapMarker: "about:blank#npc-moneyhand-bootstrap=connect-race",
    },
  };
  const provisional = moneyhandTest.provisionalControllerBootstrapWindow(connection);
  const inspectionError = Object.assign(new Error("bootstrap tab not readable yet"), {
    code: "TARGET_NOT_READY",
  });
  const moneyhand = {
    async request() {
      throw inspectionError;
    },
  };

  const retained = await moneyhandTest.captureControllerBootstrapWindowForCommand(
    moneyhand,
    provisional,
    undefined,
    "connect",
  );
  assert.equal(retained, provisional);
  assert.equal(retained.provisional, true);
  assert.equal(retained.windowId, undefined);

  const retainedForTask = await moneyhandTest.captureControllerBootstrapWindowForCommand(
    moneyhand,
    provisional,
    undefined,
    "task",
  );
  assert.equal(retainedForTask, provisional);
  assert.equal(retainedForTask.provisional, true);

  await assert.rejects(
    moneyhandTest.captureControllerBootstrapWindowForCommand({
      async request() {
        return {
          ok: true,
          result: {
            method: "windows.getAll",
            result: [17, 18].map((id) => ({
              id,
              type: "normal",
              tabs: [{ id: id + 100, windowId: id, url: connection.browser.bootstrapMarker }],
            })),
          },
        };
      },
    }, provisional, undefined, "task"),
    (error) => error?.code === "BOOTSTRAP_WINDOW_AMBIGUOUS",
  );
});

test("controller connect does not swallow cancellation during bootstrap inspection", async () => {
  const connection = {
    launched: true,
    session: { profile: "profile", instanceId: "instance", bootId: "boot" },
    browser: { bootstrapMarker: "about:blank#npc-moneyhand-bootstrap=cancelled" },
  };
  const provisional = moneyhandTest.provisionalControllerBootstrapWindow(connection);
  const controller = new AbortController();
  const reason = new Error("controller client disconnected");
  controller.abort(reason);

  await assert.rejects(
    moneyhandTest.captureControllerBootstrapWindowForCommand({
      async request() {
        throw Object.assign(new Error("inspection aborted"), { code: "ABORTED" });
      },
    }, provisional, controller.signal, "connect"),
    (error) => error === reason,
  );
});

test("controller bootstrap cleanup waits out a transient exclusive-window BUSY result", async () => {
  const marker = "about:blank#npc-moneyhand-bootstrap=busy-settle";
  const record = {
    marker,
    selector: { profile: "profile", instanceId: "instance", bootId: "boot" },
    windowId: 27,
    tabId: 72,
    provisional: false,
  };
  let busy = true;
  const methods = [];
  const moneyhand = {
    async request(request) {
      methods.push(request.params.method);
      if (busy) {
        busy = false;
        return {
          ok: false,
          error: {
            code: "BUSY",
            message: "Browser work conflicts with an exclusive window mutation",
          },
        };
      }
      if (request.params.method === "windows.getAll") {
        return {
          ok: true,
          result: {
            method: "windows.getAll",
            result: [{
              id: 27,
              type: "normal",
              tabs: [{ id: 72, windowId: 27, url: marker }],
            }],
          },
        };
      }
      return { ok: true, result: { method: "tabs.remove", result: null } };
    },
  };

  const result = await moneyhandTest.closeControllerBootstrapWindow(moneyhand, record);
  assert.equal(result.ok, true);
  assert.deepEqual(methods, ["windows.getAll", "windows.getAll", "tabs.remove"]);
});

test("controller bootstrap cleanup treats a missing provisional marker as already closed", async () => {
  const record = {
    marker: "about:blank#npc-moneyhand-bootstrap=already-gone",
    selector: { profile: "profile", instanceId: "instance", bootId: "boot" },
    provisional: true,
  };
  const methods = [];
  const result = await moneyhandTest.closeControllerBootstrapWindow({
    async request(request) {
      methods.push(request.params.method);
      return {
        ok: true,
        result: {
          method: "windows.getAll",
          result: [{
            id: 31,
            type: "normal",
            tabs: [{ id: 81, windowId: 31, url: "https://user.example/" }],
          }],
        },
      };
    },
  }, record);
  assert.deepEqual(result, {
    attempted: true,
    ok: true,
    alreadyClosed: true,
    provisional: true,
  });
  assert.deepEqual(methods, ["windows.getAll"]);
});

test("runMoneyHandTask injects the task abort signal into high-level calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-signal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  return await moneyhand.navigateTaskTab({ taskSpaceId: 'signal-task' });",
    "}",
  ].join("\n"), "utf8");
  const controller = new AbortController();
  let observedSignal;
  const moneyhand = {
    async request() {},
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
    async navigateTaskTab(options) {
      observedSignal = options.signal;
      if (options.signal.aborted) throw options.signal.reason;
      await new Promise((resolvePromise, rejectPromise) => {
        options.signal.addEventListener("abort", () => rejectPromise(options.signal.reason), {
          once: true,
        });
      });
    },
  };
  const running = runMoneyHandTask({ moneyhand, taskPath, signal: controller.signal });
  const reason = new Error("controller client disconnected");
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason, reason);
});

test("runMoneyHandTask aborts every blocking task helper but keeps control cleanup unscoped", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-helper-signals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  await moneyhand.completeTaskContext({ taskSpaceId: 'control-cleanup' });",
    "  await Promise.all([",
    "    moneyhand.waitForTaskPage({ taskSpaceId: 'wait-page' }),",
    "    moneyhand.createTaskSpace({ id: 'create-space' }),",
    "    moneyhand.execute({ op: 'waitForTaskPage', taskSpaceId: 'execute-wait' }),",
    "    moneyhand.rateControl({ action: 'wait', input: {} }),",
    "  ]);",
    "}",
  ].join("\n"), "utf8");
  const observed = new Map();
  const blocking = (name, options) => {
    observed.set(name, options.signal);
    return new Promise((resolvePromise, rejectPromise) => {
      if (options.signal?.aborted) {
        rejectPromise(options.signal.reason);
        return;
      }
      options.signal?.addEventListener("abort", () => rejectPromise(options.signal.reason), {
        once: true,
      });
    });
  };
  let controlSignal = "not-called";
  let cleanupSignal = "not-called";
  const moneyhand = {
    async request() {},
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows(options) {
      cleanupSignal = options.signal;
      return { ok: true, attempted: 0, results: [] };
    },
    async completeTaskContext(options) {
      controlSignal = options.signal;
      return { cleanupComplete: true };
    },
    waitForTaskPage(options) { return blocking("waitForTaskPage", options); },
    createTaskSpace(options) { return blocking("createTaskSpace", options); },
    execute(options) { return blocking("execute", options); },
    rateControl(options) { return blocking("rateControl", options); },
  };

  await assert.rejects(
    runMoneyHandTask({ moneyhand, taskPath, timeoutMs: 30, abortGraceMs: 100 }),
    (error) => error.code === "TASK_TIMEOUT"
      && error.details.taskAcknowledgedAbort === true
      && error.details.controllerReusable === true,
  );
  assert.deepEqual([...observed.keys()].sort(), [
    "createTaskSpace",
    "execute",
    "rateControl",
    "waitForTaskPage",
  ]);
  for (const signal of observed.values()) assert.equal(signal.aborted, true);
  assert.equal(controlSignal, undefined);
  assert.equal(cleanupSignal, undefined);
});

test("runMoneyHandTask returns one TASK_TIMEOUT after abort-aware cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ signal }) {",
    "  await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));",
    "}",
  ].join("\n"), "utf8");
  let cleanupCalls = 0;
  const moneyhand = {
    async request() {},
    ownedTaskWindowIds() { return ["owned-timeout-window"]; },
    async cleanupOwnedTaskWindows() {
      cleanupCalls += 1;
      return { ok: true, attempted: 1, results: [] };
    },
  };

  await assert.rejects(
    runMoneyHandTask({ moneyhand, taskPath, timeoutMs: 20, abortGraceMs: 50 }),
    (error) => error.code === "TASK_TIMEOUT"
      && error.details.taskAcknowledgedAbort === true
      && error.details.cleanupComplete === true
      && error.details.controllerReusable === true,
  );
  assert.equal(cleanupCalls, 1);
});

test("runMoneyHandTask fails closed when a task ignores abort", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-unresponsive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(
    taskPath,
    "export async function run() { await new Promise(() => {}); }\n",
    "utf8",
  );
  let failClosed = false;
  const moneyhand = {
    async request() {},
    ownedTaskWindowIds() { return []; },
    async cleanupOwnedTaskWindows() { return { ok: true, attempted: 0, results: [] }; },
  };

  await assert.rejects(
    runMoneyHandTask({
      moneyhand,
      taskPath,
      timeoutMs: 20,
      abortGraceMs: 20,
      onUnresponsive() { failClosed = true; },
    }),
    (error) => error.code === "TASK_TIMEOUT"
      && error.details.taskAcknowledgedAbort === false
      && error.details.cleanupComplete === true
      && error.details.controllerReusable === false,
  );
  assert.equal(failClosed, true);
});

test("non-retained task spaces do not exhaust a resident controller", () => {
  const spaces = new TaskSpaceRegistry({ maximum: 2 });
  for (let index = 0; index < 10; index += 1) {
    const id = `resident-task-${index}`;
    spaces.create({
      id,
      selector: { instanceId: "instance", bootId: "boot" },
      tabIds: [index + 1],
    });
    const completed = spaces.complete(id, { keep: false });
    assert.equal(completed.state, "complete");
    assert.equal(completed.keep, false);
  }
  assert.deepEqual(spaces.list(), []);
});

test("MoneyHand advertises the shortest read-only data acquisition policy", async () => {
  const contract = JSON.parse(await readFile(new URL(
    "../skills/npc-moneyhand/references/moneyhand-contract.json",
    import.meta.url,
  ), "utf8"));
  const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 0 });
  const policy = moneyhand.capabilities().agentPolicy.dataAcquisition;
  const capabilities = moneyhand.capabilities();

  assert.deepEqual(policy, contract.agentPolicy.dataAcquisition);
  assert.deepEqual(capabilities.operations.programmatic, contract.programmaticOperations);
  assert.deepEqual(capabilities.surfaceRouting, contract.surfaceRouting);
  assert.deepEqual(capabilities.taskRuntime.visualFallback, contract.taskRuntime.visualFallback);
  assert.deepEqual(capabilities.taskRuntime.progress, contract.taskRuntime.progress);
  assert.deepEqual(capabilities.transports.taskModule, contract.transports.taskModule);
  assert.equal(capabilities.taskRuntime.visualFallback.mode, "automatic-broad-page-anomaly");
  assert.equal(capabilities.taskRuntime.visualFallback.maximumAutomaticCapturesPerTask, 120);
  assert.equal(capabilities.taskRuntime.visualFallback.hidesWaitIdTabIdAndBase64, true);
  assert.equal(capabilities.taskRuntime.visualFallback.actionReplay, false);
  assert.equal(capabilities.semanticObservation.defaultMode, "accessibility");
  assert.equal(contract.semanticObservation.domSnapshotDefault, false);
  assert.deepEqual(
    capabilities.semanticObservation.locatorWait,
    contract.semanticObservation.locatorWait,
  );
  assert.deepEqual(
    capabilities.semanticObservation.locatorAction,
    contract.semanticObservation.locatorAction,
  );
  assert.deepEqual(
    capabilities.semanticObservation.refActions,
    contract.semanticObservation.refActions,
  );
  assert.deepEqual(
    capabilities.semanticObservation.frameScope,
    contract.semanticObservation.frameScope,
  );
  assert.deepEqual(capabilities.pageTransitions, contract.pageTransitions);
  assert.deepEqual(capabilities.taskRuntime, contract.taskRuntime);
  assert.equal(capabilities.semanticObservation.oopif, contract.semanticObservation.oopifBoundary);
  assert.equal(policy.objective, "minimum-total-elapsed-time");
  assert.equal(policy.defaultBehaviorMode, "raw");
  assert.equal(policy.pilot.requiredBeforeScale, true);
  assert.equal(policy.pilot.scale, "gradual-batch-and-concurrency-ramp");
  assert.equal(policy.rateControl.mode, "adaptive");
  assert.ok(policy.rateControl.signals.includes("http-429"));
  assert.ok(policy.rateControl.onThrottle.includes("honor-retry-after"));
  assert.ok(policy.rateControl.onThrottle.includes("increase-interval-exponentially-with-jitter"));
  assert.ok(policy.rateControl.stopSignals.includes("access-challenge"));
  assert.equal(
    capabilities.rateControl.enforcement,
    "task-runtime-auto-gate-plus-explicit-specialized-scheduler",
  );
  assert.equal(capabilities.rateControl.taskRuntimeImplicitGate, true);
  assert.equal(capabilities.rateControl.implicitRequestGate, false);
  assert.equal(capabilities.rateControl.humanBypassesRateControl, false);
  assert.deepEqual(policy.orderedPlanes, [
    "existing-structured-data",
    "cdp-network-json",
    "same-session-readonly-replay",
    "cdp-runtime-dom-batch",
    "browser-ui-lazy-load",
    "explicit-screenshot",
  ]);
  assert.equal(policy.rules.rankEligiblePlanesOnly, true);
  assert.equal(policy.rules.technicalAccessDoesNotGrantAuthorization, true);
  assert.equal(policy.rules.readOnlyByDefault, true);
  assert.equal(policy.rules.replayOnlyKnownReadOnlyRequests, true);
  assert.equal(policy.rules.screenshotLastResort, true);
});

test("MoneyHand forwards a cancellation signal only to the blocking rate-control wait", async () => {
  const calls = [];
  const rateController = {
    async wait(value, options) {
      calls.push({ action: "wait", value, options });
      return { allowed: true };
    },
    plan(value) {
      calls.push({ action: "plan", value });
      return { allowed: true };
    },
  };
  const moneyhand = createMoneyHand({ rateController });
  const abortController = new AbortController();
  await moneyhand.rateControl({
    action: "wait",
    input: { scope: { origin: "https://example.test", profile: "Default" } },
    signal: abortController.signal,
  });
  await moneyhand.rateControl({
    action: "plan",
    input: { scope: { origin: "https://example.test", profile: "Default" } },
    signal: abortController.signal,
  });
  assert.equal(calls[0].options.signal, abortController.signal);
  assert.equal(Object.hasOwn(calls[0].value, "signal"), false);
  assert.equal(Object.hasOwn(calls[1].value, "signal"), false);
});

test("the real-browser checkable fixture is local, binary, and event-auditable", async () => {
  const source = await readFile(new URL(
    "../scripts/fixtures/moneyhand-checkable.html",
    import.meta.url,
  ), "utf8");
  assert.match(source, /id="native" type="checkbox"/u);
  assert.match(source, /role="switch" aria-checked="false"/u);
  assert.match(source, /fixtureEvents/u);
  assert.match(source, /isTrusted/u);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|type="password"|<form\b/iu);
});

function extensionHello(options = {}) {
  return {
    v: 2,
    type: "hello",
    protocol: PROTOCOL,
    product: "npc-moneyhand",
    profile: options.profile ?? "npc-instance_0001",
    instanceId: options.instanceId ?? "instance_0001",
    bootId: options.bootId ?? "boot_0000001",
    version: "2.0.0-alpha.10",
    auth: { mode: "none" },
    focus: options.focus ?? { windowId: 1, focused: true, lastFocusedAt: 1 },
    browser: { platform: { os: "win" } },
    unknownOutcomeIds: options.unknownOutcomeIds ?? [],
    capabilities: options.capabilities ?? {
      coordinateContract: COORDINATE_SPACE,
    },
  };
}

async function startMoneyHand(t, options = {}) {
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
    ...options,
  });
  await moneyhand.start();
  t.after(() => moneyhand.stop({ graceMs: 0 }));
  return moneyhand;
}

async function connectExtension(moneyhand, t, hello = extensionHello()) {
  const waiting = moneyhand.wait({
    selector: { profile: hello.profile },
    timeoutMs: 1_000,
  });
  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: moneyhand.peer.boundPort,
    path: moneyhand.peer.path,
  });
  t.after(() => opened.client.destroy());
  assert.equal(opened.response.status, 101);
  opened.client.sendJson(hello);
  const ready = await opened.client.nextJson();
  assert.equal(ready.type, "ready");
  const ping = await opened.client.nextJson();
  assert.equal(ping.type, "ping");
  opened.client.sendJson({
    v: 2,
    type: "pong",
    timestamp: ping.timestamp,
  });
  return {
    client: opened.client,
    hello,
    ready,
    session: await waiting,
  };
}

function respond(client, request, value) {
  client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ...value,
  });
}

function outputCollector(stream) {
  let data = "";
  stream.on("data", (chunk) => {
    data += chunk.toString("utf8");
  });
  return () => data
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  PNG_SIGNATURE.copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function layoutMetrics(width = 100, height = 50) {
  return {
    cssLayoutViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: width,
      clientHeight: height,
    },
    cssVisualViewport: {
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      clientWidth: width,
      clientHeight: height,
      scale: 1,
      zoom: 1,
    },
    cssContentSize: {
      x: 0,
      y: 0,
      width,
      height: height * 3,
    },
  };
}

function batchStep(index, method, result, tabId = 42) {
  return {
    index,
    method: "cdp.send",
    ok: true,
    result: {
      target: { tabId },
      method,
      result,
    },
  };
}

function requestedBatchStep(index, step, result) {
  return {
    index,
    method: "cdp.send",
    ok: true,
    result: {
      target: step.params.target,
      method: step.params.method,
      result,
    },
  };
}

function respondCdp(client, request, result) {
  assert.equal(request.method, "cdp.send");
  respond(client, request, {
    ok: true,
    result: {
      target: request.params.target,
      method: request.params.method,
      result,
    },
  });
}

function semanticFrame(loaderId = "loader-semantic", url = "https://example.test/app") {
  return { frameTree: { frame: { id: "root", loaderId, url } } };
}

function respondTaskPageState(client, request, options = {}) {
  assert.equal(request.method, "batch.run");
  assert.equal(request.params.continueOnError, true);
  assert.deepEqual(
    request.params.steps.map((step) => step.params.method),
    ["Page.getFrameTree", "Runtime.evaluate"],
  );
  assert.equal(
    request.params.steps[1].params.params.expression,
    "({ readyState: document.readyState })",
  );
  const tabId = options.tabId ?? 42;
  respond(client, request, {
    ok: true,
    result: {
      completed: 2,
      total: 2,
      results: [
        batchStep(0, "Page.getFrameTree", semanticFrame(
          options.loaderId ?? "loader-page",
          options.url ?? "https://example.test/",
        ), tabId),
        batchStep(1, "Runtime.evaluate", {
          result: {
            type: "object",
            value: { readyState: options.readyState ?? "complete" },
          },
        }, tabId),
      ],
    },
  });
}

async function beginOwnedTaskContext(moneyhand, client, options = {}) {
  const id = options.id ?? "owned-task";
  const windowId = options.windowId ?? 7;
  const tabId = options.tabId ?? 42;
  const beginning = moneyhand.beginTaskContext({
    id,
    behavior: options.behavior ?? "raw",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: windowId, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: windowId,
        type: "normal",
        tabs: [{ id: tabId, windowId, active: true, url: marker, status: "complete" }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, options.behavior === "human" ? "behavior.set" : "behavior.reset");
  respond(client, request, {
    ok: true,
    result: {
      behavior: { mode: options.behavior === "human" ? "human" : "raw" },
      expiresAt: null,
    },
  });
  return { task: await beginning, marker, windowId, tabId };
}

function rootSemanticFrameTree() {
  return semanticFrame("loader-root", "https://example.test/app");
}

function nestedRootSemanticFrameTree() {
  return {
    frameTree: {
      frame: {
        id: "root",
        loaderId: "loader-root",
        url: "https://example.test/app",
      },
      childFrames: [{
        frame: {
          id: "middle-frame",
          parentId: "root",
          loaderId: "loader-middle",
          url: "https://example.test/middle",
        },
      }],
    },
  };
}

function childSemanticFrameTree(parentFrameId = "root") {
  return {
    frameTree: {
      frame: {
        id: "child-frame",
        parentId: parentFrameId,
        loaderId: "loader-child",
        url: "https://frame.example.test/form",
      },
    },
  };
}

function middleOopifFrameTree() {
  return {
    frameTree: {
      frame: {
        id: "middle-frame",
        parentId: "root",
        loaderId: "loader-middle",
        url: "https://middle.example.test/frame",
      },
    },
  };
}

function semanticFrameSessions(parentFrameId = "root") {
  return {
    tabId: 42,
    sessions: [{
      sessionId: "child-session",
      parentSessionId: undefined,
      autoAttachConfigured: true,
      targetInfo: {
        type: "iframe",
        targetId: "child-target",
        parentFrameId,
        url: "https://frame.example.test/form",
      },
    }],
  };
}

function nestedOopifFrameSessions() {
  return {
    tabId: 42,
    sessions: [{
      sessionId: "middle-session",
      parentSessionId: undefined,
      autoAttachConfigured: true,
      targetInfo: {
        type: "iframe",
        targetId: "middle-target",
        parentFrameId: "root",
        url: "https://middle.example.test/frame",
      },
    }, {
      sessionId: "child-session",
      parentSessionId: "middle-session",
      autoAttachConfigured: true,
      targetInfo: {
        type: "iframe",
        targetId: "child-target",
        parentFrameId: "middle-frame",
        url: "https://frame.example.test/form",
      },
    }],
  };
}

async function captureSemanticFixture(moneyhand, client, options = {}) {
  const promise = moneyhand.captureSemanticSnapshot({
    tabId: options.tabId ?? 42,
    maxNodes: 20,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  const frameTree = semanticFrame(
    options.loaderId ?? "loader-semantic",
    options.url ?? "https://example.test/app",
  );
  respond(client, request, {
    ok: true,
    result: {
      completed: 3,
      total: 3,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree, options.tabId ?? 42),
        batchStep(1, "Accessibility.getFullAXTree", {
          nodes: options.nodes ?? [{
            nodeId: options.axNodeId ?? "ax-target",
            backendDOMNodeId: options.backendNodeId ?? 84,
            ignored: false,
            role: { value: options.role ?? "button" },
            name: { value: options.name ?? "Continue" },
            properties: [],
          }],
        }, options.tabId ?? 42),
        batchStep(2, "Page.getFrameTree", frameTree, options.tabId ?? 42),
      ],
    },
  });
  return (await promise).snapshot;
}

async function captureFrameSemanticFixture(moneyhand, client, options = {}) {
  const rootTree = options.rootTree ?? rootSemanticFrameTree();
  const childTree = options.childTree ?? childSemanticFrameTree();
  const sessions = options.sessions ?? semanticFrameSessions();
  const targetTrees = options.targetTrees ?? [{ sessionId: "child-session", tree: childTree }];
  const treeBySession = new Map(targetTrees.map((entry) => [entry.sessionId, entry.tree]));
  const axByFrame = options.axByFrame ?? new Map([
    ["root", {
      nodeId: "ax-main",
      backendDOMNodeId: 41,
      frameId: "root",
      role: { value: "heading" },
      name: { value: "Checkout" },
      properties: [],
    }],
    ["middle-frame", {
      nodeId: "ax-middle",
      backendDOMNodeId: 61,
      frameId: "middle-frame",
      role: { value: "button" },
      name: { value: "Continue in frame" },
      properties: [],
    }],
    ["child-frame", {
      nodeId: "ax-child",
      backendDOMNodeId: 84,
      frameId: "child-frame",
      role: { value: "button" },
      name: { value: "Continue" },
      properties: [],
    }],
  ]);
  const promise = moneyhand.captureSemanticSnapshot({
    tabId: 42,
    maxNodes: 20,
    includeFrames: true,
    maxFrames: 8,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.method, "target.attach");
  assert.deepEqual(request.params, { tabId: 42, autoAttachFrames: true });
  respond(client, request, {
    ok: true,
    result: { tabId: 42, attached: true, autoAttachFrames: true },
  });

  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, rootTree);

  for (let index = 0; index < 3; index += 1) {
    request = await client.nextJson();
    assert.equal(request.method, "target.sessions");
    respond(client, request, { ok: true, result: sessions });
  }

  if (targetTrees.length > 0) {
    request = await client.nextJson();
    assert.equal(request.method, "batch.run");
    assert.equal(request.params.steps.length, targetTrees.length);
    assert.deepEqual(
      request.params.steps.map((step) => step.params.target),
      targetTrees.map((entry) => ({ tabId: 42, sessionId: entry.sessionId })),
    );
    respond(client, request, {
      ok: true,
      result: {
        completed: targetTrees.length,
        total: targetTrees.length,
        results: request.params.steps.map((step, index) => requestedBatchStep(
          index,
          step,
          treeBySession.get(step.params.target.sessionId),
        )),
      },
    });
  }

  request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  const steps = request.params.steps;
  const treeSteps = steps.filter((step) => step.params.method === "Page.getFrameTree");
  const axSteps = steps.filter((step) => step.params.method === "Accessibility.getFullAXTree");
  assert.equal(treeSteps.length, 2 * (1 + targetTrees.length));
  assert.deepEqual(treeSteps[0].params.target, { tabId: 42 });
  assert.deepEqual(
    treeSteps.slice(1, 1 + targetTrees.length).map((step) => step.params.target),
    targetTrees.map((entry) => ({ tabId: 42, sessionId: entry.sessionId })),
  );
  assert.deepEqual(
    axSteps.map((step) => step.params.params.frameId),
    options.frameIds ?? ["root", "child-frame"],
  );
  respond(client, request, {
    ok: true,
    result: {
      completed: steps.length,
      total: steps.length,
      results: steps.map((step, index) => {
        if (step.params.method === "Page.getFrameTree") {
          const value = step.params.target.sessionId
            ? treeBySession.get(step.params.target.sessionId)
            : rootTree;
          return requestedBatchStep(index, step, value);
        }
        const frameId = step.params.params.frameId;
        const frameNodes = axByFrame.get(frameId);
        return requestedBatchStep(index, step, {
          nodes: Array.isArray(frameNodes) ? frameNodes : [frameNodes],
        });
      }),
    },
  });

  request = await client.nextJson();
  assert.equal(request.method, "target.sessions");
  respond(client, request, { ok: true, result: sessions });
  return (await promise).snapshot;
}

async function createSemanticIsolatedWorld(client, executionContextId = 701) {
  const request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Page.createIsolatedWorld");
  assert.equal(request.params.params.frameId, "root");
  assert.equal(request.params.params.worldName, "npc-moneyhand.semantic-ref");
  respondCdp(client, request, { executionContextId });
}

async function respondSemanticTargetPreflight(client, value, frameTree = semanticFrame()) {
  let request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, frameTree);
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.match(request.params.params.functionDeclaration, /elementFromPoint/u);
  respondCdp(client, request, {
    result: { type: "object", value },
  });
}

async function respondSemanticFileInputPreflight(client, value, frameTree = semanticFrame()) {
  let request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, frameTree);
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.doesNotMatch(request.params.params.functionDeclaration, /elementFromPoint/u);
  assert.equal(Object.hasOwn(request.params.params, "arguments"), false);
  respondCdp(client, request, {
    result: { type: "object", value },
  });
}

function viewportBatchResults(options = {}) {
  const before = options.before ?? layoutMetrics();
  const after = options.after ?? before;
  const loaderBefore = options.loaderBefore ?? "loader-stable";
  const loaderAfter = options.loaderAfter ?? loaderBefore;
  const urlBefore = options.urlBefore ?? "https://example.test/a";
  const urlAfter = options.urlAfter ?? urlBefore;
  const image = options.image ?? pngHeader(200, 100);
  return [
    batchStep(0, "Page.getFrameTree", {
      frameTree: { frame: { id: "root", loaderId: loaderBefore, url: urlBefore } },
    }),
    batchStep(1, "Page.getLayoutMetrics", before),
    batchStep(2, "Runtime.evaluate", {
      result: {
        type: "object",
        value: {
          devicePixelRatio: 2,
          innerWidth: 100,
          innerHeight: 50,
          scrollX: 0,
          scrollY: 0,
          visualViewport: {
            offsetLeft: 0,
            offsetTop: 0,
            pageLeft: 0,
            pageTop: 0,
            width: 100,
            height: 50,
            scale: 1,
          },
        },
      },
    }),
    batchStep(3, "Page.captureScreenshot", { data: image.toString("base64") }),
    batchStep(4, "Page.getLayoutMetrics", after),
    batchStep(5, "Page.getFrameTree", {
      frameTree: { frame: { id: "root", loaderId: loaderAfter, url: urlAfter } },
    }),
  ];
}

function fullPageGuardResults(options = {}) {
  return [
    batchStep(0, "Page.getFrameTree", {
      frameTree: {
        frame: {
          id: "root",
          loaderId: options.loaderId ?? "loader-full-page",
          url: options.url ?? "https://example.test/full-page",
        },
      },
    }),
    batchStep(1, "Page.getLayoutMetrics", options.metrics ?? layoutMetrics(100, 50)),
  ];
}

test("MoneyHand keeps one Peer and routes each request to the latest focused Profile", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const first = await connectExtension(moneyhand, t, extensionHello({
    profile: "npc-profile-one",
    instanceId: "instance_profile_one",
    focus: { windowId: 11, focused: false, lastFocusedAt: 100 },
  }));
  const second = await connectExtension(moneyhand, t, extensionHello({
    profile: "npc-profile-two",
    instanceId: "instance_profile_two",
    focus: { windowId: 22, focused: true, lastFocusedAt: 200 },
  }));

  const firstRequest = moneyhand.request({ method: "system.status", params: {} });
  const sentToSecond = await second.client.nextJson();
  assert.equal(sentToSecond.method, "system.status");
  respond(second.client, sentToSecond, {
    ok: true,
    result: { selected: "two" },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await firstRequest).result, { selected: "two" });

  first.client.sendJson({
    v: 2,
    type: "event",
    seq: 1,
    event: "window.focused",
    target: { windowId: 11 },
    data: { focused: true, lastFocusedAt: 300 },
  });
  await waitFor(
    () => moneyhand.status().activeSession?.instanceId === "instance_profile_one",
  );

  const secondRequest = moneyhand.request({ method: "target.list", params: {} });
  const sentToFirst = await first.client.nextJson();
  assert.equal(sentToFirst.method, "target.list");
  respond(first.client, sentToFirst, {
    ok: true,
    result: { selected: "one" },
    meta: { durationMs: 0 },
  });
  assert.deepEqual((await secondRequest).result, { selected: "one" });
});

test("MoneyHand lifecycle preserves the final stop during concurrent restart calls", async () => {
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  await moneyhand.start();
  const firstPort = moneyhand.peer.boundPort;
  await Promise.all([
    moneyhand.stop({ graceMs: 0 }),
    moneyhand.start(),
    moneyhand.stop({ graceMs: 0 }),
  ]);
  assert.equal(moneyhand.peer.state, "STOPPED");
  assert.equal(moneyhand.peer.boundPort, undefined);

  const probe = await import("node:net").then(({ createServer }) => createServer());
  try {
    probe.listen({ host: "127.0.0.1", port: firstPort, exclusive: true });
    await once(probe, "listening");
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
});

test("MoneyHand reports a port conflict without disturbing the existing listener and can retry", async () => {
  const blocker = await import("node:net").then(({ createServer }) => createServer());
  blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(blocker, "listening");
  const port = blocker.address().port;
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  await assert.rejects(
    moneyhand.start(),
    (error) => error.code === "LISTEN_FAILED" && error.details?.code === "EADDRINUSE",
  );
  assert.equal(moneyhand.peer.state, "STOPPED");
  assert.equal(blocker.listening, true);

  await new Promise((resolve) => blocker.close(resolve));
  try {
    assert.equal(await moneyhand.start(), `ws://127.0.0.1:${port}/extension`);
  } finally {
    await moneyhand.stop({ graceMs: 0 });
  }
});

test("MoneyHand preserves Hand needs_instruction as a terminal value", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const terminalPromise = moneyhand.request({
    method: "future.unknown",
    params: {},
  });
  const request = await client.nextJson();
  const need = {
    waitId: "wait_1",
    target: { tabId: 42 },
    context: {
      text: "bounded",
      untrustedPageContent: true,
    },
  };
  respond(client, request, {
    ok: false,
    status: "needs_instruction",
    error: { code: "UNKNOWN_METHOD", message: "unknown" },
    need,
    meta: { durationMs: 1 },
  });

  const terminal = await terminalPromise;
  assert.equal(terminal.ok, false);
  assert.equal(terminal.status, "needs_instruction");
  assert.deepEqual(terminal.need, need);
});

test("inspectTaskBlocker captures bounded text and a local viewport image then resolves the private wait", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const space = await moneyhand.createTaskSpace({ id: "visual-blocker-task", tabIds: [42] });
  const image = pngHeader(240, 120);
  const inspecting = moneyhand.inspectTaskBlocker({
    taskSpaceId: space.id,
    operation: "actSemanticRef",
    reason: {
      code: "TARGET_OCCLUDED",
      message: "The semantic target is covered",
      actionDispatched: false,
    },
  });
  let request = await client.nextJson();
  assert.equal(request.method, "system.status");
  respond(client, request, {
    ok: true,
    result: {
      mode: "ws-only",
      behavior: { mode: "raw" },
      waiting: [{
        tabId: 42,
        waitId: "wait_private",
        since: "2026-08-20T00:00:00.000Z",
        error: "The semantic target is covered",
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "observe.context");
  assert.deepEqual(request.params.target, { tabId: 42 });
  respond(client, request, {
    ok: true,
    result: {
      target: { tabId: 42 },
      url: "https://example.test/thread",
      title: "Example thread",
      readyState: "complete",
      text: "A dialog covers the button",
      textTruncated: false,
      controls: [{ tag: "button", text: "Continue" }],
      contentTruncated: false,
      untrustedPageContent: true,
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "observe.screenshot");
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    format: "png",
    fullPage: false,
  });
  respond(client, request, {
    ok: true,
    result: {
      target: { tabId: 42 },
      mimeType: "image/png",
      data: image.toString("base64"),
    },
  });

  const evidence = await inspecting;
  t.after(() => rm(evidence.screenshot.path, { force: true }));
  assert.equal(evidence.schema, "npc-moneyhand-visual-fallback/1");
  assert.equal(evidence.captured, true);
  assert.equal(evidence.waitingForInstruction, true);
  assert.equal(evidence.actionReplayed, false);
  assert.equal(evidence.trigger.operation, "actSemanticRef");
  assert.equal(evidence.trigger.code, "TARGET_OCCLUDED");
  assert.equal(evidence.page.url, "https://example.test/thread");
  assert.equal(evidence.page.text, "A dialog covers the button");
  assert.equal(evidence.screenshot.mimeType, "image/png");
  assert.equal(evidence.screenshot.width, 240);
  assert.equal(evidence.screenshot.height, 120);
  assert.deepEqual(await readFile(evidence.screenshot.path), image);
  assert.equal("waitId" in evidence, false);
  assert.equal("tabId" in evidence, false);
  assert.equal("data" in evidence.screenshot, false);

  const resolving = moneyhand.resolveTaskBlocker({
    taskSpaceId: space.id,
    action: "resume",
  });
  request = await client.nextJson();
  assert.equal(request.method, "system.status");
  respond(client, request, {
    ok: true,
    result: {
      mode: "ws-only",
      behavior: { mode: "raw" },
      waiting: [{
        tabId: 42,
        waitId: "wait_private",
        since: "2026-08-20T00:00:00.000Z",
        error: "The semantic target is covered",
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "instruction.resolve");
  assert.deepEqual(request.params, {
    tabId: 42,
    waitId: "wait_private",
    action: "resume",
  });
  respond(client, request, {
    ok: true,
    result: {
      tabId: 42,
      waitId: "wait_private",
      action: "resume",
      waiting: false,
    },
  });
  assert.deepEqual(await resolving, {
    taskSpaceId: space.id,
    resolved: true,
    action: "resume",
    waitingForInstruction: false,
  });
  moneyhand.completeTaskSpace({ id: space.id, keep: false });
});

test("JSONL isolates malformed input, rejects reused command IDs, and nests Hand terminals", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 500,
    connectTimeoutMs: 1_000,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  const { client } = await connectExtension(moneyhand, t);

  input.write('{"id":"status-1","op":"sta');
  input.write('tus"}\r\n');
  input.write("{bad json}\n");
  input.write('{"id":"status-1","op":"status"}\n');
  input.write(
    `${JSON.stringify({
      id: "request-1",
      op: "request",
      request: { method: "system.status", params: {} },
    })}\n`,
  );
  input.write(
    `${JSON.stringify({
      id: "request-1",
      op: "request",
      request: { method: "system.status", params: {} },
    })}\n`,
  );
  input.write('{"id":"stop-bad","op":"shutdown","graceMs":999999}\n');
  input.write('{"id":"status-after-bad-stop","op":"status"}\n');

  const request = await client.nextJson();
  assert.equal(request.method, "system.status");
  respond(client, request, {
    ok: false,
    status: "needs_instruction",
    error: { code: "PAGE_UNCLEAR", message: "ask Agent" },
    need: { waitId: "wait_jsonl", context: { untrustedPageContent: true } },
    meta: { durationMs: 0 },
  });
  await waitFor(() => lines().some(
    (message) => message.id === "request-1" && message.ok === true,
  ));
  input.write('{"id":"stop-1","op":"shutdown","args":{"graceMs":0}}\n');
  await running;

  const messages = lines();
  assert.ok(messages.every((message) => message && typeof message === "object"));
  assert.equal(
    messages.find((message) => message.id === null)?.error.code,
    "INVALID_JSON",
  );
  const statusResults = messages.filter((message) => message.id === "status-1");
  assert.equal(statusResults.length, 2);
  assert.equal(statusResults.find((message) => message.ok === true)?.value.state, "RUNNING");
  assert.equal(
    statusResults.find((message) => message.ok === false)?.error.code,
    "ID_CONFLICT",
  );
  const requestResults = messages.filter((message) => message.id === "request-1");
  assert.equal(requestResults.length, 2);
  assert.equal(
    requestResults.find((message) => message.ok === true)?.value.status,
    "needs_instruction",
  );
  assert.equal(
    requestResults.find((message) => message.ok === false)?.error.code,
    "ID_CONFLICT",
  );
  assert.equal(
    messages.find((message) => message.id === "stop-1")?.value.stopped,
    true,
  );
  assert.equal(
    messages.find((message) => message.id === "stop-bad")?.error.code,
    "INVALID_COMMAND",
  );
  assert.equal(
    messages.find((message) => message.id === "status-after-bad-stop")?.ok,
    true,
  );
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("MoneyHand JSONL accepts canonical args and rejects ambiguous mixed fields", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 0 });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  input.end([
    JSON.stringify({
      id: "canonical-route",
      op: "routeSurface",
      args: { surface: "canvas" },
    }),
    JSON.stringify({
      id: "mixed-route",
      op: "routeSurface",
      args: { surface: "canvas" },
      surface: "native-dialog",
    }),
    "",
  ].join("\n"));
  await running;
  assert.equal(
    lines().find((message) => message.id === "canonical-route")?.value.backend,
    "moneyhand",
  );
  assert.equal(
    lines().find((message) => message.id === "canonical-route")?.value.mode,
    "page-visual-cdp-input",
  );
  assert.equal(
    lines().find((message) => message.id === "mixed-route")?.error.code,
    "INVALID_COMMAND",
  );
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("JSONL bounds raw bytes before newline and continues after an oversized line", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");

  const exactCommand = JSON.stringify({ id: "exact-limit", op: "status" });
  const exactPadding = " ".repeat(MAX_JSONL_LINE_BYTES - Buffer.byteLength(exactCommand));
  input.write(exactPadding.slice(0, 500_000));
  input.write(`${exactPadding.slice(500_000)}${exactCommand}\n`);

  input.write(" ".repeat(MAX_JSONL_LINE_BYTES));
  input.write(` ${JSON.stringify({ id: "hidden-over-limit", op: "status" })}\n`);
  input.write('{"id":"after-over-limit","op":"status"}\n');
  await waitFor(() => lines().some(
    (message) => message.id === "after-over-limit" && message.ok === true,
  ));
  input.write('{"id":"stop-size-test","op":"shutdown","graceMs":0}\n');
  await running;

  const messages = lines();
  assert.equal(messages.find((message) => message.id === "exact-limit")?.ok, true);
  assert.equal(
    messages.find((message) => message.error?.code === "LINE_TOO_LARGE")?.id,
    null,
  );
  assert.equal(
    messages.some((message) => message.id === "hidden-over-limit"),
    false,
  );
  assert.equal(messages.find((message) => message.id === "after-over-limit")?.ok, true);
});

test("JSONL protects an active command ID through churn and can cancel only that command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");

  input.write('{"id":"victim","op":"wait","timeoutMs":0}\n');
  await waitFor(() => moneyhand.peer.waiters.size === 1);
  input.write('{"id":"drain-victim","op":"drain"}\n');
  input.write('{"id":"cancel-drain","op":"cancel","args":{"targetId":"drain-victim"}}\n');
  await waitFor(() => lines().some(
    (message) => message.id === "drain-victim"
      && message.error?.code === "CANCELLED_BY_AGENT",
  ));
  for (let index = 0; index < 4_096; index += 1) {
    input.write(`${JSON.stringify({ id: `churn-${index}`, op: "status" })}\n`);
  }
  await waitFor(() => lines().some(
    (message) => message.id === "churn-4095",
  ), 5_000);

  input.write('{"id":"victim","op":"status"}\n');
  input.write('{"id":"cancel-victim","op":"cancel","targetId":"victim"}\n');
  await waitFor(() => lines().filter((message) => message.id === "victim").length === 2);
  await waitFor(() => lines().some(
    (message) => message.id === "cancel-victim" && message.ok === true,
  ));
  input.write('{"id":"stop-after-cancel","op":"shutdown","graceMs":0}\n');
  await running;

  const victimCodes = lines()
    .filter((message) => message.id === "victim")
    .map((message) => message.error?.code)
    .sort();
  assert.deepEqual(victimCodes, ["ABORTED", "ID_CONFLICT"]);
  assert.equal(moneyhand.peer.waiters.size, 0);
});

test("JSONL cancellation aborts a rate-control wait without changing its public schema", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const scope = { origin: "https://example.test", profile: "Default" };
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    rateControlOptions: { baseDelayMs: 10_000, jitterRatio: 0 },
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  input.write(`${JSON.stringify({
    id: "rate-observe",
    op: "rateControl",
    args: { action: "observe", input: { scope, throttle: true } },
  })}\n`);
  await waitFor(() => lines().some(
    (message) => message.id === "rate-observe" && message.ok === true,
  ));
  input.write(`${JSON.stringify({
    id: "rate-wait",
    op: "rateControl",
    args: { action: "wait", input: { scope } },
  })}\n`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  input.write(`${JSON.stringify({
    id: "cancel-rate-wait",
    op: "cancel",
    args: { targetId: "rate-wait" },
  })}\n`);
  await waitFor(() => lines().some(
    (message) => message.id === "rate-wait" && message.error?.code === "ABORTED",
  ));
  await waitFor(() => lines().some(
    (message) => message.id === "cancel-rate-wait" && message.ok === true,
  ));
  input.write('{"id":"stop-rate-wait","op":"shutdown","graceMs":0}\n');
  await running;
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("one-shot JSONL drains one piped command after stdin closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  input.end('{"id":"one-status","op":"status"}\n');
  await runJsonlMoneyHand({
    moneyhand,
    input,
    output,
    once: true,
    onceTimeoutMs: 1_000,
  });
  const messages = lines();
  const listening = messages.find((message) => message.event === "moneyhand.listening");
  assert.equal(listening.capabilities.transports.jsonl.oneShot, true);
  assert.equal(
    listening.capabilities.agentPolicy.dataAcquisition.objective,
    "minimum-total-elapsed-time",
  );
  assert.equal(messages.find((message) => message.id === "one-status")?.ok, true);
  assert.equal(messages.at(-1)?.event, "moneyhand.stopped");
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("one-shot JSONL exits after a semantic command error without waiting for stdin EOF", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  const startedAt = Date.now();
  const running = runJsonlMoneyHand({
    moneyhand,
    input,
    output,
    once: true,
    onceTimeoutMs: 1_000,
  });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  input.write('{"id":"bad-once-stop","op":"shutdown","graceMs":999999}\n');
  await running;
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(
    lines().find((message) => message.id === "bad-once-stop")?.error.code,
    "INVALID_COMMAND",
  );
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("permanent JSONL output backpressure cannot strand the listener", async () => {
  class GateOutput extends EventEmitter {
    write() {
      return false;
    }
  }
  const input = new PassThrough();
  const output = new GateOutput();
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  const startedAt = Date.now();
  await assert.rejects(
    runJsonlMoneyHand({
      moneyhand,
      input,
      output,
      outputDrainTimeoutMs: 50,
    }),
    (error) => error.code === "OUTPUT_BACKPRESSURE_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(moneyhand.peer.state, "STOPPED");
});

test("request timeout is surfaced as unknown outcome and a late response is never replayed", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const late = new Promise((resolve) => {
    const listener = (message) => {
      if (message.event !== "hand.late_response") return;
      moneyhand.off("event", listener);
      resolve(message);
    };
    moneyhand.on("event", listener);
  });
  const terminalPromise = moneyhand.request({
    method: "chrome.call",
    params: { method: "tabs.reload", args: [42] },
  }, { timeoutMs: 20 });
  const request = await client.nextJson();
  await assert.rejects(
    terminalPromise,
    (error) => error.code === "OUTCOME_UNKNOWN" && error.id === request.id,
  );
  respond(client, request, {
    ok: true,
    result: { reloaded: true },
    meta: { durationMs: 30 },
  });
  assert.equal((await late).message.id, request.id);
});

test("confirmUnknown explicitly submits only reviewed outcome IDs on the replacement session", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const hello = extensionHello({
    unknownOutcomeIds: ["unknown-reviewed-1"],
  });
  const first = await connectExtension(moneyhand, t, hello);
  const confirming = moneyhand.confirmUnknown({
    selector: {
      instanceId: hello.instanceId,
      bootId: hello.bootId,
    },
    ids: ["unknown-reviewed-1"],
    timeoutMs: 1_000,
  });
  const close = await first.client.nextFrame();
  assert.equal(close.opcode, 0x8);
  first.client.destroy();
  await first.client.waitForSocketClose();

  const opened = await openRawWebSocket({
    host: "127.0.0.1",
    port: moneyhand.peer.boundPort,
    path: moneyhand.peer.path,
  });
  t.after(() => opened.client.destroy());
  opened.client.sendJson(hello);
  const ready = await opened.client.nextJson();
  assert.deepEqual(ready.ackUnknownOutcomeIds, ["unknown-reviewed-1"]);
  const ping = await opened.client.nextJson();
  opened.client.sendJson({
    v: 2,
    type: "pong",
    timestamp: ping.timestamp,
  });
  const replacement = await confirming;
  assert.equal(replacement.instanceId, hello.instanceId);
  assert.ok(replacement.serial > first.session.serial);
});

test("task bootstrap uses the recovered same-boot session after window creation disconnects", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const hello = extensionHello();
  const first = await connectExtension(moneyhand, t, hello);
  const taskId = "recovered-create-session";
  const beginning = moneyhand.beginTaskContext({
    id: taskId,
    behavior: "raw",
    timeoutMs: 1_000,
  });
  const createRequest = await first.client.nextJson();
  assert.equal(createRequest.params.method, "windows.create");
  const marker = createRequest.params.args[0].url;
  first.client.destroy();
  await first.client.waitForSocketClose();

  const replacement = await connectExtension(moneyhand, t, extensionHello({
    unknownOutcomeIds: [createRequest.id],
  }));
  let request = await replacement.client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(replacement.client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker, status: "complete" }],
      }],
    },
  });
  request = await replacement.client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(replacement.client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });

  const task = await beginning;
  assert.notEqual(replacement.client, first.client);
  assert.equal(task.taskSpaceId, taskId);
  assert.equal(task.selector.bootId, hello.bootId);
  assert.equal(task.tabId, 42);
  moneyhand.taskWindows.delete(taskId);
  moneyhand.completeTaskSpace({ id: taskId, keep: false });
});

test("task runtime owns one dedicated window, uses real input scroll, and closes only that window", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);

  const beginning = moneyhand.beginTaskContext({
    id: "human-browse",
    behavior: "human",
    behaviorOptions: { ttlMs: 600_000 },
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.equal(request.params.method, "windows.create");
  assert.equal(request.params.args[0].focused, true);
  assert.equal(request.params.args[0].type, "normal");
  assert.match(request.params.args[0].url, /^about:blank#npc-moneyhand-task=/u);
  const taskMarker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.create",
      result: { id: 7, type: "normal" },
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.params, {
    method: "windows.getAll",
    args: [{ populate: true }],
  });
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{
          id: 42,
          windowId: 7,
          active: true,
          title: "MoneyHand task",
          url: taskMarker,
          status: "complete",
        }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.set");
  assert.deepEqual(request.params, { mode: "human", ttlMs: 600_000 });
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "human" }, expiresAt: Date.now() + 600_000 },
  });

  const task = await beginning;
  assert.equal(task.taskId, "human-browse");
  assert.equal(task.taskSpaceId, "human-browse");
  assert.equal(task.tabId, 42);
  assert.equal(task.page.title, "MoneyHand task");
  assert.equal(task.page.windowId, 7);
  assert.equal(task.page.ownedWindow, true);
  assert.deepEqual(task.selector, {
    profile: "npc-instance_0001",
    instanceId: "instance_0001",
    bootId: "boot_0000001",
  });

  const scrolling = moneyhand.scrollTaskTab({
    taskSpaceId: task.taskSpaceId,
    deltaY: 700,
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Page.getLayoutMetrics");
  respondCdp(client, request, layoutMetrics(100, 50));
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.equal(request.behavior, undefined);
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    action: "scroll",
    coordinateSpace: COORDINATE_SPACE,
    x: 50,
    y: 25,
    deltaX: 0,
    deltaY: 700,
  });
  respond(client, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "scroll", ok: true },
  });
  const scrolled = await scrolling;
  assert.equal(scrolled.actionDispatched, true);
  assert.equal(scrolled.effect, "input");
  assert.equal(scrolled.tabId, 42);

  const probing = moneyhand.probeTaskContext({
    taskSpaceId: task.taskSpaceId,
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.params, { method: "tabs.get", args: [42] });
  respond(client, request, {
    ok: true,
    result: { method: "tabs.get", result: { id: 42, url: "https://example.test/start" } },
  });
  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, {
    frameTree: {
      frame: {
        id: "root",
        loaderId: "loader-task-start",
        url: "https://example.test/start",
      },
    },
  });
  assert.equal((await probing).healthy, true);

  const completing = moneyhand.completeTaskContext({
    taskSpaceId: task.taskSpaceId,
    keep: true,
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.params, {
    method: "windows.getAll",
    args: [{ populate: true }],
  });
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 1,
        type: "normal",
        tabs: [{ id: 10, windowId: 1, url: "https://user.example/" }],
      }, {
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: taskMarker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.params, { method: "windows.remove", args: [7] });
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const completed = await completing;
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.behaviorReset.ok, true);
  assert.equal(completed.windowCleanup.ok, true);
  assert.equal(completed.windowCleanup.windowId, 7);
  assert.equal(completed.taskSpace.state, "complete");
  assert.equal(completed.taskSpace.keep, true);
});

test("beginTaskContext accepts an exact owned about:blank marker without a CDP health probe", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);

  const beginning = moneyhand.beginTaskContext({
    id: "marker-not-debuggable",
    behavior: "raw",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 17, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 17,
        type: "normal",
        tabs: [{ id: 71, windowId: 17, url: marker, status: "complete" }],
      }],
    },
  });

  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });

  const task = await beginning;
  assert.equal(task.tabId, 71);
  assert.equal(task.page.guard, null);
  const probing = moneyhand.probeTaskContext({ taskSpaceId: task.taskSpaceId, timeoutMs: 1_000 });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.params, { method: "tabs.get", args: [71] });
  respond(client, request, {
    ok: true,
    result: { method: "tabs.get", result: { id: 71, windowId: 17, url: marker } },
  });
  const probe = await probing;
  assert.equal(probe.healthy, true);
  assert.equal(probe.stage, "ownership-marker");
  assert.equal(probe.guard, null);
  moneyhand.taskWindows.delete(task.taskSpaceId);
  moneyhand.completeTaskSpace({ id: task.taskSpaceId, keep: false });
});

test("navigateTaskTab bootstraps an owned about:blank marker through tabs.update before CDP polling", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const taskId = "marker-bootstrap-navigation";
  const beginning = moneyhand.beginTaskContext({ id: taskId, behavior: "raw", timeoutMs: 1_000 });
  let request = await client.nextJson();
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 18, type: "normal" } },
  });
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 18,
        type: "normal",
        tabs: [{ id: 72, windowId: 18, url: marker, status: "complete" }],
      }],
    },
  });
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const task = await beginning;

  const navigating = moneyhand.navigateTaskTab({
    taskSpaceId: task.taskSpaceId,
    tabId: task.tabId,
    url: "https://example.test/target",
    expectedUrl: "https://example.test/target",
    effect: "navigation",
    waitUntil: "domcontentloaded",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 1,
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  assert.deepEqual(request.params, { method: "tabs.get", args: [72] });
  respond(client, request, {
    ok: true,
    result: { method: "tabs.get", result: { id: 72, windowId: 18, url: marker } },
  });
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  assert.deepEqual(request.params, {
    method: "tabs.update",
    args: [72, { url: "https://example.test/target" }],
  });
  respond(client, request, {
    ok: true,
    result: {
      method: "tabs.update",
      result: { id: 72, windowId: 18, url: "https://example.test/target" },
    },
  });
  request = await client.nextJson();
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respondTaskPageState(client, request, {
    loaderId: "loader-target",
    url: "https://example.test/target",
    readyState: "complete",
  });

  const navigation = await navigating;
  assert.equal(navigation.loaded, true);
  assert.equal(navigation.navigation.transport, "chrome.tabs.update");
  assert.equal(navigation.before.ownershipMarker, true);
  moneyhand.taskWindows.delete(task.taskSpaceId);
  moneyhand.completeTaskSpace({ id: task.taskSpaceId, keep: false });
});

test("task runtime rejects unknown behavior fields before browser dispatch", async (t) => {
  const moneyhand = await startMoneyHand(t);
  await connectExtension(moneyhand, t);
  await assert.rejects(
    moneyhand.beginTaskContext({
      id: "invalid-behavior",
      behavior: "human",
      behaviorOptions: { inventedDelay: 1 },
    }),
    (error) => error.code === "INVALID_TASK_BEHAVIOR",
  );
  assert.equal(moneyhand.listTaskSpaces().length, 0);
});

test("task runtime does not require debugger access to its about:blank ownership marker", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const beginning = moneyhand.beginTaskContext({
    id: "new-tab-ready-delay",
    behavior: "raw",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 7, type: "normal" } },
  });
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, active: true, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const task = await beginning;
  assert.equal(task.taskSpaceId, "new-tab-ready-delay");
  assert.equal(task.tabId, 42);
  moneyhand.taskWindows.delete(task.taskSpaceId);
});

test("task runtime removes an acknowledged new window when ownership validation fails", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const beginning = moneyhand.beginTaskContext({
    id: "validation-cleanup",
    behavior: "raw",
    timeoutMs: 1_000,
  });
  const rejected = assert.rejects(
    beginning,
    (error) => error.code === "TASK_WINDOW_VALIDATION_FAILED"
      && error.details.actionDispatched === true
      && error.details.windowCleanup.ok === true
      && error.details.windowCleanup.windowId === 7,
  );
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 7, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: false,
    error: { code: "WINDOW_ENUMERATION_FAILED", message: "could not enumerate windows" },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.get");
  assert.deepEqual(request.params.args, [7, { populate: true }]);
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.get",
      result: {
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker }],
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  assert.deepEqual(request.params.args, [7]);
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  await rejected;
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("task runtime never closes a provisional window after the user changes its tabs", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const taskId = "validation-user-changed";
  const beginning = moneyhand.beginTaskContext({
    id: taskId,
    behavior: "raw",
    timeoutMs: 1_000,
  });
  const rejected = assert.rejects(
    beginning,
    (error) => error.code === "TASK_WINDOW_VALIDATION_FAILED"
      && error.details.windowCleanup.ok === false
      && error.details.windowCleanup.closeAttempted === false
      && error.details.windowCleanup.error.code === "TASK_WINDOW_OWNERSHIP_CHANGED"
      && error.details.provisionalRetained === true,
  );
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 7, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: false,
    error: { code: "WINDOW_ENUMERATION_FAILED", message: "could not enumerate windows" },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.get");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.get",
      result: {
        id: 7,
        type: "normal",
        tabs: [
          { id: 42, windowId: 7, url: marker },
          { id: 43, windowId: 7, url: "https://user.example/new-tab" },
        ],
      },
    },
  });
  await rejected;
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), [taskId]);

  const sweeping = moneyhand.cleanupOwnedTaskWindows({ taskIds: [taskId] });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [
          { id: 42, windowId: 7, url: marker },
          { id: 43, windowId: 7, url: "https://user.example/new-tab" },
        ],
      }],
    },
  });
  const swept = await sweeping;
  assert.equal(swept.ok, false);
  assert.equal(swept.results[0].error.code, "TASK_WINDOW_NOT_FOUND");
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  moneyhand.taskWindows.delete(taskId);
});

test("task runtime retains an unverified provisional window until a marker-exact sweep", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const taskId = "validation-deferred-cleanup";
  const beginning = moneyhand.beginTaskContext({
    id: taskId,
    behavior: "raw",
    timeoutMs: 1_000,
  });
  const rejected = assert.rejects(
    beginning,
    (error) => error.code === "TASK_WINDOW_VALIDATION_FAILED"
      && error.details.windowCleanup.ok === false
      && error.details.windowCleanup.closeAttempted === false
      && error.details.provisionalRetained === true,
  );
  let request = await client.nextJson();
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 7, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: false,
    error: { code: "WINDOW_ENUMERATION_FAILED", message: "could not enumerate windows" },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.get");
  respond(client, request, {
    ok: false,
    error: { code: "WINDOW_INSPECTION_FAILED", message: "could not inspect exact window" },
  });
  await rejected;
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), [taskId]);

  const sweeping = moneyhand.cleanupOwnedTaskWindows({ taskIds: [taskId] });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  assert.deepEqual(request.params.args, [7]);
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  const swept = await sweeping;
  assert.equal(swept.ok, true);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("task runtime retains marker-only unknown creation and closes only one exact late window", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const taskId = "unknown-window-outcome";
  const beginning = moneyhand.beginTaskContext({
    id: taskId,
    behavior: "raw",
    timeoutMs: 20,
  });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  request = await client.nextJson(200);
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: { method: "windows.getAll", result: [] },
  });
  await assert.rejects(
    beginning,
    (error) => error.code === "TASK_WINDOW_CREATE_OUTCOME_UNKNOWN"
      && error.details.actionDispatched === true
      && error.details.windowCleanup.attempted === false
      && error.details.provisionalRetained === true,
  );
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), [taskId]);

  const ambiguousSweep = moneyhand.cleanupOwnedTaskWindows({ taskIds: [taskId] });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [7, 8].map((windowId, index) => ({
        id: windowId,
        type: "normal",
        tabs: [{ id: 42 + index, windowId, url: marker }],
      })),
    },
  });
  const ambiguous = await ambiguousSweep;
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.results[0].error.code, "TASK_WINDOW_AMBIGUOUS");
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), [taskId]);

  const changedSweep = moneyhand.cleanupOwnedTaskWindows({ taskIds: [taskId] });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [
          { id: 42, windowId: 7, url: marker },
          { id: 43, windowId: 7, url: "https://user.example/changed" },
        ],
      }],
    },
  });
  const changed = await changedSweep;
  assert.equal(changed.ok, false);
  assert.equal(changed.results[0].error.code, "TASK_WINDOW_NOT_FOUND");
  await assert.rejects(client.nextJson(30), /timed out waiting for WebSocket frame/u);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), [taskId]);

  const exactSweep = moneyhand.cleanupOwnedTaskWindows({ taskIds: [taskId] });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  assert.deepEqual(request.params.args, [7]);
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  const exact = await exactSweep;
  assert.equal(exact.ok, true);
  assert.equal(exact.results[0].windowId, 7);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("task cleanup is idempotent when the user already closed the owned window", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const { task, windowId } = await beginOwnedTaskContext(moneyhand, client, {
    id: "already-closed-window",
  });
  const completing = moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 1,
        type: "normal",
        tabs: [{ id: 10, windowId: 1, url: "https://user.example/" }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const completed = await completing;
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.windowCleanup.alreadyClosed, true);
  assert.equal(completed.windowCleanup.windowId, windowId);
  assert.equal(completed.taskSpace.state, "complete");
});

test("task cleanup refuses to close a task window after its tab ownership changed", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const { task, marker, windowId, tabId } = await beginOwnedTaskContext(moneyhand, client, {
    id: "changed-task-window",
  });
  const completing = moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: windowId,
        type: "normal",
        tabs: [
          { id: tabId, windowId, url: marker },
          { id: 43, windowId, url: "https://user.example/new-tab" },
        ],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const completed = await completing;
  assert.equal(completed.cleanupComplete, false);
  assert.equal(completed.windowCleanup.ok, false);
  assert.equal(completed.windowCleanup.error.code, "TASK_WINDOW_NOT_FOUND");
  assert.equal(completed.taskSpace.state, "active");
  moneyhand.taskWindows.delete(task.taskSpaceId);
});

test("task cleanup cancels an exact task-tab wait before closing its owned window", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const { task, marker, windowId, tabId } = await beginOwnedTaskContext(moneyhand, client, {
    id: "waiting-task-window",
  });
  const completing = moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: windowId,
        type: "normal",
        tabs: [{ id: tabId, windowId, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  respond(client, request, {
    ok: false,
    status: "needs_instruction",
    error: {
      code: "TAB_WAITING",
      message: "The task tab is waiting for Agent instruction",
      details: { waitId: "wait-owned-tab", tabId },
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "instruction.resolve");
  assert.deepEqual(request.params, {
    tabId,
    waitId: "wait-owned-tab",
    action: "cancel",
  });
  respond(client, request, {
    ok: true,
    result: {
      tabId,
      waitId: "wait-owned-tab",
      action: "cancel",
      waiting: false,
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: windowId,
        type: "normal",
        tabs: [{ id: tabId, windowId, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });
  const completed = await completing;
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.windowCleanup.ok, true);
  assert.equal(completed.windowCleanup.windowId, windowId);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("task cleanup retries only an explicitly not-dispatched BUSY behavior reset", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const { task, marker, windowId, tabId } = await beginOwnedTaskContext(moneyhand, client, {
    id: "busy-behavior-reset",
    behavior: "human",
  });
  const completing = moneyhand.completeTaskContext({ taskSpaceId: task.taskSpaceId });
  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: windowId,
        type: "normal",
        tabs: [{ id: tabId, windowId, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respond(client, request, {
    ok: false,
    error: { code: "BUSY", message: "Exclusive window mutation is still settling" },
  });
  request = await client.nextJson(1_000);
  assert.equal(request.method, "behavior.reset");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });

  const completed = await completing;
  assert.equal(completed.cleanupComplete, true);
  assert.equal(completed.behaviorReset.ok, true);
  assert.equal(completed.windowCleanup.ok, true);
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("task runner is not reusable and never replays an unknown behavior-reset outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-reset-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand }) {",
    "  await moneyhand.beginTaskContext({ id: 'reset-cleanup-task', behavior: 'raw' });",
    "  const error = new Error('fixture failed after task setup');",
    "  error.code = 'TASK_FIXTURE_FAILED';",
    "  throw error;",
    "}",
  ].join("\n"), "utf8");
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const running = runMoneyHandTask({ moneyhand, taskPath, timeoutMs: 1_000 });
  const rejected = assert.rejects(
    running,
    (error) => error.code === "TASK_FIXTURE_FAILED"
      && error.details.cleanupComplete === false
      && error.details.controllerReusable === false
      && error.details.taskWindowCleanup.ok === false
      && error.details.taskWindowCleanup.results[0].cleanupComplete === false
      && error.details.taskWindowCleanup.results[0].windowCleanup.ok === true
      && error.details.taskWindowCleanup.results[0].behaviorReset.ok === false
      && error.details.taskWindowCleanup.results[0].behaviorReset.error.code === "OUTCOME_UNKNOWN",
  );

  let request = await client.nextJson();
  assert.equal(request.params.method, "windows.create");
  const marker = request.params.args[0].url;
  respond(client, request, {
    ok: true,
    result: { method: "windows.create", result: { id: 7, type: "normal" } },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker, status: "complete" }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: true,
    result: { behavior: { mode: "raw" }, expiresAt: null },
  });

  request = await client.nextJson();
  assert.equal(request.method, "system.status");
  respond(client, request, { ok: true, result: { waiting: [] } });
  request = await client.nextJson();
  assert.equal(request.method, "observe.context");
  respond(client, request, {
    ok: true,
    result: {
      target: { tabId: 42 },
      url: marker,
      title: "cleanup fixture",
      readyState: "complete",
      text: "fixture failed after task setup",
      controls: [],
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "observe.screenshot");
  respond(client, request, {
    ok: false,
    error: { code: "VISUAL_CAPTURE_FAILED", message: "fixture omits PNG output" },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "windows.getAll");
  respond(client, request, {
    ok: true,
    result: {
      method: "windows.getAll",
      result: [{
        id: 7,
        type: "normal",
        tabs: [{ id: 42, windowId: 7, url: marker }],
      }],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "windows.remove");
  respond(client, request, {
    ok: true,
    result: { method: "windows.remove", result: null },
  });
  request = await client.nextJson();
  assert.equal(request.method, "behavior.reset");
  respond(client, request, {
    ok: false,
    error: { code: "OUTCOME_UNKNOWN", message: "behavior reset terminal was lost" },
  });
  await assert.rejects(client.nextJson(50), /timed out waiting for WebSocket frame/u);

  await rejected;
  assert.deepEqual(moneyhand.ownedTaskWindowIds(), []);
});

test("captureStableViewport retries only stale pre-write captures", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-stable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "stable.png");
  await moneyhand.createTaskSpace({ id: "stable-capture", tabIds: [42] });

  const capture = moneyhand.captureStableViewport({
    taskSpaceId: "stable-capture",
    outputPath,
    maxAttempts: 3,
    retryDelayMs: 0,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      completed: 6,
      total: 6,
      results: viewportBatchResults({
        before: layoutMetrics(100, 50),
        after: layoutMetrics(99, 50),
      }),
    },
    meta: { durationMs: 1 },
  });
  request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  respond(client, request, {
    ok: true,
    result: {
      completed: 6,
      total: 6,
      results: viewportBatchResults(),
    },
    meta: { durationMs: 1 },
  });
  const result = await capture;
  assert.equal(result.stable, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.taskSpaceId, "stable-capture");
  assert.equal(result.path, outputPath);
  assert.deepEqual(await readFile(outputPath), pngHeader(200, 100));
});

test("captureStableViewport rejects a failed terminal instead of reporting stable success", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-stable-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "must-not-exist.png");
  await moneyhand.createTaskSpace({ id: "stable-capture-failure", tabIds: [42] });

  const capture = moneyhand.captureStableViewport({
    taskSpaceId: "stable-capture-failure",
    outputPath,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  respond(client, request, {
    ok: false,
    error: {
      code: "TARGET_NOT_READY",
      message: "Profile tab could not be read",
      details: { tabId: 42 },
    },
  });
  await assert.rejects(
    capture,
    (error) => error.code === "VIEWPORT_CAPTURE_FAILED"
      && error.details.actionDispatched === false
      && error.details.attempts === 1
      && error.details.cause.code === "TARGET_NOT_READY",
  );
  await assert.rejects(readFile(outputPath), (error) => error.code === "ENOENT");
});

test("captureStableViewport reports a screenshot dispatched by a partial failed batch", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-stable-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "partial-must-not-exist.png");
  await moneyhand.createTaskSpace({ id: "stable-capture-partial", tabIds: [42] });

  const capture = moneyhand.captureStableViewport({
    taskSpaceId: "stable-capture-partial",
    outputPath,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  respond(client, request, {
    ok: false,
    error: {
      code: "TARGET_NOT_READY",
      message: "Profile tab changed after capture",
      details: {
        failedAt: 4,
        causeCode: "TARGET_NOT_READY",
        results: [
          batchStep(0, "Page.getFrameTree", semanticFrame("loader-partial")),
          batchStep(1, "Page.getLayoutMetrics", layoutMetrics()),
          batchStep(2, "Runtime.evaluate", { result: { type: "object", value: {} } }),
          batchStep(3, "Page.captureScreenshot", {
            data: pngHeader(200, 100).toString("base64"),
          }),
          {
            index: 4,
            method: "cdp.send",
            ok: false,
            error: { code: "TARGET_NOT_READY", message: "tab changed" },
          },
        ],
      },
    },
  });
  await assert.rejects(
    capture,
    (error) => error.code === "VIEWPORT_CAPTURE_FAILED"
      && error.details.actionDispatched === true
      && error.details.retry === "safe-to-recheck"
      && error.details.attempts === 1
      && error.details.cause.code === "TARGET_NOT_READY",
  );
  await assert.rejects(readFile(outputPath), (error) => error.code === "ENOENT");
});

test("captureFullPage writes one guarded observation-only PNG and infers outputRoot", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-full-page-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "full-page.png");
  const image = pngHeader(300, 900);
  await moneyhand.createTaskSpace({ id: "full-page-capture", tabIds: [42] });

  const capture = moneyhand.captureFullPage({
    taskSpaceId: "full-page-capture",
    outputPath,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  respond(client, request, {
    ok: true,
    result: { completed: 2, total: 2, results: fullPageGuardResults() },
  });
  request = await client.nextJson();
  assert.equal(request.method, "observe.screenshot");
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    format: "png",
    fullPage: true,
  });
  respond(client, request, {
    ok: true,
    result: {
      target: { tabId: 42 },
      mimeType: "image/png",
      data: image.toString("base64"),
    },
  });
  request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  respond(client, request, {
    ok: true,
    result: { completed: 2, total: 2, results: fullPageGuardResults() },
  });

  const result = await capture;
  assert.equal(result.observationOnly, true);
  assert.equal(result.coordinateMapping, false);
  assert.equal(result.path, outputPath);
  assert.deepEqual(result.documentCss, { width: 100, height: 150 });
  assert.deepEqual(result.image, {
    path: outputPath,
    width: 300,
    height: 900,
    bytes: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
  });
  assert.deepEqual(await readFile(outputPath), image);
});

test("captureViewportBundle writes a guarded PNG and returns image-to-CSS mapping", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "viewport.png");

  const capturePromise = moneyhand.captureViewportBundle({
    tabId: 42,
    outputPath,
    outputRoot: directory,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  assert.deepEqual(
    request.params.steps.map((step) => step.params.method),
    [
      "Page.getFrameTree",
      "Page.getLayoutMetrics",
      "Runtime.evaluate",
      "Page.captureScreenshot",
      "Page.getLayoutMetrics",
      "Page.getFrameTree",
    ],
  );
  respond(client, request, {
    ok: true,
    result: {
      completed: 6,
      total: 6,
      results: viewportBatchResults(),
    },
    meta: { durationMs: 1 },
  });

  const { bundle } = await capturePromise;
  assert.equal(bundle.coordinateSpace, COORDINATE_SPACE);
  assert.equal(bundle.guard.loaderId, "loader-stable");
  assert.equal(bundle.guard.atomic, false);
  assert.deepEqual(bundle.sessionSelector, {
    instanceId: "instance_0001",
    bootId: "boot_0000001",
  });
  assert.deepEqual(bundle.image.width, 200);
  assert.deepEqual(bundle.image.height, 100);
  assert.deepEqual(bundle.mapping.imagePixelsPerCssPixel, { x: 2, y: 2 });
  assert.deepEqual(bundle.mapping.imageToCss, { scaleX: 0.5, scaleY: 0.5 });
  assert.equal(bundle.image.sha256.length, 64);
  assert.deepEqual(await readFile(outputPath), pngHeader(200, 100));
});

test("captureSemanticSnapshot compacts AX and DOMSnapshot data into guarded refs", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);

  const snapshotPromise = moneyhand.captureSemanticSnapshot({
    tabId: 42,
    maxNodes: 20,
    includeDomSnapshot: true,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  assert.deepEqual(
    request.params.steps.map((step) => step.params.method),
    [
      "Page.getFrameTree",
      "DOMSnapshot.captureSnapshot",
      "Accessibility.getFullAXTree",
      "Page.getFrameTree",
    ],
  );
  const frameTree = {
    frameTree: {
      frame: { id: "root", loaderId: "loader-semantic", url: "https://example.test/app" },
    },
  };
  const domSnapshot = {
    strings: ["HTML", "BUTTON", "id", "save-button"],
    documents: [{
      nodes: {
        backendNodeId: [1, 42],
        nodeName: [0, 1],
        attributes: [[], [2, 3]],
      },
      layout: {
        nodeIndex: [1],
        bounds: [[10, 20, 100, 40]],
      },
    }],
  };
  const axTree = {
    nodes: [{
      nodeId: "ax-save",
      backendDOMNodeId: 42,
      ignored: false,
      role: { value: "button" },
      name: { value: "Save" },
      properties: [{ name: "disabled", value: { value: false } }],
    }],
  };
  respond(client, request, {
    ok: true,
    result: {
      completed: 4,
      total: 4,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "DOMSnapshot.captureSnapshot", domSnapshot),
        batchStep(2, "Accessibility.getFullAXTree", axTree),
        batchStep(3, "Page.getFrameTree", frameTree),
      ],
    },
    meta: { durationMs: 1 },
  });

  const { snapshot } = await snapshotPromise;
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.mode, "accessibility+dom");
  assert.equal(snapshot.nodes[0].ref, "@1");
  assert.equal(snapshot.nodes[0].backendNodeId, 42);
  assert.deepEqual(snapshot.nodes[0].locator, {
    kind: "css",
    value: "#save-button",
    confidence: "unique-snapshot",
  });
  assert.match(snapshot.content, /@1 button "Save"/u);
  assert.equal(snapshot.guard.loaderId, "loader-semantic");
  assert.deepEqual(snapshot.sessionSelector, {
    instanceId: "instance_0001",
    bootId: "boot_0000001",
  });

  const resolved = moneyhand.resolveSemanticRef({ snapshotId: snapshot.id, ref: "@1" });
  assert.equal(resolved.node.backendNodeId, 42);
  assert.equal(resolved.tabId, 42);

  const cssWaiting = moneyhand.waitForSemanticLocator({
    tabId: 42,
    locator: snapshot.nodes[0].locator,
    stablePolls: 1,
    timeoutMs: 1_000,
  });
  const waitRequest = await client.nextJson();
  assert.deepEqual(
    waitRequest.params.steps.map((step) => step.params.method),
    [
      "Page.getFrameTree",
      "DOMSnapshot.captureSnapshot",
      "Accessibility.getFullAXTree",
      "Page.getFrameTree",
    ],
  );
  respond(client, waitRequest, {
    ok: true,
    result: {
      completed: 4,
      total: 4,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "DOMSnapshot.captureSnapshot", domSnapshot),
        batchStep(2, "Accessibility.getFullAXTree", axTree),
        batchStep(3, "Page.getFrameTree", frameTree),
      ],
    },
  });
  assert.equal((await cssWaiting).matched, true);
});

test("captureSemanticSnapshot keeps full DOM transfer off the default fast path", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const promise = moneyhand.captureSemanticSnapshot({ tabId: 42, timeoutMs: 1_000 });
  const request = await client.nextJson();
  assert.deepEqual(
    request.params.steps.map((step) => step.params.method),
    ["Page.getFrameTree", "Accessibility.getFullAXTree", "Page.getFrameTree"],
  );
  const frameTree = {
    frameTree: {
      frame: { id: "root", loaderId: "loader-ax", url: "https://example.test/app" },
    },
  };
  respond(client, request, {
    ok: true,
    result: {
      completed: 3,
      total: 3,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "Accessibility.getFullAXTree", {
          nodes: [{
            nodeId: "ax-next",
            backendDOMNodeId: 84,
            role: { value: "button" },
            name: { value: "Next" },
            properties: [],
          }],
        }),
        batchStep(2, "Page.getFrameTree", frameTree),
      ],
    },
  });
  const { snapshot } = await promise;
  assert.equal(snapshot.mode, "accessibility");
  assert.deepEqual(snapshot.nodes[0].locator, {
    kind: "role",
    role: "button",
    name: "Next",
    confidence: "semantic",
  });
});

test("semantic snapshots expose link hrefs and navigateSemanticRef avoids pointer clicks", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "link",
    name: "Open discussion",
    nodes: [{
      nodeId: "ax-discussion-link",
      backendDOMNodeId: 84,
      ignored: false,
      role: { value: "link" },
      name: { value: "Open discussion" },
      properties: [{ name: "url", value: { value: "/discussion/42" } }],
    }],
  });
  assert.equal(snapshot.nodes[0].href, "/discussion/42");
  assert.match(snapshot.content, /href="\/discussion\/42"/u);
  await moneyhand.createTaskSpace({ id: "semantic-link-nav", tabIds: [42] });
  const navigations = [];
  moneyhand.navigateTaskTab = async (options) => {
    navigations.push(options);
    return { ready: true, finalUrl: options.url };
  };

  const result = await moneyhand.navigateSemanticRef({
    taskSpaceId: "semantic-link-nav",
    snapshotId: snapshot.id,
    ref: "@1",
    waitUntil: "load",
  });
  assert.equal(result.href, "/discussion/42");
  assert.equal(result.url, "https://example.test/discussion/42");
  assert.equal(navigations.length, 1);
  assert.deepEqual(navigations[0], {
    taskSpaceId: "semantic-link-nav",
    tabId: 42,
    url: "https://example.test/discussion/42",
    effect: "navigation",
    waitUntil: "load",
  });
});

test("captureSemanticSnapshot optionally compacts main and flattened iframe AX trees into frame-bound refs", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureFrameSemanticFixture(moneyhand, client);

  assert.equal(snapshot.mode, "accessibility+frames");
  assert.deepEqual(snapshot.frameScope, {
    included: true,
    totalFrames: 2,
    totalFramesExact: true,
    omittedTargets: 0,
    selectedFrames: 2,
    truncated: false,
    maxFrames: 8,
  });
  assert.equal(snapshot.frames.length, 2);
  assert.deepEqual(snapshot.frames[1], {
    frameId: "child-frame",
    loaderId: "loader-child",
    url: "https://frame.example.test/form",
    depth: 1,
    topLevel: false,
    parentFrameId: "root",
    sessionId: "child-session",
    targetId: "child-target",
  });
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.nodes[1].ref, "@2");
  assert.deepEqual(snapshot.nodes[1].frame, {
    frameId: "child-frame",
    loaderId: "loader-child",
    url: "https://frame.example.test/form",
    depth: 1,
    topLevel: false,
    sessionId: "child-session",
    targetId: "child-target",
    parentFrameId: "root",
  });
  assert.deepEqual(snapshot.nodes[1].locator, {
    kind: "role",
    role: "button",
    name: "Continue",
    confidence: "semantic",
    frameId: "child-frame",
  });
  assert.match(snapshot.content, /@2 button frame="child-frame" "Continue"/u);

  const resolved = moneyhand.resolveSemanticRef({ snapshotId: snapshot.id, ref: "@2" });
  assert.deepEqual(resolved.guard, {
    frameId: "child-frame",
    loaderId: "loader-child",
    url: "https://frame.example.test/form",
  });
  assert.equal(resolved.framePath.length, 1);
  assert.equal(resolved.framePath[0].sessionId, "child-session");
  assert.equal(resolved.framePath[0].targetId, "child-target");
});

test("actSemanticRef maps a child-frame point and accepts the exact top-level OOPIF owner hit", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureFrameSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "frame-click", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "frame-click",
    snapshotId: snapshot.id,
    ref: "@2",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.method, "target.sessions");
  respond(client, request, { ok: true, result: semanticFrameSessions() });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, childSemanticFrameTree());

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.createIsolatedWorld");
  assert.equal(request.params.params.frameId, "child-frame");
  respondCdp(client, request, { executionContextId: 701 });

  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, { object: { objectId: "object-child" } });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, childSemanticFrameTree());

  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        ok: true,
        connected: true,
        url: "https://frame.example.test/form",
        x: 50,
        y: 60,
        rect: { x: 20, y: 40, width: 60, height: 40 },
        viewport: { width: 400, height: 300 },
        tag: "button",
        role: "button",
        editable: false,
        focused: false,
        value: null,
        checked: null,
      },
    },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, childSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42 });
  respondCdp(client, request, rootSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.getFrameOwner");
  assert.deepEqual(request.params.params, { frameId: "child-frame" });
  respondCdp(client, request, { backendNodeId: 700 });
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.scrollIntoViewIfNeeded");
  respondCdp(client, request, {});
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.getContentQuads");
  respondCdp(client, request, {
    quads: [[100, 200, 500, 200, 500, 500, 100, 500]],
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, childSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42 });
  respondCdp(client, request, rootSemanticFrameTree());

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.createIsolatedWorld");
  assert.equal(request.params.params.frameId, "root");
  respondCdp(client, request, { executionContextId: 702 });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.evaluate");
  respondCdp(client, request, {
    result: { type: "object", value: { width: 800, height: 600 } },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42 });
  respondCdp(client, request, rootSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, childSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.getNodeForLocation");
  assert.deepEqual(request.params.target, { tabId: 42 });
  assert.deepEqual(
    { x: request.params.params.x, y: request.params.params.y },
    { x: 150, y: 260 },
  );
  respondCdp(client, request, { backendNodeId: 700, frameId: "root" });

  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.deepEqual(request.params.target, { tabId: 42 });
  assert.equal(request.params.x, 150);
  assert.equal(request.params.y, 260);
  respond(client, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "click", ok: true },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, childSemanticFrameTree());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { connected: true, focused: false, value: null, checked: null },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.deepEqual(request.params.target, { tabId: 42, sessionId: "child-session" });
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.target.frameId, "child-frame");
  assert.deepEqual(result.target.localPoint, { x: 50, y: 60 });
  assert.equal(result.target.x, 150);
  assert.equal(result.target.y, 260);
  assert.equal(result.verification.claim, "observation-only");
  assert.equal(result.cleanup.released, true);
});

test("actSemanticRef rejects a top-level hit that is not the exact OOPIF owner", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureFrameSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "frame-owner-occluded", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "frame-owner-occluded",
    snapshotId: snapshot.id,
    ref: "@2",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  const rejected = assert.rejects(
    acting,
    (error) => error.code === "SEMANTIC_FRAME_OCCLUDED"
      && error.details?.expectedTopLevelOwner?.backendNodeId === 700
      && error.details?.observedBackendNodeId === 999,
  );
  let released = false;
  while (!released) {
    const request = await client.nextJson();
    if (request.method === "target.sessions") {
      respond(client, request, { ok: true, result: semanticFrameSessions() });
      continue;
    }
    assert.equal(request.method, "cdp.send");
    const method = request.params.method;
    if (method === "Page.getFrameTree") {
      respondCdp(
        client,
        request,
        request.params.target.sessionId ? childSemanticFrameTree() : rootSemanticFrameTree(),
      );
    } else if (method === "Page.createIsolatedWorld") {
      respondCdp(client, request, {
        executionContextId: request.params.target.sessionId ? 701 : 702,
      });
    } else if (method === "DOM.resolveNode") {
      respondCdp(client, request, { object: { objectId: "object-occluded-child" } });
    } else if (method === "Runtime.callFunctionOn") {
      respondCdp(client, request, {
        result: {
          type: "object",
          value: {
            ok: true,
            connected: true,
            url: "https://frame.example.test/form",
            x: 50,
            y: 60,
            rect: { x: 20, y: 40, width: 60, height: 40 },
            viewport: { width: 400, height: 300 },
            tag: "button",
            role: "button",
            editable: false,
            focused: false,
            value: null,
            checked: null,
          },
        },
      });
    } else if (method === "DOM.getFrameOwner") {
      respondCdp(client, request, { backendNodeId: 700 });
    } else if (method === "DOM.scrollIntoViewIfNeeded") {
      respondCdp(client, request, {});
    } else if (method === "DOM.getContentQuads") {
      respondCdp(client, request, {
        quads: [[100, 200, 500, 200, 500, 500, 100, 500]],
      });
    } else if (method === "Runtime.evaluate") {
      respondCdp(client, request, {
        result: { type: "object", value: { width: 800, height: 600 } },
      });
    } else if (method === "DOM.getNodeForLocation") {
      respondCdp(client, request, { backendNodeId: 999, frameId: "root" });
    } else if (method === "Runtime.releaseObject") {
      respondCdp(client, request, {});
      released = true;
    } else {
      assert.fail(`unexpected occluded OOPIF method: ${method}`);
    }
  }
  await rejected;
});

test("actSemanticRef maps same-process frame scroll into its CDP target root viewport", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const rootTree = nestedRootSemanticFrameTree();
  const sessions = { tabId: 42, sessions: [] };
  const snapshot = await captureFrameSemanticFixture(moneyhand, client, {
    rootTree,
    sessions,
    targetTrees: [],
    frameIds: ["root", "middle-frame"],
  });
  assert.equal(snapshot.nodes[1].ref, "@2");
  assert.equal(snapshot.nodes[1].frame.frameId, "middle-frame");
  await moneyhand.createTaskSpace({ id: "same-process-frame-scroll", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "same-process-frame-scroll",
    snapshotId: snapshot.id,
    ref: "@2",
    action: "scroll",
    deltaX: -80,
    deltaY: 640,
    effect: "input",
    timeoutMs: 1_000,
  });
  let ownerRequests = 0;
  let preflightReads = 0;
  let released = false;
  while (!released) {
    const request = await client.nextJson();
    if (request.method === "target.sessions") {
      respond(client, request, { ok: true, result: sessions });
      continue;
    }
    if (request.method === "input.perform") {
      assert.deepEqual(request.params.target, { tabId: 42 });
      assert.equal(request.params.action, "scroll");
      assert.equal(request.params.coordinateSpace, COORDINATE_SPACE);
      assert.deepEqual(
        {
          x: request.params.x,
          y: request.params.y,
          deltaX: request.params.deltaX,
          deltaY: request.params.deltaY,
        },
        { x: 130, y: 150, deltaX: -80, deltaY: 640 },
      );
      respond(client, request, {
        ok: true,
        result: { target: { tabId: 42 }, action: "scroll", ok: true },
      });
      continue;
    }
    assert.equal(request.method, "cdp.send");
    const method = request.params.method;
    if (method === "Page.getFrameTree") {
      respondCdp(client, request, rootTree);
    } else if (method === "Page.createIsolatedWorld") {
      respondCdp(client, request, {
        executionContextId: request.params.params.frameId === "middle-frame" ? 701 : 702,
      });
    } else if (method === "DOM.resolveNode") {
      respondCdp(client, request, { object: { objectId: "object-same-process" } });
    } else if (method === "Runtime.callFunctionOn") {
      preflightReads += 1;
      respondCdp(client, request, {
        result: {
          type: "object",
          value: preflightReads === 1
            ? {
                ok: true,
                connected: true,
                url: "https://example.test/middle",
                x: 50,
                y: 50,
                rect: { x: 20, y: 30, width: 60, height: 40 },
                viewport: { width: 500, height: 400 },
                tag: "button",
                role: "button",
                editable: false,
                focused: false,
                value: null,
                checked: null,
              }
            : { connected: true, focused: false, value: null, checked: null },
        },
      });
    } else if (method === "DOM.getFrameOwner") {
      ownerRequests += 1;
      assert.deepEqual(request.params.params, { frameId: "middle-frame" });
      respondCdp(client, request, { backendNodeId: 600 });
    } else if (method === "DOM.scrollIntoViewIfNeeded") {
      respondCdp(client, request, {});
    } else if (method === "DOM.getContentQuads") {
      respondCdp(client, request, {
        quads: [[80, 100, 580, 100, 580, 500, 80, 500]],
      });
    } else if (method === "Runtime.evaluate") {
      respondCdp(client, request, {
        result: { type: "object", value: { width: 900, height: 700 } },
      });
    } else if (method === "DOM.getNodeForLocation") {
      assert.deepEqual(
        { x: request.params.params.x, y: request.params.params.y },
        { x: 130, y: 150 },
      );
      respondCdp(client, request, { backendNodeId: 61, frameId: "middle-frame" });
    } else if (method === "Runtime.releaseObject") {
      respondCdp(client, request, {});
      released = true;
    } else {
      assert.fail(`unexpected same-process frame action method: ${method}`);
    }
  }

  const result = await acting;
  assert.equal(ownerRequests, 1);
  assert.equal(result.target.x, 130);
  assert.equal(result.target.y, 150);
  assert.deepEqual(result.target.localPoint, { x: 50, y: 50 });
  assert.deepEqual(result.target.topLevelGuardPoint, { x: 130, y: 150 });
  assert.equal(result.target.frameId, "middle-frame");
  assert.equal(result.cleanup.released, true);
});

test("actSemanticRef drags between two guarded frame refs without stale owner scrolling", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const rootTree = nestedRootSemanticFrameTree();
  const sessions = { tabId: 42, sessions: [] };
  const axByFrame = new Map([
    ["root", {
      nodeId: "ax-drag-heading",
      backendDOMNodeId: 41,
      frameId: "root",
      role: { value: "heading" },
      name: { value: "Drag board" },
      properties: [],
    }],
    ["middle-frame", [{
      nodeId: "ax-drag-source",
      backendDOMNodeId: 61,
      frameId: "middle-frame",
      role: { value: "button" },
      name: { value: "Drag source" },
      properties: [],
    }, {
      nodeId: "ax-drop-target",
      backendDOMNodeId: 62,
      frameId: "middle-frame",
      role: { value: "button" },
      name: { value: "Drop target" },
      properties: [],
    }]],
  ]);
  const snapshot = await captureFrameSemanticFixture(moneyhand, client, {
    rootTree,
    sessions,
    targetTrees: [],
    frameIds: ["root", "middle-frame"],
    axByFrame,
  });
  assert.deepEqual(
    snapshot.nodes.map((node) => [node.ref, node.name]),
    [["@1", "Drag board"], ["@2", "Drag source"], ["@3", "Drop target"]],
  );
  await moneyhand.createTaskSpace({ id: "same-process-frame-drag", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "same-process-frame-drag",
    snapshotId: snapshot.id,
    ref: "@2",
    action: "drag",
    toRef: "@3",
    effect: "input",
    timeoutMs: 1_000,
  });
  const scrollModes = {
    "object-drag-source": [],
    "object-drop-target": [],
  };
  let executionContextId = 800;
  let ownerRequests = 0;
  let releases = 0;
  while (releases < 2) {
    const request = await client.nextJson();
    if (request.method === "input.perform") {
      assert.deepEqual(request.params, {
        target: { tabId: 42 },
        action: "drag",
        coordinateSpace: COORDINATE_SPACE,
        from: { x: 130, y: 150 },
        to: { x: 330, y: 250 },
      });
      respond(client, request, {
        ok: true,
        result: { target: { tabId: 42 }, action: "drag", ok: true },
      });
      continue;
    }
    assert.equal(request.method, "cdp.send");
    const method = request.params.method;
    if (method === "Page.getFrameTree") {
      respondCdp(client, request, rootTree);
    } else if (method === "Page.createIsolatedWorld") {
      executionContextId += 1;
      respondCdp(client, request, { executionContextId });
    } else if (method === "DOM.resolveNode") {
      const backendNodeId = request.params.params.backendNodeId;
      assert.ok(backendNodeId === 61 || backendNodeId === 62);
      respondCdp(client, request, {
        object: {
          objectId: backendNodeId === 61 ? "object-drag-source" : "object-drop-target",
        },
      });
    } else if (method === "Runtime.callFunctionOn") {
      const objectId = request.params.params.objectId;
      if (request.params.params.functionDeclaration.includes("elementFromPoint")) {
        const scroll = request.params.params.arguments?.[0]?.value?.scroll;
        scrollModes[objectId].push(scroll);
        const source = objectId === "object-drag-source";
        respondCdp(client, request, {
          result: {
            type: "object",
            value: {
              ok: true,
              connected: true,
              url: "https://example.test/middle",
              x: source ? 50 : 250,
              y: source ? 50 : 150,
              rect: source
                ? { x: 20, y: 30, width: 60, height: 40 }
                : { x: 220, y: 130, width: 60, height: 40 },
              viewport: { width: 500, height: 400 },
              tag: "button",
              role: "button",
              editable: false,
              focused: false,
              value: null,
              checked: null,
            },
          },
        });
      } else {
        assert.equal(objectId, "object-drag-source");
        respondCdp(client, request, {
          result: {
            type: "object",
            value: { connected: true, focused: false, value: null, checked: null },
          },
        });
      }
    } else if (method === "DOM.getFrameOwner") {
      ownerRequests += 1;
      assert.deepEqual(request.params.params, { frameId: "middle-frame" });
      respondCdp(client, request, { backendNodeId: 600 });
    } else if (method === "DOM.scrollIntoViewIfNeeded") {
      assert.fail("semantic drag must not scroll a frame owner after dual final preflight");
    } else if (method === "DOM.getContentQuads") {
      respondCdp(client, request, {
        quads: [[80, 100, 580, 100, 580, 500, 80, 500]],
      });
    } else if (method === "Runtime.evaluate") {
      respondCdp(client, request, {
        result: { type: "object", value: { width: 900, height: 700 } },
      });
    } else if (method === "DOM.getNodeForLocation") {
      assert.ok([
        "130,150",
        "330,250",
      ].includes(`${request.params.params.x},${request.params.params.y}`));
      respondCdp(client, request, { backendNodeId: 61, frameId: "middle-frame" });
    } else if (method === "Runtime.releaseObject") {
      assert.ok([
        "object-drag-source",
        "object-drop-target",
      ].includes(request.params.params.objectId));
      releases += 1;
      respondCdp(client, request, {});
    } else {
      assert.fail(`unexpected semantic frame drag method: ${method}`);
    }
  }

  const result = await acting;
  assert.equal(ownerRequests, 2);
  assert.deepEqual(scrollModes, {
    "object-drag-source": [true, false],
    "object-drop-target": [true, false],
  });
  assert.deepEqual(result.target.localPoint, { x: 50, y: 50 });
  assert.deepEqual(result.target.topLevelGuardPoint, { x: 130, y: 150 });
  assert.equal(result.destination.ref, "@3");
  assert.deepEqual(result.destination.localPoint, { x: 250, y: 150 });
  assert.deepEqual(result.destination.topLevelGuardPoint, { x: 330, y: 250 });
  assert.equal(result.verification.claim, "observation-only");
  assert.equal(result.cleanup.released, true);
  assert.equal(result.cleanup.objects.source.released, true);
  assert.equal(result.cleanup.objects.destination.released, true);
});

test("actSemanticRef does not double-map an OOPIF quad already rooted through a same-process parent", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const rootTree = nestedRootSemanticFrameTree();
  const childTree = childSemanticFrameTree("middle-frame");
  const sessions = semanticFrameSessions("middle-frame");
  const snapshot = await captureFrameSemanticFixture(moneyhand, client, {
    rootTree,
    childTree,
    sessions,
    frameIds: ["root", "middle-frame", "child-frame"],
  });
  assert.deepEqual(snapshot.frames.map((frame) => frame.frameId), [
    "root",
    "middle-frame",
    "child-frame",
  ]);
  assert.equal(snapshot.nodes[2].ref, "@3");
  await moneyhand.createTaskSpace({ id: "nested-frame-click", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "nested-frame-click",
    snapshotId: snapshot.id,
    ref: "@3",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  let ownerRequests = 0;
  let preflightReads = 0;
  let released = false;
  while (!released) {
    const request = await client.nextJson();
    if (request.method === "target.sessions") {
      respond(client, request, { ok: true, result: sessions });
      continue;
    }
    if (request.method === "input.perform") {
      assert.deepEqual(request.params.target, { tabId: 42 });
      assert.deepEqual({ x: request.params.x, y: request.params.y }, { x: 190, y: 220 });
      respond(client, request, {
        ok: true,
        result: { target: { tabId: 42 }, action: "click", ok: true },
      });
      continue;
    }
    assert.equal(request.method, "cdp.send");
    const method = request.params.method;
    if (method === "Page.getFrameTree") {
      respondCdp(client, request, request.params.target.sessionId ? childTree : rootTree);
    } else if (method === "Page.createIsolatedWorld") {
      respondCdp(client, request, {
        executionContextId: request.params.params.frameId === "root" ? 702 : 701,
      });
    } else if (method === "DOM.resolveNode") {
      respondCdp(client, request, { object: { objectId: "object-nested-child" } });
    } else if (method === "Runtime.callFunctionOn") {
      preflightReads += 1;
      respondCdp(client, request, {
        result: {
          type: "object",
          value: preflightReads === 1
            ? {
                ok: true,
                connected: true,
                url: "https://frame.example.test/form",
                x: 50,
                y: 50,
                rect: { x: 20, y: 30, width: 60, height: 40 },
                viewport: { width: 300, height: 200 },
                tag: "button",
                role: "button",
                editable: false,
                focused: false,
                value: null,
                checked: null,
              }
            : { connected: true, focused: false, value: null, checked: null },
        },
      });
    } else if (method === "DOM.getFrameOwner") {
      ownerRequests += 1;
      assert.deepEqual(request.params.params, { frameId: "child-frame" });
      respondCdp(client, request, { backendNodeId: 700 });
    } else if (method === "DOM.scrollIntoViewIfNeeded") {
      respondCdp(client, request, {});
    } else if (method === "DOM.getContentQuads") {
      respondCdp(client, request, {
        quads: [[140, 170, 440, 170, 440, 370, 140, 370]],
      });
    } else if (method === "Runtime.evaluate") {
      respondCdp(client, request, {
        result: { type: "object", value: { width: 900, height: 700 } },
      });
    } else if (method === "DOM.getNodeForLocation") {
      assert.deepEqual(
        { x: request.params.params.x, y: request.params.params.y },
        { x: 190, y: 220 },
      );
      respondCdp(client, request, { backendNodeId: 84, frameId: "child-frame" });
    } else if (method === "Runtime.releaseObject") {
      respondCdp(client, request, {});
      released = true;
    } else {
      assert.fail(`unexpected nested frame action method: ${method}`);
    }
  }

  const result = await acting;
  assert.equal(ownerRequests, 1);
  assert.equal(result.target.x, 190);
  assert.equal(result.target.y, 220);
  assert.equal(result.cleanup.released, true);
});

test("actSemanticRef maps through two flattened OOPIF session roots before one top-level click", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const rootTree = rootSemanticFrameTree();
  const middleTree = middleOopifFrameTree();
  const childTree = childSemanticFrameTree("middle-frame");
  const sessions = nestedOopifFrameSessions();
  const snapshot = await captureFrameSemanticFixture(moneyhand, client, {
    rootTree,
    sessions,
    targetTrees: [
      { sessionId: "middle-session", tree: middleTree },
      { sessionId: "child-session", tree: childTree },
    ],
    frameIds: ["root", "middle-frame", "child-frame"],
  });
  const resolved = moneyhand.resolveSemanticRef({ snapshotId: snapshot.id, ref: "@3" });
  assert.deepEqual(resolved.framePath.map((frame) => frame.sessionId), [
    "middle-session",
    "child-session",
  ]);
  assert.deepEqual(resolved.framePath.map((frame) => frame.targetId), [
    "middle-target",
    "child-target",
  ]);
  await moneyhand.createTaskSpace({ id: "nested-oopif-click", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "nested-oopif-click",
    snapshotId: snapshot.id,
    ref: "@3",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  const treeBySession = new Map([
    ["middle-session", middleTree],
    ["child-session", childTree],
  ]);
  const ownerFrames = [];
  let preflightReads = 0;
  let released = false;
  while (!released) {
    const request = await client.nextJson();
    if (request.method === "target.sessions") {
      respond(client, request, { ok: true, result: sessions });
      continue;
    }
    if (request.method === "input.perform") {
      assert.deepEqual(request.params.target, { tabId: 42 });
      assert.deepEqual({ x: request.params.x, y: request.params.y }, { x: 190, y: 220 });
      respond(client, request, {
        ok: true,
        result: { target: { tabId: 42 }, action: "click", ok: true },
      });
      continue;
    }
    assert.equal(request.method, "cdp.send");
    const method = request.params.method;
    if (method === "Page.getFrameTree") {
      respondCdp(
        client,
        request,
        treeBySession.get(request.params.target.sessionId) ?? rootTree,
      );
    } else if (method === "Page.createIsolatedWorld") {
      const contextByFrame = { "child-frame": 701, "middle-frame": 702, root: 703 };
      respondCdp(client, request, {
        executionContextId: contextByFrame[request.params.params.frameId],
      });
    } else if (method === "DOM.resolveNode") {
      respondCdp(client, request, { object: { objectId: "object-nested-oopif" } });
    } else if (method === "Runtime.callFunctionOn") {
      preflightReads += 1;
      respondCdp(client, request, {
        result: {
          type: "object",
          value: preflightReads === 1
            ? {
                ok: true,
                connected: true,
                url: "https://frame.example.test/form",
                x: 50,
                y: 50,
                rect: { x: 20, y: 30, width: 60, height: 40 },
                viewport: { width: 300, height: 200 },
                tag: "button",
                role: "button",
                editable: false,
                focused: false,
                value: null,
                checked: null,
              }
            : { connected: true, focused: false, value: null, checked: null },
        },
      });
    } else if (method === "DOM.getFrameOwner") {
      ownerFrames.push(request.params.params.frameId);
      const expectedTarget = request.params.params.frameId === "child-frame"
        ? { tabId: 42, sessionId: "middle-session" }
        : { tabId: 42 };
      assert.deepEqual(request.params.target, expectedTarget);
      respondCdp(client, request, {
        backendNodeId: request.params.params.frameId === "child-frame" ? 700 : 701,
      });
    } else if (method === "DOM.scrollIntoViewIfNeeded") {
      respondCdp(client, request, {});
    } else if (method === "DOM.getContentQuads") {
      respondCdp(client, request, {
        quads: request.params.target.sessionId
          ? [[60, 70, 360, 70, 360, 270, 60, 270]]
          : [[80, 100, 580, 100, 580, 500, 80, 500]],
      });
    } else if (method === "Runtime.evaluate") {
      const dimensions = request.params.params.contextId === 702
        ? { width: 500, height: 400 }
        : { width: 900, height: 700 };
      respondCdp(client, request, { result: { type: "object", value: dimensions } });
    } else if (method === "DOM.getNodeForLocation") {
      assert.deepEqual(
        { x: request.params.params.x, y: request.params.params.y },
        { x: 190, y: 220 },
      );
      respondCdp(client, request, { backendNodeId: 84, frameId: "child-frame" });
    } else if (method === "Runtime.releaseObject") {
      respondCdp(client, request, {});
      released = true;
    } else {
      assert.fail(`unexpected nested OOPIF action method: ${method}`);
    }
  }

  const result = await acting;
  assert.deepEqual(ownerFrames, ["child-frame", "middle-frame"]);
  assert.equal(result.target.x, 190);
  assert.equal(result.target.y, 220);
  assert.equal(result.cleanup.released, true);
});

test("actSemanticRef rejects a replaced iframe target before resolving or dispatching input", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureFrameSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "stale-frame", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "stale-frame",
    snapshotId: snapshot.id,
    ref: "@2",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "target.sessions");
  const staleSessions = semanticFrameSessions();
  staleSessions.sessions[0].targetInfo.targetId = "replacement-target";
  respond(client, request, { ok: true, result: staleSessions });

  await assert.rejects(
    acting,
    (error) => error.code === "STALE_SEMANTIC_REF"
      && error.details.frameId === "child-frame",
  );
});

test("waitForSemanticLocator polls transient absence and returns the latest stable ref", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  assert.deepEqual(moneyhand.capabilities().semanticObservation.locatorWait.kinds, ["role", "css"]);
  const waiting = moneyhand.execute({
    op: "waitForSemanticLocator",
    tabId: 42,
    locator: { kind: "role", role: "button", name: "Continue" },
    state: "actionable",
    timeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    pollIntervalMs: 100,
    stablePolls: 2,
  });
  const frameTree = {
    frameTree: {
      frame: { id: "root", loaderId: "loader-wait", url: "https://example.test/wait" },
    },
  };
  const answerSnapshot = async (nodes) => {
    const request = await client.nextJson();
    assert.deepEqual(
      request.params.steps.map((step) => step.params.method),
      ["Page.getFrameTree", "Accessibility.getFullAXTree", "Page.getFrameTree"],
    );
    respond(client, request, {
      ok: true,
      result: {
        completed: 3,
        total: 3,
        results: [
          batchStep(0, "Page.getFrameTree", frameTree),
          batchStep(1, "Accessibility.getFullAXTree", { nodes }),
          batchStep(2, "Page.getFrameTree", frameTree),
        ],
      },
    });
  };
  await answerSnapshot([]);
  await connectExtension(moneyhand, t, extensionHello({
    profile: "npc-profile-other",
    instanceId: "instance_other",
    bootId: "boot_other",
    focus: { windowId: 99, focused: true, lastFocusedAt: 999 },
  }));
  assert.equal(moneyhand.status().activeSession.instanceId, "instance_other");
  await answerSnapshot([{
    nodeId: "ax-continue-1",
    backendDOMNodeId: 84,
    role: { value: "button" },
    name: { value: "Continue" },
    properties: [{ name: "disabled", value: { value: false } }],
  }]);
  await answerSnapshot([{
    nodeId: "ax-continue-2",
    backendDOMNodeId: 85,
    role: { value: "button" },
    name: { value: "Continue" },
    properties: [{ name: "disabled", value: { value: false } }],
  }]);

  const result = await waiting;
  assert.equal(result.matched, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.stablePolls, 2);
  assert.equal(result.match.ref, "@1");
  assert.equal(result.match.node.backendNodeId, 85);
  assert.deepEqual(result.snapshot.sessionSelector, {
    instanceId: "instance_0001",
    bootId: "boot_0000001",
  });
  assert.equal(moneyhand.status().semanticSnapshots.length, 1);
  assert.equal(moneyhand.resolveSemanticRef({
    snapshotId: result.snapshot.id,
    ref: result.match.ref,
  }).node.backendNodeId, 85);
});

test("waitForSemanticLocator rejects a current ambiguous role without retaining refs", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const waiting = moneyhand.waitForSemanticLocator({
    tabId: 42,
    locator: { kind: "role", role: "button", name: "Continue" },
    state: "attached",
    timeoutMs: 1_000,
    stablePolls: 1,
  });
  const request = await client.nextJson();
  const frameTree = {
    frameTree: {
      frame: { id: "root", loaderId: "loader-ambiguous", url: "https://example.test/wait" },
    },
  };
  const duplicate = (nodeId, backendDOMNodeId) => ({
    nodeId,
    backendDOMNodeId,
    role: { value: "button" },
    name: { value: "Continue" },
    properties: [],
  });
  respond(client, request, {
    ok: true,
    result: {
      completed: 3,
      total: 3,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "Accessibility.getFullAXTree", {
          nodes: [duplicate("ax-continue-1", 84), duplicate("ax-continue-2", 85)],
        }),
        batchStep(2, "Page.getFrameTree", frameTree),
      ],
    },
  });
  await assert.rejects(
    waiting,
    (error) => error.code === "SEMANTIC_LOCATOR_AMBIGUOUS"
      && error.details.count === 2
      && error.details.attempts === 1,
  );
  assert.equal(moneyhand.status().semanticSnapshots.length, 0);
});

test("waitForSemanticLocator narrows a broad selector to the exact first Profile boot", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const capturedOptions = [];
  moneyhand.captureSemanticSnapshot = async (options) => {
    capturedOptions.push(options);
    const attempt = capturedOptions.length;
    return {
      snapshot: {
        id: `stub-snapshot-${attempt}`,
        sessionSelector: { instanceId: "instance_pinned", bootId: "boot_pinned" },
        guard: { frameId: "root", loaderId: "loader-pinned", url: "https://example.test/" },
        truncated: false,
        totalCandidates: 1,
        nodes: [{
          ref: "@1",
          backendNodeId: 80 + attempt,
          role: "button",
          name: "Continue",
          actionable: true,
          properties: { disabled: false },
        }],
      },
    };
  };
  const result = await moneyhand.waitForSemanticLocator({
    tabId: 42,
    selector: { profile: "broad-profile-name" },
    locator: { kind: "role", role: "button", name: "Continue" },
    stablePolls: 2,
    pollIntervalMs: 20,
    timeoutMs: 1_000,
  });
  assert.equal(result.matched, true);
  assert.deepEqual(capturedOptions[0].selector, { profile: "broad-profile-name" });
  assert.deepEqual(capturedOptions[1].selector, {
    instanceId: "instance_pinned",
    bootId: "boot_pinned",
  });
});

test("waitForSemanticLocator automatically enables frame capture for a frame-bound locator", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const capturedOptions = [];
  moneyhand.captureSemanticSnapshot = async (options) => {
    capturedOptions.push(options);
    return {
      snapshot: {
        id: "stub-frame-snapshot",
        sessionSelector: { instanceId: "instance_pinned", bootId: "boot_pinned" },
        guard: { frameId: "root", loaderId: "loader-root", url: "https://example.test/" },
        truncated: false,
        totalCandidates: 1,
        nodes: [{
          ref: "@1",
          backendNodeId: 84,
          role: "button",
          name: "Continue",
          actionable: true,
          properties: { disabled: false },
          frame: {
            frameId: "child-frame",
            loaderId: "loader-child",
            url: "https://frame.example.test/form",
            depth: 1,
            topLevel: false,
            sessionId: "child-session",
            targetId: "child-target",
            parentFrameId: "root",
          },
        }],
      },
    };
  };

  const result = await moneyhand.waitForSemanticLocator({
    tabId: 42,
    locator: {
      kind: "role",
      role: "button",
      name: "Continue",
      frameId: "child-frame",
    },
    maxFrames: 12,
    stablePolls: 1,
    timeoutMs: 1_000,
  });

  assert.equal(result.matched, true);
  assert.equal(capturedOptions[0].includeFrames, true);
  assert.equal(capturedOptions[0].maxFrames, 12);
  assert.equal(result.match.node.frame.targetId, "child-target");
});

test("actSemanticLocator pins the Task Space before its first snapshot and closes one click", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client: pinnedClient } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "semantic-locator-click", tabIds: [42] });
  await connectExtension(moneyhand, t, extensionHello({
    profile: "npc-profile-other",
    instanceId: "instance_other",
    bootId: "boot_other",
    focus: { windowId: 99, focused: true, lastFocusedAt: 999 },
  }));
  assert.equal(moneyhand.status().activeSession.instanceId, "instance_other");

  const acting = moneyhand.execute({
    op: "actSemanticLocator",
    taskSpaceId: "semantic-locator-click",
    tabId: 42,
    locator: { kind: "role", role: "button", name: "Continue" },
    action: "click",
    effect: "input",
    stablePolls: 1,
    waitTimeoutMs: 1_000,
    timeoutMs: 1_000,
  });
  let request = await pinnedClient.nextJson();
  assert.equal(request.method, "batch.run");
  assert.deepEqual(
    request.params.steps.map((step) => step.params.method),
    ["Page.getFrameTree", "Accessibility.getFullAXTree", "Page.getFrameTree"],
  );
  const frameTree = semanticFrame();
  respond(pinnedClient, request, {
    ok: true,
    result: {
      completed: 3,
      total: 3,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "Accessibility.getFullAXTree", {
          nodes: [{
            nodeId: "ax-locator-click",
            backendDOMNodeId: 84,
            role: { value: "button" },
            name: { value: "Continue" },
            properties: [{ name: "disabled", value: { value: false } }],
          }],
        }),
        batchStep(2, "Page.getFrameTree", frameTree),
      ],
    },
  });

  request = await pinnedClient.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(pinnedClient, request, frameTree);
  await createSemanticIsolatedWorld(pinnedClient);
  request = await pinnedClient.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 84);
  respondCdp(pinnedClient, request, { object: { objectId: "object-locator-click" } });
  await respondSemanticTargetPreflight(pinnedClient, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 31,
    y: 47,
    rect: { x: 11, y: 27, width: 40, height: 40 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await pinnedClient.nextJson();
  assert.equal(request.method, "input.perform");
  assert.equal(request.params.action, "click");
  respond(pinnedClient, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "click", ok: true },
  });
  request = await pinnedClient.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(pinnedClient, request, frameTree);
  request = await pinnedClient.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(pinnedClient, request, {
    result: {
      type: "object",
      value: { connected: true, focused: true, value: null, checked: null },
    },
  });
  request = await pinnedClient.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-locator-click");
  respondCdp(pinnedClient, request, {});

  const result = await acting;
  assert.deepEqual(result.locator, {
    kind: "role",
    role: "button",
    name: "Continue",
  });
  assert.equal(result.locatorWait.attempts, 1);
  assert.equal(result.locatorWait.stablePolls, 1);
  assert.equal(result.snapshotRetained, false);
  assert.equal(moneyhand.status().semanticSnapshots.length, 0);
});

test("actSemanticLocator sends high-impact intent through the same guarded locator path", async (t) => {
  const moneyhand = await startMoneyHand(t);
  await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "semantic-locator-closed", tabIds: [42] });
  let waits = 0;
  let actions = 0;
  let waitOptions;
  moneyhand.waitForSemanticLocator = async (options) => {
    waits += 1;
    waitOptions = options;
    return {
      matched: false,
      timedOut: true,
      attempts: 3,
      stablePolls: 0,
      stablePollsRequired: 2,
      lastObservation: { status: "missing", count: 0 },
    };
  };
  moneyhand.actSemanticRef = async () => {
    actions += 1;
    return {};
  };
  const common = {
    taskSpaceId: "semantic-locator-closed",
    tabId: 42,
    locator: { kind: "role", role: "button", name: "Send" },
    action: "click",
  };

  await assert.rejects(
    moneyhand.actSemanticLocator({ ...common, effect: "send" }),
    (error) => error.code === "SEMANTIC_LOCATOR_NOT_READY"
      && error.details.actionDispatched === false,
  );
  assert.equal(waits, 1);
  assert.equal(actions, 0);

  await assert.rejects(
    moneyhand.actSemanticLocator({ ...common, effect: "input", state: "attached" }),
    (error) => error.code === "INVALID_SEMANTIC_LOCATOR",
  );
  await assert.rejects(
    moneyhand.actSemanticLocator({
      ...common,
      effect: "input",
      selector: { profile: "caller-selected-profile" },
    }),
    (error) => error.code === "TASK_SPACE_SELECTOR_OWNED",
  );
  assert.equal(waits, 1);
  assert.equal(actions, 0);

  await assert.rejects(
    moneyhand.actSemanticLocator({ ...common, effect: "input" }),
    (error) => error.code === "SEMANTIC_LOCATOR_NOT_READY"
      && error.details.actionDispatched === false
      && error.details.timedOut === true,
  );
  assert.equal(waits, 2);
  assert.equal(actions, 0);
  assert.deepEqual(waitOptions.selector, {
    profile: "npc-instance_0001",
    instanceId: "instance_0001",
    bootId: "boot_0000001",
  });
});

test("actSemanticLocator resolves drag destination in the final source snapshot and drops it", async (t) => {
  const moneyhand = await startMoneyHand(t);
  await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "semantic-locator-drag", tabIds: [42] });
  const source = {
    ref: "@1",
    backendNodeId: 84,
    role: "button",
    name: "Card",
    actionable: true,
    properties: { disabled: false },
  };
  const destination = {
    ref: "@2",
    backendNodeId: 85,
    role: "region",
    name: "Done",
    actionable: true,
    properties: { disabled: false },
  };
  let snapshotSequence = 0;
  let destinationNodes = [destination];
  moneyhand.waitForSemanticLocator = async () => {
    snapshotSequence += 1;
    const snapshot = {
      id: `semantic-locator-drag-${snapshotSequence}`,
      tabId: 42,
      sessionSelector: { instanceId: "instance_0001", bootId: "boot_0000001" },
      guard: {
        frameId: "root",
        loaderId: "loader-semantic",
        url: "https://example.test/app",
      },
      truncated: false,
      totalCandidates: 1 + destinationNodes.length,
      nodes: [source, ...destinationNodes],
    };
    moneyhand.semanticSnapshots.set(snapshot.id, { snapshot, expiresAtMs: Date.now() + 1_000 });
    return {
      matched: true,
      timedOut: false,
      attempts: 1,
      stablePolls: 1,
      stablePollsRequired: 1,
      elapsedMs: 2,
      snapshot,
      match: { ref: source.ref, node: source },
    };
  };
  let actionInput;
  let actions = 0;
  moneyhand.actSemanticRef = async (input) => {
    actions += 1;
    actionInput = input;
    return { action: { action: "drag" }, verification: { kind: "observe" } };
  };
  const common = {
    taskSpaceId: "semantic-locator-drag",
    tabId: 42,
    locator: { kind: "role", role: "button", name: "Card" },
    toLocator: { kind: "role", role: "region", name: "Done" },
    action: "drag",
    effect: "input",
  };

  const result = await moneyhand.actSemanticLocator(common);
  assert.equal(actions, 1);
  assert.equal(actionInput.snapshotId, "semantic-locator-drag-1");
  assert.equal(actionInput.ref, "@1");
  assert.equal(actionInput.toRef, "@2");
  assert.equal(Object.hasOwn(actionInput, "locator"), false);
  assert.equal(Object.hasOwn(actionInput, "toLocator"), false);
  assert.equal(result.locatorWait.destinationCurrentSnapshot, true);
  assert.equal(result.snapshotRetained, false);
  assert.equal(moneyhand.status().semanticSnapshots.length, 0);

  destinationNodes = [
    destination,
    { ...destination, ref: "@3", backendNodeId: 86 },
  ];
  await assert.rejects(
    moneyhand.actSemanticLocator(common),
    (error) => error.code === "SEMANTIC_LOCATOR_AMBIGUOUS"
      && error.details.actionDispatched === false
      && error.details.target === "destination"
      && error.details.count === 2,
  );
  assert.equal(actions, 1);
  assert.equal(moneyhand.status().semanticSnapshots.length, 0);
});

test("actSemanticRef revalidates a live ref, clicks one fresh hit point and observes once", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-click", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-click",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());

  await createSemanticIsolatedWorld(client);

  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 84);
  respondCdp(client, request, { object: { objectId: "object-click" } });

  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 31,
    y: 47,
    rect: { x: 11, y: 27, width: 40, height: 40 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });

  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.equal(request.behavior, undefined);
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    action: "click",
    coordinateSpace: COORDINATE_SPACE,
    x: 31,
    y: 47,
    button: "left",
    clickCount: 1,
  });
  respond(client, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "click", ok: true },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { connected: true, focused: true, value: null, checked: null },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-click");
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.verification.kind, "observe");
  assert.equal(result.verification.matched, null);
  assert.equal(result.verification.claim, "observation-only");
  assert.deepEqual(result.cleanup, { attempted: true, released: true });
});

test("actSemanticRef proves one guarded download from a pre-click Profile baseline", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "link",
    name: "Download report",
  });
  await moneyhand.createTaskSpace({ id: "semantic-download", tabIds: [42] });

  await assert.rejects(
    moneyhand.actSemanticRef({
      taskSpaceId: "semantic-download",
      snapshotId: snapshot.id,
      ref: "@1",
      action: "download",
      download: {},
      effect: "input",
    }),
    (error) => error.code === "INVALID_TASK_EFFECT",
  );

  const finalUrl = "https://files.example.test/report.csv?token=private";
  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-download",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: {
      timeoutMs: 1_000,
      pollIntervalMs: 20,
      match: { filename: "report.csv", finalUrl, mime: "text/csv" },
    },
    effect: "download",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 709);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-download" } });
  const target = {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 32,
    y: 48,
    rect: { x: 12, y: 28, width: 40, height: 40 },
    tag: "a",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  };
  await respondSemanticTargetPreflight(client, target);

  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  assert.equal(request.params.method, "downloads.search");
  assert.deepEqual(request.params.args[0].orderBy, ["-startTime"]);
  assert.equal(request.params.args[0].limit, 256);
  respond(client, request, {
    ok: true,
    result: { method: "downloads.search", result: [] },
  });

  await respondSemanticTargetPreflight(client, { ...target, x: 34, y: 50 });
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    action: "click",
    coordinateSpace: COORDINATE_SPACE,
    x: 34,
    y: 50,
    button: "left",
    clickCount: 1,
  });
  respond(client, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "click", ok: true },
  });

  const download = {
    id: 17,
    state: "in_progress",
    filename: "C:\\Users\\eric\\Downloads\\report.csv",
    url: "https://files.example.test/report.csv?source=app",
    finalUrl,
    mime: "text/csv",
    danger: "safe",
    bytesReceived: 64,
    totalBytes: 128,
    fileSize: -1,
    startTime: "2026-08-02T10:00:00.000Z",
  };
  request = await client.nextJson();
  assert.equal(request.params.method, "downloads.search");
  respond(client, request, {
    ok: true,
    result: { method: "downloads.search", result: [download] },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "downloads.search");
  respond(client, request, {
    ok: true,
    result: {
      method: "downloads.search",
      result: [{
        ...download,
        state: "complete",
        bytesReceived: 128,
        fileSize: 128,
        endTime: "2026-08-02T10:00:01.000Z",
      }],
    },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  const result = await acting;
  assert.equal(result.action, "download");
  assert.equal(result.actionDispatched, true);
  assert.equal(result.verification.kind, "download-complete");
  assert.equal(result.verification.matched, true);
  assert.equal(result.download.filename, "report.csv");
  assert.equal(result.download.finalUrl, "https://files.example.test/report.csv");
  assert.equal(result.download.localPathReturned, false);
  assert.equal(result.download.fileExistenceVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /Users\\\\eric|token=private/u);
});

test("actSemanticRef fails closed when one click yields ambiguous Profile downloads", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-download-ambiguous", tabIds: [42] });
  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-download-ambiguous",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: { timeoutMs: 0 },
    effect: "download",
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 710);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-download-ambiguous" } });
  const target = {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  };
  await respondSemanticTargetPreflight(client, target);
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: { method: "downloads.search", result: [] },
  });
  await respondSemanticTargetPreflight(client, target);
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  respond(client, request, { ok: true, result: { action: "click", ok: true } });
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      method: "downloads.search",
      result: [
        { id: 21, state: "complete", filename: "C:\\Downloads\\one.csv" },
        { id: 22, state: "complete", filename: "C:\\Downloads\\two.csv" },
      ],
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(
    acting,
    (error) => error.code === "DOWNLOAD_AMBIGUOUS"
      && error.details.actionDispatched === true
      && error.details.retry === "inspect-before-retry"
      && error.details.candidates.length === 2
      && error.details.candidates.every((candidate) => candidate.localPathReturned === false),
  );

  const baseline = [
    { id: 21, state: "complete", filename: "C:\\Downloads\\one.csv" },
    { id: 22, state: "complete", filename: "C:\\Downloads\\two.csv" },
  ];
  const missing = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-download-ambiguous",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: { timeoutMs: 0, match: { filename: "never.csv" } },
    effect: "download",
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 711);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  respondCdp(client, request, { object: { objectId: "object-download-missing" } });
  await respondSemanticTargetPreflight(client, target);
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: { method: "downloads.search", result: baseline },
  });
  await respondSemanticTargetPreflight(client, target);
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  respond(client, request, { ok: true, result: { action: "click", ok: true } });
  request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: { method: "downloads.search", result: baseline },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(
    missing,
    (error) => error.code === "DOWNLOAD_OUTCOME_UNKNOWN"
      && error.details.actionDispatched === true
      && error.details.retry === "inspect-before-retry",
  );

  const overflow = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-download-ambiguous",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: {},
    effect: "download",
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 712);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-download-overflow" } });
  await respondSemanticTargetPreflight(client, target);
  request = await client.nextJson();
  assert.equal(request.method, "chrome.call");
  respond(client, request, {
    ok: true,
    result: {
      method: "downloads.search",
      result: Array.from({ length: 256 }, (_, id) => ({
        id,
        state: "complete",
        filename: `C:\\Downloads\\baseline-${id}.csv`,
      })),
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(
    overflow,
    (error) => error.code === "DOWNLOAD_BASELINE_OVERFLOW"
      && error.details.actionDispatched === false,
  );
});

test("actSemanticRef dispatches hover and anchored scroll from one fresh guarded point", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-pointer", tabIds: [42] });

  const run = async ({ action, expectedHandAction, extra = {}, objectId }) => {
    const acting = moneyhand.actSemanticRef({
      taskSpaceId: "semantic-pointer",
      snapshotId: snapshot.id,
      ref: "@1",
      action,
      ...extra,
      effect: "input",
      timeoutMs: 1_000,
    });
    let request = await client.nextJson();
    assert.equal(request.params.method, "Page.getFrameTree");
    respondCdp(client, request, semanticFrame());
    await createSemanticIsolatedWorld(client);
    request = await client.nextJson();
    assert.equal(request.params.method, "DOM.resolveNode");
    respondCdp(client, request, { object: { objectId } });
    await respondSemanticTargetPreflight(client, {
      ok: true,
      connected: true,
      url: "https://example.test/app",
      x: 44,
      y: 66,
      rect: { x: 20, y: 40, width: 48, height: 52 },
      viewport: { width: 800, height: 600 },
      tag: "div",
      role: null,
      editable: false,
      focused: false,
      value: null,
      checked: null,
    });

    request = await client.nextJson();
    assert.equal(request.method, "input.perform");
    assert.deepEqual(request.params, {
      target: { tabId: 42 },
      action: expectedHandAction,
      coordinateSpace: COORDINATE_SPACE,
      x: 44,
      y: 66,
      ...(action === "scroll" ? { deltaX: extra.deltaX ?? 0, deltaY: extra.deltaY ?? 0 } : {}),
    });
    respond(client, request, {
      ok: true,
      result: { target: { tabId: 42 }, action: expectedHandAction, ok: true },
    });

    request = await client.nextJson();
    assert.equal(request.params.method, "Page.getFrameTree");
    respondCdp(client, request, semanticFrame());
    request = await client.nextJson();
    assert.equal(request.params.method, "Runtime.callFunctionOn");
    respondCdp(client, request, {
      result: {
        type: "object",
        value: { connected: true, focused: false, value: null, checked: null },
      },
    });
    request = await client.nextJson();
    assert.equal(request.params.method, "Runtime.releaseObject");
    assert.equal(request.params.params.objectId, objectId);
    respondCdp(client, request, {});

    const result = await acting;
    assert.equal(result.action, action);
    assert.deepEqual({ x: result.target.x, y: result.target.y }, { x: 44, y: 66 });
    assert.equal(result.verification.claim, "observation-only");
    assert.equal(result.cleanup.released, true);
  };

  await run({ action: "hover", expectedHandAction: "move", objectId: "object-hover" });
  await run({
    action: "scroll",
    expectedHandAction: "scroll",
    extra: { deltaX: -80, deltaY: 640 },
    objectId: "object-scroll",
  });
});

test("actSemanticRef focuses and replaces an editable ref in one Hand batch with verification", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "textbox",
    name: "Account name",
    backendNodeId: 85,
  });
  await moneyhand.createTaskSpace({ id: "semantic-type", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-type",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "type",
    text: "new value",
    replace: true,
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 702);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-type" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 60,
    y: 20,
    rect: { x: 10, y: 10, width: 100, height: 20 },
    tag: "input",
    role: null,
    editable: true,
    focused: false,
    value: "old value",
    checked: null,
  });

  request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  assert.deepEqual(request.params.steps.map((step) => [step.method, step.params.method ?? step.params.action]), [
    ["cdp.send", "DOM.focus"],
    ["input.perform", "key"],
    ["input.perform", "type"],
  ]);
  assert.equal(request.params.steps[1].params.modifiers, 2);
  assert.equal(request.params.steps[2].params.text, "new value");
  respond(client, request, {
    ok: true,
    result: { completed: 3, total: 3, results: [] },
  });

  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { connected: true, focused: true, value: "new value", checked: null },
    },
  });
  request = await client.nextJson();
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.verification.kind, "target-text-inserted");
  assert.equal(result.verification.matched, true);
  assert.equal(result.verification.claim, "declarative-postcondition");
});

test("actSemanticRef checks a binary target with one guarded pointer click", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "checkbox",
    name: "Accept terms",
    backendNodeId: 91,
  });
  await moneyhand.createTaskSpace({ id: "semantic-check", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-check",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "check",
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 930);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 91);
  respondCdp(client, request, { object: { objectId: "object-check" } });
  const unchecked = {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 45,
    y: 30,
    rect: { x: 35, y: 20, width: 20, height: 20 },
    viewport: { width: 800, height: 600 },
    tag: "input",
    inputType: "checkbox",
    role: null,
    editable: false,
    focused: false,
    value: "on",
    checked: false,
    ariaChecked: null,
    indeterminate: false,
  };
  await respondSemanticTargetPreflight(client, unchecked);
  await respondSemanticTargetPreflight(client, unchecked);

  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.deepEqual(request.params, {
    target: { tabId: 42 },
    action: "click",
    coordinateSpace: COORDINATE_SPACE,
    x: 45,
    y: 30,
    button: "left",
    clickCount: 1,
  });
  respond(client, request, {
    ok: true,
    result: { target: { tabId: 42 }, action: "click", ok: true },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        connected: true,
        focused: true,
        value: "on",
        checked: true,
        ariaChecked: null,
        indeterminate: false,
        files: null,
        selection: null,
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.action, "check");
  assert.equal(result.actionDispatched, true);
  assert.equal(result.terminal.ok, true);
  assert.deepEqual(result.checkedState, {
    source: "native",
    kind: "checkbox",
    desired: true,
    before: false,
    after: true,
    initiallySatisfied: false,
    changed: true,
  });
  assert.equal(result.verification.kind, "target-checked");
  assert.equal(result.verification.matched, true);
  assert.equal(result.cleanup.released, true);
});

test("actSemanticRef leaves an already-satisfied ARIA switch untouched", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "switch",
    name: "Email alerts",
    backendNodeId: 92,
  });
  await moneyhand.createTaskSpace({ id: "semantic-uncheck", tabIds: [42] });
  const intent = {
    taskSpaceId: "semantic-uncheck",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "uncheck",
    effect: "publish",
  };
  const approval = moneyhand.approveSemanticRefAction({
    ...intent,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });

  const acting = moneyhand.actSemanticRef({
    ...intent,
    approvalToken: approval.token,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 931);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-uncheck" } });
  const alreadyUnchecked = {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 90,
    y: 30,
    rect: { x: 70, y: 20, width: 40, height: 20 },
    viewport: { width: 800, height: 600 },
    tag: "button",
    inputType: "",
    role: "switch",
    editable: false,
    focused: false,
    value: "",
    checked: false,
    ariaChecked: "false",
    indeterminate: null,
  };
  await respondSemanticTargetPreflight(client, alreadyUnchecked);
  await respondSemanticTargetPreflight(client, alreadyUnchecked);

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        connected: true,
        focused: false,
        value: "",
        checked: false,
        ariaChecked: "false",
        indeterminate: null,
        files: null,
        selection: null,
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.action, "uncheck");
  assert.equal(result.actionDispatched, false);
  assert.equal(result.terminal, null);
  assert.deepEqual(result.checkedState, {
    source: "aria",
    kind: "switch",
    desired: false,
    before: false,
    after: false,
    initiallySatisfied: true,
    changed: false,
  });
  assert.equal(result.verification.matched, true);
  assert.equal(result.cleanup.released, true);
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "consumed"],
  );
});

test("semantic checkable approvals bind desired state and reject radio uncheck before consumption", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "radio",
    name: "Public audience",
    backendNodeId: 93,
  });
  await moneyhand.createTaskSpace({ id: "semantic-radio-approval", tabIds: [42] });
  const confirmation = {
    approved: true,
    source: "user",
    confirmedAt: new Date().toISOString(),
  };
  const common = {
    taskSpaceId: "semantic-radio-approval",
    snapshotId: snapshot.id,
    ref: "@1",
    effect: "publish",
    confirmation,
  };
  const checkApproval = moneyhand.approveSemanticRefAction({
    ...common,
    action: "check",
  });
  const uncheckApproval = moneyhand.approveSemanticRefAction({
    ...common,
    action: "uncheck",
  });
  assert.notEqual(checkApproval.requestDigest, uncheckApproval.requestDigest);

  const acting = moneyhand.actSemanticRef({
    ...common,
    confirmation: undefined,
    action: "uncheck",
    approvalToken: uncheckApproval.token,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 932);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-radio-uncheck" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 50,
    y: 50,
    rect: { x: 40, y: 40, width: 20, height: 20 },
    viewport: { width: 800, height: 600 },
    tag: "input",
    inputType: "radio",
    role: null,
    editable: false,
    focused: false,
    value: "public",
    checked: true,
    ariaChecked: null,
    indeterminate: null,
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(
    acting,
    (error) => error.code === "SEMANTIC_RADIO_CANNOT_UNCHECK",
  );
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "issued"],
  );
});

test("actSemanticRef selects one exact native option with a fixed function and verifies it", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "combobox",
    name: "Invoice status",
    backendNodeId: 89,
  });
  await moneyhand.createTaskSpace({ id: "semantic-select", tabIds: [42] });

  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-select",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "select",
    options: [{ label: "Paid" }],
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 923);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 89);
  respondCdp(client, request, { object: { objectId: "object-select" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 70,
    y: 30,
    rect: { x: 20, y: 15, width: 100, height: 30 },
    viewport: { width: 800, height: 600 },
    tag: "select",
    inputType: "",
    role: null,
    multiple: false,
    editable: false,
    focused: false,
    value: "pending",
    checked: null,
  });

  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.equal(request.params.params.objectId, "object-select");
  assert.deepEqual(request.params.params.arguments, [{
    value: { descriptors: [{ label: "Paid" }], commit: false },
  }]);
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        ok: true,
        changed: true,
        applied: false,
        multiple: false,
        selection: {
          count: 1,
          options: [{ index: 2, value: "paid", label: "Paid" }],
        },
      },
    },
  });

  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.equal(request.params.params.objectId, "object-select");
  assert.deepEqual(request.params.params.arguments, [{
    value: { descriptors: [{ label: "Paid" }], commit: true },
  }]);
  assert.match(request.params.params.functionDeclaration, /option-ambiguous/u);
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        ok: true,
        changed: true,
        multiple: false,
        selection: {
          count: 1,
          options: [{ index: 2, value: "paid", label: "Paid" }],
        },
      },
    },
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.match(request.params.params.functionDeclaration, /selectedOptions/u);
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        connected: true,
        focused: false,
        value: "paid",
        checked: null,
        files: null,
        selection: {
          multiple: false,
          count: 1,
          options: [{ index: 2, value: "paid", label: "Paid" }],
        },
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-select");
  respondCdp(client, request, {});

  const result = await acting;
  assert.equal(result.action, "select");
  assert.deepEqual(result.selection, {
    changed: true,
    multiple: false,
    count: 1,
    options: [{ index: 2, value: "paid", label: "Paid" }],
  });
  assert.equal(result.verification.kind, "target-options-selected");
  assert.equal(result.verification.matched, true);
  assert.equal(result.cleanup.released, true);

  const invalidMultiple = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-select",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "select",
    options: [{ index: 0 }, { index: 1 }],
    effect: "input",
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 924);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-select-multiple" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 70,
    y: 30,
    rect: { x: 20, y: 15, width: 100, height: 30 },
    viewport: { width: 800, height: 600 },
    tag: "select",
    inputType: "",
    role: null,
    multiple: false,
    editable: false,
    focused: false,
    value: "paid",
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-select-multiple");
  respondCdp(client, request, {});
  await assert.rejects(
    invalidMultiple,
    (error) => error.code === "SEMANTIC_SELECT_MULTIPLE_REQUIRED",
  );
});

test("semantic select approvals bind the exact option descriptor", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "combobox",
    name: "Publish audience",
    backendNodeId: 90,
  });
  await moneyhand.createTaskSpace({ id: "semantic-select-approval", tabIds: [42] });
  const common = {
    taskSpaceId: "semantic-select-approval",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "select",
    effect: "publish",
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  };
  const internal = moneyhand.approveSemanticRefAction({
    ...common,
    options: [{ value: "internal" }],
  });
  const publicOption = moneyhand.approveSemanticRefAction({
    ...common,
    options: [{ value: "public" }],
  });
  assert.notEqual(internal.requestDigest, publicOption.requestDigest);

  const acting = moneyhand.actSemanticRef({
    ...common,
    options: [{ value: "internal" }],
    confirmation: undefined,
    approvalToken: internal.token,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 925);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-select-ambiguous" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 70,
    y: 30,
    rect: { x: 20, y: 15, width: 100, height: 30 },
    viewport: { width: 800, height: 600 },
    tag: "select",
    inputType: "",
    role: null,
    multiple: false,
    editable: false,
    focused: false,
    value: "private",
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.deepEqual(request.params.params.arguments, [{
    value: { descriptors: [{ value: "internal" }], commit: false },
  }]);
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { ok: false, reason: "option-ambiguous" },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-select-ambiguous");
  respondCdp(client, request, {});
  await assert.rejects(
    acting,
    (error) => error.code === "SEMANTIC_SELECT_OPTION_AMBIGUOUS",
  );
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "issued"],
  );
});

test("actSemanticRef uploads one confined file to the exact hidden file input and verifies its FileList", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "brief.pdf");
  await writeFile(file, "bounded upload fixture", "utf8");
  const canonicalFile = await realpath(file);

  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    role: "button",
    name: "Choose file",
    backendNodeId: 87,
  });
  await moneyhand.createTaskSpace({ id: "semantic-upload", tabIds: [42] });
  const intent = {
    taskSpaceId: "semantic-upload",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "upload",
    fileRoot: directory,
    files: [file],
    effect: "upload",
  };
  const approval = moneyhand.approveSemanticRefAction({
    ...intent,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });

  const acting = moneyhand.actSemanticRef({
    ...intent,
    approvalToken: approval.token,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 920);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 87);
  respondCdp(client, request, { object: { objectId: "object-upload" } });
  await respondSemanticFileInputPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    tag: "input",
    inputType: "file",
    multiple: false,
    accept: ".pdf",
    files: { count: 0, names: [] },
  });

  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "DOM.setFileInputFiles");
  assert.equal(request.params.params.objectId, "object-upload");
  assert.deepEqual(
    await Promise.all(request.params.params.files.map((path) => realpath(path))),
    [canonicalFile],
  );
  respondCdp(client, request, {});

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  assert.match(request.params.params.functionDeclaration, /element\.files/u);
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        connected: true,
        focused: false,
        value: "",
        checked: null,
        files: { count: 1, names: ["brief.pdf"] },
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-upload");
  respondCdp(client, request, {});

  const result = await acting;
  assert.deepEqual(result.target, {
    backendNodeId: 87,
    tag: "input",
    inputType: "file",
    multiple: false,
  });
  assert.deepEqual(result.fileSelection, {
    count: 1,
    totalBytes: Buffer.byteLength("bounded upload fixture"),
    pathsReturned: false,
  });
  assert.equal(result.verification.kind, "target-files-set");
  assert.equal(result.verification.matched, true);
  assert.equal(result.cleanup.released, true);
  assert.equal(JSON.stringify(result).includes(canonicalFile), false);
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "consumed"],
  );
});

test("semantic upload rejects unsafe paths and changed files before consuming approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-upload-guard-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "npc-moneyhand-upload-outside-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  const file = join(directory, "invoice.txt");
  const outsideFile = join(outsideDirectory, "outside.txt");
  await writeFile(file, "original", "utf8");
  await writeFile(outsideFile, "outside", "utf8");

  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    name: "Upload invoice",
    backendNodeId: 88,
  });
  await moneyhand.createTaskSpace({ id: "semantic-upload-guard", tabIds: [42] });
  const confirmation = {
    approved: true,
    source: "user",
    confirmedAt: new Date().toISOString(),
  };
  const base = {
    taskSpaceId: "semantic-upload-guard",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "upload",
    fileRoot: directory,
    files: [file],
    effect: "upload",
    confirmation,
  };

  assert.throws(
    () => moneyhand.approveSemanticRefAction({ ...base, effect: "input" }),
    (error) => error.code === "INVALID_TASK_EFFECT",
  );
  assert.throws(
    () => moneyhand.approveSemanticRefAction({ ...base, files: [outsideFile] }),
    (error) => error.code === "UPLOAD_FILE_OUTSIDE_ROOT",
  );
  assert.throws(
    () => moneyhand.approveSemanticRefAction({
      ...base,
      fileRoot: parse(directory).root,
    }),
    (error) => error.code === "INVALID_UPLOAD_ROOT",
  );
  assert.throws(
    () => moneyhand.approveSemanticRefAction({ ...base, files: [file, file] }),
    (error) => error.code === "DUPLICATE_UPLOAD_FILE",
  );
  assert.throws(
    () => moneyhand.approveSemanticRefAction({ ...base, files: [directory] }),
    (error) => error.code === "INVALID_UPLOAD_FILE",
  );

  const approval = moneyhand.approveSemanticRefAction(base);
  const acting = moneyhand.actSemanticRef({
    ...base,
    confirmation: undefined,
    approvalToken: approval.token,
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 921);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-upload-changed" } });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.callFunctionOn");
  await writeFile(file, "changed after approval planning", "utf8");
  respondCdp(client, request, {
    result: {
      type: "object",
      value: {
        ok: true,
        connected: true,
        url: "https://example.test/app",
        tag: "input",
        inputType: "file",
        multiple: false,
        accept: ".txt",
        files: { count: 0, names: [] },
      },
    },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-upload-changed");
  respondCdp(client, request, {});
  await assert.rejects(acting, (error) => error.code === "UPLOAD_FILE_CHANGED");
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued"],
  );

  const secondFile = join(directory, "receipt.txt");
  await writeFile(secondFile, "second", "utf8");
  const multipleIntent = { ...base, files: [file, secondFile] };
  const multipleApproval = moneyhand.approveSemanticRefAction(multipleIntent);
  const multipleActing = moneyhand.actSemanticRef({
    ...multipleIntent,
    confirmation: undefined,
    approvalToken: multipleApproval.token,
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 922);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-upload-multiple" } });
  await respondSemanticFileInputPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    tag: "input",
    inputType: "file",
    multiple: false,
    accept: ".txt",
    files: { count: 0, names: [] },
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-upload-multiple");
  respondCdp(client, request, {});
  await assert.rejects(
    multipleActing,
    (error) => error.code === "SEMANTIC_FILE_INPUT_MULTIPLE_REQUIRED",
  );
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "issued"],
  );
});

test("actSemanticRef rejects a stale drag destination before input and releases the source", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    nodes: [{
      nodeId: "ax-drag-source-stale",
      backendDOMNodeId: 84,
      ignored: false,
      role: { value: "button" },
      name: { value: "Drag source" },
      properties: [],
    }, {
      nodeId: "ax-drop-target-stale",
      backendDOMNodeId: 85,
      ignored: false,
      role: { value: "button" },
      name: { value: "Drop target" },
      properties: [],
    }],
  });
  await moneyhand.createTaskSpace({ id: "semantic-drag-stale", tabIds: [42] });
  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-drag-stale",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "drag",
    toRef: "@2",
    effect: "input",
  });

  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 910);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 84);
  respondCdp(client, request, { object: { objectId: "object-drag-stale-source" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    viewport: { width: 900, height: 700 },
    tag: "button",
    role: "button",
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });

  request = await client.nextJson();
  assert.equal(request.params.method, "Page.getFrameTree");
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 911);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  assert.equal(request.params.params.backendNodeId, 85);
  respondCdp(client, request, { object: {} });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  assert.equal(request.params.params.objectId, "object-drag-stale-source");
  respondCdp(client, request, {});
  await assert.rejects(
    acting,
    (error) => error.code === "STALE_SEMANTIC_REF"
      && /destination/u.test(error.message),
  );
});

test("actSemanticRef rejects stale or occluded refs before input and releases resolved objects", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-refusal", tabIds: [42] });

  const stale = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-refusal",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame("loader-new", "https://example.test/next"));
  await assert.rejects(stale, (error) => error.code === "STALE_SEMANTIC_REF");

  const detached = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-refusal",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 709);
  request = await client.nextJson();
  assert.equal(request.params.method, "DOM.resolveNode");
  respond(client, request, {
    ok: false,
    error: { code: "COMMAND_FAILED", message: "No node with given backend id" },
  });
  await assert.rejects(
    detached,
    (error) => error.code === "STALE_SEMANTIC_REF"
      && error.details.causeCode === "COMMAND_FAILED",
  );

  const sameDocumentChanged = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-refusal",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 710);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-url-changed" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app#changed-during-scroll",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(sameDocumentChanged, (error) => error.code === "STALE_SEMANTIC_REF");

  const occluded = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-refusal",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 1_000,
  });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 703);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-occluded" } });
  await respondSemanticTargetPreflight(client, {
    ok: false,
    reason: "occluded",
    connected: true,
    url: "https://example.test/app",
    hitTag: "dialog",
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(
    occluded,
    (error) => error.code === "SEMANTIC_TARGET_NOT_INTERACTABLE"
      && error.details.hitTag === "dialog",
  );
});

test("semantic drag approvals bind the exact destination ref and reject a self-drag", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client, {
    nodes: [{
      nodeId: "ax-approval-source",
      backendDOMNodeId: 84,
      ignored: false,
      role: { value: "button" },
      name: { value: "Source" },
      properties: [],
    }, {
      nodeId: "ax-approval-target-a",
      backendDOMNodeId: 85,
      ignored: false,
      role: { value: "button" },
      name: { value: "Target A" },
      properties: [],
    }, {
      nodeId: "ax-approval-target-b",
      backendDOMNodeId: 86,
      ignored: false,
      role: { value: "button" },
      name: { value: "Target B" },
      properties: [],
    }],
  });
  await moneyhand.createTaskSpace({ id: "semantic-drag-approval", tabIds: [42] });
  const common = {
    taskSpaceId: "semantic-drag-approval",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "drag",
    effect: "external-write",
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  };
  const targetA = moneyhand.approveSemanticRefAction({ ...common, toRef: "@2" });
  const targetB = moneyhand.approveSemanticRefAction({ ...common, toRef: "@3" });
  assert.notEqual(targetA.requestDigest, targetB.requestDigest);
  assert.throws(
    () => moneyhand.approveSemanticRefAction({ ...common, toRef: "@1" }),
    (error) => error.code === "INVALID_SEMANTIC_ACTION",
  );
});

test("semantic high-impact approval binds the exact ref intent and is consumed once", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-publish", tabIds: [42] });
  const common = {
    taskSpaceId: "semantic-publish",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "scroll",
    deltaX: -80,
    deltaY: 640,
    effect: "publish",
  };
  const approval = moneyhand.approveSemanticRefAction({
    ...common,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });
  assert.equal(approval.oneTime, true);

  const acting = moneyhand.actSemanticRef({ ...common, approvalToken: approval.token });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 704);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-publish" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.deepEqual(
    {
      action: request.params.action,
      deltaX: request.params.deltaX,
      deltaY: request.params.deltaY,
    },
    { action: "scroll", deltaX: -80, deltaY: 640 },
  );
  respond(client, request, { ok: true, result: { action: "scroll", ok: true } });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { connected: true, focused: false, value: null, checked: null },
    },
  });
  request = await client.nextJson();
  respondCdp(client, request, {});
  await acting;
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "consumed"],
  );

  const second = moneyhand.actSemanticRef({ ...common, approvalToken: approval.token });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 705);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-reuse" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});
  await assert.rejects(second, (error) => error.code === "TASK_APPROVAL_REQUIRED");
});

test("actSemanticRef reports a failed postcondition as dispatched and unsafe to replay", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-verify-fail", tabIds: [42] });
  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-verify-fail",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "navigation",
    verification: { kind: "url-changed", timeoutMs: 0 },
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 706);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-verify-fail" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "a",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await client.nextJson();
  respond(client, request, { ok: true, result: { action: "click", ok: true } });
  request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  request = await client.nextJson();
  assert.equal(request.params.method, "Runtime.releaseObject");
  respondCdp(client, request, {});

  await assert.rejects(
    acting,
    (error) => error.code === "SEMANTIC_POSTCONDITION_FAILED"
      && error.details.actionDispatched === true
      && error.details.retry === "inspect-before-retry"
      && error.details.verification.matched === false,
  );
});

test("actSemanticRef sends an action once and skips cleanup when its outcome becomes unknown", async (t) => {
  const moneyhand = await startMoneyHand(t, { requestTimeoutMs: 5_000 });
  const { client } = await connectExtension(moneyhand, t);
  const snapshot = await captureSemanticFixture(moneyhand, client);
  await moneyhand.createTaskSpace({ id: "semantic-unknown", tabIds: [42] });
  const acting = moneyhand.actSemanticRef({
    taskSpaceId: "semantic-unknown",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "click",
    effect: "input",
    timeoutMs: 5_000,
  });
  let request = await client.nextJson();
  respondCdp(client, request, semanticFrame());
  await createSemanticIsolatedWorld(client, 707);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-unknown" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 20,
    y: 30,
    rect: { x: 10, y: 20, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  });
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  client.destroy();
  await client.waitForSocketClose();
  await assert.rejects(
    acting,
    (error) => error.code === "OUTCOME_UNKNOWN" && error.id === request.id,
  );
});

test("Task spaces pin a Profile and stop writes while user control is active", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const space = await moneyhand.createTaskSpace({ id: "complex-page", tabIds: [42] });
  assert.equal(space.ownership, "agent");
  assert.equal(space.selector.instanceId, "instance_0001");

  moneyhand.handOffTaskSpace({ id: space.id });
  await assert.rejects(
    moneyhand.taskRequest({
      id: space.id,
      request: { method: "system.status", params: {} },
    }),
    (error) => error.code === "USER_CONTROL_ACTIVE",
  );
  assert.throws(
    () => moneyhand.takeOverTaskSpace({ id: space.id }),
    (error) => error.code === "CONTROL_CONFIRMATION_REQUIRED",
  );
  moneyhand.takeOverTaskSpace({
    id: space.id,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    moneyhand.taskRequest({
      id: space.id,
      request: { method: "system.status", params: {} },
    }),
    (error) => error.code === "TASK_EFFECT_REQUIRED",
  );

  const terminalPromise = moneyhand.taskRequest({
    id: space.id,
    effect: "read-only",
    request: { method: "system.status", params: {} },
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  assert.equal(request.method, "system.status");
  respond(client, request, { ok: true, result: { mode: "ws-only" } });
  const terminal = await terminalPromise;
  assert.equal(terminal.ok, true);

  await assert.rejects(
    moneyhand.taskRequest({
      id: space.id,
      request: {
        method: "input.perform",
        params: { target: { tabId: 99 }, action: "type", text: "blocked" },
      },
    }),
    (error) => error.code === "TASK_SPACE_TAB_MISMATCH",
  );
  await assert.rejects(
    moneyhand.taskRequest({
      id: space.id,
      request: {
        method: "chrome.call",
        params: { method: "tabs.update", args: [99, { active: true }] },
      },
    }),
    (error) => error.code === "TASK_SPACE_TAB_MISMATCH",
  );
  await assert.rejects(
    moneyhand.taskRequest({
      id: space.id,
      request: {
        method: "chrome.call",
        params: { method: "windows.remove", args: [7] },
      },
    }),
    (error) => error.code === "TASK_SPACE_UNSCOPED_MUTATION",
  );
});

test("parallel Task Space requests run concurrently against two pinned Profiles", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const firstHello = extensionHello({
    profile: "npc-profile-a",
    instanceId: "instance_profile_a",
    bootId: "boot_profile_a",
    focus: { windowId: 1, focused: true, lastFocusedAt: 10 },
  });
  const secondHello = extensionHello({
    profile: "npc-profile-b",
    instanceId: "instance_profile_b",
    bootId: "boot_profile_b",
    focus: { windowId: 2, focused: true, lastFocusedAt: 20 },
  });
  const first = await connectExtension(moneyhand, t, firstHello);
  const second = await connectExtension(moneyhand, t, secondHello);
  await moneyhand.createTaskSpace({
    id: "profile-a-task",
    selector: { instanceId: firstHello.instanceId, bootId: firstHello.bootId },
    tabIds: [41],
  });
  await moneyhand.createTaskSpace({
    id: "profile-b-task",
    selector: { instanceId: secondHello.instanceId, bootId: secondHello.bootId },
    tabIds: [42],
  });

  const batchPromise = moneyhand.parallelTaskRequests({
    concurrency: 2,
    requests: [
      {
        taskSpaceId: "profile-a-task",
        request: { method: "observe.context", params: { target: { tabId: 41 } } },
        options: { effect: "read-only" },
      },
      {
        taskSpaceId: "profile-b-task",
        request: { method: "observe.context", params: { target: { tabId: 42 } } },
        options: { effect: "read-only" },
      },
    ],
  });
  const [firstRequest, secondRequest] = await Promise.all([
    first.client.nextJson(),
    second.client.nextJson(),
  ]);
  assert.equal(firstRequest.params.target.tabId, 41);
  assert.equal(secondRequest.params.target.tabId, 42);
  respond(first.client, firstRequest, { ok: true, result: { profile: "a" } });
  respond(second.client, secondRequest, { ok: true, result: { profile: "b" } });
  const batch = await batchPromise;
  assert.equal(batch.concurrency, 2);
  assert.deepEqual(batch.results.map((entry) => entry.value.result.profile), ["a", "b"]);
});

test("isolated real-Chromium multi-Profile semantic acceptance stays test-only and fail-closed", async () => {
  const [harness, profileHost, desktopLauncher] = await Promise.all([
    readFile(new URL(
      "../scripts/moneyhand-isolated-multiprofile-acceptance.mjs",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "./fixtures/moneyhand-chromium-profile.ps1",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "./fixtures/isolated-desktop-launcher.ps1",
      import.meta.url,
    ), "utf8"),
  ]);

  assert.match(harness, /createMoneyHand\(\{/u);
  assert.match(harness, /parallelTaskRequests\(\{/u);
  assert.match(harness, /captureSemanticSnapshot\(options\)/u);
  assert.match(harness, /moneyhand\.actSemanticRef\(/u);
  assert.match(harness, /Native approval/u);
  assert.match(harness, /ARIA delivery/u);
  assert.match(harness, /OOPIF action/u);
  assert.match(harness, /globalThis\.fixtureEvents/u);
  assert.match(harness, /globalThis\.frameEvents/u);
  assert.match(harness, /selector: \{ instanceId: sessions\.a\.instanceId, bootId: sessions\.a\.bootId \}/u);
  assert.match(harness, /selector: \{ instanceId: sessions\.b\.instanceId, bootId: sessions\.b\.bootId \}/u);
  assert.match(harness, /options: \{ effect: "read-only", timeoutMs: 12_000 \}/u);
  assert.match(harness, /overlapMs < 500/u);
  assert.match(harness, /browserCdpInputUsed: true/u);
  assert.match(harness, /idempotentNoInput: 2/u);
  assert.match(harness, /trustedClick: true/u);
  assert.match(harness, /activeUserProfileUsed: false/u);
  assert.match(harness, /nativeInputUsed: false/u);
  assert.match(harness, /productRuntimeSandboxChanged: false/u);
  assert.match(harness, /terminateOwnedChromium/u);
  assert.match(harness, /cleanup\?\.terminated !== 0/u);
  assert.match(profileHost, /--disable-extensions-except=/u);
  assert.match(profileHost, /--load-extension=/u);
  assert.match(profileHost, /--site-per-process/u);
  assert.match(profileHost, /--host-resolver-rules=MAP localhost 127\.0\.0\.1/u);
  assert.match(profileHost, /NPC_MONEYHAND_ACCEPTANCE_DISABLE_CHROMIUM_SANDBOX/u);
  assert.match(profileHost, /OpenInputDesktop/u);
  assert.match(profileHost, /\$parsedStartUrl\.IsLoopback/u);
  assert.match(profileHost, /isolatedDesktop = \$desktopBinding\.isolated/u);
  assert.doesNotMatch(desktopLauncher, /SwitchDesktop/u);
  assert.doesNotMatch(desktopLauncher, /DESKTOP_SWITCHDESKTOP/u);
});
test("JSONL keeps correlation ids separate from reusable Task Space ids", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  const { client } = await connectExtension(moneyhand, t);
  const result = async (id) => {
    await waitFor(() => messages().some((message) => message.id === id));
    return messages().find((message) => message.id === id);
  };

  input.write('{"id":"cmd-missing-space-id","op":"createTaskSpace"}\n');
  assert.equal(
    (await result("cmd-missing-space-id")).error.code,
    "TASK_SPACE_ID_REQUIRED",
  );

  input.write(`${JSON.stringify({
    id: "cmd-create-space",
    op: "createTaskSpace",
    taskSpaceId: "jsonl-space",
    tabIds: [42],
  })}\n`);
  assert.equal((await result("cmd-create-space")).value.id, "jsonl-space");

  input.write(`${JSON.stringify({
    id: "cmd-space-request",
    op: "taskRequest",
    taskSpaceId: "jsonl-space",
    effect: "read-only",
    request: { method: "target.list", params: {} },
  })}\n`);
  const handRequest = await client.nextJson();
  assert.equal(handRequest.method, "target.list");
  respond(client, handRequest, { ok: true, result: { targets: [] } });
  assert.equal((await result("cmd-space-request")).value.ok, true);

  input.write(`${JSON.stringify({
    id: "cmd-register-learning",
    op: "registerSiteLearning",
    learning: {
      id: "jsonl-example",
      revision: 1,
      match: { hosts: ["example.test"], pathPrefixes: ["/app"] },
      hints: [{ kind: "wait", text: "Wait for the stable result marker." }],
    },
  })}\n`);
  assert.equal((await result("cmd-register-learning")).value.changed, true);
  input.write(`${JSON.stringify({
    id: "cmd-resolve-learning",
    op: "resolveSiteLearnings",
    url: "https://example.test/app/orders",
  })}\n`);
  assert.equal((await result("cmd-resolve-learning")).value.learnings[0].id, "jsonl-example");

  const publishRequest = {
    method: "input.perform",
    params: {
      target: { tabId: 42 },
      action: "click",
      coordinateSpace: COORDINATE_SPACE,
      x: 20,
      y: 30,
    },
  };
  input.write(`${JSON.stringify({
    id: "cmd-approve-publish",
    op: "approveTaskEffect",
    taskSpaceId: "jsonl-space",
    effect: "publish",
    request: publishRequest,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  })}\n`);
  const approval = (await result("cmd-approve-publish")).value;
  input.write(`${JSON.stringify({
    id: "cmd-publish-request",
    op: "taskRequest",
    taskSpaceId: "jsonl-space",
    effect: "publish",
    approvalToken: approval.token,
    request: publishRequest,
  })}\n`);
  const publishHandRequest = await client.nextJson();
  respond(client, publishHandRequest, { ok: true, result: { dispatched: true } });
  assert.equal((await result("cmd-publish-request")).value.ok, true);

  input.write(`${JSON.stringify({
    id: "cmd-handoff-space",
    op: "handOffTaskSpace",
    taskSpaceId: "jsonl-space",
  })}\n`);
  assert.equal((await result("cmd-handoff-space")).value.ownership, "user");

  input.write(`${JSON.stringify({
    id: "cmd-takeover-space",
    op: "takeOverTaskSpace",
    taskSpaceId: "jsonl-space",
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  })}\n`);
  assert.equal((await result("cmd-takeover-space")).value.ownership, "agent");

  input.write('{"id":"cmd-stop-space","op":"shutdown","graceMs":0}\n');
  await running;
  assert.equal((await result("cmd-stop-space")).ok, true);
});

test("JSONL exposes the guarded semantic ref action loop without Agent-side CDP plumbing", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  const { client } = await connectExtension(moneyhand, t);
  const result = async (id) => {
    await waitFor(() => messages().some((message) => message.id === id));
    return messages().find((message) => message.id === id);
  };

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-space-create",
    op: "createTaskSpace",
    taskSpaceId: "semantic-jsonl-space",
    tabIds: [42],
  })}\n`);
  assert.equal((await result("semantic-jsonl-space-create")).ok, true);

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-locator-high-impact",
    op: "routeSurface",
    surface: "web-page",
    risk: "send",
  })}\n`);
  const highImpactLocator = await result("semantic-jsonl-locator-high-impact");
  assert.equal(highImpactLocator.ok, true);
  assert.equal(highImpactLocator.value.backend, "moneyhand");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-capture",
    op: "captureSemanticSnapshot",
    tabId: 42,
  })}\n`);
  let request = await client.nextJson();
  const frameTree = semanticFrame();
  respond(client, request, {
    ok: true,
    result: {
      completed: 3,
      total: 3,
      results: [
        batchStep(0, "Page.getFrameTree", frameTree),
        batchStep(1, "Accessibility.getFullAXTree", {
          nodes: [{
            nodeId: "ax-jsonl",
            backendDOMNodeId: 86,
            role: { value: "button" },
            name: { value: "Continue" },
            properties: [],
          }],
        }),
        batchStep(2, "Page.getFrameTree", frameTree),
      ],
    },
  });
  const snapshot = (await result("semantic-jsonl-capture")).value.snapshot;

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-drag",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "drag",
    effect: "input",
  })}\n`);
  const invalidDrag = await result("semantic-jsonl-invalid-drag");
  assert.equal(invalidDrag.ok, false);
  assert.equal(invalidDrag.error.code, "INVALID_SEMANTIC_ACTION");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-upload-effect",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "upload",
    fileRoot: "not-absolute",
    files: ["not-absolute/file.txt"],
    effect: "input",
  })}\n`);
  const invalidUpload = await result("semantic-jsonl-invalid-upload-effect");
  assert.equal(invalidUpload.ok, false);
  assert.equal(invalidUpload.error.code, "INVALID_TASK_EFFECT");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-select",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "select",
    options: [],
    effect: "input",
  })}\n`);
  const invalidSelect = await result("semantic-jsonl-invalid-select");
  assert.equal(invalidSelect.ok, false);
  assert.equal(invalidSelect.error.code, "INVALID_SEMANTIC_ACTION");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-check",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "check",
    checked: false,
    effect: "input",
  })}\n`);
  const invalidCheck = await result("semantic-jsonl-invalid-check");
  assert.equal(invalidCheck.ok, false);
  assert.equal(invalidCheck.error.code, "INVALID_SEMANTIC_ACTION");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-download-effect",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: {},
    effect: "input",
  })}\n`);
  const invalidDownloadEffect = await result("semantic-jsonl-invalid-download-effect");
  assert.equal(invalidDownloadEffect.ok, false);
  assert.equal(invalidDownloadEffect.error.code, "INVALID_TASK_EFFECT");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-invalid-download-path",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "download",
    download: { match: { filename: "C:/Downloads/report.csv" } },
    effect: "download",
  })}\n`);
  const invalidDownloadPath = await result("semantic-jsonl-invalid-download-path");
  assert.equal(invalidDownloadPath.ok, false);
  assert.equal(invalidDownloadPath.error.code, "INVALID_SEMANTIC_ACTION");

  input.write(`${JSON.stringify({
    id: "semantic-jsonl-act",
    op: "actSemanticRef",
    taskSpaceId: "semantic-jsonl-space",
    snapshotId: snapshot.id,
    ref: "@1",
    action: "scroll",
    deltaX: -80,
    deltaY: 640,
    effect: "input",
  })}\n`);
  request = await client.nextJson();
  respondCdp(client, request, frameTree);
  await createSemanticIsolatedWorld(client, 708);
  request = await client.nextJson();
  respondCdp(client, request, { object: { objectId: "object-jsonl" } });
  await respondSemanticTargetPreflight(client, {
    ok: true,
    connected: true,
    url: "https://example.test/app",
    x: 25,
    y: 35,
    rect: { x: 15, y: 25, width: 20, height: 20 },
    tag: "button",
    role: null,
    editable: false,
    focused: false,
    value: null,
    checked: null,
  }, frameTree);
  request = await client.nextJson();
  assert.equal(request.method, "input.perform");
  assert.deepEqual(
    {
      action: request.params.action,
      deltaX: request.params.deltaX,
      deltaY: request.params.deltaY,
    },
    { action: "scroll", deltaX: -80, deltaY: 640 },
  );
  respond(client, request, { ok: true, result: { action: "scroll", ok: true } });
  request = await client.nextJson();
  respondCdp(client, request, frameTree);
  request = await client.nextJson();
  respondCdp(client, request, {
    result: {
      type: "object",
      value: { connected: true, focused: false, value: null, checked: null },
    },
  });
  request = await client.nextJson();
  respondCdp(client, request, {});
  const action = await result("semantic-jsonl-act");
  assert.equal(action.ok, true);
  assert.equal(action.value.verification.claim, "observation-only");
  assert.equal(action.value.cleanup.released, true);

  input.write('{"id":"semantic-jsonl-stop","op":"shutdown","graceMs":0}\n');
  await running;
  assert.equal((await result("semantic-jsonl-stop")).ok, true);
});

test("MoneyHand keeps versioned non-executable site learnings outside MoneyHand", () => {
  const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 0 });
  const first = moneyhand.registerSiteLearning({
    id: "example-orders",
    revision: 1,
    match: {
      hosts: ["app.example.test", "*.example.test"],
      pathPrefixes: ["/orders", "/"],
    },
    hints: [
      { kind: "data-plane", text: "Prefer the read-only orders JSON response." },
      { kind: "verification", text: "Verify the order id after navigation." },
    ],
    provenance: "local-tested-task",
  });
  assert.equal(first.changed, true);
  assert.equal(moneyhand.registerSiteLearning(first.learning).changed, false);
  const resolved = moneyhand.resolveSiteLearnings({
    url: "https://app.example.test/orders/123?view=compact",
  });
  assert.equal(resolved.trustedLocalLearnings, true);
  assert.equal(resolved.learnings.length, 1);
  assert.equal(resolved.learnings[0].id, "example-orders");
  assert.equal(resolved.learnings[0].matched.host, "app.example.test");
  assert.equal(resolved.learnings[0].matched.pathPrefix, "/orders");
  assert.equal(resolved.learnings[0].executable, false);
  assert.equal(moneyhand.resolveSiteLearnings({ url: "https://other.test/orders" }).learnings.length, 0);
  assert.throws(
    () => moneyhand.registerSiteLearning({ ...first.learning, revision: 1, hints: [
      { kind: "workflow", text: "Conflicting same-revision content." },
    ] }),
    (error) => error.code === "SITE_LEARNING_VERSION_CONFLICT",
  );
  assert.equal(moneyhand.removeSiteLearning({ learningId: "example-orders" }).changed, true);
});

test("high-impact Task Space requests dispatch directly and optionally consume a supplied token", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "publish-review", tabIds: [42] });
  const request = {
    method: "input.perform",
    params: {
      target: { tabId: 42 },
      action: "click",
      coordinateSpace: COORDINATE_SPACE,
      x: 20,
      y: 30,
    },
  };

  const direct = moneyhand.taskRequest({ id: "publish-review", effect: "publish", request });
  let handRequest = await client.nextJson();
  respond(client, handRequest, { ok: true, result: { dispatched: true } });
  assert.equal((await direct).ok, true);
  const approval = moneyhand.approveTaskEffect({
    taskSpaceId: "publish-review",
    effect: "publish",
    request,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });
  assert.equal(approval.oneTime, true);
  const pending = moneyhand.taskRequest({
    id: "publish-review",
    effect: "publish",
    approvalToken: approval.token,
    request,
  });
  handRequest = await client.nextJson();
  respond(client, handRequest, { ok: true, result: { dispatched: true } });
  assert.equal((await pending).ok, true);
  await assert.rejects(
    moneyhand.taskRequest({
      id: "publish-review",
      effect: "publish",
      approvalToken: approval.token,
      request,
    }),
    (error) => error.code === "TASK_APPROVAL_REQUIRED",
  );
  assert.deepEqual(
    moneyhand.listApprovalActivity({ limit: 10 }).map((entry) => entry.event),
    ["issued", "consumed"],
  );

  const mismatch = moneyhand.approveTaskEffect({
    taskSpaceId: "publish-review",
    effect: "publish",
    request,
    confirmation: {
      approved: true,
      source: "user",
      confirmedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(
    moneyhand.taskRequest({
      id: "publish-review",
      effect: "publish",
      approvalToken: mismatch.token,
      request: { ...request, params: { ...request.params, x: 21 } },
    }),
    (error) => error.code === "TASK_APPROVAL_MISMATCH",
  );
});

test("surface routing keeps browser work in MoneyHand and sends browser boundaries to a human", () => {
  const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 0 });
  const canvas = moneyhand.routeSurface({ surface: "canvas" });
  assert.equal(canvas.backend, "moneyhand");
  assert.equal(canvas.mode, "page-visual-cdp-input");
  assert.deepEqual(canvas.escalation, ["human"]);

  const nativeDialog = moneyhand.routeSurface({ surface: "native-dialog" });
  assert.equal(nativeDialog.backend, "human");
  assert.equal(nativeDialog.mode, "browser-boundary");
  assert.deepEqual(nativeDialog.escalation, []);

  for (const surface of [
    "captcha",
    "extension-ui",
    "password-prompt",
    "security-confirmation",
  ]) {
    assert.equal(moneyhand.routeSurface({ surface }).backend, "human", surface);
  }
  assert.equal(moneyhand.routeSurface({ surface: "captcha" }).mode, "human-takeover");
  assert.equal(moneyhand.routeSurface({ surface: "extension-ui" }).mode, "browser-boundary");
  assert.equal(moneyhand.routeSurface({ surface: "password-prompt" }).mode, "human-takeover");
  assert.equal(moneyhand.routeSurface({ surface: "security-confirmation" }).mode, "human-takeover");

  assert.equal(moneyhand.routeSurface({ surface: "web-page", risk: "payment" }).backend, "moneyhand");
  assert.equal(moneyhand.routeSurface({
    surface: "web-page",
    risk: "payment",
    userConfirmed: true,
  }).backend, "moneyhand");
});

test("captureViewportBundle rejects changed viewport state and writes no file", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "stale.png");

  const capturePromise = moneyhand.captureViewportBundle({
    tabId: 42,
    outputPath,
    outputRoot: directory,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      completed: 6,
      total: 6,
      results: viewportBatchResults({
        before: layoutMetrics(100, 50),
        after: layoutMetrics(99, 50),
      }),
    },
    meta: { durationMs: 1 },
  });
  await assert.rejects(capturePromise, (error) => error.code === "STALE_VIEWPORT");
  await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");
});

test("captureViewportBundle rejects same-document URL changes with stable metrics", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-url-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "url-change.png");

  const capturePromise = moneyhand.captureViewportBundle({
    tabId: 42,
    outputPath,
    outputRoot: directory,
    timeoutMs: 1_000,
  });
  const request = await client.nextJson();
  respond(client, request, {
    ok: true,
    result: {
      completed: 6,
      total: 6,
      results: viewportBatchResults({
        urlBefore: "https://example.test/a",
        urlAfter: "https://example.test/b",
      }),
    },
    meta: { durationMs: 1 },
  });
  await assert.rejects(capturePromise, (error) => error.code === "STALE_VIEWPORT");
  await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");
});

test("captureViewportBundle refuses an Extension without the coordinate contract", async (t) => {
  const moneyhand = await startMoneyHand(t);
  await connectExtension(moneyhand, t, extensionHello({ capabilities: {} }));
  await assert.rejects(
    moneyhand.captureViewportBundle({
      tabId: 42,
      outputPath: join(tmpdir(), "must-not-exist.png"),
      outputRoot: tmpdir(),
    }),
    (error) => error.code === "UNSUPPORTED_COORDINATE_CONTRACT",
  );
});

test("captureViewportBundle confines output to an existing local task root", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const root = await mkdtemp(join(tmpdir(), "npc-moneyhand-root-"));
  const outside = await mkdtemp(join(tmpdir(), "npc-moneyhand-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(
    moneyhand.captureViewportBundle({
      tabId: 42,
      outputPath: join(outside, "escape.png"),
      outputRoot: root,
    }),
    (error) => error.code === "OUTPUT_OUTSIDE_ROOT",
  );
  if (process.platform === "win32") {
    for (const outputPath of [
      "\\\\attacker.invalid\\share\\shot.png",
      join(root, "NUL.png"),
      join(root, "capture:stream.png"),
    ]) {
      await assert.rejects(
        moneyhand.captureViewportBundle({
          tabId: 42,
          outputPath,
          outputRoot: root,
        }),
        (error) => error.code === "INVALID_OUTPUT_PATH",
      );
    }
  }
});

test("navigateTaskTab closes a redirected document transition in one bounded MoneyHand command", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "navigation", tabIds: [42] });
  const promise = moneyhand.navigateTaskTab({
    taskSpaceId: "navigation",
    tabId: 42,
    url: "https://example.test/start",
    effect: "navigation",
    waitUntil: "domcontentloaded",
    expectedUrl: "https://example.test/final?from=redirect",
    urlMatch: "origin+path",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 2,
  });

  let request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-before",
    url: "https://example.test/before",
  });
  request = await client.nextJson();
  assert.equal(request.method, "cdp.send");
  assert.equal(request.params.method, "Page.navigate");
  assert.deepEqual(request.params.params, { url: "https://example.test/start" });
  respondCdp(client, request, { frameId: "root", loaderId: "loader-start" });

  request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-final",
    url: "https://example.test/final?from=redirect",
    readyState: "interactive",
  });
  request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-final",
    url: "https://example.test/final?from=redirect",
    readyState: "complete",
  });
  request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-final",
    url: "https://example.test/final?from=redirect",
    readyState: "complete",
  });

  const result = await promise;
  assert.equal(result.taskSpaceId, "navigation");
  assert.equal(result.actionDispatched, true);
  assert.equal(result.loaded, true);
  assert.equal(result.navigation.loaderId, "loader-start");
  assert.equal(result.state.loaderId, "loader-final");
  assert.equal(result.state.url, "https://example.test/final?from=redirect");
  assert.equal(result.observations, 3);
  assert.equal(result.stablePolls, 2);
  assert.equal(result.claim, "document-readiness-only");
});

test("navigateTaskTab proves same-document URL movement without inventing a new loader", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "fragment", tabIds: [42] });
  const promise = moneyhand.navigateTaskTab({
    taskSpaceId: "fragment",
    tabId: 42,
    url: "https://example.test/page#details",
    effect: "navigation",
    waitUntil: "domcontentloaded",
    expectedUrl: "https://example.test/page#details",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 1,
  });
  let request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-same",
    url: "https://example.test/page",
  });
  request = await client.nextJson();
  respondCdp(client, request, { frameId: "root" });
  request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-same",
    url: "https://example.test/page#details",
    readyState: "complete",
  });
  const result = await promise;
  assert.equal(result.navigation.loaderId, null);
  assert.equal(result.state.loaderId, "loader-same");
  assert.equal(result.observations, 1);
});

test("navigateTaskTab does not misreport a download response as a loaded document", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "navigation-download", tabIds: [42] });
  const promise = moneyhand.navigateTaskTab({
    taskSpaceId: "navigation-download",
    tabId: 42,
    url: "https://example.test/report.csv",
    effect: "navigation",
    waitUntil: "commit",
  });
  let request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-before-download",
    url: "https://example.test/reports",
  });
  request = await client.nextJson();
  respondCdp(client, request, {
    frameId: "root",
    loaderId: "loader-download",
    isDownload: true,
  });
  await assert.rejects(
    promise,
    (error) => error.code === "NAVIGATION_BECAME_DOWNLOAD"
      && error.details?.actionDispatched === true,
  );
});

test("page transitions require exact effects and reject same-Profile tab concurrency", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "page-lock", tabIds: [42] });
  await assert.rejects(
    moneyhand.execute({
      op: "navigateTaskTab",
      taskSpaceId: "page-lock",
      tabId: 42,
      url: "https://example.test/next",
      effect: "read-only",
    }),
    (error) => error.code === "INVALID_TASK_EFFECT",
  );

  const waiting = moneyhand.waitForTaskPage({
    taskSpaceId: "page-lock",
    tabId: 42,
    effect: "read-only",
    waitUntil: "load",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 1,
  });
  const request = await client.nextJson();
  await assert.rejects(
    moneyhand.navigateTaskTab({
      taskSpaceId: "page-lock",
      tabId: 42,
      url: "https://example.test/next",
      effect: "navigation",
    }),
    (error) => error.code === "PAGE_TRANSITION_BUSY"
      && error.details?.actionDispatched === false,
  );
  respondTaskPageState(client, request, {
    loaderId: "loader-ready",
    url: "https://example.test/ready",
  });
  const result = await waiting;
  assert.equal(result.effect, "read-only");
  assert.equal(result.claim, "document-readiness-only");
});

test("page readiness waits remain concurrent across different pinned tabs", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "parallel-pages", tabIds: [42, 43] });
  const waits = [42, 43].map((tabId) => moneyhand.waitForTaskPage({
    taskSpaceId: "parallel-pages",
    tabId,
    effect: "read-only",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 1,
  }));
  const requests = [await client.nextJson(), await client.nextJson()];
  assert.deepEqual(
    new Set(requests.map((request) => request.params.steps[0].params.target.tabId)),
    new Set([42, 43]),
  );
  for (const request of requests) {
    const tabId = request.params.steps[0].params.target.tabId;
    respondTaskPageState(client, request, {
      tabId,
      loaderId: `loader-${tabId}`,
      url: `https://example.test/${tabId}`,
    });
  }
  const results = await Promise.all(waits);
  assert.deepEqual(results.map((result) => result.tabId), [42, 43]);
});

test("navigateTaskTab times out after one dispatch and never replays Page.navigate", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "navigation-timeout", tabIds: [42] });
  const promise = moneyhand.navigateTaskTab({
    taskSpaceId: "navigation-timeout",
    tabId: 42,
    url: "https://example.test/expected",
    effect: "navigation",
    expectedUrl: "https://example.test/expected",
    timeoutMs: 20,
    pollIntervalMs: 20,
    stablePolls: 1,
  });
  let request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-before",
    url: "https://example.test/before",
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.navigate");
  respondCdp(client, request, { frameId: "root", loaderId: "loader-navigation" });
  for (let observation = 0; observation < 2; observation += 1) {
    request = await client.nextJson();
    assert.equal(request.method, "batch.run");
    respondTaskPageState(client, request, {
      loaderId: "loader-other",
      url: "https://example.test/unexpected",
      readyState: "complete",
    });
  }
  await assert.rejects(
    promise,
    (error) => error.code === "NAVIGATION_WAIT_TIMEOUT"
      && error.details?.actionDispatched === true
      && error.details?.retry === "inspect-before-retry"
      && error.details?.observations === 2,
  );
});

test("navigateTaskTab tolerates one transient unreadable state without replaying navigation", async (t) => {
  const moneyhand = await startMoneyHand(t);
  const { client } = await connectExtension(moneyhand, t);
  await moneyhand.createTaskSpace({ id: "navigation-transient", tabIds: [42] });
  const promise = moneyhand.navigateTaskTab({
    taskSpaceId: "navigation-transient",
    tabId: 42,
    url: "https://example.test/expected",
    effect: "navigation",
    expectedUrl: "https://example.test/expected",
    timeoutMs: 1_000,
    pollIntervalMs: 20,
    stablePolls: 1,
  });
  let request = await client.nextJson();
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respondTaskPageState(client, request, {
    loaderId: "loader-before",
    url: "https://example.test/before",
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.navigate");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respondCdp(client, request, { frameId: "root", loaderId: "loader-navigation" });

  request = await client.nextJson();
  assert.equal(request.method, "batch.run");
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respond(client, request, {
    ok: false,
    error: { code: "TARGET_NOT_READY", message: "Profile tab could not be read" },
  });

  request = await client.nextJson();
  assert.deepEqual(request.behavior, { onUnclear: "error" });
  respondTaskPageState(client, request, {
    loaderId: "loader-navigation",
    url: "https://example.test/expected",
    readyState: "complete",
  });

  const result = await promise;
  assert.equal(result.loaded, true);
  assert.equal(result.state.url, "https://example.test/expected");
  assert.equal(result.observations, 1);
});

test("JSONL exposes the same Task-Space page transition without Agent-side CDP polling", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
  });
  const running = runJsonlMoneyHand({ moneyhand, input, output });
  t.after(() => moneyhand.stop({ graceMs: 0 }));
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  const { client } = await connectExtension(moneyhand, t);
  const result = async (id) => {
    await waitFor(() => lines().some((message) => message.id === id));
    return lines().find((message) => message.id === id);
  };

  input.write(`${JSON.stringify({
    id: "create-page-space",
    op: "createTaskSpace",
    taskSpaceId: "jsonl-page",
    tabIds: [42],
  })}\n`);
  assert.equal((await result("create-page-space")).ok, true);
  input.write(`${JSON.stringify({
    id: "navigate-page",
    op: "navigateTaskTab",
    taskSpaceId: "jsonl-page",
    tabId: 42,
    url: "https://example.test/jsonl",
    effect: "navigation",
    waitUntil: "commit",
  })}\n`);
  let request = await client.nextJson();
  respondTaskPageState(client, request, {
    loaderId: "loader-jsonl-before",
    url: "https://example.test/before",
  });
  request = await client.nextJson();
  assert.equal(request.params.method, "Page.navigate");
  respondCdp(client, request, { frameId: "root", loaderId: "loader-jsonl" });
  const navigated = await result("navigate-page");
  assert.equal(navigated.ok, true);
  assert.equal(navigated.value.actionDispatched, true);
  assert.equal(navigated.value.claim, "Page.navigate-command-acknowledged-only");

  input.write('{"id":"stop-jsonl-page","op":"shutdown","graceMs":0}\n');
  await running;
  assert.equal((await result("stop-jsonl-page")).ok, true);
});

test("an abort signal stops a JSONL MoneyHand and releases its listener", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = outputCollector(output);
  const controller = new AbortController();
  const moneyhand = createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  const running = runJsonlMoneyHand({
    moneyhand,
    input,
    output,
    signal: controller.signal,
  });
  await waitFor(() => moneyhand.peer.state === "RUNNING");
  const port = moneyhand.peer.boundPort;
  input.write('{"id":"wait-forever","op":"wait","timeoutMs":0}\n');
  await waitFor(() => moneyhand.peer.waiters.size === 1);
  const abortStarted = Date.now();
  controller.abort();
  await running;
  assert.ok(Date.now() - abortStarted < 500);
  assert.equal(moneyhand.peer.state, "STOPPED");
  assert.equal(
    lines().find((message) => message.id === "wait-forever")?.error.code,
    "ABORTED",
  );

  const probe = await import("node:net").then(({ createServer }) => createServer());
  try {
    probe.listen({ host: "127.0.0.1", port, exclusive: true });
    await once(probe, "listening");
    assert.equal(probe.address().port, port);
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
});
