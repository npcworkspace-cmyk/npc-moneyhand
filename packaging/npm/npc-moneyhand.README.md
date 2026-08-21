# npc-moneyhand

Zero-runtime-dependency MoneyHand Agent Skill with an embedded browser controller. It pairs with
the npc-moneyhand Chrome extension over a loopback WebSocket and does not require a daemon.

The Skill owns controller startup, durable task IDs and reattachment, task-scoped JSONL/ESM
orchestration, semantic browser actions, raw and human behavior modes, idempotent effect receipts,
automatic and explicit adaptive rate control, checkpoints, bounded recovery, and evidence-gated
completion. The Chrome
extension remains the thin execution hand.

## Install a release tarball

```text
npm install --ignore-scripts ./npc-moneyhand-1.0.0.tgz
```

For a project-local install, use `npm exec` so no global `PATH` setup is required:

```text
npm exec -- moneyhand --describe
npm exec -- moneyhand --port 19846
```

`--describe` is offline and emits one `npc-agent-cli-descriptor/1` JSON line without starting a
listener, consuming stdin, accessing Chrome, or producing browser input. Validate the descriptor,
then use its operation catalog instead of guessing operation names or fields.

## Common JSONL lifecycle

After startup, read the `moneyhand.listening` event before sending requests. Each command has a
unique `id`, an `op`, and canonical arguments in `args`:

```json
{"id":"status-1","op":"status","args":{}}
{"id":"drain-1","op":"drain","args":{}}
{"id":"stop-1","op":"shutdown","args":{}}
```

Keep reading stdout until the shutdown result, the final `moneyhand.stopped` event, and EOF. A
write timeout or disconnect has an unknown postcondition: inspect the real browser state before
retrying. The calling Agent remains responsible for authorization and confirmation of external
effects.

The package also ships `SKILL.md`, its machine-readable operation catalog and contract under
`references/`, and reusable task assets. It requires Node.js 20 or newer and has no third-party
runtime packages.
