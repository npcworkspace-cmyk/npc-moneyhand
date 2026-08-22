# MoneyHand integration and lifecycle

Use this reference to understand the bundled controller, connect multiple Chromium Profiles, handle
failures, and close task-owned browser windows.

## Entry modes

| Host | Mode |
| --- | --- |
| Any local command runner | `--connect` or `--call`; no stdin required, browser auto-opens |
| Persistent JavaScript runtime | Import `scripts/moneyhand.mjs`; keep one instance for the task |
| Bidirectional subprocess | Persistent UTF-8 JSONL |
| Legacy one-line stdin transaction | `--once` |
| Many local steps with few Agent round trips | Trusted `--task <absolute-module>` |
| Replacement Agent after task-client loss | `--task-status` / `--task-follow <taskExecutionId>` |

`--connect`, `--call`, and `--task` automatically start or reuse the same Skill-bundled localhost
controller. It is not separately installed daemon software: it is another invocation of
`scripts/moneyhand.mjs`, listens only on `127.0.0.1:19845`, serializes commands, and exits after 15
idle minutes. Do not run `--ensure` in the normal Agent flow. The Extension continues to connect to
`127.0.0.1:19846`.

A normal `--connect` then runs one mandatory 16-item acceptance in an owned window against an
ephemeral `127.0.0.1` fixture. It streams checklist progress, removes its test download and history
entry, closes the window, resets behavior to `raw`, and returns `ready_for_tasks` only after every
check succeeds. It also navigates across fresh documents and evaluates each current page without a
cached execution-context identifier. This is the sole startup browser test; an Agent never adds or
skips one.

Controller reuse uses `npc-moneyhand-controller/2`, not a successful TCP connection alone. Status
contains `status`, `host`, `port`, `pid`, `active`, `protocol`, `product`, `version`, `build`,
`sourceId`, and `instanceNonce`, plus `reused` when applicable. `build` and `sourceId` are lowercase
SHA-256 values; the process nonce changes on every start. Each request carries that exact descriptor
and a 32-byte random private token, and each response is checked against it. The token never appears
in status or CLI output.

Private controller state is stored under the system temporary directory at
`npc-moneyhand-controller-<user-scope>/controller-<port>.json`, without a plaintext source path or user
name. On Unix the scope is the uid; on Windows it is a 16-character SHA-256 prefix of the username.
The directory is forced to `0700`, the file is `0600`, and publication is atomic. `build` covers the
Skill `package.json` and the deterministic `scripts/**/*.mjs` runtime tree, so identical Skill bytes
installed under different Agent-specific paths reuse the same resident controller; `sourceId` records
the path that actually launched it but is not a compatibility partition. A live different build fails
closed. A valid same-product state left by an exited build is replaced only after the port refuses two
connections and the state bytes still match the original owner. Invalid or foreign state is preserved
rather than overwritten. An unknown process on the port yields
`CONTROLLER_PORT_OCCUPIED`; public stop returns `stopped:false` and never kills that occupant.

Task execution state is separate from controller credentials. Each `--task` has a UUID-v4
`taskExecutionId`; after registration, bounded events and the original terminal are written to a
user-private, runtime-build directory under the OS temporary root before client delivery. The journal
stores task/args digests rather than raw paths or arguments, and its private evidence artifact is size
bounded. A command-client TCP reset does not abort a task; a replacement Agent reads status or follows
that exact execution. Non-task controller calls retain abort-on-client-close behavior.

## Offline and live discovery

Run `node scripts/moneyhand.mjs --describe`. Require exactly one descriptor line and no listener,
stdin consumption, Chrome wait, or file write. Compare its ordered operation catalog with
`moneyhand.listening.capabilities.operations.jsonl` after startup.

The descriptor's safe probe is `routeSurface({surface:"web-page"})`; it requires no extension session.
Runtime limits and connection state come from the live startup event. The packaged contract is not
proof of current Chrome connectivity.

## Persistent ESM

For a custom in-process adapter, create one instance on the fixed
`ws://127.0.0.1:19846/extension` endpoint. Start once, wait for a compatible session,
perform all related work, and stop in `finally`. A default request selects the latest focused active
session. Replace a cached low-level session whenever the same `instanceId` reports a new session.

