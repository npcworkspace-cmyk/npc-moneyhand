# MoneyHand task runtime

Read this short path for every browser task after `--connect` returns `connected`. Do not enumerate
debugger targets, guess browser IDs, or start another controller. Copy `assets/disposable-task.mjs`
outside the Skill, replace its bounded task-work placeholder, remove the exported
`MONEYHAND_TASK_TEMPLATE` sentinel, and preserve its `beginTaskContext()` / `completeTaskContext()`
lifecycle. Never submit the packaged asset or an unchanged copy: `TASK_TEMPLATE_NOT_IMPLEMENTED` means implement the concrete task instead of retrying it.

## Normal path

1. Call `beginTaskContext()` once. It selects the latest focused Profile and creates one dedicated task window with pinned `taskSpaceId` and `tabId`.
2. Use only those returned identifiers. Later focus changes never retarget the task.
3. Default to `behavior:"raw"`; request `human` only for genuinely human-style input.
4. The module receives `run({moneyhand,signal,args,progress,taskExecutionId})`. Pass `signal` to waits
   and call `progress()` at every bounded batch or durable checkpoint.
5. Give every replay-sensitive navigation, input, upload, download, publish, send, or write a stable
   `effectId` inside this task execution. MoneyHand injects the fixed `navigation` effect for
   `navigateTaskTab()` / `navigateSemanticRef()` and the fixed `input` effect for `scrollTaskTab()`;
   do not guess or override those values.
6. A claimed `complete` result must include machine-checkable `requirements` and bounded `evidence`.
7. Always call `completeTaskContext()` in `finally`; failed cleanup means the task is incomplete.

Do not rewrite the lifecycle from memory. The asset already reports exceptions, attaches visual
evidence, resets behavior, closes the owned window, and downgrades nominal success after bad cleanup.
Run it from the Skill root with an absolute task path:

```text
node scripts/moneyhand.mjs --task "ABSOLUTE_PATH_TO_TASK_MODULE.mjs" --args-json "{}"
```

This is a foreground stdout stream. Keep consuming it through the terminal `id:"task"` result. Never
detach, background, or fire-and-forget it. If the host returns a process/session handle, resume that
exact handle at least every 30 seconds; show meaningful checkpoints, visuals, and errors immediately,
and give the user a concise update at least every 30 seconds during heartbeat-only periods.

Retain `taskExecutionId` from the first `moneyhand.task_submitted` event. A disconnected client does
not cancel the resident task. Recover the same execution—never submit a duplicate:

```text
node scripts/moneyhand.mjs --task-status "TASK_EXECUTION_ID"
node scripts/moneyhand.mjs --task-follow "TASK_EXECUTION_ID"
```

Use `--task-last` once only if the ID itself was lost. These commands read the private journal and do
not connect the Extension or open a browser. `state:"interrupted"` is not success.

Read compact `taskSummary` first on a terminal, status, or initial follow record. Its bounded fields
are `state`, `phase`, `progress:{current,total}`, `lastCheckpoint`, `lastActivityAgoMs`, `rate`,
`visual`, and `nextAction`. Follow only `nextAction`; initial follow exposes the same object at top
level and as `status.taskSummary`.

## Copyable operation shapes

Navigate with `domcontentloaded` for ordinary dynamic pages. The task runtime injects its fixed
`navigation` effect:

```js
await moneyhand.navigateTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId,
  url: "https://example.test/page", effectId: "navigate:example-page",
  waitUntil: "domcontentloaded",
  timeoutMs: 30_000,
  signal,
});
```

For a semantic action, pass the string `snapshot.id`; `action`, `effect`, and `verification` are
top-level siblings:

```js
const { snapshot } = await moneyhand.captureSemanticSnapshot({
  tabId: task.tabId, maxNodes: 800, signal,
});
const link = snapshot.nodes.find((node) => node.role === "link" && node.href);
if (!link) throw new Error("LINK_NOT_FOUND");
await moneyhand.actSemanticRef({
  taskSpaceId: task.taskSpaceId, snapshotId: snapshot.id, ref: link.ref,
  action: "click", effect: "input",
  effectId: "click:example-link",
  verification: { kind: "url-changed" },
  signal,
});
```

In task modules, omit snapshot `selector`: it selects a browser session, never CSS, and the runtime pins the active Task Context. Whole-document `body`, `html`, `:root`, or `document` hints are compatibility aliases only. Type uses `text`, select uses `options`, and both accept the common singular `value` alias.

When a link has `href`, prefer `navigateSemanticRef({taskSpaceId,snapshotId,ref,signal})` over an occludable click.

For a bounded read of the current document, use `evaluateTaskTab()`. It selects the current default
page context on every call, awaits Promises by default, returns values by copy, and never accepts a
cached `contextId`, `executionContextId`, or `objectId`:

