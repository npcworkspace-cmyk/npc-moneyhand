---
name: npc-moneyhand
description: Install and connect the npc-moneyhand Chromium extension through one fixed, bounded startup flow, then use the connected browser only after asking the user for a task. Use when an Agent receives the npc-moneyhand GitHub link, imports the Skill, connects MoneyHand, or performs a browser task through the shared MoneyHand base beneath a specialized Skill.
---

# NPC MoneyHand

Use MoneyHand as the shared browser executor. Follow the startup procedure exactly. Do not explore
the repository, inspect extension source, generate an adapter, or run a browser test during startup.
Resolve every command from the directory containing this file. Require local Node.js 20+.

## Mandatory startup

If this directory is already loaded as a Skill, do not reinstall it. Otherwise install only the
`skills/npc-moneyhand` directory through the Agent host's normal local-Skill import. Do not scan the
computer for undocumented Skill directories.

Run exactly once:

```text
node scripts/moneyhand.mjs --connect
```

Read the result whose id is `connect`, follow only its `nextAction`, and continue reading until
`moneyhand.stopped`. Do not run any browser operation before a connected result.

The outer `ok: true` only means the command returned a valid bounded result. Only `value.connected: true`
with `value.status: connected` means that MoneyHand connected.

### `status: connected`

Send the returned `userMessage` to the user and stop. Ask what browser task to perform. Do not open a
site, list tabs, take a screenshot, or run a smoke test before the user answers.

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
- run preflight, capability discovery, status probes, tab enumeration, or test navigation;
- write a temporary controller or task script;
- scan ports, change the fixed endpoint, or start a second listener or daemon;
- switch to Playwright, remote debugging, another extension, or another browser-control tool;
- kill, close, or restart browser processes;
- modify a browser Profile, extension files, enterprise policy, or pairing configuration;
- repeat a command beyond the two paths defined above.

If a host cannot run local Node.js 20+ or cannot import a local Skill, report that requirement and
stop instead of inventing an alternative installation.

## After the user supplies a task

Use one task-owned MoneyHand controller for the complete user task. Keep the first selected browser
Profile and task page stable until completion; a later focus change is not permission to retarget.
Use fast structured browser actions by default and use human-style behavior only when the user or a
specialized Skill requests it. Treat a post-dispatch disconnect or timeout as an unknown outcome;
inspect real page state before repeating a write.

Read `references/browser-workflows.md` only after the user provides a task that needs detailed browser
actions. Read `references/integration-lifecycle.md` only when implementing a persistent adapter or a
trusted local task module. Do not read machine contracts during startup.

## Specialized Skills

A specialized Skill may depend on `npc-moneyhand` and reuse its connected controller. MoneyHand owns
connection, browser wake-up, task binding, browser actions, recovery, and shutdown. The specialized
Skill owns its platform or business workflow, bounds, fields, checkpoints, completion proof, and
output. Never copy MoneyHand or start a second controller inside a specialized Skill.