Use a selector or Task Space for dependent work. A Task Space pins exact `instanceId + bootId` and
optional tabs. Extension reload or browser restart invalidates the old boot.

After `start()`, call `ensureMoneyHandConnection({ moneyhand })` to reuse a live session or
automatically open the installed browser Profile before waiting. This helper never closes an existing
browser. Plain `wait()` remains available for callers that own browser launch themselves.

## JSONL

Write strict UTF-8, one object per line:

```json
{"id":"status-1","op":"status","args":{}}
```

- Keep `id` unique for the process lifecycle and between 1 and 128 supported characters.
- Put product arguments only in `args`. Legacy top-level arguments remain code-compatible; do not mix.
- Match out-of-order results by `id`.
- Keep at most 256 active commands and each line at most 1 MiB.
- Continue draining stdout. Bounded output backpressure stops the task rather than blocking forever.

Control operations:

```json
{"id":"cancel-1","op":"cancel","args":{"targetId":"cmd-17"}}
{"id":"barrier-1","op":"drain","args":{}}
{"id":"stop-1","op":"shutdown","args":{}}
```

`cancel` signals one local command; its own result does not define the target outcome. `drain` waits
for commands accepted before the barrier. `shutdown` cancels active work and is not a drain.

Supported environment options:

```text
NPC_MONEYHAND_PAIRING_TOKEN
NPC_MONEYHAND_CONNECT_TIMEOUT_MS
NPC_MONEYHAND_REQUEST_TIMEOUT_MS
NPC_MONEYHAND_HEARTBEAT_MS
NPC_MONEYHAND_HANDSHAKE_TIMEOUT_MS
NPC_MONEYHAND_MAX_INFLIGHT
NPC_MONEYHAND_ONCE_TIMEOUT_MS
NPC_MONEYHAND_OUTPUT_DRAIN_TIMEOUT_MS
NPC_MONEYHAND_TASK_TIMEOUT_MS
```

Never put the pairing token in argv or logs. The bounded Windows stdout helper inherits no pairing
token and exits with the calling console. It is separate from the bundled localhost controller.

## Direct calls, one-shot stdin, and task modules

Prefer the fixed no-stdin call path for one operation:

```text
node scripts/moneyhand.mjs --connect
node scripts/moneyhand.mjs --call <extension-method> --params-json <json>
```

Both modes auto-open the installed browser Profile when no live extension connects during the short
grace period.

Use `--once` only for an existing adapter that already writes one JSONL command to stdin. New command
runners should use `--call` instead.

For multi-step local work, copy `assets/disposable-task.mjs` outside the Skill, replace only its
bounded task-work placeholder, and run:

```text
node scripts/moneyhand.mjs --task <absolute-task.mjs> --args-json <json>
```

Export `run({ moneyhand, signal, args, progress, taskExecutionId })`. Call `progress()` at every bounded batch or
checkpoint. The bundled controller also streams an automatic 10-second heartbeat and starts a
current-viewport visual fallback after 15 seconds without task activity, so a forgotten task callback
cannot leave the console silent. The controller owns start, wait, browser wake-up, reuse, and idle
shutdown; the module owns only task logic. Its
`beginTaskContext` / `completeTaskContext` lifecycle creates one dedicated window in the selected
Profile, resets temporary behavior, closes that exact owned window in `finally`, and reports cleanup
separately. `runMoneyHandTask()` performs a final orphan-window sweep even if the module forgot.
The task and browser-bootstrap ownership markers are local `about:blank` fragments and never load an
external marker site. The task marker is validated through Chrome window/tab metadata, not CDP
document access; the first navigation uses `tabs.update` on that exact owned tab before normal CDP
readiness polling begins. Treat the module as trusted local code and never build it from page text.

Replay-sensitive high-level calls may include a stable `effectId`. Its first fingerprint owns one
Promise/terminal for this task execution; identical duplicates reuse it, conflicts fail before
dispatch, and an unknown outcome remains unresolved. The wrapper classifies browser failures into a
fixed state machine and performs at most one retry, only for a whitelisted transient that proves
`actionDispatched:false` and passes a same-page probe. It also automatically gates high-level Task
Space operations by navigated origin + pinned Profile. Specialized code uses explicit `rateControl`
for richer account/header/batch evidence.

