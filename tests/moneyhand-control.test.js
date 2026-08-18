import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  MAX_JSONL_INFLIGHT,
  MONEYHAND_CONTROL_PROTOCOL,
  createMoneyHand,
  runJsonlMoneyHand,
  runMoneyHandTask,
} from "../skills/npc-moneyhand/scripts/moneyhand.mjs";
import { MoneyHandPeerError } from "../skills/npc-moneyhand/scripts/lib/peer.mjs";

function collect(stream) {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { value += chunk; });
  return () => value.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

class FakeMoneyHandAgent extends EventEmitter {
  constructor() {
    super();
    this.stopped = false;
  }

  async start() {
    return "ws://127.0.0.1:54321/extension";
  }

  async stop() {
    this.stopped = true;
  }

  capabilities() {
    return {
      protocol: MONEYHAND_CONTROL_PROTOCOL,
      wireProtocol: "npc-moneyhand/2",
      independent: true,
    };
  }

  status() {
    return { state: this.stopped ? "STOPPED" : "RUNNING" };
  }

  async execute(command) {
    if (command.op === "wait") {
      return await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => resolvePromise({ unexpected: true }), 5_000);
        const abort = () => {
          clearTimeout(timer);
          reject(new MoneyHandPeerError("ABORTED", "fake wait aborted"));
        };
        if (command.signal?.aborted) abort();
        else command.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (command.op === "request") {
      return { terminalId: command.request?.id ?? "generated" };
    }
    return this.status();
  }
}

test("standalone MoneyHand Skill starts a zero-dependency loopback listener", async (t) => {
  const agent = createMoneyHand({ host: "127.0.0.1", port: 0 });
  t.after(() => agent.stop({ graceMs: 0 }));
  const endpoint = await agent.start();
  assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/extension$/u);
  const capabilities = agent.capabilities();
  assert.equal(capabilities.protocol, MONEYHAND_CONTROL_PROTOCOL);
  assert.equal(capabilities.wireProtocol, "npc-moneyhand/2");
  assert.equal(capabilities.agentInterop.protocol, "npc-agent-jsonl/1");
  assert.equal(capabilities.taskSpaces.pinnedSession, true);
  assert.equal(agent.status().sessions.length, 0);
  await agent.stop({ graceMs: 0 });
  assert.equal(agent.status().state, "STOPPED");
});

test("MoneyHand JSONL exposes capability discovery and a correlated one-shot result", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const values = collect(output);
  const running = runJsonlMoneyHand({
    input,
    output,
    once: true,
    port: 0,
  });
  input.end(`${JSON.stringify({ id: "caps-1", op: "capabilities" })}\n`);
  await running;
  const messages = values();
  assert.equal(messages[0].event, "moneyhand.listening");
  assert.equal(
    messages[0].capabilities.transports.jsonl.maxInflight,
    MAX_JSONL_INFLIGHT,
  );
  assert.equal(
    messages.find((message) => message.id === "caps-1").value.hand.protocol,
    "npc-moneyhand/2",
  );
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("MoneyHand JSONL accepts canonical args, preserves legacy fields, and rejects mixing", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const values = collect(output);
  const agent = new FakeMoneyHandAgent();
  const running = runJsonlMoneyHand({ moneyhand: agent, input, output });
  input.end([
    JSON.stringify({
      id: "canonical-request",
      op: "request",
      args: { request: { id: "hand-request-1", method: "system.status", params: {} } },
    }),
    JSON.stringify({ id: "legacy-status", op: "status" }),
    JSON.stringify({ id: "mixed-status", op: "status", args: {}, timeoutMs: 100 }),
    "",
  ].join("\n"));
  await running;
  const messages = values();
  assert.equal(
    messages.find((message) => message.id === "canonical-request")?.value.terminalId,
    "hand-request-1",
  );
  assert.equal(messages.find((message) => message.id === "legacy-status")?.ok, true);
  assert.equal(
    messages.find((message) => message.id === "mixed-status")?.error.code,
    "INVALID_COMMAND",
  );
});

