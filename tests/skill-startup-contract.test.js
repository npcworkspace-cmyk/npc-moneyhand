import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SKILL_PATH = "skills/npc-moneyhand/SKILL.md";

test("base Skill exposes one bounded startup path with mandatory automatic acceptance", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  const startup = skill.split("## Run the user's task")[0];

  for (const required of [
    "node scripts/moneyhand.mjs --connect",
    "node scripts/moneyhand.mjs --connect --after-user-action",
    "follow only its `nextAction`",
    "Only `value.connected: true`",
    "`ready_for_tasks`",
    "Do not ask the user whether to run it and do not skip it",
    "temporary localhost-only task window",
    "behavior reset to `raw`",
    "Never run another automatic retry",
    "do not wait for a\n`moneyhand.stopped` event",
    "directory that directly contains this\n`SKILL.md`",
    "Do not change into `scripts/` first",
    "current conversation already contains one concrete browser task",
    "Do not ask the user to repeat or reconfirm the same task",
    "Ending the Agent turn after\n  connection in this case is a task failure",
    "Never run `assets/disposable-task.mjs`",
    "TASK_TEMPLATE_NOT_IMPLEMENTED",
  ]) {
    assert.ok(skill.includes(required), `missing startup rule: ${required}`);
  }

  for (const leaked of [
    "target.list",
    "--call",
    "--describe",
    "behavior.set",
    "tabId",
    "instanceId",
    "bootId",
    "agent-operations.json",
    "moneyhand-contract.json",
    "skill-composition.md",
  ]) {
    assert.equal(startup.includes(leaked), false, `low-level startup surface leaked: ${leaked}`);
  }
  assert.doesNotMatch(startup, /continue reading until\s+`moneyhand\.stopped`/u);
});

test("install or import cannot terminate before connection and automatic acceptance", async () => {
  const [skill, hostGuide, openai] = await Promise.all([
    readFile(SKILL_PATH, "utf8"),
    readFile("skills/npc-moneyhand/references/agent-hosts.md", "utf8"),
    readFile("skills/npc-moneyhand/agents/openai.yaml", "utf8"),
  ]);
  assert.match(skill, /install\/import request is incomplete until the same Agent turn/iu);
  assert.match(skill, /Installing or importing the Skill files alone is not a completed installation task/u);
  assert.match(skill, /Never present connection or acceptance as an optional next step/u);
  assert.match(skill, /never ask whether the user wants it run now/u);
  assert.match(hostGuide, /steps 1 through 5 as one uninterrupted Agent turn/u);
  assert.match(hostGuide, /Copying\/importing[\s\S]*alone is not success/u);
  assert.match(hostGuide, /Do not stop after step 1/u);
  assert.match(openai, /\$npc-moneyhand/u);
  assert.match(openai, /immediately run[\s\S]*same turn[\s\S]*without offering them as optional/u);
});

test("base Skill teaches the built-in acceptance surface without mixing a specialized workflow", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  for (const capability of [
    "navigation and semantic observation",
    "text input, pointer click, checkbox, select, upload, wheel scrolling",
    "stable viewport and full-page screenshots",
    "download completion followed by removal",
    "exact task-window closure and behavior reset to `raw`",
  ]) {
    assert.ok(skill.includes(capability), `missing automatic acceptance capability: ${capability}`);
  }
  assert.doesNotMatch(skill, /Reddit|VOC|influencer|creator discovery/iu);
});

test("base Skill keeps specialized workflow ownership outside MoneyHand", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /A specialized Skill may depend on `npc-moneyhand`/u);
  assert.match(skill, /The specialized\s+Skill owns its platform or business workflow/u);
  assert.doesNotMatch(skill, /Reddit|VOC|influencer|creator discovery/iu);
});

