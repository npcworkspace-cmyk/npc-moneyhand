---
name: npc-moneyhand
description: Install, immediately connect, and automatically accept-test the npc-moneyhand Chromium extension through one fixed startup flow, then run user-requested browser work directly or beneath a specialized Skill. An install/import request is incomplete until the same Agent turn runs the connection command and returns its bounded acceptance result. Use when an Agent receives the npc-moneyhand GitHub link, imports the Skill, connects MoneyHand, or needs the shared MoneyHand browser base.
---

# NPC MoneyHand

Use MoneyHand as the shared browser executor. Follow the startup procedure exactly. Do not explore
the repository, inspect extension source, generate an adapter, or invent an additional browser test.
Run every documented command from the Skill root: the directory that directly contains this
`SKILL.md`. Do not change into `scripts/` first. Require local Node.js 20+.

Installing or importing the Skill files alone is not a completed installation task. In the same Agent
turn, continue through `--connect` and its automatic acceptance until one bounded `connect` result is
returned. Never present connection or acceptance as an optional next step, never merely print the
command for the user to run, and never ask whether the user wants it run now.

## Mandatory startup

If this directory is already loaded as a Skill, do not reinstall it. Otherwise install only the
`skills/npc-moneyhand` directory through the Agent host's normal local-Skill import, then continue
immediately to the command below without ending the turn. Do not scan the computer for undocumented
Skill directories.

Run exactly once:

```text
node scripts/moneyhand.mjs --connect
```

This one command starts or reuses MoneyHand's bundled localhost controller, keeps the Extension
connection alive for later browser tasks, and automatically runs the built-in full acceptance in a
temporary localhost-only task window. It is the same Skill script, not separately installed daemon
software. When it has to open the browser, the bounded handshake and acceptance are part of this same
command, not a user-confirmed retry. Do not start a controller or test script yourself.

Read the result whose id is `connect` and follow only its `nextAction`. The command-line client exits
after that bounded result while the bundled controller remains available; do not wait for a
`moneyhand.stopped` event from `--connect`. Do not run any browser operation before a connected result.

The outer `ok: true` only means the command returned a valid bounded result. Only `value.connected: true`
with `value.status: connected` means that MoneyHand connected.

### `status: connected`

The returned acceptance checklist has passed, `nextAction` is `ready_for_tasks`, and `taskRouting`
is the machine-readable routing rule. Send the returned `userMessage` as the connection result. Then
use this fixed routing rule:

- If the current conversation already contains one concrete browser task, continue with that task
  immediately. Do not ask the user to repeat or reconfirm the same task. Ending the Agent turn after
  connection in this case is a task failure.
- If no concrete browser task has been supplied yet, stop and ask the user what to do.

Do not run another smoke test or visit a public site merely to test the connection.

### Built-in automatic acceptance

Do not ask the user whether to run it and do not skip it. The command creates a task-owned window,
opens only an ephemeral `127.0.0.1` fixture, streams progress, and verifies all of these paths:

- task ownership plus temporary human behavior;
- navigation and semantic observation with link metadata;
- text input, pointer click, checkbox, select, upload, wheel scrolling, and a bounded CDP read;
- repeated fresh-document navigation plus current-context evaluation without cached CDP context IDs;
- stable viewport and full-page screenshots;
- download completion followed by removal of the test file and its history entry;
- exact task-window closure and behavior reset to `raw`.

The acceptance never visits an external website and never uses a user's existing page. A normal
connected result is returned only after every checklist item and cleanup pass. If it fails, report the
returned bounded result and stop; do not write another acceptance script or branch into diagnostics.

### `action: install_extension`

Send the returned `userMessage` and wait. It tells the user to install the Extension, open that
browser, and click MoneyHand's `立即连接`. After the user confirms, run the returned `retryCommand`
exactly once. It is the same single recovery command shown below.

### `action: open_browser_and_click_extension`

Send the returned `userMessage` and wait. After the user confirms the click, run exactly once:

```text
node scripts/moneyhand.mjs --connect --after-user-action
```

Never run another automatic retry after this command.

### `status: blocked`

Send the returned `userMessage` and stop. Do not repair, replace, or bypass the connection path. A
terminal blocked result automatically stops the bundled controller after delivering the result, so
the Agent must not run an additional `--stop`, inspect listeners, or invent cleanup commands.

## Startup prohibitions

During installation and connection, never:

- inspect extension or controller source;
- run an extra preflight, capability discovery, status probe, enumeration, or test navigation outside
  the built-in automatic acceptance;
- write a temporary controller or task script;
- scan ports, change either fixed localhost endpoint, or start a second controller/listener;
- switch to Playwright, remote debugging, another extension, or another browser-control tool;
- kill, close, or restart browser processes;
- modify a browser Profile, extension files, enterprise policy, or pairing configuration;
- repeat a command beyond the two paths defined above.

If a host cannot run local Node.js 20+ or cannot import a local Skill, report that requirement and
stop instead of inventing an alternative installation.

