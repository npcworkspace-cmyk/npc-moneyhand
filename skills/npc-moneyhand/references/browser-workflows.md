# Browser workflows

For a normal task, read only `task-runtime.md` first. Open this file when the task actually needs one
of the advanced operations listed below. Begin with `beginTaskContext()`; it creates the
dedicated task window on a local `about:blank` fragment marker and returns the pinned context without
loading an external marker site. Do not enumerate debugger targets or guess a page/window identifier.
The operations below are advanced building blocks under that context.

Use this reference when choosing a data plane, navigating, resolving semantic controls, handling
downloads/uploads/select/check actions, or converting screenshots to safe input coordinates.

## Contents

- [Acquisition order and rate control](#acquisition-order-and-rate-control)
- [Page transitions](#page-transitions)
- [Semantic snapshots and locators](#semantic-snapshots-and-locators)
- [Semantic actions](#semantic-actions)
- [Downloads and uploads](#downloads-and-uploads)
- [Select and binary controls](#select-and-binary-controls)
- [Viewport capture and coordinates](#viewport-capture-and-coordinates)
- [Bounded page-health recovery](#bounded-page-health-recovery)

## Acquisition order and rate control

When the user leaves the method open, choose the lowest total elapsed-time eligible plane:

1. Existing structured data already available in the session/task.
2. CDP network response JSON or a known read-only same-session replay.
3. CDP Runtime/DOM batch extraction.
4. Browser UI for lazy loading, pagination or state only exposed through interaction.
5. A deliberate screenshot after structured/text routes are insufficient. Separately, the task
   runtime automatically captures the current viewport on visible-page anomalies or 15 seconds of
   task silence; this is recovery evidence, not a competing data-acquisition plane.

Technical visibility is not authorization. Do not export cookies/tokens, bypass challenges, replay a
write request, or extend collection scope because CDP exposes it.

Run the smallest representative pilot before scaling. Verify required fields, pagination, dedupe,
account state and rate signals. On HTTP 429/503, `Retry-After`, throttle payload, access challenge or
latency regression: checkpoint, lower concurrency before increasing delay, add jitter, and retry only
known reads. Stop on challenge, persistent 403, account-state change or repeated throttle at minimum
concurrency. Recover through consecutive clean small batches and never exceed the last safe rate.

## Page transitions

Prefer `navigateTaskTab()` to raw `Page.navigate + sleep`:

```json
{"id":"nav-1","op":"navigateTaskTab","args":{"taskSpaceId":"research","tabId":42,"url":"https://example.test/orders","effect":"navigation","waitUntil":"domcontentloaded","expectedUrl":"https://example.test/orders","urlMatch":"origin+path"}}
```

It pins the Task Space Profile/tab before input. From the unreadable local `about:blank` ownership
marker, the first transition verifies the exact marker with `tabs.get` and dispatches one
`tabs.update`; later transitions dispatch one `Page.navigate`. Both paths then wait with fixed
`Page.getFrameTree + document.readyState` reads. The default is `domcontentloaded`, which accepts an
interactive DOM without waiting for every image, media or third-party subresource. Request `load`
only when the task actually requires `document.readyState === "complete"`; it may legitimately take
longer or exhaust the bounded wait on dynamic pages. `commit` proves only a valid navigation result;
none of these readiness levels proves business success or data completeness.

Use `waitForTaskPage()` with `effect:"read-only"` for a transition already in progress. URL matching is
declarative (`exact`, `prefix`, `includes`, `origin`, `origin+path`), not caller JavaScript. A transient
unreadable page state is returned directly to MoneyHand's bounded retry loop rather than opening an
Agent-instruction wait, and is retried without replaying navigation. This request-local control-plane
override does not disable text-first Agent waits for genuinely unclear semantic/input actions. If
an error reports `actionDispatched:true` (including `NAVIGATION_OUTCOME_UNKNOWN` or
`NAVIGATION_WAIT_TIMEOUT`), the task runtime attaches current text plus a local viewport PNG. Inspect
that evidence once and never issue the same navigation again without proof that it did not take
effect. Consider a corrected retry only when the error explicitly reports `actionDispatched:false`.

For scrolling, prefer `scrollTaskTab()`. It infers the pinned page and viewport center, then
dispatches through `input.perform`; this is the normal path where human scroll pacing applies. Page
JavaScript such as `window.scrollBy()` is not human input.

## Semantic snapshots and locators

`captureSemanticSnapshot()` uses a bounded Accessibility tree by default and produces short-lived
snapshot-local `@ref` values plus stable role/name locators. Request DOMSnapshot bounds/CSS only when
needed. Link nodes expose a bounded `href` when Accessibility or DOM evidence provides one. Include
frames explicitly for OOPIF or nested frame work; respect discovery limits and frame guards.

Use `waitForSemanticLocator()` with the exact Task Space selector. It pins the first Profile boot,
waits for consecutive stable samples, continues through missing/not-ready states, and fails closed on
ambiguity. Do not reuse locators containing snapshot-only duplicate indexes as durable locators.

For ordinary non-high-impact work, `actSemanticLocator()` fuses stable wait, final fresh snapshot/ref,
live target checks, one action and declarative verification without returning the internal snapshot.
High-impact effects are rejected before the first Hand read; use the explicit wait -> approve ref ->
act ref path.

## Semantic actions

`actSemanticRef()` supports click, download, hover, scroll, drag, upload, select, check, uncheck, type
and key. Always supply Task Space, fresh snapshot/ref, explicit effect and a meaningful verification.

```js
const { snapshot } = await moneyhand.captureSemanticSnapshot({
  tabId: task.tabId,
  selector: task.selector,
  maxNodes: 800,
});
const target = snapshot.nodes.find((node) => node.role === "link" && node.href);
await moneyhand.actSemanticRef({
  taskSpaceId: task.taskSpaceId,
  snapshotId: snapshot.id,
  ref: target.ref,
  action: "click",
  effect: "input",
  verification: { kind: "url-changed" },
});
```

The argument to `snapshotId` is the string `snapshot.id`, not the snapshot object. `action` must be a
top-level string. `effect` and `verification` are top-level siblings, never fields inside `action`.
For link navigation, prefer `navigateSemanticRef()` when `node.href` exists; it resolves relative
URLs against the guarded captured page and avoids pointer occlusion.

- Click/type/key re-resolve the backend node, viewport, frame guard, hit target, occlusion and enabled
  state immediately before input.
- Scroll anchors one fresh ref and requires at least one explicit nonzero bounded delta.
- Drag uses source `ref` and destination `toRef` from the same snapshot; both must remain visible and
  pass independent frame hit testing before one root drag. Observation of the source afterward is not
  proof the drop succeeded.
- Hover and visual actions use current hit points, not stored document coordinates.
- An optional caller-supplied approval token can bind Profile boot, tab, snapshot guard, backend node,
  action payload and verification; it is not required for dispatch.

Any stale snapshot/ref, loader/frame drift, occlusion, ambiguity or identity mismatch requires a fresh
observation. The task runtime automatically captures the current viewport for these failures.
Occlusion errors include `details.hitTag`; inspect the attached image, then avoid force-clicking or
guessing through an overlay. A verification failure after dispatch is not proof the action failed.

## Downloads and uploads

Download requires `action:"download"` and exact effect `download`. The MoneyHand controller records a bounded current
Profile download-ID baseline, performs a final no-scroll target preflight, clicks once, and waits for
one new matching ID to reach `complete`. Optional exact match fields are basename, URL, final URL and
MIME. Multiple new IDs are ambiguous.

The receipt omits absolute paths, strips URL query/fragment and reports
`fileExistenceVerified:false`. Timeout, interruption, ambiguity or observation error occurs after the
click; inspect Chrome download history before any retry.

Upload requires `action:"upload"`, exact effect `upload`, an existing absolute task-private
`fileRoot`, and 1–16 absolute regular files inside its realpath. The controller rejects network/device/volume
roots, escapes, links outside root, duplicates, directories and size violations; it captures file
identity metadata and rechecks before dispatch. It does not read file contents or return paths.
The target must be the exact current `input[type=file]`; multi-file needs `multiple`.

## Select and binary controls

Select accepts exact value/label/zero-based index descriptors for a native `<select>`. Each descriptor
must resolve uniquely to an enabled option; duplicates, ambiguity, missing options and wrong `multiple`
semantics fail before mutation. The controller dry-runs before dispatch, commits with
the same fixed function, then verifies selected index/value/label. Resulting DOM `input/change` events
are not native trusted events.

Use `check`/`uncheck` as desired state, not toggle. Require a readable native checkbox/radio or ARIA
binary state. Already-satisfied state returns zero input; otherwise dispatch one guarded pointer click
and require `target-checked`. Reject radio uncheck, mixed/indeterminate or unreadable states before
dispatch. If the caller supplied an optional token, a no-op still consumes that exact token.

## Viewport capture and coordinates

MoneyHand input coordinates are top-level CSS viewport coordinates under
`css-viewport-v1`. Do not pass screen, full-page, document or raw screenshot pixels directly.

Use `captureStableViewport()` for normal task screenshots. It wraps
`captureViewportBundle()` and retries only `STALE_VIEWPORT`, before any file is written, for at
most three attempts by default. Pass a new absolute `.png` `outputPath`; the high-level helper infers
`outputRoot` from the existing parent directory. If supplied, `outputRoot` must be an existing local
task directory containing `outputPath`. Use the lower-level `captureViewportBundle()` only with both
an explicit existing `outputRoot` and a new `outputPath`. It binds Profile boot, tab, loader/frame state,
viewport/scroll/DPR/zoom and PNG dimensions, then returns an explicit image-to-CSS mapping. Treat the
PNG as sensitive local task data and do not overwrite files.

Stable success returns `{bundle, taskSpaceId, tabId, attempts, stable:true}`. Exhausted stale captures
throw `VIEWPORT_NOT_STABLE`; any failed capture terminal immediately throws
`VIEWPORT_CAPTURE_FAILED` with `actionDispatched:false` and writes no file. Do not infer success from
the helper returning an object with a false stability flag: that shape is not a success result.

Before visual input, verify the bundle is fresh and the same Profile/tab/loader/viewport remains.
Map a bounded image point through the bundle, then use CDP Input. Capture again after navigation,
scroll, resize, zoom, frame movement, Profile switch or unknown outcome. A full-page screenshot does
not have this click contract and remains observation-only. Use `captureFullPage()` only after the
task has expanded the desired content; it requests the whole document, checks page guards before and
after, writes at most one new PNG, and rejects responses above the Extension's 4 MiB decoded limit.
Success explicitly returns `observationOnly:true`, `coordinateMapping:false`, document/image metadata,
and a SHA-256. Exhausted stale guards throw `FULL_PAGE_NOT_STABLE`; other capture-stage failures are
not retried.

## Bounded page-health recovery

`beginTaskContext()` creates and verifies one dedicated task window, so a live WebSocket with an
unreadable tab does not begin a task. If a later operation reports a page-read or navigation-preflight failure, call
`probeTaskContext()` once:

- `healthy:true`: inspect the current page and decide from observed state; do not replay an unknown
  action automatically.
- `healthy:false, stage:"page"`: checkpoint, complete the context, then use the fixed connection flow
  once.
- `healthy:false, stage:"session"`: the pinned Profile boot is gone; do not switch to another Profile
  or account inside the same task.

Platform-specific link filtering, ad/footer classification, expansion-label matching and resumable
business checkpoints belong in the specialized Skill, not in this shared browser layer.