test("normal task docs stay concise while exposing copyable operation shapes", async () => {
  const [runtime, recovery] = await Promise.all([
    readFile("skills/npc-moneyhand/references/task-runtime.md", "utf8"),
    readFile("skills/npc-moneyhand/references/task-recovery.md", "utf8"),
  ]);
  assert.ok(runtime.trimEnd().split(/\r?\n/u).length <= 190, "normal task path is too dense");
  assert.match(runtime, /assets\/disposable-task\.mjs/u);
  assert.match(runtime, /Read another reference only when/u);
  assert.match(runtime, /task-recovery\.md/u);
  assert.doesNotMatch(runtime, /TASK_WINDOW_OWNERSHIP_CHANGED/u);
  assert.match(recovery, /about:blank#npc-moneyhand-task=<uuid>/u);
  assert.match(recovery, /about:blank#npc-moneyhand-bootstrap=<uuid>/u);
  assert.match(recovery, /TASK_WINDOW_OWNERSHIP_CHANGED/u);
  assert.match(recovery, /unknown creation outcome without an acknowledged[\s\S]*ID is never removed/u);
  assert.match(runtime, /taskRequest\.request\.method.*`cdp\.send`/u);
  assert.match(runtime, /method: "cdp\.send",[\s\S]*method: "Runtime\.evaluate"/u);
  assert.match(runtime, /terminal\.result\?\.result\?\.result\?\.value/u);
  assert.match(runtime, /Never put `Runtime\.evaluate` directly in `request\.method`/u);
  assert.match(runtime, /--task "ABSOLUTE_PATH_TO_TASK_MODULE\.mjs"/u);
  assert.match(runtime, /Deduplicate by canonical identifier/u);
  for (const text of [runtime, await readFile(SKILL_PATH, "utf8")]) {
    assert.match(text, /path\/byte count proves transport only/u);
    assert.match(text, /task-specific visible sentinel/u);
  }
  assert.match(recovery, /supplies its `AbortSignal` automatically/u);
  assert.match(runtime, /timeoutMs: 30_000,[\s\S]*signal,/u);
});

test("normal task docs expose timeout cleanup and non-ambiguous screenshot terminals", async () => {
  const [runtime, recovery, lifecycle, workflows] = await Promise.all([
    readFile("skills/npc-moneyhand/references/task-runtime.md", "utf8"),
    readFile("skills/npc-moneyhand/references/task-recovery.md", "utf8"),
    readFile("skills/npc-moneyhand/references/integration-lifecycle.md", "utf8"),
    readFile("skills/npc-moneyhand/references/browser-workflows.md", "utf8"),
  ]);
  for (const field of [
    'actionDispatched:"task-dependent"',
    'retry:"inspect-checkpoint-before-retry"',
    "taskAcknowledgedAbort",
    "cleanupComplete",
    "controllerReusable",
    "taskWindowCleanup",
  ]) {
    assert.ok(recovery.includes(field), `task recovery omits timeout field ${field}`);
    assert.ok(lifecycle.includes(field), `integration lifecycle omits timeout field ${field}`);
  }
  assert.match(runtime, /task-recovery\.md/u);
  assert.match(lifecycle, /NPC_MONEYHAND_TASK_TIMEOUT_MS/u);
  assert.match(recovery, /does not inject an aborted signal into `completeTaskContext\(\)`/u);
  for (const code of [
    "VIEWPORT_CAPTURE_FAILED",
    "VIEWPORT_NOT_STABLE",
    "FULL_PAGE_NOT_STABLE",
  ]) {
    assert.ok(recovery.includes(code), `task recovery omits screenshot terminal ${code}`);
    assert.ok(workflows.includes(code), `browser workflow omits screenshot terminal ${code}`);
  }
  assert.match(recovery, /stable:true/u);
  assert.match(recovery, /observationOnly:true/u);
  assert.match(recovery, /coordinateMapping:false/u);
});

test("normal task docs require attached streamed progress and automatic bounded visual fallback", async () => {
  const [skill, runtime, recovery, hostGuide, contract] = await Promise.all([
    readFile(SKILL_PATH, "utf8"),
    readFile("skills/npc-moneyhand/references/task-runtime.md", "utf8"),
    readFile("skills/npc-moneyhand/references/task-recovery.md", "utf8"),
    readFile("skills/npc-moneyhand/references/agent-hosts.md", "utf8"),
    readFile("skills/npc-moneyhand/references/moneyhand-contract.json", "utf8").then(JSON.parse),
  ]);
  for (const text of [skill, runtime]) {
    assert.match(text, /moneyhand\.task_progress/u);
    assert.match(text, /moneyhand\.task_monitor/u);
    assert.match(text, /10 seconds|10-second/u);
    assert.match(text, /15 seconds/u);
    assert.match(text, /visualFallback\.screenshot\.path/u);
    assert.match(text, /resolveTaskBlocker/u);
    assert.match(text, /never replay|Do not[\s\S]*?replay|do not[\s\S]*?replay/iu);
  }
  assert.match(recovery, /up to 120 captures/u);
  assert.match(recovery, /visualFallback\.trigger\.actionDispatched/u);
  for (const text of [skill, runtime, hostGuide]) {
    assert.match(text, /foreground/iu);
    assert.match(text, /stdout/u);
    assert.match(text, /30 seconds/u);
    assert.match(text, /process\/session handle/u);
    assert.match(text, /terminal[\s\S]*?`id:"task"` result/u);
    assert.match(text, /moneyhand\.task_monitor/u);
  }
  assert.match(skill, /Never detach, background, fire-and-forget/u);
  assert.match(runtime, /cannot independently create a[\s\S]*new turn inside an arbitrary Agent host/u);
  assert.match(hostGuide, /cannot call a host-specific Agent scheduler/u);
  assert.equal(contract.taskRuntime.progress.automaticIntervalMs, 10_000);
  assert.equal(contract.taskRuntime.progress.visualSilenceMs, 15_000);
  assert.equal(contract.taskRuntime.progress.attachedMonitorIntervalMs, 10_000);
  assert.equal(contract.taskRuntime.progress.thresholdsCanOnlyTighten, true);
  assert.equal(contract.taskRuntime.progress.startsBeforeModuleImport, true);
  assert.equal(contract.taskRuntime.progress.streamsBeforeTaskCompletion, true);
  assert.equal(contract.taskRuntime.progress.screenshotBeforeTaskTimeoutAbort, true);
  assert.equal(contract.taskRuntime.progress.screenshotBeforeCleanupOnTerminalAnomaly, true);
  assert.equal(contract.taskRuntime.progress.watchdogPausedAndDrainedBeforeTaskCleanup, true);
  assert.equal(
    contract.taskRuntime.visualFallback.triggers.includes("task-terminal-failure-timeout-or-incomplete"),
    true,
  );
  assert.equal(contract.taskRuntime.visualFallback.maximumAutomaticCapturesPerTask, 120);
  assert.equal(contract.taskRuntime.visualFallback.hidesWaitIdTabIdAndBase64, true);
  assert.equal(contract.taskRuntime.visualFallback.actionReplay, false);
});

test("advanced lifecycle docs bind resident reuse and stop to the exact private controller instance", async () => {
  const [lifecycle, compatibility] = await Promise.all([
    readFile("skills/npc-moneyhand/references/integration-lifecycle.md", "utf8"),
    readFile("docs/AGENT_COMPATIBILITY.md", "utf8"),
  ]);
  for (const field of [
    "npc-moneyhand-controller/2",
    "pid",
    "build",
    "sourceId",
    "instanceNonce",
  ]) {
    assert.ok(lifecycle.includes(field), `integration lifecycle omits controller identity ${field}`);
  }
  assert.match(lifecycle, /token never appears[\s\S]*status or CLI output/u);
  assert.match(lifecycle, /CONTROLLER_PORT_OCCUPIED/u);
  assert.match(lifecycle, /public stop returns `stopped:false`[\s\S]*never kills/u);
  assert.match(lifecycle, /npc-moneyhand-controller-<user-scope>/u);
  assert.match(lifecycle, /controller-<port>\.json/u);
  assert.match(lifecycle, /identical Skill bytes[\s\S]*different Agent-specific paths[\s\S]*reuse/u);
  assert.match(lifecycle, /live different build fails[\s\S]*port refuses two[\s\S]*Invalid or foreign state is preserved/u);
  assert.match(lifecycle, /connected but sent no line[\s\S]*cannot hold shutdown open indefinitely/u);
  assert.match(compatibility, /npc-moneyhand-controller\/2/u);
  assert.match(compatibility, /moneyhand --stop[\s\S]*stopped:true/u);
});
