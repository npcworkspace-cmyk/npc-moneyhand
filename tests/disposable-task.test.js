import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    assert.equal(result.lifecycle.cleanupComplete, true);

    const source = await readFile(resolve(assets, name), "utf8");
    assert.doesNotMatch(source, /target\.list|Runtime\.evaluate|window\.scrollBy/u);
    assert.doesNotMatch(source, /WebSocket|\.start\s*\(|\.stop\s*\(/u);
    assert.match(source, /beginTaskContext/u);
    assert.match(source, /completeTaskContext/u);
  });
}
