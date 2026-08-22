import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import { run } from "../skills/npc-moneyhand/assets/connect-acceptance.mjs";

function fakeMoneyHand(options = {}) {
  const calls = [];
  const state = {
    value: "moneyhand-ready",
    output: "accepted:moneyhand-ready",
    checked: true,
    selected: "beta",
    uploadName: "acceptance-upload.txt",
    clicks: 1,
    scrollY: 700,
  };
  let currentUrl = "about:blank";
  const api = {
    calls,
    async beginTaskContext(input) {
      calls.push({ method: "beginTaskContext", input });
      return {
        taskSpaceId: input.id,
        tabId: 42,
        selector: { instanceId: "acceptance-instance", bootId: "acceptance-boot" },
        page: { ownedWindow: true },
        behavior: { mode: "human" },
      };
    },
    async navigateTaskTab(input) {
      calls.push({ method: "navigateTaskTab", input });
      if (options.failNavigation) {
        throw Object.assign(new Error("fixture navigation failed"), { code: "NAVIGATION_FAILED" });
      }
      currentUrl = input.url;
      return { loaded: true, navigation: { transport: "chrome.tabs.update" } };
    },
    async captureSemanticSnapshot(input) {
      calls.push({ method: "captureSemanticSnapshot", input });
      const names = [
        "Acceptance text",
        "Apply acceptance input",
        "Acceptance checkbox",
        "Acceptance select",
        "Acceptance upload",
        "Download acceptance file",
      ];
      return {
        snapshot: {
          id: "semantic:acceptance",
          nodes: names.map((name, index) => ({
            ref: `@${index + 1}`,
            name,
            ...(name === "Download acceptance file" ? { href: "http://127.0.0.1/download" } : {}),
          })),
        },
      };
    },
    async actSemanticRef(input) {
      calls.push({ method: "actSemanticRef", input });
      if (input.action === "type" || input.action === "click") return { actionDispatched: true };
      if (input.action === "check") return { checkedState: { after: true } };
      if (input.action === "select") return { selection: { options: [{ value: "beta" }] } };
      if (input.action === "upload") {
        calls.push({ method: "uploadRoot", path: input.fileRoot });
        return { fileSelection: { count: 1 } };
      }
      if (input.action === "download") {
        return { download: { id: 17, state: "complete" } };
      }
      throw new Error(`Unexpected semantic action ${input.action}`);
    },
    async scrollTaskTab(input) {
      calls.push({ method: "scrollTaskTab", input });
      return { actionDispatched: true };
    },
    async evaluateTaskTab(input) {
      calls.push({ method: "evaluateTaskTab", input });
      return {
        schema: "npc-moneyhand-task-evaluate/1",
        hasValue: true,
        value: input.expression.includes("#acceptance-text")
          ? state
          : {
              href: currentUrl,
              title: "MoneyHand automatic acceptance",
              fixture: true,
            },
      };
    },
    async captureStableViewport(input) {
      calls.push({ method: "captureStableViewport", input });
      await writeFile(input.outputPath, Buffer.alloc(256, 1));
      return { stable: true, bundle: { image: { sha256: "a".repeat(64) } } };
    },
    async captureFullPage(input) {
      calls.push({ method: "captureFullPage", input });
      await writeFile(input.outputPath, Buffer.alloc(512, 2));
      return { observationOnly: true, image: { sha256: "b".repeat(64) } };
    },
    async request(input) {
      calls.push({ method: "request", input });
      return {
        ok: true,
        result: { method: input.params.method, result: input.params.method === "downloads.erase" ? [17] : null },
      };
    },
    async completeTaskContext(input) {
      calls.push({ method: "completeTaskContext", input });
      return {
        cleanupComplete: true,
        windowCleanup: { ok: true },
        behaviorReset: { ok: true, value: { behavior: { mode: "raw" } } },
      };
    },
  };
  return api;
}

test("automatic connect acceptance exercises the safe localhost browser checklist and cleans up", async () => {
  const moneyhand = fakeMoneyHand();
  const progress = [];
  const result = await run({
    moneyhand,
    args: { taskId: "connect-acceptance-test" },
    progress: async (event) => progress.push(event),
  });

  assert.equal(result.outcome.status, "complete");
  assert.equal(result.outcome.checks.length, 16);
  assert.equal(result.outcome.checks.every((check) => check.status === "passed"), true);
  assert.deepEqual(result.lifecycle, {
    cleanupComplete: true,
    windowClosed: true,
    behaviorReset: "raw",
  });
  assert.equal(progress.at(-1).current, 16);
  assert.equal(progress.at(-1).total, 16);
  assert.deepEqual(
    moneyhand.calls.filter((call) => call.method === "actSemanticRef").map((call) => call.input.action),
    ["type", "click", "check", "select", "upload", "download"],
  );
  assert.deepEqual(
    moneyhand.calls.filter((call) => call.method === "request").map((call) => call.input.params.method),
    ["downloads.removeFile", "downloads.erase"],
  );
  assert.equal(moneyhand.calls.filter((call) => call.method === "navigateTaskTab").length, 3);
  assert.equal(moneyhand.calls.filter((call) => call.method === "evaluateTaskTab").length, 3);
  const uploadRoot = moneyhand.calls.find((call) => call.method === "uploadRoot").path;
  await assert.rejects(access(uploadRoot));
});

test("automatic connect acceptance reports a failed check and still closes its task context", async () => {
  const moneyhand = fakeMoneyHand({ failNavigation: true });
  const result = await run({
    moneyhand,
    args: { taskId: "connect-acceptance-failure" },
    progress: async () => {},
  });

  assert.equal(result.outcome.status, "incomplete");
  assert.equal(
    result.outcome.checks.some((check) => check.name === "localhost_navigation"
      && check.status === "failed"),
    true,
  );
  assert.equal(result.lifecycle.cleanupComplete, true);
  assert.equal(
    moneyhand.calls.filter((call) => call.method === "completeTaskContext").length,
    1,
  );
});
