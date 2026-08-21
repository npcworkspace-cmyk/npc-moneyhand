# MoneyHand task recovery

Read this reference only after the normal path in `task-runtime.md` reaches a timeout, page-health or
controller failure, unknown outcome, cleanup failure, or visual blocker. It explains recovery
decisions; it is not startup reading and does not authorize a second controller, a Profile switch, or
blind action replay.

## Ownership and cleanup

`beginTaskContext()` creates one normal task window with one tab carrying
`about:blank#npc-moneyhand-task=<uuid>`. MoneyHand proves that exact window, tab, and marker before
binding the Task Space. The first navigation verifies the marker with Chrome tab metadata, transitions
that tab, and then resumes CDP page-health probes.

If Chrome acknowledges window creation but verification fails, compensation removes it only while it
is still the same normal, single-tab marker window. A changed window raises
`TASK_WINDOW_OWNERSHIP_CHANGED` and is preserved. An unknown creation outcome without an acknowledged
window ID is never removed. Final cleanup applies the same proof.

When MoneyHand had to launch Chromium, it may also own one unchanged
`about:blank#npc-moneyhand-bootstrap=<uuid>` tab. It removes only that exact unchanged bootstrap tab
after the task; removing the last tab also closes its launch window. Pre-existing and user-modified
tabs/windows are preserved.

If the Extension handshake succeeds before that newly launched marker tab becomes readable, the
controller keeps the unique marker as provisional ownership and starts the requested command. Cleanup
later removes only one exact marker match; no match is already-clean, while multiple matches fail
closed. A transient bootstrap read therefore cannot strand a task or authorize guessed cleanup.

The task wrapper supplies its `AbortSignal` automatically to high-level waiting operations when the
caller omits it. It deliberately does not inject an aborted signal into `completeTaskContext()` or
`cleanupOwnedTaskWindows()`, so `finally` cleanup can finish. Never pass the task's aborted signal into
those cleanup calls. An explicitly not-dispatched `BUSY` during cleanup may be retried only inside the
built-in bounded cleanup window; unknown outcomes are not replayed.

## Visual blocker recovery

The task runtime captures one current-viewport PNG for visible-page timeouts, occlusion, stale or
ambiguous semantic targets, page-health/readiness failures, `needs_instruction`, other visible-page
operation failures, task silence, and terminal timeout/failure/incomplete outcomes. It never replays
the failed action.

Monitoring starts before task-module import. The base heartbeat is emitted at least every 10 seconds.
After 15 seconds without task/browser activity, the watchdog starts a concurrent read-only visual
inspection and can repeat within the task budget, up to 120 captures. These are hard maximums: an
embedding caller may tighten but cannot relax them. If synchronous task code blocks the controller,
the attached CLI emits `moneyhand.task_monitor`; after the event loop recovers, MoneyHand captures the
current task page before cleanup. `completeTaskContext` first pauses and drains in-flight watchdog
observation, so screenshots cannot race task-window removal. Monitoring never extends the task deadline
or switches Profile.

Recovery is fixed:

1. Open the exact local PNG at `visualFallback.screenshot.path`.
2. Read its bounded page text together with the original error.
3. Inspect `visualFallback.trigger.actionDispatched`. When true or unknown, never replay the action.
4. If `waitingForInstruction:true`, use only
   `resolveTaskBlocker({taskSpaceId,action:"resume"|"cancel"})`.

The public result intentionally hides raw `waitId`, `tabId`, and screenshot base64. Keep automatic
PNGs local unless the user authorizes sharing them.

## Timeout and controller state

Every `--task` has a 30-minute budget by default. A trusted long-running specialized Skill may set
`--task-timeout-ms` explicitly, up to 24 hours, and must checkpoint between bounded batches.

On expiry MoneyHand aborts the injected signal, captures the current pinned page when available,
waits for `finally` cleanup, and returns one `TASK_TIMEOUT`. Read all of these fields before deciding
whether to resume:

- `timeoutMs`;
- `actionDispatched:"task-dependent"`;
- `retry:"inspect-checkpoint-before-retry"`;
- `taskAcknowledgedAbort`;
- `cleanupComplete`;
- `controllerReusable`;
- `taskWindowCleanup`.

If the module ignores abort, `taskAcknowledgedAbort:false` and `controllerReusable:false` mean that
controller rejects new work, attempts owned-window cleanup, and exits. Cancellation is cooperative
and never proves that an in-page action did not dispatch.

## Page-health decision

After an unexpected page-read failure, call `probeTaskContext()` once:

- `healthy:true`: inspect the current page and continue from observed state;
- `healthy:false, stage:"page"`: checkpoint, complete the context, then run the fixed connection flow
  once;
- `healthy:false, stage:"session"`: the pinned Profile boot is gone; end the task without switching
  account or Profile.

Do not loop connection attempts or silently restart work under a different browser identity.

## Screenshot terminals

`captureStableViewport()` retries only `STALE_VIEWPORT`. Stable success contains `stable:true`.
Exhaustion throws `VIEWPORT_NOT_STABLE`; another failed capture throws `VIEWPORT_CAPTURE_FAILED` with
`actionDispatched:false` and writes no file.

`captureFullPage()` is observation-only. Success contains `observationOnly:true` and
`coordinateMapping:false`. Exhausted stale guards throw `FULL_PAGE_NOT_STABLE`; other capture stages
are not automatically retried. See `browser-workflows.md` for coordinate and file-root details.

## Retry and outcome decisions

| Evidence | Decision |
| --- | --- |
| Validation/effect failure before input | Correct the request; a new dispatch may be safe |
| Explicit `actionDispatched:false` | A corrected retry may be safe |
| Stale ref, occlusion, ambiguity | Use the attached current evidence and acquire a fresh target |
| `OUTCOME_UNKNOWN`, dispatch true, post-dispatch timeout or disconnect | Inspect real state; never replay blindly |
| Postcondition failed after dispatch | Treat as possibly successful until inspected |
| Cleanup incomplete | Return `incomplete`, preserve evidence, and do not close another window |

MoneyHand uses request-local `onUnclear:"error"` for ownership checks, navigation dispatch, and
readiness probes so a transient CDP read failure does not silently turn the task into an Agent wait.
It retries transient reads only inside the same bounded navigation budget. Any navigation error with
`actionDispatched:true`, including `NAVIGATION_OUTCOME_UNKNOWN` and `NAVIGATION_WAIT_TIMEOUT`, requires
one inspection of the current URL and page before any new decision.

Completion remains evidence-based: required child records and fields must be present for every claimed
item. An empty array proves zero only when the page/source proves zero. Normalize canonical IDs or URLs
before appending; two visits to the same canonical URL are one item, never two completed items.
