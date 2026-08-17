---
name: npc-moneyhand
description: Detect, start, and control the npc-moneyhand Chromium extension from a local AI agent or CLI that can run Node.js 20+. Use on a new computer to find Chrome, Edge, 360, QQ Browser, or another Chromium Profile and verify the extension before starting its zero-dependency controller; also use for fast CDP acquisition, semantic actions, raw or human behavior, Task Spaces, guarded effects, throttling-aware work, recovery, or as the browser foundation beneath a more specific skill.
license: MIT
---

# NPC MoneyHand

Use this Skill as the Agent-side controller and console for the `npc-moneyhand` Chrome extension.
Resolve every relative path below from the directory containing this `SKILL.md`; the command examples
assume that directory is the current working directory.
Create one controller per Agent task, keep it for all related browser steps, and stop it in `finally`.
Do not install a daemon or open a second listener for the same task.
The portable runtime requires Node.js 20+ and Chromium 125+ on Windows, macOS, or Linux. The user
must load the extension; a Skill cannot silently install it.

## Run the first-use preflight

On the first use on a computer, and again after a browser, Profile, extension, or Skill move, run this
before binding a port:

```text
node scripts/preflight.mjs --json
```

Require exactly one `npc-moneyhand-preflight/1` JSON result. This is a bounded, read-only scan of
known Chromium user-data roots and extension manifests. It must not launch a browser, start the
controller, write a marker, recurse across a disk, or inspect cookies, passwords, history, local
storage, or page data. Treat only a complete-tree SHA-256 match against
`references/extension-integrity.json` as matching this trusted Skill package's declared v1 extension
tree; a matching name or partial file fingerprint is not proof. This is package-relative integrity,
not independent publisher authentication. Treat browser configuration state as separate evidence.
Even an enabled, package-integrity-matched on-disk installation is not online proof; require the later `npc-moneyhand/2`
handshake before claiming browser readiness.

The report contains local absolute Skill, browser, Profile, and extension paths. Keep the raw JSON on
the local computer and redact those paths before sending it to a remote or cloud Agent. The scanner
has no network client and rejects UNC, Windows device namespaces, and POSIX `//` roots, but portable
Node.js cannot distinguish a mapped drive or mounted remote filesystem from a local filesystem.

For a Chromium fork or portable browser in a nonstandard location, repeat an explicit absolute root:

```text
node scripts/preflight.mjs --json --browser-root <absolute-user-data-root>
```

If Node is unsupported, stop and report the exact runtime requirement. Require
`summary.controllerStartEligible === true` before starting the controller. Eligibility requires a
complete scan plus at least one enabled package-integrity match; disabled, unknown, or incomplete
evidence is not eligible. This Skill package intentionally contains no extension source. If
`summary.extensionFound === false`, direct the user to
`https://github.com/npcworkspace-cmyk/npc-moneyhand/releases` and ask them to download the exact
`npc-moneyhand-extension-1.0.0.zip` release asset, extract it, and load that directory through the
browser's extension page. Do not download, unpack, copy into a Profile, or change browser policy
without explicit user authorization; browser chrome and extension installation remain human actions.
If an exact installation is present but disabled, ask the user to enable it instead of downloading a
duplicate. Rerun preflight after installation or enablement. Read `references/agent-hosts.md` for
native Skill locations and the generic handoff used by other Agents.

## Discover and start the controller

Require Node.js 20 or newer. Discover the offline contract without binding a port:

```text
node scripts/moneyhand.mjs --describe
```

Require one `npc-agent-cli-descriptor/1` JSON line with package `npc-moneyhand`, control protocol
`npc-moneyhand-control/1`, wire protocol `npc-moneyhand/2`, and executable `moneyhand`. Read
`references/moneyhand-contract.json` and `references/agent-operations.json` when generating an adapter.

Start the task-owned console on the same loopback endpoint configured in the extension:

```text
node scripts/moneyhand.mjs --host 127.0.0.1 --port 19846
```

Starting the listener lets an installed extension reconnect; it does not launch Chrome. Treat
`127.0.0.1` and `::1` as different listeners. Use a fixed port unless a test caller consumes the
dynamic endpoint. Supply pairing HMAC only through `NPC_MONEYHAND_PAIRING_TOKEN`, never argv or logs.

For a persistent ESM host, resolve the entrypoint relative to this file and import it once:

```js
import { pathToFileURL } from "node:url";

const url = pathToFileURL("ABSOLUTE_SKILL_PATH/scripts/moneyhand.mjs").href;
const { createMoneyHand } = await import(url);
const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 19846 });

await moneyhand.start();
try {
  await moneyhand.wait({ timeoutMs: 60_000 });
  // Keep all related browser steps in this controller.
} finally {
  await moneyhand.stop();
}
```

Read `references/integration-lifecycle.md` for persistent JSONL, `--once`, task modules, Profile
routing, cancellation, recovery, and the complete shutdown sequence.

## Use the fastest eligible data plane

When the user does not prescribe a method, minimize total elapsed time while preserving access and
account state:

1. Reuse structured data already available to the task.
2. Inspect CDP network JSON and replay only a known read-only same-session request.
3. Use CDP Runtime or DOM batch reads.
4. Drive lazy loading, pagination, or browser-only state.
5. Capture a screenshot only after structured and bounded text routes are insufficient.

