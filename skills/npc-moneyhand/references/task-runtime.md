# MoneyHand task runtime

Read this one normal path after `--connect` returns `connected`. Do not enumerate debugger targets,
guess browser IDs, start another controller, or rewrite lifecycle code from memory.

## Fixed authoring route

1. For a custom task, copy `assets/disposable-task.mjs` and replace only `executeTask()`; there is no sentinel or flag, and a normalized source-identical template is rejected when it is a blank asset.
2. For generic multi-page records, copy the runnable `references/bounded-file-task.example.mjs`; it may remain source-identical when its selectors fit.
3. Write task arguments to one absolute UTF-8 JSON file and use `--args-file`; never inline non-empty JSON in a shell command.
4. Use the injected `task.taskSpaceId` and `task.tabId`; later browser focus never retargets the task.
5. Default to `behavior:"raw"`; pass `args.behavior:"human"` only for genuinely human-style input.
6. Call `progress({phase,message,current,total,checkpoint})` after every bounded batch or checkpoint.
7. Return exactly `{outcome,output?}` from `executeTask()`. Map every explicit user acceptance
   condition to its own machine-checkable requirement; never merge record count, page count, order,
   required IDs, or required field values into one generic check. Omit unknown expectations; never guess them.
   Wrapper cleanup failure downgrades completion.

The runnable reference is one-page-to-many-records. `acceptance` is an allowlist of explicit facts,
not a checklist to fill. Never infer `pageIds` from a page key, URL, title, or this example:

```json
{"pages":[{"id":"alpha","url":"https://example.test/alpha"}],
 "outputPath":"ABSOLUTE_OUTPUT.jsonl","manifestPath":"ABSOLUTE_MANIFEST.json",
 "checkpointPath":"ABSOLUTE_CHECKPOINT.json","behavior":"raw",
 "acceptance":{"recordCount":2,"recordsByPage":{"alpha":2},
 "requiredFields":["id","pageKey","text","url"]}}
```

If the user explicitly says gamma's page ID must equal `literal-${POST_ID}`, add only
`"pageIds":{"gamma":"literal-${POST_ID}"}`. Otherwise omit `pageIds`. Unknown acceptance keys fail closed.
Each supplied count, page ID, and field becomes its own completion-gate requirement. Adapt the extractor only when the generic `[data-record], .record-card` selector or fields
do not fit. Collect every bounded match; never invent a per-page cardinality. Keep page order with
`recordGroupOrderRequirement(records, expectedPageKeys)`; never expand IDs using assumed per-page counts.

Run from the Skill root with an absolute task path:

```text
node scripts/moneyhand.mjs --task "ABSOLUTE_PATH_TO_TASK_MODULE.mjs" --args-file "ABSOLUTE_PATH_TO_TASK_ARGS.json"
```

This is a foreground stdout stream. Keep consuming it through the terminal `id:"task"` result. Never
detach, background, or fire-and-forget it. If the host returns a process/session handle, resume that
exact handle at least every 30 seconds; relay checkpoints, visuals, and errors immediately and give
the user a still-running update at least every 30 seconds during heartbeat-only periods.

Retain `taskExecutionId` from `moneyhand.task_submitted`. Client loss does not cancel the resident
task. Recover the same execution—never submit a duplicate:

```text
node scripts/moneyhand.mjs --task-status "TASK_EXECUTION_ID"
node scripts/moneyhand.mjs --task-follow "TASK_EXECUTION_ID"
```

Use `--task-last` once only if the ID was lost. These commands read the private journal and do not
open a browser. `state:"interrupted"` is not success.

## Output contract

- `progress()` produces streamed progress events; it does not return business records.
- `executeTask()` returns once. The complete wrapper result is preserved at terminal
  `id:"task".value`; `taskSummary`, `taskEvidence`, and `completionGate` are additive, not replacements.
- Small scalar results may be returned directly in `output`. Any list, comments, posts, downloads, or
  other bulk data must be written under a user-authorized task directory and returned as a manifest.
- Evidence proves completion. It contains bounded paths, counts, canonical IDs, hashes, or verified
  screenshots; it must not be used as the bulk-data payload. When `output` declares `path` and `count`,
  completion requires matching `output-file` evidence with the same path, format, and count.

Read `taskSummary` first on terminal/status/follow surfaces and execute only its `nextAction`, but then
read `value.output` when the user requested task data or an artifact. Do not mistake a completed
summary for delivery of the requested records.

## Stable effects and bounded work

Every replay-sensitive navigation, input, upload, download, publish, send, or write needs a stable
`effectId` scoped to this task execution. IDs accept only 1-128 characters from
`[A-Za-z0-9._:-]`. Never use a raw URL or a retry number. The template provides the deterministic,
URL-safe helper:

```js
effectId: stableEffectId("navigate", canonicalIdOrUrl)
```

Navigation helpers inject `effect:"navigation"`; `scrollTaskTab()` injects `effect:"input"`. Supply
the stable ID but never add or override those fixed effects.

