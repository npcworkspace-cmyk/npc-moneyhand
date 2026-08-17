import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SKILL = "skills/npc-moneyhand/SKILL.md";
const COMPOSITION = "skills/npc-moneyhand/references/skill-composition.md";
const OPERATIONS = "skills/npc-moneyhand/references/agent-operations.json";

async function sources() {
  const [skill, composition, operationText] = await Promise.all([
    readFile(SKILL, "utf8"),
    readFile(COMPOSITION, "utf8"),
    readFile(OPERATIONS, "utf8"),
  ]);
  return { skill, composition, operations: JSON.parse(operationText) };
}

test("specialized Skill composition keeps one-way ownership and an explicit creation boundary", async () => {
  const { skill, composition } = await sources();

  assert.match(skill, /must declare its origins, bounds, effects, required operations/u);
  assert.match(skill, /before creating or changing a specialized Skill/u);
  assert.match(composition, /Keep the dependency one-way/u);
  assert.match(composition, /MoneyHand and its\s+extension must never import, discover, or depend/u);
  for (const heading of [
    "## Layer ownership",
    "## Creation boundary",
    "## Required composition contract",
    "## Controller integration",
    "## Lifecycle and recovery",
    "## Packaging boundary",
    "## Acceptance checklist",
    "## Examples",
  ]) {
    assert.ok(composition.includes(heading), `missing composition heading: ${heading}`);
  }
});

test("the documented composition declaration uses only packaged MoneyHand operations", async () => {
  const { composition, operations } = await sources();
  const block = composition.match(/```json\s*([\s\S]*?)```/u);
  assert.ok(block, "missing JSON composition declaration");
  const declaration = JSON.parse(block[1]);
  const knownOperations = new Set(operations.operations.map((operation) => operation.op));
  const knownWireMethods = new Set(operations.nestedOperations.methods);

  assert.equal(declaration.baseSkill, "npc-moneyhand");
  assert.equal(declaration.controlProtocol, operations.productProtocol);
  assert.equal(declaration.wireProtocol, "npc-moneyhand/2");
  assert.equal(declaration.controllerOwnership, "injected");
  for (const operation of declaration.requires.operations) {
    assert.ok(knownOperations.has(operation), `unknown documented operation: ${operation}`);
  }
  for (const method of declaration.requires.wireMethods) {
    assert.ok(knownWireMethods.has(method), `unknown documented wire method: ${method}`);
  }
});

test("specialized Skill boundaries prohibit duplicated control, credential export, and safety bypass", async () => {
  const { composition } = await sources();

  for (const rule of [
    /must not:\s*[\s\S]*copy or fork the MoneyHand peer/u,
    /start a second listener, daemon, browser, remote-debugging endpoint/u,
    /bypass Task Space binding, rate decisions, approvals/u,
    /human behavior as permission to evade CAPTCHA/u,
    /export cookies, authorization headers, passwords, session tokens/u,
    /replay a write or unknown-outcome action automatically/u,
    /add its SDK, parser, database, model client, queue, or reporting code/u,
    /claim all items\/comments\/results were collected without/u,
  ]) {
    assert.match(composition, rule);
  }
  assert.match(composition, /data-rights rules/u);
  assert.match(composition, /prove exact completion or return a bounded incomplete result/u);
});

test("specialized Skill acceptance covers lifecycle, rate, approvals, exact scope, and real Profile evidence", async () => {
  const { composition } = await sources();

  for (const evidence of [
    "zero domain-owned controller `start()`/`stop()` calls",
    "creates and completes one Task Space",
    "rate plan before dispatch and observe afterward",
    "High-impact effects fail before dispatch",
    "Exact-scope mismatch fails before browser dispatch",
    "zero automatic retries or destructive cleanup",
    "A separate real-Profile acceptance",
    "no copied peer, extension, secrets, live checkpoints, or undeclared dependency",
  ]) {
    assert.ok(composition.includes(evidence), `missing acceptance evidence: ${evidence}`);
  }
  for (const example of ["crawl-reddit-comments", "influencer-development Skill", "A VOC Skill"]){
    assert.ok(composition.includes(example), `missing specialized Skill example: ${example}`);
  }
});
