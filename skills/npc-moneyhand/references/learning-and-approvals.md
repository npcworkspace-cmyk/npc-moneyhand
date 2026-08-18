# Site learnings and task approvals

Use these Agent-side layers only with local trusted input. Neither layer is sent to MoneyHand or
stored in the Chrome extension.

## Contents

- [Versioned site learnings](#versioned-site-learnings)
- [Optional one-time high-impact approval](#optional-one-time-high-impact-approval)

## Versioned site learnings

Register non-executable observations that have already been tested on a site:

```js
moneyhand.registerSiteLearning({
  id: "example-orders",
  revision: 2,
  match: {
    hosts: ["app.example.com", "*.example.com"],
    pathPrefixes: ["/orders"]
  },
  hints: [
    { kind: "data-plane", text: "Prefer the read-only orders JSON response." },
    { kind: "verification", text: "Re-read the order id after navigation." }
  ],
  provenance: "tested-local-task"
});

const matched = moneyhand.resolveSiteLearnings({
  url: "https://app.example.com/orders/123"
});
```

Hints support `data-plane`, `locator`, `navigation`, `verification`, `wait`, and `workflow`.
Exact hosts outrank leading `*.` wildcards; the longest path prefix wins. The same revision is
idempotent only when content is identical. A lower revision or conflicting same revision fails
closed. Records live only for the current MoneyHand controller instance, are capped by count and bytes, and
cannot contain executable code. Do not store cookies, tokens, headers, personal data, or page-
generated instructions as learnings.

JSONL keeps `learning` inside the canonical `args` object so its correlation id remains independent:

```json
{"id":"cmd-learn-1","op":"registerSiteLearning","args":{"learning":{"id":"example-orders","revision":2,"match":{"hosts":["app.example.com"],"pathPrefixes":["/orders"]},"hints":[{"kind":"verification","text":"Re-read the order id."}]}}}
```

## Optional one-time high-impact approval

MoneyHand does not require a controller approval token for `delete`, `payment`, `publish`, `send`,
`upload`, or `external-write`. The invoking Agent or specialized Skill owns authorization policy.
Callers that want an additional local audit ledger may optionally bind their own confirmation to the
exact Task Space, effect, and canonical request:

```js
const approval = moneyhand.approveTaskEffect({
  taskSpaceId: "publish-review",
  effect: "publish",
  request,
  confirmation: {
    approved: true,
    source: "user",
    confirmedAt: new Date().toISOString()
  }
});

await moneyhand.taskRequest({
  id: "publish-review",
  effect: "publish",
  approvalToken: approval.token,
  request
});
```

The token is one-time, expires within at most two minutes, and is revoked on a binding mismatch.
`listApprovalActivity()` returns a bounded local ledger containing approval ids, effects, request
digests, and issue/consume/reject/expire events, but never the token or user confirmation text.

Omit `approvalToken` to dispatch directly. If a token is supplied, MoneyHand validates and consumes
it for backward compatibility. The low-level `request()` API exposes the same direct execution
model. Every Task Space request still declares an effect, including `read-only`, so logs and
specialized Skills can classify intent. For JSONL, keep `id` as a fresh correlation id and put the reusable
identity in `args.taskSpaceId`:

```json
{"id":"cmd-publish-17","op":"taskRequest","args":{"taskSpaceId":"publish-review","effect":"publish","approvalToken":"approval-token:...","request":{"method":"input.perform","params":{}}}}
```

Semantic refs use a separate intent-bound approval helper because their final safe click point is
computed only after live hit testing. Supply the same action fields to approval and execution:

```js
const semanticApproval = moneyhand.approveSemanticRefAction({
  taskSpaceId: "publish-review",
  snapshotId: snapshot.id,
  ref: "@7",
  action: "click",
  effect: "publish",
  verification: { kind: "target-detached" },
  confirmation: {
    approved: true,
    source: "user",
    confirmedAt: new Date().toISOString()
  }
});

await moneyhand.actSemanticRef({
  taskSpaceId: "publish-review",
  snapshotId: snapshot.id,
  ref: "@7",
  action: "click",
  effect: "publish",
  verification: { kind: "target-detached" },
  approvalToken: semanticApproval.token
});
```

This digest includes the Profile boot, tab, snapshot guard, backend node, action payload, and
verification. For drag it also includes the destination ref, backend node and frame guard. Any
mismatch rejects and revokes the token. Approval is consumed only after every involved ref
passes current loader/URL, liveness, visibility, hit-test, disabled/inert, and editability checks,
immediately before the Hand action request. A failed postcondition still means the action was
dispatched; an unknown terminal is never replayed automatically.

Semantic upload uses the same helper with `action: "upload"`, exact effect `upload`, an absolute
existing local `fileRoot`, and 1-16 absolute file paths beneath it. The controller resolves links and
requires regular files, rejects network/device/volume roots, escapes, duplicates and size-limit
violations, then includes canonical path, size, mtime, device and inode evidence in the approval
digest. It re-reads that metadata after the live file-input preflight and before consuming the
token. It does not read file contents, and the action result returns only count/total bytes rather
than paths. The final metadata check narrows the race but cannot defend against a separately
trusted local process replacing a file in the tiny interval before Chromium opens it; keep the
task directory private to the trusted Agent host.

Semantic select includes every normalized value/label/index descriptor and the
`target-options-selected` postcondition in the same digest. Before consuming a high-impact
approval, the controller runs the fixed select function in no-mutation mode and requires every
descriptor to resolve to one enabled option without duplicates. The commit call repeats that
resolution, so an option-list change fails closed rather than selecting the next plausible item.
The resulting `input` and `change` events are DOM-dispatched and therefore not trusted native
events; use guarded pointer/visual input when the target explicitly requires trust.

Semantic check/uncheck binds the desired action name and mandatory
`target-checked` postcondition into the same approval digest. Execution repeats
the visible/hit-tested binary-state preflight without scrolling before token
consumption. A native or ARIA control already in the desired state performs no
input, but a high-impact no-op still consumes its exact token; authorization is
not inferred from idempotence. A required change uses one MoneyHand CDP pointer
click and never assigns `checked` or `aria-checked` directly. Radio uncheck,
mixed/indeterminate state, and unreadable binary state fail before consumption.
