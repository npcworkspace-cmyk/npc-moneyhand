import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  TaskEvidenceCollector,
  evaluateTaskCompletion,
} from "../skills/npc-moneyhand/scripts/lib/task-evidence.mjs";

const examplePath = resolve(
  "skills",
  "npc-moneyhand",
  "references",
  "bounded-file-task.example.mjs",
);

test("complete authoring example treats required fields as meaningful business values", async () => {
  const { recordHasMeaningfulField } = await import(pathToFileURL(examplePath));
  for (const value of ["value", 0, false, [0], { count: 0 }]) {
    assert.equal(recordHasMeaningfulField({ field: value }, "field"), true);
  }
  for (const value of ["", "  \n", null, undefined, Number.NaN, [], {}]) {
    assert.equal(recordHasMeaningfulField({ field: value }, "field"), false);
  }
  assert.equal(recordHasMeaningfulField({}, "field"), false);
});

test("complete authoring example preserves bounded page taskData and rejects silent fields", async () => {
  const module = await import(pathToFileURL(examplePath));
  const base = {
    outputPath: resolve("task-data-output.jsonl"),
    manifestPath: resolve("task-data-manifest.json"),
    checkpointPath: resolve("task-data-checkpoint.json"),
  };
  const plan = module.taskInputs({
    ...base,
    pages: [{
      pageKey: "alpha",
      url: "https://example.test/alpha",
      taskData: { scrollDeltaY: 230, label: "拟人滚动" },
    }],
  });
  assert.deepEqual(plan.pages, [{
    id: "alpha",
    url: "https://example.test/alpha",
    taskData: { scrollDeltaY: 230, label: "拟人滚动" },
  }]);
  assert.throws(() => module.taskInputs({
    ...base,
    pages: [{
      id: "alpha",
      pageKey: "alpha",
      url: "https://example.test/alpha",
    }],
  }), (error) => error?.code === "INVALID_TASK_ARGS"
    && /not both/u.test(error.message));
  assert.deepEqual(plan.acceptance.taskFacts, [{
    id: "scroll:page-1",
    expected: {
      pageKey: "alpha",
      deltaY: 230,
      effect: "input",
      actionDispatched: true,
    },
  }]);
  assert.throws(() => module.taskInputs({
    ...base,
    pages: [{ id: "alpha", url: "https://example.test/alpha", deltaY: 230 }],
  }), (error) => error?.code === "INVALID_TASK_ARGS"
    && /put custom values under taskData/u.test(error.message));
  assert.throws(() => module.taskInputs({
    ...base,
    pages: [{
      id: "alpha",
      url: "https://example.test/alpha",
      taskData: { text: "界".repeat(1_400) },
    }],
  }), (error) => error?.code === "INVALID_TASK_ARGS");
  for (const scrollDeltaY of [0, 0.5, -100_001, 100_001, "230"]) {
    assert.throws(() => module.taskInputs({
      ...base,
      pages: [{
        id: "alpha",
        url: "https://example.test/alpha",
        taskData: { scrollDeltaY },
      }],
    }), (error) => error?.code === "INVALID_TASK_ARGS"
      && /scrollDeltaY/u.test(error.message));
  }
  assert.throws(() => module.taskInputs({
    ...base,
    pages: [{
      id: "alpha",
      url: "https://example.test/alpha",
      taskData: { scrollDeltaY: 230 },
    }],
    acceptance: {
      taskFacts: [{ id: "scroll:page-1", expected: { deltaY: 999 } }],
    },
  }), (error) => error?.code === "INVALID_TASK_ARGS"
    && /must not redeclare native fact/u.test(error.message));
  assert.throws(() => module.taskInputs({
    ...base,
    pages: [{
      id: "alpha",
      url: "https://example.test/alpha",
      taskData: { scrollDeltaY: 230 },
    }],
    acceptance: {
      taskFacts: Array.from({ length: 64 }, (_, index) => ({
        id: `custom:${index}`,
        expected: true,
      })),
    },
  }), (error) => error?.code === "INVALID_TASK_ARGS"
    && /must not exceed 64/u.test(error.message));
});

test("complete authoring example rejects invalid native input before opening a task window", async () => {
  const module = await import(pathToFileURL(examplePath));
  let began = false;
  await assert.rejects(module.run({
    moneyhand: {
      async beginTaskContext() {
        began = true;
        throw new Error("must not be reached");
      },
    },
    signal: AbortSignal.timeout(5_000),
    args: {
      pages: [{
        id: "alpha",
        url: "https://example.test/alpha",
        taskData: { scrollDeltaY: 0 },
      }],
      outputPath: resolve("invalid-native-output.jsonl"),
      manifestPath: resolve("invalid-native-manifest.json"),
      checkpointPath: resolve("invalid-native-checkpoint.json"),
    },
    async progress() {},
  }), (error) => error?.code === "INVALID_TASK_ARGS" && /scrollDeltaY/u.test(error.message));
  assert.equal(began, false);
});

