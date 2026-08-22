import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const CHINESE_README = "README.md";
const ENGLISH_README = "README_EN.md";

test("Chinese and English product pages link to each other", async () => {
  const [chinese, english] = await Promise.all([
    readFile(CHINESE_README, "utf8"),
    readFile(ENGLISH_README, "utf8"),
  ]);

  assert.match(chinese, /\[English\]\(\.\/README_EN\.md\)/u);
  assert.match(english, /\[简体中文\]\(\.\/README\.md\)/u);
  await Promise.all([access(CHINESE_README), access(ENGLISH_README)]);
});

test("both product pages keep concise onboarding and composition links discoverable", async () => {
  const pages = await Promise.all([
    readFile(CHINESE_README, "utf8"),
    readFile(ENGLISH_README, "utf8"),
  ]);
  for (const page of pages) {
    assert.match(page, /\.\/docs\/AGENT_QUICKSTART\.md/u);
    assert.match(page, /\.\/ARCHITECTURE\.md/u);
    assert.match(page, /\.\/skills\/npc-moneyhand\/references\/skill-composition\.md/u);
  }
});

test("every local product-page link resolves inside the repository", async () => {
  const pages = await Promise.all([
    readFile(CHINESE_README, "utf8"),
    readFile(ENGLISH_README, "utf8"),
  ]);

  for (const page of pages) {
    const localTargets = [...page.matchAll(/\]\((\.\/[^)#]+)(?:#[^)]+)?\)/gu)]
      .map((match) => decodeURIComponent(match[1].slice(2)));
    assert.ok(localTargets.length > 0, "README has no local links");
    await Promise.all(localTargets.map((target) => access(target)));
  }
});

test("English product page preserves the concise positioning and scenario capabilities", async () => {
  const english = await readFile(ENGLISH_README, "utf8");

  for (const statement of [
    "The browser action and task runtime for the Agent era",
    "Multi-Agent task isolation",
    "Complete task management",
    "Long-running and unattended work",
    "Batch execution and Token efficiency",
    "Visual fallback and recovery",
    "Adaptive rate control and verified completion",
    "Complete page interaction",
    "Three layers",
    "Fixed rule for a new Agent",
  ]) {
    assert.ok(
      english.includes(statement),
      "missing English positioning statement: " + statement,
    );
  }

  for (const keyword of [
    "AI Agent Browser Automation",
    "Multi-Agent Browser Control",
    "Chrome Extension",
    "CDP",
    "Web Automation",
    "Computer Use",
    "Agent Skill",
    "Local-first",
  ]) {
    assert.ok(
      english.includes(keyword),
      "missing English discovery keyword: " + keyword,
    );
  }
});

test("Chinese and English product pages describe the same isolated task runtime", async () => {
  const [chinese, english] = await Promise.all([
    readFile(CHINESE_README, "utf8"),
    readFile(ENGLISH_README, "utf8"),
  ]);
  assert.match(chinese, /多个 Agent[\s\S]*独立窗口、Task Space、执行 ID、进度和检查点/u);
  assert.match(english, /Multiple Agents[\s\S]*own window, Task Space, execution ID, progress, and checkpoints/u);
  assert.match(chinese, /创建任务 → 固定窗口 → 执行动作 → 返回进度[\s\S]*验证结果 → 自动清理/u);
  assert.match(english, /create → pin window → execute → report progress[\s\S]*verify result → clean up/u);
  assert.match(chinese, /Agent 暂时断开[\s\S]*继续跟进同一个任务/u);
  assert.match(english, /originating Agent disconnects[\s\S]*continue following the same task/u);
  assert.match(chinese, /超时、遮挡、页面变化、操作无反馈或任务静默/u);
  assert.match(english, /times out[\s\S]*occluded[\s\S]*task goes silent/u);
});

test("public product pages do not use private application examples", async () => {
  const productPages = await Promise.all([
    readFile(CHINESE_README, "utf8"),
    readFile(ENGLISH_README, "utf8"),
  ]);

  for (const page of productPages) {
    assert.doesNotMatch(page, /Reddit|VOC|influencer development|红人开发/u);
  }
});
