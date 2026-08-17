import assert from "node:assert/strict";
import test from "node:test";
import {
  matchSemanticLocator,
  normalizeSemanticLocator,
  normalizeSemanticLocatorState,
  semanticLocatorStabilityKey,
} from "../skills/npc-moneyhand/scripts/lib/semantic-locator.mjs";

test("semantic locators accept only exact snapshot-derived role or CSS forms", () => {
  assert.deepEqual(normalizeSemanticLocator({
    kind: "role",
    role: "button",
    name: "Continue",
    confidence: "semantic",
  }), { kind: "role", role: "button", name: "Continue" });
  assert.deepEqual(normalizeSemanticLocator({
    kind: "css",
    value: "#continue",
    confidence: "unique-snapshot",
  }), { kind: "css", value: "#continue" });
  assert.equal(normalizeSemanticLocatorState(undefined), "actionable");
  assert.throws(
    () => normalizeSemanticLocator({ kind: "css", value: "#x", nth: 2 }),
    /unsupported field/u,
  );
  assert.throws(
    () => normalizeSemanticLocator({ kind: "role", role: "button", name: "" }),
    /non-empty string/u,
  );
});

test("semantic locator matching treats absence and disabled targets as transient but ambiguity as fatal", () => {
  const locator = { kind: "role", role: "button", name: "Continue" };
  assert.deepEqual(matchSemanticLocator([], locator, "actionable"), {
    status: "missing",
    count: 0,
  });
  const disabled = {
    ref: "@1",
    backendNodeId: 91,
    role: "button",
    name: "Continue",
    actionable: true,
    properties: { disabled: true },
    locator: { kind: "css", value: "#continue" },
  };
  const notReady = matchSemanticLocator([disabled], locator, "actionable");
  assert.equal(notReady.status, "not-ready");
  assert.equal(notReady.reason, "disabled");
  assert.equal(matchSemanticLocator([disabled], locator, "attached").status, "matched");
  const ambiguous = matchSemanticLocator([
    disabled,
    { ...disabled, ref: "@2", backendNodeId: 92, properties: { disabled: false } },
  ], locator, "attached");
  assert.deepEqual(ambiguous, { status: "ambiguous", count: 2, refs: ["@1", "@2"] });
});

test("semantic locator stability follows Profile boot, loader and meaning instead of stale backend ids", () => {
  const locator = { kind: "role", role: "button", name: "Continue" };
  const snapshot = {
    sessionSelector: { instanceId: "instance", bootId: "boot" },
    guard: { frameId: "root", loaderId: "loader", url: "https://example.test/" },
  };
  const first = {
    ref: "@1",
    backendNodeId: 91,
    role: "button",
    name: "Continue",
    value: "old",
    tag: "button",
    actionable: true,
    properties: { disabled: false },
  };
  const second = { ...first, ref: "@7", backendNodeId: 202, value: "new" };
  assert.equal(
    semanticLocatorStabilityKey(snapshot, first, locator, "actionable"),
    semanticLocatorStabilityKey(snapshot, second, locator, "actionable"),
  );
  assert.notEqual(
    semanticLocatorStabilityKey(snapshot, second, locator, "actionable"),
    semanticLocatorStabilityKey({
      ...snapshot,
      guard: { ...snapshot.guard, loaderId: "loader-next" },
    }, second, locator, "actionable"),
  );
});
