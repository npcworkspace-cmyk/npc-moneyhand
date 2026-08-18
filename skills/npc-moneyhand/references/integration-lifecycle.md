# MoneyHand integration and lifecycle

Use this reference to select an entry mode, connect multiple Chrome Profiles, handle failures, and
close one task-owned MoneyHand controller.

## Entry modes

| Host | Mode |
| --- | --- |
| Any local command runner | `--connect` or `--call`; no stdin required, browser auto-opens |
| Persistent JavaScript runtime | Import `scripts/moneyhand.mjs`; keep one instance for the task |
| Bidirectional subprocess | Persistent UTF-8 JSONL |
| Legacy one-line stdin transaction | `--once` |
| Many local steps with few Agent round trips | Trusted `--task <absolute-module>` |

All modes are task-owned. None installs a daemon or service. Prefer `--connect` for the first live
proof and `--call` for hosts that close stdin.

## Offline and live discovery

Run `node scripts/moneyhand.mjs --describe`. Require exactly one descriptor line and no listener,
stdin consumption, Chrome wait, or file write. Compare its ordered operation catalog with
`moneyhand.listening.capabilities.operations.jsonl` after startup.

The descriptor's safe probe is `routeSurface({surface:"web-page"})`; it requires no extension session.
Runtime limits and connection state come from the live startup event. The packaged contract is not
proof of current Chrome connectivity.

## Persistent ESM

Create one instance on the fixed `ws://127.0.0.1:19846/extension` endpoint. Start once, wait for a compatible session,
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
```

Never put the pairing token in argv or logs. The bounded output helper inherits no pairing token and
exits with the console; it is not a daemon.

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

For multi-step local work, copy `assets/disposable-task.mjs` outside the Skill and run:

```text
node scripts/moneyhand.mjs --task <absolute-task.mjs> --args-json <json>
```

Export `run({ moneyhand, signal, args })`. The CLI owns start, wait, browser wake-up, and stop; the
module owns only task logic. Treat the module as trusted local code and never build it from page text.

## Profile routing and Task Spaces

Multiple extension instances may connect to fixed port `19846`. Default routing prefers a currently focused
session, then persisted focus time, then stable session order. Leaving Chrome does not erase its last
focus state.

Use distinct Task Spaces for independent Profiles. Never share one port across independent Agent
tasks or reuse a JSONL correlation ID as Task Space identity. Task Spaces are optional for simple raw
requests and useful when dependent operations must remain pinned to one Profile boot.

## Error and retry decisions

| Evidence | Response |
| --- | --- |
| Validation or effect failure before input | Correct the request and use a new ID |
| Busy, stale ref/Profile boot, ambiguity | Re-read and rebind; never guess |
| `ABORTED_NOT_STARTED` or explicit `actionDispatched:false` | A corrected retry may be safe |
| `OUTCOME_UNKNOWN`, dispatch true, post-dispatch timeout/abort/disconnect | Inspect real state; do not replay |
| Postcondition failed or inconclusive after dispatch | Treat as possibly successful until inspected |
| Output/protocol failure | Preserve received lines and inspect writes before a new process |

After inspecting exact unknown request IDs for one `instanceId + bootId`, call `confirmUnknown()` only
for those IDs. It reconnects deliberately. Never auto-acknowledge.

## Clean shutdown

ESM uses `stop()` in `finally`. JSONL uses:

1. Send `drain` and wait for its result.
2. Send `shutdown` and close stdin.
3. Read the shutdown result.
4. Read `moneyhand.stopped`.
5. Drain stdout to EOF and verify every expected result ID.

Exit code `0` proves only that bytes reached the OS pipe; it does not prove the Agent consumed them.
