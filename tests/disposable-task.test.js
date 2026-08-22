import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assets = resolve(root, "skills", "npc-moneyhand", "assets");

async function runTemplate(name, args) {
  const calls = [];
  const task = {
    taskSpaceId: "pinned-task",
    tabId: 42,
    page: { tabId: 42, title: "Focused page", url: "https://example.test" },
    behavior: { mode: args?.behavior === "human" ? "human" : "raw" },
  };
  const lifecycle = {
    cleanupComplete: true,
    taskSpaceId: task.taskSpaceId,
    behaviorReset: { attempted: true, ok: true },
  };
  const moneyhand = {
    async beginTaskContext(options) {
      calls.push({ method: "beginTaskContext", options });
      return task;
    },
    async inspectTaskBlocker(options) {
      calls.push({ method: "inspectTaskBlocker", options });
      return {
        schema: "npc-moneyhand-visual-fallback/1",
        captured: true,
        screenshot: { path: "C:\\temp\\terminal.png" },
        actionReplayed: false,
      };
    },
    async completeTaskContext(options) {
      calls.push({ method: "completeTaskContext", options });
      return lifecycle;
    },
  };
  const module = await import(pathToFileURL(resolve(assets, name)));
  return {
    calls,
    result: await module.run({
      moneyhand,
      signal: AbortSignal.timeout(1_000),
      args,
      async progress(value) {
        calls.push({ method: "progress", value });
      },
    }),
  };
}

for (const name of ["disposable-task.mjs", "specialized-task.mjs"]) {
  test(`${name} binds one task context and always owns cleanup, not controller lifecycle`, async () => {
    const args = {
      taskId: "task-1",
      behavior: "human",
      behaviorOptions: { ttlMs: 600_000 },
    };
    const { calls, result } = await runTemplate(name, args);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], {
      method: "beginTaskContext",
      options: {
        id: "task-1",
        behavior: "human",
        behaviorOptions: { ttlMs: 600_000 },
        signal: calls[0].options.signal,
      },
    });
    assert.equal(calls[1].method, "progress");
    assert.equal(calls[1].value.phase, "start");
    assert.deepEqual(calls[2], {
      method: "inspectTaskBlocker",
      options: {
        taskSpaceId: "pinned-task",
        operation: "task-terminal",
        reason: {
          code: name === "disposable-task.mjs"
            ? "TASK_LOGIC_NOT_IMPLEMENTED"
            : "SPECIALIZED_WORKFLOW_NOT_IMPLEMENTED",
          message: "Task did not reach a complete outcome",
          retry: "inspect-current-page-before-next-action",
        },
      },
    });
    assert.deepEqual(calls[3], {
      method: "completeTaskContext",
      options: {
        taskSpaceId: "pinned-task",
        keep: false,
        resetBehavior: true,
      },
    });
    assert.equal(result.outcome.status, "incomplete");
    assert.equal(result.outcome.visualFallback.captured, true);
    assert.deepEqual(result.outcome.evidence, [{
      type: "visual-fallback",
      path: "C:\\temp\\terminal.png",
    }]);
    assert.equal(result.output, null);
    assert.equal(result.lifecycle.cleanupComplete, true);

    const source = await readFile(resolve(assets, name), "utf8");
    assert.doesNotMatch(source, /target\.list|Runtime\.evaluate|window\.scrollBy/u);
    assert.doesNotMatch(source, /WebSocket|\.start\s*\(|\.stop\s*\(/u);
    assert.match(source, /beginTaskContext/u);
    assert.match(source, /completeTaskContext/u);
    assert.match(source, /async function executeTask/u);
    assert.match(source, /replace only[\s\S]*executeTask\(\)/iu);
    assert.match(source, /TASK_RESULT_CONTRACT_INVALID/u);
    assert.match(source, /output/u);
    assert.doesNotMatch(source, /MONEYHAND_TASK_TEMPLATE|replace-before-running/u);
  });
}

test("task templates expose one deterministic URL-safe effect ID helper", async () => {
  const module = await import(pathToFileURL(resolve(assets, "disposable-task.mjs")));
  const first = module.stableEffectId("navigate/page", "https://example.test/a?x=1&y=2");
  const duplicate = module.stableEffectId("navigate/page", "https://example.test/a?x=1&y=2");
  const different = module.stableEffectId("navigate/page", "https://example.test/b");
  assert.equal(first, duplicate);
  assert.notEqual(first, different);
  assert.match(first, /^[A-Za-z0-9._:-]{1,128}$/u);
  assert.equal(first.startsWith("navigate_page:"), true);
  assert.throws(
    () => module.stableEffectId("navigate", ""),
    (error) => error.code === "INVALID_EFFECT_KEY",
  );
});

for (const name of ["disposable-task.mjs", "specialized-task.mjs"]) {
  test(`${name} builds page expressions without recursively interpolating literal text`, async () => {
    const module = await import(pathToFileURL(resolve(assets, name)));
    const expression = module.pageExpression(({ id }) => ({
      id,
      literal: "literal-${POST_ID}",
    }), { id: "input-${ITEM_ID}" });
    assert.equal(expression.includes("literal-${POST_ID}"), true);
    const value = runInNewContext(expression);
    assert.equal(value.id, "input-${ITEM_ID}");
    assert.equal(value.literal, "literal-${POST_ID}");
    const circular = {};
    circular.self = circular;
    assert.throws(
      () => module.pageExpression(() => null, circular),
      (error) => error.code === "INVALID_PAGE_EXPRESSION_INPUT",
    );
  });

  test(`${name} verifies grouped record order without assuming per-page cardinality`, async () => {
    const module = await import(pathToFileURL(resolve(assets, name)));
    assert.deepEqual(module.recordGroupOrderRequirement([
      { pageKey: "beta" },
      { pageKey: "beta" },
      { pageKey: "beta" },
      { pageKey: "gamma" },
      { pageKey: "alpha" },
      { pageKey: "alpha" },
    ], ["beta", "gamma", "alpha"]), {
      id: "record-page-order",
      satisfied: true,
      expected: "beta\ngamma\nalpha",
      actual: "beta\ngamma\nalpha",
    });
    assert.equal(module.recordGroupOrderRequirement([
      { pageKey: "beta" },
      { pageKey: "alpha" },
      { pageKey: "gamma" },
    ], ["beta", "gamma", "alpha"]).satisfied, false);
    assert.throws(
      () => module.recordGroupOrderRequirement([{ pageKey: "" }], ["beta"]),
      (error) => error.code === "INVALID_RECORD_GROUP_ORDER_INPUT",
    );
  });
}