## Run the user's task

Read `references/task-runtime.md` before writing or running task logic. It is the short, single normal
task path and contains copyable argument shapes. Do not preload recovery or full API references.
Never run `assets/disposable-task.mjs`, `assets/specialized-task.mjs`, or an unchanged copy. They are
blank lifecycle templates: copy one to a task-owned temporary path, replace only `executeTask()`, and
preserve `run()`. The controller rejects only those source-identical blank assets as
`TASK_TEMPLATE_NOT_IMPLEMENTED` before browser dispatch.
Write non-empty task arguments to an absolute UTF-8 JSON file and invoke `--args-file`; never hand-escape
inline JSON in a shell command.
For a first multi-page or file-producing task, copy the runnable platform-neutral
`references/bounded-file-task.example.mjs`. If its generic record selector fits, leave its source intact
and put only user-supplied or authoritative task-input expectations in `args.acceptance`; omit every
unknown value. In particular, never infer a `pageIds` value from a page key, URL, title, or example.
This complete reference is allowed unchanged and directly emits `recordId/title/body/sourceUrl`. Name each page with `pageKey` (`id` is a legacy alias; never supply both). Set
`pages[].taskData.scrollDeltaY` to request a native proven scroll without editing code; its input is validated before a task window opens and its real receipt becomes `scroll:page-N` automatically. Do not redeclare that fact. Put other custom per-page inputs under `pages[].taskData`; unknown sibling keys fail instead of being silently discarded. For every page-side DOM read, use
`pageExpression(pageFunction,input)`; never hand-build an expression string. For ordered output, use
`recordGroupOrderRequirement(records,expectedPageKeys)` instead of expanding page IDs from a guessed per-page count.
MoneyHand selects the latest focused connected Profile once, opens one dedicated task window in
that Profile, pins it under a generated `taskId`, and closes that exact window in cleanup. The Agent
must never enumerate or guess tab/window IDs. A later focus change is not permission to retarget. If
MoneyHand had to open the Chromium Profile itself, it also records and closes its unchanged bootstrap
tab after the task; removing the last tab closes that launch window, while pre-existing or
user-modified tabs/windows are preserved.

Task and bootstrap ownership markers are `about:blank` fragments; creating them never requests an
external website.

MoneyHand's core task capabilities are:

- one-time Profile selection plus an automatically created, task-owned browser window;
- zero-dependency Worker isolation for Agent-authored task modules; timeout or shutdown terminates an
  unresponsive module and its task-owned Node handles before controller/window cleanup;
- automatic exact-window cleanup after success, failure, abort, or a task module that forgot cleanup;
- automatic cleanup of the exact unchanged browser-launch bootstrap tab after the task, without
  touching pre-existing or user-modified tabs/windows;
- exact local ownership proof before first navigation, then bounded CDP page-health probes;
- fast raw behavior by default and temporary human-style input when explicitly requested;
- structured observation with link URLs, semantic actions, direct ref navigation, bounded navigation
  waits, and real browser input;
- one read-only `evaluateTaskTab()` helper that always targets the current default page context after
  navigation, while retaining raw CDP as an advanced escape hatch;
- automatic current-viewport visual fallback for waits, timeouts, occlusion, stale/ambiguous targets,
  page-health failures and other visible-page anomalies, without replaying the failed action;
- mandatory streamed task progress, including a 10-second heartbeat and a screenshot after 15 seconds
  without new task activity, even when task code forgot to report progress; neither threshold can be
  relaxed by task or adapter code;
- one private, build-bound task journal keyed by `taskExecutionId`; losing an Agent command socket does
  not cancel the resident task, and a replacement Agent can query or follow that exact execution;
- per-task idempotency receipts for caller-supplied `effectId` values, including concurrent duplicate
  collapse, conflict rejection, and permanent no-replay treatment for unknown outcomes;
- a fixed recovery classifier: only a proven-not-dispatched transient may receive one same-page probe
  and one retry; stale/occluded targets are refreshed and dispatched/unknown actions are only inspected;
- task code cannot block the controller event loop because it runs in an isolated Worker; the normal
  heartbeat and screenshot watchdog remain live during synchronous task code. The attached client can
  still emit `moneyhand.task_monitor` if the controller or output transport itself stops reporting;
- an atomic cleanup barrier that pauses and drains the screenshot watchdog before task-window removal,
  so observation and cleanup cannot race;
- stable deliberate viewport screenshots that throw on capture failure, plus observation-only full-page
  screenshots; both successful helpers return the exact written PNG as top-level `path`; a path/byte count proves transport only, so task evidence must be opened and checked for a task-specific visible sentinel;
- automatic origin/Profile-scoped rate gating for high-level Task Space operations, plus the detailed
  explicit scheduler available to specialized Skills;
- a standard private evidence bundle and a completion gate that rejects a claimed `complete` result
  while cleanup, effect outcomes, rate state, instruction state, or declared requirements are unresolved;
