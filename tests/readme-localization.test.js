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

test("English product page preserves the positioning, three layers, and token thesis", async () => {
  const english = await readFile(ENGLISH_README, "utf8");

  for (const statement of [
    "The universal browser action companion for the Agent era",
    "Why install MoneyHand?",
    "The three-layer architecture",
    "Layer 1: the Extension is the stable hand",
    "Layer 2: the MoneyHand Skill is the reusable action system",
    "Layer 3: a Custom Skill becomes your batch action assistant",
    "Token efficiency by architecture",
    "General browser capabilities",
    "Build your own Custom Skill",
    "Product boundaries",
  ]) {
    assert.ok(english.includes(statement), `missing English positioning statement: ${statement}`);
  }

  for (const keyword of [
    "AI agent browser automation",
    "Chrome Extension",
    "Chrome DevTools Protocol (CDP)",
    "browser agents",
    "web automation",
    "computer-use",
    "Custom Skill",
    "local-first",
  ]) {
    assert.ok(english.includes(keyword), `missing English discovery keyword: ${keyword}`);
  }
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