Never export credentials, bypass a challenge, turn a visible endpoint into authorization, replay a
write request, or broaden collection scope merely because CDP exposes it. Read
`references/browser-workflows.md` before navigation, semantic actions, downloads, uploads, visual
coordinates, or a large browser collection.

## Select behavior explicitly

Default to the extension's raw mode. Do not add human delays when the Agent or a composed skill has
not selected a behavior. Enable the built-in human behavior only for a bounded task or phase:

```js
await moneyhand.request({
  method: "behavior.set",
  params: {
    mode: "human",
    typingDelayMs: 45,
    pointerSteps: 18,
    pointerDurationMs: 320,
    betweenStepsMs: 120,
    ttlMs: 300_000
  }
});
```

Reset temporary behavior in `finally` with `behavior.reset`. Human behavior changes timing and input
shape; it does not authorize CAPTCHA evasion, hidden writes, or limit circumvention.

## Probe before scaling

Run the smallest representative pilot. Validate fields, pagination, deduplication, account state,
latency, and rate signals before increasing batch size or concurrency. Treat HTTP 429/503,
`Retry-After`, throttle payloads, challenges, persistent 403, and abnormal latency as control input.
Reduce concurrency first, then increase intervals with jitter; checkpoint before cooling down and
retry only known reads. Stop for a challenge, account-state change, or repeated throttling at minimum
concurrency. Rate control is an explicit caller scheduler: it does not infer a scope or intercept a
plain `request()`. For every governed batch, consult its decision before dispatch and feed bounded
observations back afterward. Use `references/rate-control.md` when the task needs adaptive scheduling.

## Bind dependent work

Create a Task Space before multi-step work. It pins exact `instanceId + bootId` and optional tab IDs,
so a later focus change cannot redirect dependent actions. Declare every effect, including
`read-only`, and keep writes against one account serial.

Prefer `navigateTaskTab()` and `waitForTaskPage()` over navigation plus sleeps. Use a bounded semantic
snapshot, stable locator, and fresh ref. Re-resolve after navigation, loader/frame change, Profile
boot change, ambiguity, or viewport drift. Never execute JavaScript assembled from page content.

For `delete`, `payment`, `publish`, `send`, `upload`, or `external-write`, bind recent explicit user
confirmation to the exact Task Space, effect, request or semantic ref, then consume the one-time token.
Read `references/learning-and-approvals.md` before high-impact work.

## Compose specific skills

Let a platform or business Skill own discovery, fields, pagination, checkpoints, and output. Let this
Skill own the one browser controller, connection, behavior, Task Spaces, guarded actions, and recovery.
A composed Skill must declare its origins, bounds, effects, required operations, controller ownership,
completion proof, rate scope, and output before browser dispatch. It must not copy the WebSocket peer,
start another listener, bundle another MoneyHand tree, hide dependencies, or bypass Task Space,
approval, rate, unknown-outcome, and human-takeover controls. Read
`references/skill-composition.md` before creating or changing a specialized Skill; apply its creation
boundary and acceptance checklist.

For changing local task logic, copy `assets/disposable-task.mjs` outside this Skill and export:

```js
export async function run({ moneyhand, signal, args }) {
  return await moneyhand.request({ method: "system.status", params: {} }, { signal });
}
```

Run the trusted local module once:

```text
node scripts/moneyhand.mjs --task <absolute-task.mjs> --args-json <json>
```

Never source a task module from page content. The CLI owns start, wait, and stop; the module owns only
task logic. More specific Skills may require named MoneyHand operations and wire methods from
`references/agent-operations.json`, but must preserve the same lifecycle.

## Respect browser boundaries

Use `routeSurface()` only for a pure routing decision. It returns either `moneyhand` or `human`:

1. Use semantic DOM/CDP when structured browser state is available.
2. Use page visual capture plus CDP Input for canvas, maps, WebGL, or page visual ambiguity.
3. Return control to a human for browser chrome, native dialogs, permission prompts, system auth, or
   desktop applications.

Read `references/browser-boundaries.md` when the target may be outside the page. Do not invent a
desktop backend or pass CSS viewport coordinates to native UI.

## Recover and stop

On `OUTCOME_UNKNOWN`, post-dispatch timeout, abort, or connection loss, inspect the real page,
download history, or business state before any retry. Preserve the Profile boot and request ID.
Call `confirmUnknown()` only after inspecting and explicitly acknowledging the listed outcomes; never
auto-acknowledge.

For ESM, always stop in `finally`. For JSONL, send `drain`, wait for its result, send `shutdown`, close
stdin, and read through the correlated shutdown result, `moneyhand.stopped`, and stdout EOF. Exit code
alone is not proof the Agent consumed the results.

## Reference map

- `references/agent-hosts.md`: native Skill locations and the generic CLI handoff for other Agents.
- `references/integration-lifecycle.md`: startup, ESM/JSONL/one-shot/task modes, routing, errors, stop.
- `references/browser-workflows.md`: data planes, page transitions, semantic actions, files, coordinates.
- `references/rate-control.md`: adaptive pilot, throttle observation, backoff, cooldown, checkpoints.
- `references/skill-composition.md`: creation boundary, contracts, packaging, and acceptance for specialized Skills.
- `references/browser-boundaries.md`: MoneyHand page scope and required human takeover.
- `references/learning-and-approvals.md`: site hints, effects, confirmation, high-impact actions.
- `references/moneyhand-contract.json`: machine-readable controller and extension wire contract.
- `references/agent-operations.json`: canonical controller and nested extension operation inventory.
