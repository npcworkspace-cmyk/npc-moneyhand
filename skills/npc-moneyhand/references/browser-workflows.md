# Browser workflows

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

## Acquisition order and rate control

When the user leaves the method open, choose the lowest total elapsed-time eligible plane:

1. Existing structured data already available in the session/task.
2. CDP network response JSON or a known read-only same-session replay.
3. CDP Runtime/DOM batch extraction.
4. Browser UI for lazy loading, pagination or state only exposed through interaction.
5. Explicit screenshot after structured/text routes are insufficient.

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
{"id":"nav-1","op":"navigateTaskTab","args":{"taskSpaceId":"research","tabId":42,"url":"https://example.test/orders","effect":"navigation","waitUntil":"load","expectedUrl":"https://example.test/orders","urlMatch":"origin+path"}}
```

It pins the Task Space Profile/tab before input, dispatches one `Page.navigate`, and waits with fixed
`Page.getFrameTree + document.readyState` reads. `commit` proves only a valid navigation result;
`domcontentloaded`/`load` prove document readiness, not business success or data completeness.

Use `waitForTaskPage()` with `effect:"read-only"` for a transition already in progress. URL matching is
declarative (`exact`, `prefix`, `includes`, `origin`, `origin+path`), not caller JavaScript. A navigation
timeout/abort/read failure after dispatch is outcome unknown; inspect the page before deciding.

## Semantic snapshots and locators

`captureSemanticSnapshot()` uses a bounded Accessibility tree by default and produces short-lived
snapshot-local `@ref` values plus stable role/name locators. Request DOMSnapshot bounds/CSS only when
needed. Include frames explicitly for OOPIF or nested frame work; respect discovery limits and frame
guards.

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

- Click/type/key re-resolve the backend node, viewport, frame guard, hit target, occlusion and enabled
  state immediately before input.
- Scroll anchors one fresh ref and requires at least one explicit nonzero bounded delta.
- Drag uses source `ref` and destination `toRef` from the same snapshot; both must remain visible and
  pass independent frame hit testing before one root drag. Observation of the source afterward is not
  proof the drop succeeded.
- Hover and visual actions use current hit points, not stored document coordinates.
- High-impact approval binds Profile boot, tab, snapshot guard, backend node, action payload and
  verification; drag also binds the destination.

Any stale snapshot/ref, loader/frame drift, occlusion, ambiguity or identity mismatch requires a fresh
observation. A verification failure after dispatch is not proof the action failed.

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
roots, escapes, links outside root, duplicates, directories and size violations; it binds file identity
metadata into approval and rechecks before dispatch. It does not read file contents or return paths.
The target must be the exact current `input[type=file]`; multi-file needs `multiple`.

## Select and binary controls

Select accepts exact value/label/zero-based index descriptors for a native `<select>`. Each descriptor
must resolve uniquely to an enabled option; duplicates, ambiguity, missing options and wrong `multiple`
semantics fail before mutation. The controller dry-runs before high-impact approval consumption, commits with
the same fixed function, then verifies selected index/value/label. Resulting DOM `input/change` events
are not native trusted events.

Use `check`/`uncheck` as desired state, not toggle. Require a readable native checkbox/radio or ARIA
binary state. Already-satisfied state returns zero input; otherwise dispatch one guarded pointer click
and require `target-checked`. Reject radio uncheck, mixed/indeterminate or unreadable states before
approval consumption. A high-impact no-op still consumes its exact authorization.

## Viewport capture and coordinates

MoneyHand input coordinates are top-level CSS viewport coordinates under
`css-viewport-v1`. Do not pass screen, full-page, document or raw screenshot pixels directly.

Use `captureViewportBundle()` only with an existing local task root and a new output path. It binds
Profile boot, tab, loader/frame state, viewport/scroll/DPR/zoom and PNG dimensions, then returns an
explicit image-to-CSS mapping. Treat the PNG as sensitive local task data and do not overwrite files.

Before visual input, verify the bundle is fresh and the same Profile/tab/loader/viewport remains.
Map a bounded image point through the bundle, then use CDP Input. Capture again after navigation,
scroll, resize, zoom, frame movement, Profile switch or unknown outcome. A full-page screenshot does
not have this click contract and remains observation-only.
