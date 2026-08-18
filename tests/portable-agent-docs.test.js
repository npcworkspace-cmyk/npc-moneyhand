import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HOST_GUIDE = "skills/npc-moneyhand/references/agent-hosts.md";

async function hostGuide() {
  return await readFile(HOST_GUIDE, "utf8");
}

test("portable Agent guide declares one bounded connect baseline and its runtime boundary", async () => {
  const guide = await hostGuide();

  for (const command of [
    "node scripts/moneyhand.mjs --connect",
    "node scripts/moneyhand.mjs --connect --after-user-action",
  ]) {
    assert.match(guide, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(guide, /Node\.js 20 or newer/u);
  assert.match(guide, /does not\s+install a daemon/u);
  assert.match(guide, /Skill archive excludes the extension/u);
  assert.match(guide, /npc-moneyhand-extension-1\.0\.0\.zip/u);
  assert.match(guide, /github\.com\/npcworkspace-cmyk\/npc-moneyhand\/releases/u);
  assert.match(guide, /Never close or restart all browser processes/u);
  assert.match(guide, /follow only `nextAction`/u);
  assert.match(guide, /Only `value\.connected: true`/u);
  assert.match(guide, /ask the user what browser task to perform/u);
  assert.doesNotMatch(guide, /target\.list|--call|tabId/u);
});

test("portable Agent guide names every requested host without inventing native Dsh support", async () => {
  const guide = await hostGuide();

  for (const host of [
    "Codex",
    "Claude Code",
    "CodeBuddy Code",
    "WorkBuddy",
    "Hermes Agent",
    "Pi",
    "OpenClaw",
    "Dsh",
  ]) {
    assert.match(guide, new RegExp(`\\b${host}\\b`, "u"));
  }
  assert.match(guide, /WorkBuddy documents local Skill import through its UI/u);
  assert.match(guide, /`Dsh` is not one\s+unambiguous, documented Agent product name/u);
  assert.match(guide, /Use the generic handoff whenever a host\s+has no verified native Agent Skills route/u);
  assert.doesNotMatch(guide, /\.dsh\/skills|~\/\.workbuddy\/skills/u);
});

test("portable Agent guide records only verified native roots and official references", async () => {
  const guide = await hostGuide();

  for (const root of [
    "<repo>/.agents/skills/npc-moneyhand",
    "~/.agents/skills/npc-moneyhand",
    "<repo>/.claude/skills/npc-moneyhand",
    "~/.claude/skills/npc-moneyhand",
    "<repo>/.codebuddy/skills/npc-moneyhand",
    "~/.codebuddy/skills/npc-moneyhand",
    "~/.hermes/skills/npc-moneyhand",
    "~/.pi/agent/skills/npc-moneyhand",
    "<workspace>/skills/npc-moneyhand",
    "~/.openclaw/skills/npc-moneyhand",
  ]) {
    assert.ok(guide.includes(root), `missing documented root: ${root}`);
  }
  for (const url of [
    "https://developers.openai.com/codex/skills",
    "https://code.claude.com/docs/en/slash-commands",
    "https://www.codebuddy.cn/docs/cli/skills",
    "https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market",
    "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md",
    "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md",
    "https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md",
    "https://agentskills.io/specification",
  ]) {
    assert.ok(guide.includes(url), `missing official reference: ${url}`);
  }
});

test("portable Agent guide contains no retired MoneyHand product surfaces", async () => {
  const guide = await hostGuide();

  for (const retired of [
    "NPC-AIplug",
    "npc-aiplug",
    "npc-moneyoperator",
    "MoneyDesk",
    "moneydesk",
    "operator.mjs",
  ]) {
    assert.equal(guide.includes(retired), false, `retired surface leaked into guide: ${retired}`);
  }
});
