import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../skills/npc-moneyhand/assets/disposable-task.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const template = resolve(
  root,
  "skills",
  "npc-moneyhand",
  "assets",
  "disposable-task.mjs",
);

test("disposable task uses the supplied MoneyHand without owning its lifecycle", async () => {
  const requests = [];
  const signal = AbortSignal.timeout(1_000);
  const moneyhand = {
    async request(message, options) {
      requests.push({ message, options });
      return {
        ok: true,
        result: { targets: [{ targetId: "active-tab" }] },
      };
    },
  };
  const args = { query: "nexa" };

  const result = await run({
    moneyhand,
    signal,
    args,
  });

  assert.deepEqual(requests, [{
    message: { method: "target.list", params: {} },
    options: { signal },
  }]);
  assert.deepEqual(result, {
    args,
    terminal: {
      ok: true,
      result: { targets: [{ targetId: "active-tab" }] },
    },
  });

  const source = await readFile(template, "utf8");
  assert.doesNotMatch(source, /createMoneyOperator|WebSocket|\.start\s*\(|\.stop\s*\(/u);
  assert.doesNotMatch(source, /\bsession\b/u);
});

test("disposable task preserves needs_instruction as a terminal value", async () => {
  const terminal = {
    ok: false,
    status: "needs_instruction",
    waitId: "wait-1",
    need: { reason: "ambiguous page" },
    error: { code: "NEEDS_INSTRUCTION", message: "Agent decision required" },
  };
  const moneyhand = {
    async request() {
      return terminal;
    },
  };

  assert.deepEqual(
    await run({ moneyhand, signal: undefined, args: { page: 2 } }),
    { args: { page: 2 }, terminal },
  );
});