test("MoneyHand JSONL rejects invalid UTF-8 without losing the next command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const values = collect(output);
  const running = runJsonlMoneyHand({ input, output, once: true, port: 0 });
  input.write(Buffer.from([0xff, 0x0a]));
  input.end(`${JSON.stringify({ id: "after-invalid", op: "capabilities" })}\n`);
  await running;
  const messages = values();
  assert.equal(messages.find((message) => message.id === null).error.code, "INVALID_UTF8");
  assert.equal(messages.find((message) => message.id === "after-invalid").ok, true);
});

test("MoneyHand JSONL cancellation and drain are bounded local control operations", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const values = collect(output);
  const agent = new FakeMoneyHandAgent();
  const running = runJsonlMoneyHand({ moneyhand: agent, input, output });
  input.end([
    JSON.stringify({ id: "slow", op: "wait" }),
    JSON.stringify({ id: "cancel-1", op: "cancel", args: { targetId: "slow" } }),
    JSON.stringify({ id: "barrier", op: "drain" }),
    "",
  ].join("\n"));
  await running;
  const results = new Map(values()
    .filter((message) => message.type === "result")
    .map((message) => [message.id, message]));
  assert.equal(results.get("slow").ok, false);
  assert.equal(results.get("slow").error.code, "ABORTED");
  assert.equal(results.get("cancel-1").value.signalled, true);
  assert.ok(results.get("barrier").value.drained >= 1);
  assert.equal(agent.stopped, true);
});

test("MoneyHand task modules run many calls in one trusted local code pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, args }) {",
    "  return { args, capabilities: moneyhand.capabilities(), status: moneyhand.status() };",
    "}",
  ].join("\n"), "utf8");
  const agent = createMoneyHand({ port: 0 });
  await agent.start();
  t.after(() => agent.stop({ graceMs: 0 }));
  const value = await runMoneyHandTask({ moneyhand: agent, taskPath, args: { source: "cli" } });
  assert.deepEqual(value.args, { source: "cli" });
  assert.equal(value.capabilities.protocol, MONEYHAND_CONTROL_PROTOCOL);
  assert.equal(value.status.state, "RUNNING");
});

test("public MoneyHand CLI starts its listener without browser input", async () => {
  const script = resolve("skills/npc-moneyhand/scripts/moneyhand.mjs");
  const child = spawn(process.execPath, [script, "--once", "--internal-test-port", "0"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.end(`${JSON.stringify({ id: "status-1", op: "status" })}\n`);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(messages.find((message) => message.id === "status-1").value.state, "RUNNING");
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("MoneyHand JSONL releases its listener when output never drains", async () => {
  const input = new PassThrough();
  const agent = new FakeMoneyHandAgent();
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      // Intentionally never acknowledge the write or emit drain.
    },
  });
  await assert.rejects(
    runJsonlMoneyHand({ moneyhand: agent, input, output, outputDrainTimeoutMs: 50 }),
    (error) => error.code === "OUTPUT_BACKPRESSURE_TIMEOUT",
  );
  assert.equal(agent.stopped, true);
});

test("MoneyHand one-shot mode closes cleanly when stdin ends without a command", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const values = collect(output);
  input.end();
  await runJsonlMoneyHand({ input, output, once: true, onceTimeoutMs: 30, port: 0 });
  const messages = values();
  assert.equal(messages.some((message) => message.type === "result"), false);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("MoneyHand CLI cannot strand its listener behind unread Windows stdout", {
  skip: process.platform !== "win32",
}, async (t) => {
  const script = resolve("skills/npc-moneyhand/scripts/moneyhand.mjs");
  const child = spawn(process.execPath, [
    script,
    "--internal-test-port",
    "0",
    "--output-drain-timeout-ms",
    "50",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const commands = Array.from({ length: 500 }, (_, index) => JSON.stringify({
    id: `blocked-${index}`,
    op: "capabilities",
  })).join("\n");
  child.stdin.end(`${commands}\n`);
  let timer;
  const outcome = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code))),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise("timeout"), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.notEqual(outcome, "timeout");
  assert.equal(outcome, 1);
});