test("complete authoring example collects bounded pages, persists bulk data and returns a manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-authoring-example-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "records.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const checkpointPath = join(directory, "checkpoint.json");
  const pages = [
    { id: "first", url: "https://example.test/one", taskData: { scrollDeltaY: 180 } },
    {
      id: "literal-${POST_ID}",
      url: "https://example.test/two?from=agent",
      taskData: { scrollDeltaY: 260 },
    },
    { id: "third", url: "https://example.test/three", taskData: { scrollDeltaY: -140 } },
  ];
  const calls = [];
  const expressions = [];
  let currentPage;
  const recordCounts = new Map([["first", 2], ["literal-${POST_ID}", 1], ["third", 3]]);
  const moneyhand = {
    async beginTaskContext(options) {
      calls.push({ method: "beginTaskContext", options });
      return {
        taskSpaceId: "example-task-space",
        tabId: 73,
        page: { tabId: 73, url: "about:blank" },
        behavior: { mode: options.behavior },
      };
    },
    async navigateTaskTab(options) {
      calls.push({ method: "navigateTaskTab", options });
      currentPage = pages.find((page) => page.url === options.url);
      return { actionDispatched: true };
    },
    async scrollTaskTab(options) {
      calls.push({ method: "scrollTaskTab", options });
      return {
        effect: "input",
        actionDispatched: true,
        delta: { x: 0, y: options.deltaY },
        handRequestId: `hand-${currentPage.id}`,
      };
    },
    async evaluateTaskTab(options) {
      calls.push({ method: "evaluateTaskTab", options });
      expressions.push(options.expression);
      return {
        value: Array.from({ length: recordCounts.get(currentPage.id) }, (_, index) => ({
          recordId: `${currentPage.id}:${index}`,
          pageKey: currentPage.id,
          pageId: currentPage.id,
          sourceUrl: currentPage.url,
          title: `Title ${currentPage.id}`,
          index,
          body: `Body ${currentPage.id} ${index}`,
        })),
      };
    },
    async inspectTaskBlocker() {
      throw new Error("complete example must not inspect a blocker");
    },
    async completeTaskContext(options) {
      calls.push({ method: "completeTaskContext", options });
      return { cleanupComplete: true, behaviorReset: { ok: true } };
    },
  };
  const progress = [];
  const module = await import(pathToFileURL(examplePath));
  const result = await module.run({
    moneyhand,
    signal: AbortSignal.timeout(5_000),
    args: {
      pages,
      outputPath,
      manifestPath,
      checkpointPath,
      behavior: "human",
      acceptance: {
        recordCount: 6,
        recordsByPage: { first: 2, "literal-${POST_ID}": 1, third: 3 },
        pageIds: { "literal-${POST_ID}": "literal-${POST_ID}" },
        requiredFields: [
          "recordId",
          "pageKey",
          "pageId",
          "sourceUrl",
          "title",
          "index",
          "body",
        ],
      },
    },
    taskExecutionId: "task-example",
    async progress(event) {
      progress.push(event);
    },
  });

  assert.equal(result.outcome.status, "complete");
  assert.equal(result.output.path, outputPath);
  assert.equal(result.output.manifestPath, manifestPath);
  assert.equal(result.output.checkpointPath, checkpointPath);
  assert.equal(result.output.count, 6);
  assert.equal(Object.hasOwn(result, "records"), false);
  assert.deepEqual(result.outcome.requirements.slice(0, 3), [
    { id: "requested-pages", satisfied: true, expected: 3, actual: 3 },
    {
      id: "requested-page-identifiers",
      satisfied: true,
      expected: pages.map((page) => page.id).join("\n"),
      actual: pages.map((page) => page.id).join("\n"),
    },
    {
      id: "record-page-order",
      satisfied: true,
      expected: pages.map((page) => page.id).join("\n"),
      actual: pages.map((page) => page.id).join("\n"),
    },
  ]);
  assert.equal(result.outcome.requirements.length, 15);
  assert.equal(result.outcome.requirements.every((requirement) => requirement.satisfied), true);
  assert.equal(
    result.outcome.requirements.some((requirement) => (
      requirement.id.startsWith("page-record-count:first:")
    )),
    true,
  );
  assert.deepEqual(result.outcome.requirements[3], {
    id: "requested-record-count",
    satisfied: true,
    expected: 6,
    actual: 6,
  });
  assert.equal(new Set(result.outcome.requirements.map((requirement) => requirement.id)).size, 15);
  assert.equal(result.outcome.evidence.length, 2);
  assert.deepEqual(result.outcome.taskFacts, pages.map((page, index) => ({
    id: `scroll:page-${index + 1}`,
    actual: {
      pageKey: page.id,
      deltaY: page.taskData.scrollDeltaY,
      effect: "input",
      actionDispatched: true,
      handRequestId: `hand-${page.id}`,
    },
  })));
  assert.deepEqual(result.args.acceptance.taskFacts, pages.map((page, index) => ({
    id: `scroll:page-${index + 1}`,
    expected: {
      pageKey: page.id,
      deltaY: page.taskData.scrollDeltaY,
      effect: "input",
      actionDispatched: true,
    },
  })));
  const collector = new TaskEvidenceCollector({
    taskExecutionId: "task-example",
    startedAtMs: 0,
  });
  const evidence = collector.build({ value: result, cleanup: { ok: true } });
  const gate = evaluateTaskCompletion({ value: result, cleanup: { ok: true }, evidence });
  assert.equal(gate.passed, true);
  assert.deepEqual(
    gate.checks.find((entry) => entry.id === "task-facts-verified"),
    { id: "task-facts-verified", passed: true, detail: "3/3 task facts observed and matched" },
  );
  assert.equal(progress.length, 4);
  assert.deepEqual(progress.slice(1).map((entry) => entry.current), [1, 2, 3]);
  const navigations = calls.filter((call) => call.method === "navigateTaskTab");
  assert.equal(navigations.length, 3);
  assert.equal(new Set(navigations.map((call) => call.options.effectId)).size, 3);
  for (const call of navigations) {
    assert.match(call.options.effectId, /^[A-Za-z0-9._:-]{1,128}$/u);
    assert.equal(call.options.waitUntil, "domcontentloaded");
    assert.equal(call.options.timeoutMs, 30_000);
  }
  const scrolls = calls.filter((call) => call.method === "scrollTaskTab");
  assert.equal(scrolls.length, 3);
  assert.deepEqual(scrolls.map((call) => call.options.deltaY), [180, 260, -140]);
  assert.equal(new Set(scrolls.map((call) => call.options.effectId)).size, 3);
  assert.equal(scrolls.every((call) => (
    /^[A-Za-z0-9._:-]{1,128}$/u.test(call.options.effectId)
  )), true);
  assert.equal(expressions.length, 3);
  assert.equal(expressions[1].includes('"literal-${POST_ID}"'), true);
  const records = (await readFile(outputPath, "utf8"))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(records.length, 6);
  assert.deepEqual([...new Set(records.map((record) => record.pageKey))], pages.map((page) => page.id));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.count, 6);
  assert.equal(manifest.path, outputPath);
  assert.equal(result.outcome.evidence[0].count, 6);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(checkpoint.completed, 3);
  assert.deepEqual(checkpoint.completedIds, pages.map((page) => page.id));
  assert.equal(checkpoint.recordCount, 6);
  assert.equal(calls.at(-1).method, "completeTaskContext");
  assert.equal(result.lifecycle.cleanupComplete, true);
});

