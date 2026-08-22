import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const examplePath = resolve(
  "skills",
  "npc-moneyhand",
  "references",
  "bounded-file-task.example.mjs",
);

test("complete authoring example collects bounded pages, persists bulk data and returns a manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-authoring-example-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "records.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const checkpointPath = join(directory, "checkpoint.json");
  const pages = [
    { id: "first", url: "https://example.test/one" },
    { id: "literal-${POST_ID}", url: "https://example.test/two?from=agent" },
    { id: "third", url: "https://example.test/three" },
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
        behavior: { mode: "raw" },
      };
    },
    async navigateTaskTab(options) {
      calls.push({ method: "navigateTaskTab", options });
      currentPage = pages.find((page) => page.url === options.url);
      return { actionDispatched: true };
    },
    async evaluateTaskTab(options) {
      calls.push({ method: "evaluateTaskTab", options });
      expressions.push(options.expression);
      return {
        value: Array.from({ length: recordCounts.get(currentPage.id) }, (_, index) => ({
          id: `${currentPage.id}:${index}`,
          pageKey: currentPage.id,
          pageId: currentPage.id,
          url: currentPage.url,
          pageTitle: `Title ${currentPage.id}`,
          index,
          text: `Body ${currentPage.id} ${index}`,
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
    args: { pages, outputPath, manifestPath, checkpointPath },
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
  assert.deepEqual(result.outcome.requirements, [
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
  assert.equal(result.outcome.evidence.length, 2);
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
          id: "one:0",
          pageKey: "one",
          pageId: "one",
          url: "https://example.test/",
          pageTitle: "One",
          index: 0,
          text: "One",
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