- machine-readable relay fields on progress, recovery, effect, rate, monitor, and terminal events so an
  Agent host can wake itself and decide which checkpoints must also be shown to the user;
- one compact `taskSummary` on terminal/status/follow surfaces plus one additive recovery envelope on
  terminal errors, so a new Agent follows `nextAction` before opening full logs;
- one shared controller beneath independently distributed specialized Skills.

Normal task code receives `progress({phase,message,current,total,checkpoint})`; use it at every bounded
batch or checkpoint. MoneyHand still emits `moneyhand.task_progress` automatically, so a forgotten
callback cannot leave the console silent. When an exception or silent-task watchdog returns
`visualFallback.captured:true`, open exactly `visualFallback.screenshot.path` with the Agent host's
local image viewer. Do not take a second screenshot or replay the original action. If
`waitingForInstruction:true`, use only `resolveTaskBlocker({taskSpaceId,action:"resume"|"cancel"})`;
never search for `tabId` or `waitId`. Automatic images are local-sensitive temporary PNG files and
must not be pasted into remote/shared logs without user authorization.

`progress()` is the streaming channel. `executeTask()` returns `{outcome,output?}` once, and the fixed
wrapper preserves it at terminal `id:"task".value`; `taskSummary` and `taskEvidence` are additive.
Write every bulk list or downloaded dataset to a user-authorized task file and return a small output
manifest. Evidence proves the result with bounded paths, counts, IDs, hashes, or screenshots; it is
never the bulk-data payload. Use the template's `stableEffectId(prefix,key)` for raw URLs or other
canonical keys instead of hand-building effect IDs.
Before claiming `complete`, map every explicit user acceptance condition to a separate requirement;
record count, page count, order, required IDs, and required field values must never share one generic check.
In the runnable reference, `requiredFields` rejects missing, null, blank-string, non-finite-number, and empty collection values; a present empty key is not proof.
Collect every bounded matching row; never invent a per-page count, page ID, or field assertion the user omitted.
For any custom task-specific action not native to the runnable reference, declare bounded `{id,expected}` entries in
`args.acceptance.taskFacts` and return matching measured `{id,actual,evidence?}` entries in
`outcome.taskFacts`; IDs match exactly, expected object fields match recursively, and actual objects may retain extra measured fields. Arrays and primitives remain exact.
Requested `human` behavior automatically adds `runtime:behavior-mode`; an evidence file alone never proves a requirement.
For file output, `output.path/count` and `output-file` evidence must describe the same file and count.

Run every `--task` as one foreground-attached command and keep consuming its stdout until the terminal
`id:"task"` result. Record the `taskExecutionId` from `moneyhand.task_submitted`. Never detach, background, fire-and-forget,
or end the Agent turn while it is running. If the host returns a
process/session handle, immediately use that host's wait or continuation operation at intervals no
longer than 30 seconds until completion. Treat `relay.wakeAgent:true` on task progress, monitor,
recovery, rate, effect, and terminal events as a host wake signal; show checkpoints and every
visual/error event immediately, and give the user a concise still-running update at least every 30
seconds when only heartbeats arrive.

If the attached command or Agent process is lost unexpectedly, do not submit the task again. Run
`node scripts/moneyhand.mjs --task-last` only when the execution ID was not retained, then run exactly
`node scripts/moneyhand.mjs --task-follow "TASK_EXECUTION_ID"` and consume that stream to its terminal
result. Use `--task-status "TASK_EXECUTION_ID"` for a one-shot status read. These commands read the
private journal and do not start another browser task. The controller cannot create a turn inside an
arbitrary Agent host by itself; the host must consume the relay/attached stream.

On every terminal, status, or initial follow record, read `taskSummary` first and execute only its
`nextAction`. Open larger evidence only when required. For bounded current-page JavaScript/DOM reads,
use `evaluateTaskTab()` from `task-runtime.md`; never cache CDP context or object IDs across navigation.

Read `references/task-recovery.md` only after a task timeout, controller/page-health failure, unknown
outcome, cleanup failure, or visual blocker requires a recovery decision.

Human behavior applies only to actions sent through MoneyHand's input path. It does not transform page
JavaScript, DOM mutation, or network requests into human actions. Read `references/behavior-modes.md`
when the user or a specialized Skill requests human-style clicking, typing, or scrolling.

Read `references/browser-workflows.md` only when the normal task helpers do not cover a browser action.
Read `references/integration-lifecycle.md` when implementing a persistent adapter or trusted task
module. Do not read machine contracts during startup. Raw protocol operations are an advanced escape
hatch, not the normal task path.

## Specialized Skills

A specialized Skill may depend on `npc-moneyhand` and reuse its connected controller. MoneyHand owns
connection, browser wake-up, task binding, browser actions, recovery, and shutdown. The specialized
Skill owns its platform or business workflow, bounds, fields, checkpoints, completion proof, and
output. Read `references/skill-composition.md` and copy `assets/specialized-task.mjs` when creating or
adapting one. Never copy MoneyHand or start a second controller inside a specialized Skill.
