import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createMoneyHand } from "../skills/npc-moneyhand/scripts/moneyhand.mjs";

async function bytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return total;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hand = createMoneyHand({ host: "127.0.0.1", port: 0 });

const routeStarted = performance.now();
for (let index = 0; index < 100_000; index += 1) {
  hand.routeSurface({ surface: index % 2 ? "web-page" : "native-dialog" });
}
const routeElapsed = performance.now() - routeStarted;

const start = performance.now();
await hand.start();
const startMs = performance.now() - start;
const statusStarted = performance.now();
for (let index = 0; index < 100_000; index += 1) hand.status();
const statusElapsed = performance.now() - statusStarted;
const stop = performance.now();
await hand.stop({ graceMs: 0 });
const stopMs = performance.now() - stop;

console.log(JSON.stringify({
  schema: "npc-control-benchmark/1",
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  artifacts: {
    extensionBytes: await bytes(join(root, "extension")),
    moneyHandSkillBytes: await bytes(join(root, "skills", "npc-moneyhand")),
    externalPackages: 0,
  },
  moneyHand: {
    listenerStartMs: rounded(startMs),
    statusCalls: 100_000,
    totalStatusMs: rounded(statusElapsed),
    microsecondsPerStatus: rounded((statusElapsed * 1000) / 100_000),
    listenerStopMs: rounded(stopMs),
    routeDecisions: 100_000,
    totalRouteMs: rounded(routeElapsed),
    microsecondsPerRouteDecision: rounded((routeElapsed * 1000) / 100_000),
  },
}, null, 2));
