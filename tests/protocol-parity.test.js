import assert from "node:assert/strict";
import test from "node:test";
import * as extensionProtocol from "../extension/protocol.js";
import * as moneyhandProtocol from "../skills/npc-moneyhand/scripts/lib/protocol.mjs";

test("standalone MoneyHand protocol constants and validators match the Extension", () => {
  for (const name of [
    "PRODUCT",
    "PROTOCOL",
    "PROTOCOL_VERSION",
    "MAX_MESSAGE_BYTES",
    "MAX_UNKNOWN_OUTCOME_IDS",
    "MAX_FOCUS_FUTURE_MS",
  ]) {
    assert.equal(moneyhandProtocol[name], extensionProtocol[name], name);
  }
  for (const value of [
    "",
    "short",
    "pair-secret-123456",
    "x".repeat(512),
    "x".repeat(513),
  ]) {
    assert.equal(
      moneyhandProtocol.pairingTokenIsValid(value),
      extensionProtocol.pairingTokenIsValid(value),
      `pairing token parity for length ${value.length}`,
    );
  }
  for (const value of [
    "",
    "npc-instance_0001",
    "测试-profile",
    "contains space",
    "x".repeat(65),
  ]) {
    assert.equal(
      moneyhandProtocol.profileIsValid(value),
      extensionProtocol.profileIsValid(value),
      `profile parity for '${value}'`,
    );
  }
});
