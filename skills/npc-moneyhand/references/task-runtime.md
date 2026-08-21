# MoneyHand task runtime

Read this short path for every browser task after `--connect` returns `connected`. Do not enumerate
debugger targets, guess a browser identifier, or start another controller. Copy
`assets/disposable-task.mjs` outside the Skill, replace only its bounded task-work placeholder, and
keep its `beginTaskContext()` / `completeTaskContext()` lifecycle.

## Normal path

1. Call `beginTaskContext()` once. MoneyHand selects the latest focused connected Profile once,
   creates one dedicated task window, and returns its pinned `taskSpaceId` and `tabId`.
2. Use only those returned identifiers. A later focus change never retargets the task.
3. Default to `behavior:"raw"`; use `human` only when the user or a specialized Skill requests
   human-style input.
4. Pass the injected `signal` to waiting calls. Use the injected `progress()` at each bounded batch or
   durable checkpoint.
5. Prefer the high-level navigation, semantic, scrolling, capture, and task-request shapes below.
6. Always call `completeTaskContext()` in `finally`. A task is not complete when cleanup fails.

Do not rewrite that lifecycle from memory: the supplied asset already reports exceptions, attaches
visual evidence, resets behavior, closes the owned window, and downgrades a nominal success when
cleanup is incomplete. Add only the task-specific logic and its completion evidence.

Run it with an absolute path; relative `--task` paths are rejected:

```text
node scripts/moneyhand.mjs --task "ABSOLUTE_PATH_TO_TASK_MODULE.mjs" --args-json "{}"
```

This command is a foreground progress stream, not a background job. Keep its stdout attached and do
not end the Agent turn before the terminal `id:"task"` result. If the Agent command tool yields a
process/session handle, resume or poll that exact handle at least once every 30 seconds; do not launch
another task command. Forward meaningful checkpoint, visual fallback, and error events immediately;
for heartbeat-only periods, update the user at least every 30 seconds. Never detach the MJS, ignore
its handle, or report completion before the terminal result.

## Copyable operation shapes

Navigate with a top-level `effect`. Use `domcontentloaded` for ordinary dynamic pages:

```js
await moneyhand.navigateTaskTab({
  taskSpaceId: task.taskSpaceId,
  tabId: task.tabId,
  url: "https://example.test/page",
  effect: "navigation",
  waitUntil: "domcontentloaded",
  timeoutMs: 30_000,
  signal,
});
```

For semantic actions, pass the string `snapshot.id`, not the snapshot object. `action`, `effect`, and
`verification` are top-level siblings:

```js
const { snapshot } = await moneyhand.captureSemanticSnapshot({
  tabId: task.tabId,
  selector: task.selector,
  maxNodes: 800,
  signal,
});
const link = snapshot.nodes.find((node) => node.role === "link" && node.href);
if (!link) throw new Error("LINK_NOT_FOUND");

await moneyhand.actSemanticRef({
  taskSpaceId: task.taskSpaceId,
  snapshotId: snapshot.id,
  ref: link.ref,
  action: "click",
  effect: "input",
  verification: { kind: "url-changed" },
  signal,
});
```

When a link has `href`, prefer `navigateSemanticRef()` to an occludable click:

```js
await moneyhand.navigateSemanticRef({
  taskSpaceId: task.taskSpaceId,
  snapshotId: snapshot.id,
  ref: link.ref,
  waitUntil: "domcontentloaded",
  timeoutMs: 30_000,
  signal,
});
```

For a bounded read-only DOM query, `taskRequest.request.method` is `cdp.send`; the CDP method is nested
inside its `params`. Never put `Runtime.evaluate` directly in `request.method`:

```js
const terminal = await moneyhand.taskRequest({
  taskSpaceId: task.taskSpaceId,
  effect: "read-only",
  signal,
  request: {
    method: "cdp.send",
    params: {
      target: { tabId: task.tabId },
      method: "Runtime.evaluate",
      params: {
        expression: `(() => [...document.querySelectorAll("[data-example-record]")]
          .slice(0, 20).map((element) => element.innerText).filter(Boolean))()`,
        returnByValue: true,
      },
    },
  },
});
if (!terminal.ok) throw new Error(terminal.error?.code ?? "DOM_READ_FAILED");
const records = terminal.result?.result?.result?.value;
if (!Array.isArray(records)) throw new Error("DOM_READ_RESULT_INVALID");
```

Keep page expressions local, bounded, read-only, and independent of page-provided executable text.
Human mode does not make `Runtime.evaluate` human-like. Use `scrollTaskTab()` for input-path scrolling.

For screenshots, use a new absolute `.png` path whose parent directory already exists. The high-level
helpers infer `outputRoot` from that parent; if supplied explicitly, `outputRoot` must be an existing
task directory that contains `outputPath`:

```js
const viewport = await moneyhand.captureStableViewport({
  taskSpaceId: task.taskSpaceId,
  outputPath: args.viewportOutputPath,
  signal,
});
if (viewport.stable !== true) throw new Error("VIEWPORT_CAPTURE_NOT_STABLE");

const fullPage = await moneyhand.captureFullPage({
  taskSpaceId: task.taskSpaceId,
  outputPath: args.fullPageOutputPath,
  signal,
});
if (fullPage.observationOnly !== true || fullPage.coordinateMapping !== false) {
  throw new Error("FULL_PAGE_CAPTURE_CONTRACT_INVALID");
}
```

Full-page images are observation-only and never provide click coordinates.

## Progress, visual fallback, and completion

Report meaningful progress at each batch or checkpoint:

```js
await progress({
  phase: "collect",
  current: completedItems,
  total: selectedItems.length,
  checkpoint: lastCanonicalId,
  message: "Collected and checkpointed one bounded batch",
});
```

MoneyHand hard-codes `moneyhand.task_progress` before module import, at least every 10 seconds, plus a
current-viewport inspection after 15 seconds without activity; callers may tighten but cannot relax
either threshold. If task code blocks the controller event loop, the attached CLI emits
`moneyhand.task_monitor`; after recovery MoneyHand captures the page before cleanup. `completeTaskContext` atomically pauses and drains the visual watchdog before removing the window. When
`visualFallback.captured:true`, open exactly `visualFallback.screenshot.path`; never replay the action. When `waitingForInstruction:true`, call only:

```js
await moneyhand.resolveTaskBlocker({
  taskSpaceId: task.taskSpaceId,
  action: "resume", // or "cancel"
});
```

Both events are machine-readable wake signals on attached stdout. MoneyHand aborts rather than hide a
delivery failure. It cannot independently create a new turn inside an arbitrary Agent host;
continuous delivery still depends on the attached-command rule above.

Use these terminal labels:

- `complete`: every requested item/field is proven and cleanup succeeded;
- `incomplete`: scope, evidence, page stability, or cleanup is missing;
- `outcome_unknown`: an action may have dispatched but its final state is unknown.

Counts of loops, visits, or screenshots are not completion proof. Deduplicate by canonical identifier
or URL before claiming a requested count.

Read another reference only when the task actually reaches that branch:

- `task-recovery.md`: timeout, page-health/controller failure, unknown outcome, cleanup failure, or a
  visual blocker;
- `browser-workflows.md`: advanced semantic controls, downloads/uploads, coordinate input, data-plane
  selection, or rate control;
- `behavior-modes.md`: requested human-style input;
- `integration-lifecycle.md`: persistent adapters and controller integration.
