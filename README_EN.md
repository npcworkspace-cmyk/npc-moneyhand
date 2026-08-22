# npc-moneyhand (抓钱手 / MoneyHand)

[简体中文](./README.md) | [English](./README_EN.md)

> **The browser action and task runtime for the Agent era.**
>
> Give AI agents a pair of hands in the real browser, plus isolated tasks, long-running task management, and unattended execution.

**AI Agent Browser Automation · Multi-Agent Browser Control · Chrome Extension · CDP · Web Automation · Computer Use · Agent Skill · Local-first**

<strong>npc-moneyhand</strong>, also known as <strong>抓钱手</strong> or <strong>MoneyHand</strong>, lets Codex, Claude Code, OpenClaw, Hermes, and other local agents connect to the Chromium browser and signed-in environment the user already works in.

It is not a site-specific crawler or another disposable automation script. MoneyHand combines browser interaction, task isolation, progress management, recovery, and Skill composition into one reusable foundation.

> **For first-time installation, download only these two files:** [`npc-moneyhand-portable-skill.zip`](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases/latest/download/npc-moneyhand-portable-skill.zip) (base Skill) and [`npc-moneyhand-extension.zip`](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases/latest/download/npc-moneyhand-extension.zip) (browser Extension). All other Release assets are for development, auditing, or integrity verification.

[Quickstart](./docs/AGENT_QUICKSTART.md) · [MIT License](./LICENSE)

## What can it do?

- Search, browse, extract, and organize information from the web.
- Work inside signed-in websites with the user's authorization.
- Batch clicks, typing, pagination, forms, and list processing.
- Upload, download, submit, verify, and manage web content.
- Test website flows, controls, links, and outcomes.
- Run long, batch, or unattended browser tasks.
- Turn repeatable team and personal workflows into Specialized Skills.

If a task happens inside a Chromium page, MoneyHand can serve as the Agent's general execution layer.

## Core capabilities

### Multi-Agent task isolation

Multiple Agents can submit and follow different browser tasks. Every task has its own window, Task Space, execution ID, progress, and checkpoints. MoneyHand runs work concurrently or queues it according to the browser, Profile, and website capacity, reducing tab stealing, page drift, and cross-task interference.

> **Multiple Agents share one pair of hands, while every task keeps its own workspace.**

### Complete task management

MoneyHand manages the full task lifecycle:

~~~text
create → pin window → execute → report progress
→ checkpoint → recover → verify result → clean up
~~~

An Agent can see whether a task is alive, where it is, whether the website is pushing back, and whether the next action is to continue, wait, or stop.

### Long-running and unattended work

A Specialized Skill can define steps, batches, checkpoints, recovery, stop conditions, and completion criteria. After a task starts, it can keep running; if the originating Agent disconnects, another Agent can continue following the same task.

This supports repeatable research, web back-office work, page checks, list processing, and other daily workflows. Scheduling can be supplied by an Agent, operating-system scheduler, or external orchestrator.

### Batch execution and Token efficiency

MoneyHand moves repeated steps into batches, fast page reads, and deterministic scripts, reducing per-step model calls, repeated page transfer, and unnecessary screenshot interpretation.

> **For batchable work, MoneyHand significantly reduces model round trips, Token usage, and waiting time.**

A fixed savings percentage will be published only after a reproducible benchmark.

### Visual fallback and recovery

When a page times out, an element is occluded, the page changes, an action has no visible response, or a task goes silent, MoneyHand returns current page information, a screenshot, and recovery guidance instead of blindly replaying the action.

### Adaptive rate control and verified completion

MoneyHand adjusts speed, spacing, and batch size when a website pushes back. It can wait, checkpoint, or stop. Before reporting completion, it checks the result, evidence, unresolved states, and task-window cleanup.

### Complete page interaction

Navigation, waiting, click, type, scroll, select, check, drag, upload, download, screenshots, structured page reads, fast CDP operations, and Agent-selected human-like input are available through one foundation.

## Three layers

~~~text
Agent
understands goals and makes decisions
    ↓
Specialized Skill
defines the workflow and result
    ↓
npc-moneyhand Skill
manages tasks, progress, recovery, and rate control
    ↓
MoneyHand Extension
executes actions in the real browser
~~~

- **Extension**: performs stable, general browser actions.
- **Base Skill**: manages connection and task execution.
- **Specialized Skill**: defines a website or business workflow.

> **One universal Hand can support countless specialized action assistants.**

## Quickstart

1. Install the MoneyHand Extension from [GitHub Releases](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases).
2. Download the portable Skill, or clone the repository and run <code>npm run skill:install</code>.
3. From the installed Skill root, run:

~~~text
node scripts/moneyhand.mjs --connect
~~~

MoneyHand connects to the Extension, wakes the browser when needed, and completes automatic acceptance before starting a real task.

### Fixed rule for a new Agent

1. Install <code>skills/npc-moneyhand</code>.
2. Immediately run the connect command once from the Skill root.
3. After connection and acceptance pass, continue the task already present in the conversation; ask the user only when no task exists.
4. Follow only the returned <code>nextAction</code>.

The normal path does not scan ports, rewrite the controller, install another browser framework, or invent an alternate connection method. See [Agent Quickstart](./docs/AGENT_QUICKSTART.md).

## Local operation and boundaries

- The Extension and Agent communicate only through the local computer; no remote service or separately installed daemon is required.
- MoneyHand does not export passwords, cookies, authorization data, or browser Profiles.
- It does not bypass CAPTCHA, account controls, or website limits.
- Page visibility does not grant data-use rights.
- A Specialized Skill does not copy the controller, start a second connection service, or move domain logic into the Extension.

MoneyHand targets desktop browsers compatible with the required Chromium Extension APIs and requires Node.js 20+. Windows + Chromium is the current primary real-device environment. Run automatic acceptance on the target machine before production use on macOS or Linux.

## Documentation

- [Agent Quickstart](./docs/AGENT_QUICKSTART.md)
- [Architecture and boundaries](./ARCHITECTURE.md)
- [Agent and CLI integration](./docs/AGENT_INTEGRATION.md)
- [Troubleshooting](./docs/AGENT_TROUBLESHOOTING.md)
- [Specialized Skill composition](./skills/npc-moneyhand/references/skill-composition.md)

## License

[MIT](./LICENSE)