| Work | Default | Hard rule |
|---|---:|---|
| `evaluateTaskTab()` request | 30 seconds | pass `timeoutMs` only for one bounded read; split long work |
| navigation/page wait | 30 seconds | maximum 300 seconds |
| page observations | 100 ms polls | `ceil(timeoutMs / pollIntervalMs) + 1 <= 512` |
| controller progress | 10 seconds | automatic heartbeat cannot replace business checkpoints |
| activity silence | 15 seconds | automatic current-viewport screenshot |

For a long page wait, raise `pollIntervalMs`; do not create thousands of observations. Pagination,
comment expansion, scrolling, or parsing must run as small batches with progress and a durable
checkpoint after each batch. Do not hide a whole crawl inside one Promise or page expression.

## Copyable operation shapes

Navigate dynamic pages with `domcontentloaded`:

```js
await moneyhand.navigateTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId,
  url, effectId: stableEffectId("navigate", url),
  waitUntil: "domcontentloaded", timeoutMs: 30_000,
  signal,
});
```

For a bounded current-document read, `evaluateTaskTab()` always selects the current default context,
awaits Promises by default, and returns values by copy. It never accepts a cached `contextId`,
`executionContextId`, or `objectId`. Do not hand-build an `expression` template string. The task
template's `pageExpression(pageFunction,input)` helper serializes host input and preserves literal
page-side text such as `${POST_ID}` without accidental module interpolation:

```js
const evaluated = await moneyhand.evaluateTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId,
  expression: pageExpression(({ itemId, limit }) => ({
    itemId,
    records: [...document.querySelectorAll("[data-record]")]
      .slice(0, limit).map((element) => element.innerText).filter(Boolean),
    literalExample: "literal-${POST_ID}",
  }), { itemId: args.itemId, limit: args.limit }),
  timeoutMs: 15_000,
  signal,
});
const value = evaluated.value;
if (!value || !Array.isArray(value.records)) throw new Error("DOM_READ_RESULT_INVALID");
```

`pageExpression()` rejects non-JSON input before browser dispatch. `undefined` returns
`isUndefined:true`; page exceptions use `TASK_EVALUATION_EXCEPTION`. Build a fresh expression after
every navigation and never carry a CDP context/object between documents. Raw CDP
remains an advanced escape hatch in `browser-workflows.md`; JavaScript is not human input.

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
  action: "click", effect: "input", effectId: stableEffectId("click", link.href),
  verification: { kind: "url-changed" }, signal,
});
```

In task modules, omit snapshot `selector`: it selects a browser session, never CSS. When a link has
`href`, prefer `navigateSemanticRef()` over an occludable click. Type uses `text`; select uses
`options`; both accept singular `value` aliases.

Use input-path scrolling:

```js
await moneyhand.scrollTaskTab({
  taskSpaceId: task.taskSpaceId, tabId: task.tabId,
  deltaY: 700, effectId: stableEffectId("scroll", canonicalPageId), signal,
});
```

Screenshot paths must be new absolute `.png` paths under an existing task directory. Both helpers
return the exact written top-level `path`:

```js
const viewport = await moneyhand.captureStableViewport({
  taskSpaceId: task.taskSpaceId, outputPath: args.viewportOutputPath, signal });
const fullPage = await moneyhand.captureFullPage({
  taskSpaceId: task.taskSpaceId, outputPath: args.fullPageOutputPath, signal });
```

A path/byte count proves transport only. Open every image used as evidence and verify a task-specific
visible sentinel; blank or wrong-page images fail. Full-page images are observation-only and never
provide click coordinates.

## Completion and recovery

Use `complete`, `incomplete`, or `outcome_unknown`. Deduplicate by canonical identifier or URL before
claiming a count. `completionGate` rejects completion while cleanup, effects, rate state, instruction
state, or declared requirements remain unresolved. A missing requirement cannot be inferred later:
before returning, compare the requirement IDs with every explicit acceptance condition in the user's request.
Private controller evidence never replaces domain output.

MoneyHand emits `moneyhand.task_progress` before import and at least every 10 seconds. After 15 seconds
without activity it captures the viewport. `moneyhand.task_monitor` covers attached-client transport
silence. Relay wake fields still require the Agent host to consume the foreground stream; the
controller cannot independently create a new turn inside an arbitrary Agent host.

When `visualFallback.captured:true`, open exactly `visualFallback.screenshot.path`; do not take a
second image and never replay the failed action. When `waitingForInstruction:true`, call only:

```js
await moneyhand.resolveTaskBlocker({ taskSpaceId: task.taskSpaceId, action: "resume" }); // or cancel
```

Read another reference only when the task reaches that branch:

- `task-recovery.md`: timeout, page/controller failure, unknown outcome, cleanup failure, or blocker;
- `browser-workflows.md`: advanced actions, transfers, coordinates, or data-plane selection;
- `behavior-modes.md`: requested human-style input;
- `rate-control.md`: specialized rate evidence and checkpoints;
- `integration-lifecycle.md`: persistent adapters and controller integration.
