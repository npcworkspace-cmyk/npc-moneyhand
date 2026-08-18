import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SKILL_PATH = "skills/npc-moneyhand/SKILL.md";

test("base Skill exposes one bounded startup path and stops to ask the user", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");

  for (const required of [
    "node scripts/moneyhand.mjs --connect",
    "node scripts/moneyhand.mjs --connect --after-user-action",
    "follow only its `nextAction`",
    "Only `value.connected: true`",
    "Ask what browser task to perform",
    "Never run another automatic retry",
  ]) {
    assert.ok(skill.includes(required), `missing startup rule: ${required}`);
  }

  for (const leaked of [
    "target.list",
    "--call",
    "--describe",
    "behavior.set",
    "tabId",
    "instanceId",
    "bootId",
    "agent-operations.json",
    "moneyhand-contract.json",
    "skill-composition.md",
  ]) {
    assert.equal(skill.includes(leaked), false, `low-level startup surface leaked: ${leaked}`);
  }
});

test("base Skill keeps specialized workflow ownership outside MoneyHand", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /A specialized Skill may depend on `npc-moneyhand`/u);
  assert.match(skill, /The specialized\s+Skill owns its platform or business workflow/u);
  assert.doesNotMatch(skill, /Reddit|VOC|influencer|creator discovery/iu);
});
