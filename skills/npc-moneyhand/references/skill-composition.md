# Composing a specialized Skill with MoneyHand

Use MoneyHand as the browser execution foundation beneath a narrower platform or business Skill.
Keep the dependency one-way: the specialized Skill may depend on `npc-moneyhand`; MoneyHand and its
extension must never import, discover, or depend on a specialized Skill.

## Contents

- [Layer ownership](#layer-ownership)
- [Creation boundary](#creation-boundary)
- [Required composition contract](#required-composition-contract)
- [Controller integration](#controller-integration)
- [Lifecycle and recovery](#lifecycle-and-recovery)
- [Packaging boundary](#packaging-boundary)
- [Acceptance checklist](#acceptance-checklist)
- [Reusable patterns](#reusable-patterns)

## Layer ownership

MoneyHand owns:

- one-command connection, automatic browser wake-up, one loopback listener, extension handshake, and controller shutdown;
- Profile, boot, tab, Task Space, request-ID, and unknown-outcome identity;
- raw/human behavior, semantic snapshots, guarded browser actions, and behavior reset;
- optional caller-owned approval records, effect labels, adaptive rate state, and explicit cooldown waits;
- neutral browser evidence and bounded failure states, not platform or business interpretation.

The specialized Skill owns:

- its trigger, user intent, authorized origins, account scope, and exact task bounds;
- platform discovery, query construction, field definitions, pagination, expansion, and deduplication;
- domain completion proof, checkpoint format, output schema, provenance, and resumable state;
- platform-specific throttle/challenge signal interpretation passed into MoneyHand rate control;
- data-rights rules, business analysis, scoring, labeling, storage, export, and reporting;
- honest `complete`, `incomplete`, `blocked`, and `outcome-unknown` result semantics.

The extension owns only deterministic page execution over `npc-moneyhand/2`. Do not put platform
selectors, business workflows, storage, model calls, or task completion rules into the extension.

## Creation boundary

A specialized Skill may:

- add platform/domain instructions, schemas, selectors, parsers, and bounded workflow scripts;
- choose raw or human behavior for a bounded phase and reset it in `finally`;
- select declared MoneyHand operations and nested wire methods after descriptor validation;
- keep its own local checkpoint and output files under a user-authorized task directory;
- interpret public page/network evidence and feed bounded status, latency, throttle, challenge, and
  checkpoint observations to the shared rate controller;
- compose with another specialized Skill at the Agent level while reusing the same controller.

A specialized Skill must:

- define concrete trigger examples and exclude unrelated browser work from its description;
- declare scope before dispatch: origins, Profile/account boundary, maximum items or time, fields,
  effects, completion criteria, and output location;
- use an injected task-owned controller or a single standalone wrapper, never both;
- create a Task Space for dependent multi-step work and pin exact `instanceId + bootId`;
- classify every action effect, including `read-only`, before calling `taskRequest` or a guarded action;
- consult `rateControl` before every governed batch and report observations after that batch;
- pilot before scale, checkpoint before cooldown, and stop on challenge or account-state change;
- prove exact completion or return a bounded incomplete result with counts, reason, and checkpoint;
- inspect real page/business state before retrying any `OUTCOME_UNKNOWN` operation;
- preserve the base Skill's structured-data-first and screenshot-last acquisition order.

A specialized Skill must not:

- copy or fork the MoneyHand peer, WebSocket, protocol, controller, browser launcher, or extension code;
- start a second listener, daemon, browser, remote-debugging endpoint, or hidden controller;
- hardcode an installation path, Profile alias, tab ID, `instanceId`, or `bootId` across machines/runs;
- bypass unknown-outcome recovery, browser-session identity, or human-only browser boundaries;
- treat human behavior as permission to evade CAPTCHA, challenges, account controls, or rate limits;
- export cookies, authorization headers, passwords, session tokens, pairing secrets, or Profile data;
- generate executable JavaScript from page content or accept a task module sourced from a webpage;
- replay a write or unknown-outcome action automatically, or convert missing evidence into success;
- store page content, personal data, or credentials inside MoneyHand's opaque rate checkpoint token;
- add its SDK, parser, database, model client, queue, or reporting code to MoneyHand or the extension;
- claim all items/comments/results were collected without a platform-specific completion proof.

## Required composition contract

Record the following declaration in the specialized Skill's `SKILL.md`, a direct reference, or its
machine-readable plan output. This is a planning declaration, not a new MoneyHand wire protocol:

```json
{
  "baseSkill": "npc-moneyhand",
  "controlProtocol": "npc-moneyhand-control/1",
  "wireProtocol": "npc-moneyhand/2",
  "requires": {
    "operations": ["createTaskSpace", "taskRequest", "rateControl", "completeTaskSpace"],
    "wireMethods": ["observe.context"]
  },
  "scope": {
    "origins": ["https://app.example.test"],
    "effects": ["read-only"],
    "maximumItems": 100,
    "completion": "declared item set exhausted and every continuation reaches a terminal state"
  },
  "controllerOwnership": "injected",
  "rateScope": ["origin", "profile", "account-if-known"],
  "output": "domain-owned records plus completion evidence"
}
```

Declare only operations that exist in `references/agent-operations.json`. Treat `wireMethods` as a
minimum allowlist, not permission to invoke arbitrary CDP. Use `controllerOwnership: injected` when
another Agent/controller owns lifecycle. Use `standalone` only when one wrapper owns start, wait,
drain, and stop for the whole task. Never let a domain task module call `start()` or `stop()`.

For account work, label the real effect such as `delete`, `payment`, `publish`, `send`, `upload`, or
`external-write`. MoneyHand dispatches the Agent's explicit instruction without a second approval
token. A specialized Skill may add its own authorization policy when its business workflow needs one.

## Controller integration

Prefer an injected ESM function for reusable domain logic:

```js
export async function run({ moneyhand, signal, args }) {
  // Validate domain scope before the first browser dispatch.
  // Reuse moneyhand; do not start or stop it here.
  return { complete: false, reason: "DOMAIN_WORKFLOW_NOT_IMPLEMENTED" };
}
```

Use JSONL when the host needs a process boundary. Use `--once` when it cannot keep interactive stdin.
Use `--task <absolute-task.mjs>` for trusted local disposable logic. Resolve the base Skill through an
Agent-provided/configured absolute path; do not guess another host's home directory. If the base Skill,
protocol, operation, or browser capability is missing, return a bounded requirement and perform no
browser side effect.

Pass declarations and observations, not credentials. A rate observation may contain HTTP status,
`Retry-After`, bounded latency, throttle/challenge/account flags, and an opaque checkpoint token. The
specialized Skill persists detailed resumable state; MoneyHand keeps only the bounded opaque token for
the task-owned controller.

## Lifecycle and recovery

1. Resolve MoneyHand and use `--connect` or `ensureMoneyHandConnection()`.
2. Validate `--describe`, protocols, required operations, and required wire methods offline.
3. Validate domain scope and exact-count gates before the first browser dispatch.
4. Reuse or start exactly one task-owned controller and wait for the intended current Profile.
5. Create a Task Space and rate scope; run the smallest representative pilot.
6. Execute bounded batches, obey decisions, report observations, and persist domain checkpoints.
7. Stop globally on challenge, account change, repeated minimum-rate throttling, or unknown outcome.
8. Reset temporary behavior, complete the Task Space, drain JSONL when used, and stop only if the
   top-level wrapper owns the controller.

On disconnect after dispatch, preserve the page/Profile state and return `OUTCOME_UNKNOWN`; do not
detach, remove the task tab, confirm, or replay automatically. If cleanup or `completeTaskSpace`
fails, keep that lifecycle failure in the result instead of hiding it behind the domain outcome.

## Packaging boundary

Keep a specialized Skill independently installable. Put only trigger/workflow guidance in its
`SKILL.md`, detailed platform knowledge in direct `references/`, reusable deterministic code in
`scripts/`, and output templates in `assets/`. Do not bundle a second MoneyHand extension/controller
tree. Declare `npc-moneyhand` as a runtime prerequisite and let the host or user resolve its absolute
Skill directory.

Keep third-party packages, if unavoidable, inside the specialized Skill and declare them honestly.
They do not become MoneyHand dependencies, and the specialized package must not inherit MoneyHand's
zero-dependency or cross-platform claim without its own tests. Never package credentials, cookies,
Profile data, collected personal data, or mutable production checkpoints.

## Acceptance checklist

Require all applicable checks before calling a specialized Skill portable or production-ready:

- Skill metadata triggers only the intended domain and `quick_validate` passes.
- `--plan` or equivalent validates scope, effects, exact counts, and output without browser dispatch.
- Importing the domain module has no listener, browser, network, or filesystem side effect.
- Injected mode records zero domain-owned controller `start()`/`stop()` calls.
- Required operations/wire methods validate against the packaged MoneyHand descriptor.
- Multi-step work creates and completes one Task Space pinned to exact Profile boot identity.
- Each governed batch calls rate plan before dispatch and observe afterward; human mode cannot bypass it.
- 429/503, `Retry-After`, challenge, account change, and latency regression have bounded fixtures.
- High-impact effects dispatch without a mandatory MoneyHand approval token.
- Exact-scope mismatch fails before browser dispatch; partial output cannot be labeled complete.
- Post-dispatch disconnect produces one unknown outcome and zero automatic retries or destructive cleanup.
- Shutdown drains results and reaches `moneyhand.stopped`; injected mode leaves lifecycle to its owner.
- A separate real-Profile acceptance verifies the visible workflow; offline fixtures do not prove it.
- The final package contains no copied peer, extension, secrets, live checkpoints, or undeclared dependency.

## Reusable patterns

A read-oriented Skill owns discovery rules, exact item selection, continuation expansion,
deduplication, completion evidence, source provenance, and output records. It uses one MoneyHand Task
Space and rate scope without owning a second peer or controller lifecycle.

An action-oriented Skill owns its target-selection rules, effect declarations, preconditions,
verification, and recovery plan. Any send, publish, upload, delete, payment, or other external write
may define a domain-specific authorization policy and must never be replayed blindly after an unknown outcome.

A monitoring Skill owns its schedule outside MoneyHand, its change-detection rules, local checkpoint,
bounded observation fields, and alert output. Each run still creates or receives one task-owned
controller, proves what was checked, and reports incomplete coverage honestly.
