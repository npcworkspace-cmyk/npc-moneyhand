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

The returned acceptance checklist has passed and `nextAction` is `ready_for_tasks`. Send the returned
`userMessage` as the connection result. Then use this fixed routing rule:

- If the current conversation already contains one concrete browser task, continue with that task
  immediately. Do not ask the user to repeat or reconfirm the same task.
- If no concrete browser task has been supplied yet, stop and ask the user what to do.

Do not run another smoke test or visit a public site merely to test the connection.

### Built-in automatic acceptance

Do not ask the user whether to run it and do not skip it. The command creates a task-owned window,
opens only an ephemeral `127.0.0.1` fixture, streams progress, and verifies all of these paths:

- task ownership plus temporary human behavior;
- navigation and semantic observation with link metadata;
- text input, pointer click, checkbox, select, upload, wheel scrolling, and a bounded CDP read;
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

Send the returned `userMessage` and stop. Do not repair, replace, or bypass the connection path.

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
- automatic exact-window cleanup after success, failure, abort, or a task module that forgot cleanup;
- automatic cleanup of the exact unchanged browser-launch bootstrap tab after the task, without
  touching pre-existing or user-modified tabs/windows;
- exact local ownership proof before first navigation, then bounded CDP page-health probes;
- fast raw behavior by default and temporary human-style input when explicitly requested;
- structured observation with link URLs, semantic actions, direct ref navigation, bounded navigation
  waits, and real browser input;
- automatic current-viewport visual fallback for waits, timeouts, occlusion, stale/ambiguous targets,
  page-health failures and other visible-page anomalies, without replaying the failed action;
- mandatory streamed task progress, including a 10-second heartbeat and a screenshot after 15 seconds
  without new task activity, even when task code forgot to report progress; neither threshold can be
  relaxed by task or adapter code;
- an attached-client `moneyhand.task_monitor` wake event when task code blocks the controller event
  loop, followed by a current-page screenshot before cleanup as soon as the controller recovers;
- an atomic cleanup barrier that pauses and drains the screenshot watchdog before task-window removal,
  so observation and cleanup cannot race;
- stable deliberate viewport screenshots that throw on capture failure, plus observation-only full-page
  screenshots;
- adaptive caller-scheduled rate decisions and honest complete/incomplete/unknown outcomes;
- one shared controller beneath independently distributed specialized Skills.

Normal task code receives `progress({phase,message,current,total,checkpoint})`; use it at every bounded
batch or checkpoint. MoneyHand still emits `moneyhand.task_progress` automatically, so a forgotten
callback cannot leave the console silent. When an exception or silent-task watchdog returns
`visualFallback.captured:true`, open exactly `visualFallback.screenshot.path` with the Agent host's
local image viewer. Do not take a second screenshot or replay the original action. If
`waitingForInstruction:true`, use only `resolveTaskBlocker({taskSpaceId,action:"resume"|"cancel"})`;
never search for `tabId` or `waitId`. Automatic images are local-sensitive temporary PNG files and
must not be pasted into remote/shared logs without user authorization.

Run every `--task` as one foreground-attached command and keep consuming its stdout until the terminal
`id:"task"` result. Never detach, background, fire-and-forget, or end the Agent turn while it is
running. If the host returns a process/session handle, immediately use that host's wait or continuation
operation at intervals no longer than 30 seconds until completion. Treat `moneyhand.task_progress` and
`moneyhand.task_monitor` as host wake signals: surface meaningful checkpoints and every visual/error
event immediately, and
give the user a concise still-running update at least every 30 seconds when only heartbeats arrive.
The controller cannot invoke an arbitrary Agent host's scheduler by itself; a host that cannot retain
or resume an attached local command cannot claim unattended long-task support.

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
