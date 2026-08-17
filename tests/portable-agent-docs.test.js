import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HOST_GUIDE = "skills/npc-moneyhand/references/agent-hosts.md";

async function hostGuide() {
  return await readFile(HOST_GUIDE, "utf8");
}

test("portable Agent guide declares one executable baseline and its runtime boundary", async () => {
  const guide = await hostGuide();

  for (const command of [
    "node scripts/preflight.mjs --json",
    "node scripts/moneyhand.mjs --describe",
    "node scripts/moneyhand.mjs --host 127.0.0.1 --port 19846",
  ]) {
    assert.match(guide, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(guide, /Node\.js 20 or newer/u);
  assert.match(guide, /Merely displaying or injecting `SKILL\.md` cannot scan/u);
  assert.match(guide, /does not install a daemon or background service/u);
  assert.match(guide, /bounded, read-only browser and extension scan/u);
  assert.match(guide, /starting it does not launch a browser/u);
  assert.match(guide, /Preflight JSON contains local absolute paths/u);
  assert.match(guide, /cannot distinguish mapped drives or mounted NFS\/SMB/u);
  assert.match(guide, /portable Skill archive intentionally excludes extension source/u);
  assert.match(guide, /npc-moneyhand-extension-1\.0\.0\.zip/u);
  assert.match(guide, /github\.com\/npcworkspace-cmyk\/npc-moneyhand\/releases/u);
  assert.match(guide, /Do not silently download it, copy it into a Profile/u);
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
  assert.match(guide, /Use the generic handoff whenever a host has no verified native Agent Skills route/u);
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