test("complete authoring example refuses to overwrite an existing bulk output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-authoring-overwrite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "records.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const checkpointPath = join(directory, "checkpoint.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, "keep\n"));
  const module = await import(pathToFileURL(examplePath));
  const result = await module.run({
    moneyhand: {
      async beginTaskContext() {
        return {
          taskSpaceId: "overwrite-space",
          tabId: 9,
          page: { tabId: 9 },
          behavior: { mode: "raw" },
        };
      },
      async navigateTaskTab() {},
      async evaluateTaskTab() {
        return { value: [{
          recordId: "one:0",
          pageKey: "one",
          pageId: "one",
          sourceUrl: "https://example.test/",
          title: "One",
          index: 0,
          body: "One",
        }] };
      },
      async inspectTaskBlocker() {
        return { captured: false, screenshot: { captured: false }, actionReplayed: false };
      },
      async completeTaskContext() {
        return { cleanupComplete: true };
      },
    },
    signal: AbortSignal.timeout(5_000),
    args: {
      pages: [{ id: "one", url: "https://example.test/" }],
      outputPath,
      manifestPath,
      checkpointPath,
    },
    async progress() {},
  });
  assert.equal(result.outcome.status, "incomplete");
  assert.equal(result.outcome.error.code, "EEXIST");
  assert.equal(await readFile(outputPath, "utf8"), "keep\n");
  assert.equal(result.lifecycle.cleanupComplete, true);
});
