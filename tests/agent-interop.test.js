import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const AGENT_JSONL_PROTOCOL = "npc-agent-jsonl/1";
const LIFECYCLE_OPERATIONS = ["capabilities", "status", "cancel", "drain", "shutdown"];

const PRODUCTS = [
  {
    name: "MoneyHand",
    script: "skills/npc-moneyhand/scripts/moneyhand.mjs",
    contract: "skills/npc-moneyhand/references/moneyhand-contract.json",
    catalog: "skills/npc-moneyhand/references/agent-operations.json",
    args: ["--internal-test-port", "0"],
    startupEvent: "moneyhand.listening",
    stoppedEvent: "moneyhand.stopped",
  },
];

async function runLifecycle(product) {
  const catalog = JSON.parse(await readFile(resolve(product.catalog), "utf8"));
  const child = spawn(process.execPath, [resolve(product.script), ...product.args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  const messages = [];
  const seen = new EventEmitter();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    messages.push(message);
    seen.emit("message", message);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waitFor = async (predicate, label) => {
    const existing = messages.find(predicate);
    if (existing) return existing;
    let timer;
    let listener;
    try {
      return await new Promise((resolvePromise, rejectPromise) => {
        listener = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          seen.off("message", listener);
          resolvePromise(message);
        };
        seen.on("message", listener);
        timer = setTimeout(() => {
          seen.off("message", listener);
          rejectPromise(new Error(`${product.name} timed out waiting for ${label}`));
        }, 10_000);
      });
    } finally {
      clearTimeout(timer);
      if (listener) seen.off("message", listener);
    }
  };
  await waitFor((message) => message.event === product.startupEvent, "startup");
  child.stdin.write([
    JSON.stringify({ id: "probe", op: catalog.safeProbe.op, args: catalog.safeProbe.args }),
    JSON.stringify({ id: "caps", op: "capabilities", args: {} }),
    JSON.stringify({ id: "status", op: "status", args: {} }),
    JSON.stringify({ id: "barrier", op: "drain", args: {} }),
    "",
  ].join("\n"));
  await Promise.all(["probe", "caps", "status", "barrier"].map((id) => waitFor(
    (message) => message.type === "result" && message.id === id,
    id,
  )));
  child.stdin.end(`${JSON.stringify({ id: "stop", op: "shutdown", args: {} })}\n`);
  await waitFor(
    (message) => message.type === "result" && message.id === "stop",
    "shutdown result",
  );
  await waitFor((message) => message.event === product.stoppedEvent, "stopped event");
  let timer;
  const code = child.exitCode ?? await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise("timeout"), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
  if (code === "timeout") child.kill();
  lines.close();
  assert.equal(code, 0, `${product.name} lifecycle failed: ${stderr || JSON.stringify(messages)}`);
  return { messages, catalog };
}

for (const product of PRODUCTS) {
  test(`${product.name} satisfies the common Agent JSONL lifecycle`, {
    skip: product.unsupported === true,
  }, async () => {
    const { messages, catalog } = await runLifecycle(product);
    const startup = messages.find((message) => message.event === product.startupEvent);
    assert.ok(startup, `${product.name} did not emit its startup event`);
    assert.equal(startup.capabilities.agentInterop.protocol, AGENT_JSONL_PROTOCOL);
    assert.equal(startup.capabilities.agentInterop.framing, "utf-8-jsonl");
    assert.equal(startup.capabilities.agentInterop.startupEvent, product.startupEvent);
    assert.equal(startup.capabilities.agentInterop.stoppedEvent, product.stoppedEvent);
    assert.equal(startup.capabilities.agentInterop.commandFields.arguments, "args");
    assert.equal(startup.capabilities.agentInterop.argumentPolicy.mixedWithTopLevel, "reject");
    assert.equal(
      startup.capabilities.agentInterop.operationCatalog.schema,
      "npc-agent-operation-catalog/1",
    );
    assert.deepEqual(
      startup.capabilities.agentInterop.lifecycleOperations,
      LIFECYCLE_OPERATIONS,
    );
    for (const id of ["probe", "caps", "status", "barrier", "stop"]) {
      const result = messages.find((message) => message.type === "result" && message.id === id);
      assert.equal(result?.ok, true, `${product.name} did not complete '${id}'`);
    }
    const capabilities = messages.find((message) => message.id === "caps").value;
    assert.equal(capabilities.agentInterop.protocol, AGENT_JSONL_PROTOCOL);
    assert.deepEqual(
      capabilities.operations.jsonl,
      catalog.operations.map((operation) => operation.op),
    );
    const contract = JSON.parse(await readFile(resolve(product.contract), "utf8"));
    assert.deepEqual(capabilities.agentInterop, contract.agentInterop);
    assert.equal(
      messages.some((message) => message.event === product.stoppedEvent),
      true,
    );
    assert.equal(messages.some((message) => message.type === "fatal"), false);
  });
}
