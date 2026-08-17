# Adaptive rate control

Use `rateControl` for a bounded pilot, throttle observation, cooldown, checkpointing, and gradual
recovery. State is task-owned Agent memory keyed by exact `origin + profile + optional account`; the
extension receives only the resulting browser requests and behavior choices.

For a standalone deterministic scheduler, import `createRateController(options)` from
`scripts/moneyhand.mjs` and call its `plan`, `observe`, `checkpoint`, `wait`, `snapshot`, and `reset`
methods directly. The unified controller exposes the same scheduler through
`moneyhand.rateControl({ action, input })` and the JSONL `rateControl` operation.

This is an explicit caller scheduler, not an implicit interceptor. A plain `moneyhand.request()` has
no trustworthy origin/Profile/account rate scope and is not automatically blocked by an open rate
circuit. The calling Agent or composed Skill must consult the decision before each governed batch,
honor concurrency/interval/wait/stop, and then report bounded observations. The capability advertises
`enforcement:"explicit-caller-scheduler"` and `implicitRequestGate:false` so adapters cannot mistake
the scheduler for a transport-level gate.

## Actions

Call one operation with `action` and an action-specific `input`:

| Action | Purpose |
| --- | --- |
| `plan` | Create/read a scope and return allowed, concurrency, interval, wait, phase, and stop state |
| `observe` | Record HTTP, header, throttle, challenge, account, latency, clean-batch, and checkpoint evidence |
| `checkpoint` | Save an opaque resumable token before cooldown or stop |
| `wait` | Honor the current cooldown and return a fresh plan; reject an open circuit |
| `snapshot` | Return one scope or all task-owned rate states |
| `reset` | Delete one exact scope after the calling workflow has decided that reset is safe |

A scope uses an HTTP(S) origin only, not a full URL:

```json
{"origin":"https://www.reddit.com","profile":"work","account":"optional-local-label"}
```

## Pilot and observe

Ask for a plan before the first bounded batch:

```json
{"id":"rate-plan-1","op":"rateControl","args":{"action":"plan","input":{"scope":{"origin":"https://www.reddit.com","profile":"work"},"mode":"raw"}}}
```

After every representative response or batch, report only bounded control evidence:

```json
{"id":"rate-observe-1","op":"rateControl","args":{"action":"observe","input":{"scope":{"origin":"https://www.reddit.com","profile":"work"},"mode":"raw","status":429,"headers":{"retry-after":"30"},"latencyMs":2100,"checkpoint":"page:7"}}}
```

Use the returned `decision.concurrency`, `intervalMs`, `waitMs`, `checkpointRequired`, and `stop` as
hard scheduler input. Do not continue merely because the browser still accepts commands.

The controller:

- begins at concurrency 1 and requires clean pilot batches before increasing;
- halves concurrency before increasing delay;
- applies bounded exponential backoff with jitter and honors a longer `Retry-After`;
- opens a circuit on challenge or account change;
- opens a circuit after persistent 403 or repeated throttling at minimum concurrency;
- requires clean batches before relaxing backoff and never recovers above the last safe ceiling.

Within this scheduler, human behavior does not relax a decision. `mode:"human"` produces the same
cooldown and circuit rules as `raw`. This statement does not mean that unrelated plain requests are
intercepted; the caller must route every governed batch through the scheduler lifecycle above.

## Checkpoint, wait, and resume

If `checkpointRequired` is true, save the collection's opaque continuation token:

```json
{"id":"rate-checkpoint-1","op":"rateControl","args":{"action":"checkpoint","input":{"scope":{"origin":"https://www.reddit.com","profile":"work"},"token":"page:7"}}}
```

Checkpoint tokens are caller-defined resumable identifiers only. Do not store cookies, authorization
headers, pairing keys, passwords, page content, or personal data in them.

Use `wait` only for a cooldown. It rejects an open circuit, because challenge, account change,
persistent 403, and repeated minimum-concurrency throttle require Agent or human review rather than a
timer. After cooldown, run a small known read and feed its result through `observe`; do not jump
directly back to prior volume.

`reset` is not a bypass. Use it only for an intentionally new task/account scope or after the calling
workflow has reviewed why the circuit opened. Never use it to retry a challenge or erase account-risk
evidence during the same collection.