```js
const evaluated = await moneyhand.evaluateTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId, signal,
  expression: `Promise.resolve([...document.querySelectorAll("[data-example-record]")]
    .slice(0, 20).map((element) => element.innerText).filter(Boolean))`,
});
const records = evaluated.value;
if (!Array.isArray(records)) throw new Error("DOM_READ_RESULT_INVALID");
```

`undefined` returns `isUndefined:true`; page exceptions use `TASK_EVALUATION_EXCEPTION`. Call the same
helper after every navigation—never cache an execution context. Expressions stay local, bounded,
read-only, and independent of page text. Raw CDP remains in `browser-workflows.md`; human mode does
not make JavaScript human-like. Use `scrollTaskTab()` for input-path scrolling.

```js
await moneyhand.scrollTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId,
  deltaY: 700, effectId: "scroll:page-2", signal,
});
```

Do not add `effect` to that call; MoneyHand injects `input` and rejects a conflicting value before
dispatch.

Screenshot paths must be new absolute `.png` paths under an existing task directory:

```js
const viewport = await moneyhand.captureStableViewport({
  taskSpaceId: task.taskSpaceId, outputPath: args.viewportOutputPath, signal });
const fullPage = await moneyhand.captureFullPage({
  taskSpaceId: task.taskSpaceId, outputPath: args.fullPageOutputPath, signal });
if (viewport.stable !== true || fullPage.observationOnly !== true
  || fullPage.coordinateMapping !== false
  || viewport.path !== args.viewportOutputPath
  || fullPage.path !== args.fullPageOutputPath) throw new Error("CAPTURE_CONTRACT_INVALID");
```

Both helpers return the exact written PNG as top-level `path`. Use that field in requirements and
evidence instead of guessing a nested result shape. Full-page images are observation-only and never
provide click coordinates.

## Hard-coded runtime guarantees

- The task module runs inside a zero-dependency Node Worker. It sees the documented
  `moneyhand.*` methods, `progress()`, JSON-compatible `args`, and its abort `signal`; it does not share
  mutable controller internals. On success the Worker is reclaimed. On timeout or shutdown an
  unresponsive Worker is terminated before exact task-window cleanup, so a forgotten local server or
  pending timer cannot pin the resident controller.
- `effectId` is scoped to one `taskExecutionId`. Identical duplicates join/reuse the first result;
  conflicting fingerprints fail before dispatch; dispatched or unknown outcomes are never replayed.
- High-level Task Space operations are automatically rate-gated after an HTTP(S) origin is known,
  scoped by exact origin + pinned Profile. Human mode cannot bypass it. Specialized Skills may add
  richer `Retry-After`, account, latency, and checkpoint observations through `rateControl`.
- Fixed recovery retries only a whitelisted, proven-not-dispatched transient once after a healthy
  same-page probe. Stale/ambiguous/occluded targets require fresh observation; unknown actions are
  inspected without replay; session failure ends in the fixed connection flow.
- MoneyHand emits `moneyhand.task_progress` before module import and at least every 10 seconds. After
  15 seconds without activity it captures the current viewport. Task code runs on its own Worker, so
  synchronous task code cannot suppress that controller watchdog. `moneyhand.task_monitor` remains an
  attached-client fallback for a controller or output-transport reporting stall.
- Progress, recovery, effect, rate, monitor, and terminal messages carry `relay`; the Agent host must
  honor its wake, user-notification, and deadline fields. The controller cannot independently create a
  new turn inside an arbitrary Agent host.

When `visualFallback.captured:true`, open exactly `visualFallback.screenshot.path`; do not capture a
second image and never replay the failed action. When `waitingForInstruction:true`, call only:

```js
await moneyhand.resolveTaskBlocker({ taskSpaceId: task.taskSpaceId, action: "resume" }); // or cancel
```

## Completion

Use `complete`, `incomplete`, or `outcome_unknown`. Deduplicate by canonical identifier or URL before
claiming a count. A screenshot path/byte count proves transport only: open every image used as task evidence and verify a task-specific visible sentinel; blank or wrong-page images fail the requirement.

```js
outcome = {
  status: "complete",
  requirements: [{ id: "requested-items", satisfied: records.length === args.limit, expected: args.limit, actual: records.length }],
  evidence: records.map((record) => ({ type: "record", id: record.id })),
};
```

The terminal result adds `taskEvidence` and `completionGate`. A complete claim fails as
`TASK_COMPLETION_GATE_FAILED` while cleanup, effects, rate state, instruction state, or requirements
remain unresolved. Private controller evidence does not replace a specialized Skill's domain output.
Every terminal error keeps its original fields and adds `error.details.recovery`; follow its
`nextAction` instead of inferring another retry policy from the raw message.

Read another reference only when the task reaches that branch:

- `task-recovery.md`: timeout, page/controller failure, unknown outcome, cleanup failure, or blocker;
- `browser-workflows.md`: advanced actions, transfers, coordinates, or data-plane selection;
- `behavior-modes.md`: requested human-style input;
- `rate-control.md`: specialized rate evidence and checkpoints;
- `integration-lifecycle.md`: persistent adapters and controller integration.