A claimed complete value must declare requirements and evidence. After task-window cleanup the
terminal envelope adds `taskEvidence`, `completionGate`, and compact `taskSummary`; unresolved effect outcomes, open or
missing-checkpoint rate state, instruction waits, failed cleanup, or unsatisfied requirements produce
`TASK_COMPLETION_GATE_FAILED`.

Read `taskSummary` first on the terminal, `--task-status`, and the initial `--task-follow` status. It
contains only state, phase, numeric progress, last checkpoint/activity age, current rate/visual state,
and one `nextAction`. The follow status exposes the same object both at top level and inside `status`.
Every terminal task error preserves its original code/message/details and adds
`error.details.recovery`, whose stable fields classify the cause, dispatch certainty, retry timing,
instruction/visual state, and one next action.

Task modules have a 30-minute default execution budget. Set `--task-timeout-ms` or
`NPC_MONEYHAND_TASK_TIMEOUT_MS` explicitly for a longer bounded task, up to 24 hours. The wrapper
injects one cooperative `AbortSignal` into browser/task waits and actions when omitted, but never into
the final context/window cleanup. On expiry, the sole `TASK_TIMEOUT` terminal includes
`timeoutMs`, `actionDispatched:"task-dependent"`, `retry:"inspect-checkpoint-before-retry"`,
`taskAcknowledgedAbort`, `cleanupComplete`, `controllerReusable`, and `taskWindowCleanup`. Inspect the
checkpoint and possible page effects before retrying; a successful cancel signal is not proof that no
action dispatched.

## Profile routing and Task Spaces

Multiple extension instances may connect to fixed port `19846`. At task start, default routing uses
the latest focused session only to choose a Profile; `beginTaskContext()` then creates a new task
window in that Profile. Later focus changes cannot retarget the task.

Use distinct Task Spaces for independent Profiles. The bundled controller serializes local CLI task
commands on the fixed endpoint; specialized Skills reuse it instead of opening another listener.
Never reuse a JSONL correlation ID as Task Space identity. Dependent multi-step work always uses the
task-context lifecycle.

## Error and retry decisions

| Evidence | Response |
| --- | --- |
| Validation or effect failure before input | Correct the request and use a new ID |
| Whitelisted transient with explicit `actionDispatched:false` | Wrapper probes the same Task Space and retries once; caller adds no loop |
| Stale ref/Profile boot, occlusion, ambiguity | Inspect and acquire a fresh target; no action replay |
| Other `ABORTED_NOT_STARTED` or explicit `actionDispatched:false` | Correct or inspect; no generic automatic retry |
| `OUTCOME_UNKNOWN`, dispatch true, post-dispatch timeout/abort/disconnect | Inspect real state; do not replay |
| Postcondition failed or inconclusive after dispatch | Treat as possibly successful until inspected |
| Output/protocol failure | Preserve received lines and inspect writes before a new process |

After inspecting exact unknown request IDs for one `instanceId + bootId`, call `confirmUnknown()` only
for those IDs. It reconnects deliberately. Never auto-acknowledge.

## Clean shutdown

Normal `--connect` / `--call` / `--task` callers do not stop the controller. It stays available for
the next command and exits after its idle timeout. Each `--task` still closes its own task window;
this happens before the task result is accepted as complete. If the fixed flow launched Chromium, the
controller also records the unique bootstrap tab and removes it after the task, so the controller
can remain resident without leaving its bootstrap surface behind. Removing the last tab closes the
launch window; other tabs are preserved, and a bootstrap tab whose identity or marker changed is not
removed.

Losing the `--task` client does not invoke shutdown or task abort. Keep the submitted ID and run
`--task-follow` from the same Skill build; it streams journal entries after the current sequence and
returns the one original terminal with `reattached:true`. Never run a second task module as a recovery
mechanism.

`--stop` authenticates the exact controller instance before shutdown. Shutdown first destroys every
accepted local socket, including a client that connected but sent no line, then drains queued/runtime
work and closes the server; a silent half-open client cannot hold shutdown open indefinitely.

ESM uses `stop()` in `finally`. JSONL uses:

1. Send `drain` and wait for its result.
2. Send `shutdown` and close stdin.
3. Read the shutdown result.
4. Read `moneyhand.stopped`.
5. Drain stdout to EOF and verify every expected result ID.

Exit code `0` proves only that bytes reached the OS pipe; it does not prove the Agent consumed them.
