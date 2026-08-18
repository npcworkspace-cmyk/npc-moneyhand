import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openRawWebSocket } from "./helpers/raw-websocket.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const moneyhandPath = join(root, "skills", "npc-moneyhand", "scripts", "moneyhand.mjs");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function openWebSocketEventually(port) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await openRawWebSocket({ host: "127.0.0.1", port, path: "/extension" });
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastError;
}

test("CLI --task runs a complete disposable module through one MoneyHand lifecycle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, args, signal }) {",
    "  const terminal = await moneyhand.request({ method: 'target.list', params: {} }, { signal });",
    "  return { args, terminal };",
    "}",
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--task",
    taskPath,
    "--args-json",
    JSON.stringify({ source: "cli" }),
    "--internal-test-port",
    "0",
    "--connect-timeout-ms",
    "3000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const messages = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const [firstLine] = await once(lines, "line");
  const listening = JSON.parse(firstLine);
  const endpoint = new URL(listening.endpoint);
  const opened = await openRawWebSocket({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  t.after(() => opened.client.destroy());
  opened.client.sendJson({
    v: 2,
    type: "hello",
    protocol: "npc-moneyhand/2",
    product: "npc-moneyhand",
    profile: "npc-task-cli",
    instanceId: "instance_task_cli",
    bootId: "boot_task_cli",
    version: "2.0.0-alpha.10",
    auth: { mode: "none" },
    focus: { windowId: 1, focused: true, lastFocusedAt: 1 },
    browser: { platform: { os: "test" } },
    unknownOutcomeIds: [],
    capabilities: { coordinateContract: "css-viewport-v1" },
  });
  const ready = await opened.client.nextJson();
  assert.equal(ready.type, "ready");
  const ping = await opened.client.nextJson();
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });
  const request = await opened.client.nextJson();
  assert.equal(request.method, "target.list");
  opened.client.sendJson({
    v: 2,
    type: "response",
    id: request.id,
    ok: true,
    result: { targets: [{ tabId: 42 }] },
  });
  const [code] = await waitForClose(child, 5_000);
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "task");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.args, { source: "cli" });
  assert.equal(result.value.terminal.result.targets[0].tabId, 42);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("CLI --connect returns one bounded connected result without probing tabs", async (t) => {
  const port = await unusedPort();
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--connect",
    "--internal-test-port",
    String(port),
    "--connect-timeout-ms",
    "3000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const messages = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const opened = await openWebSocketEventually(port);
  t.after(() => opened.client.destroy());
  opened.client.sendJson({
    v: 2,
    type: "hello",
    protocol: "npc-moneyhand/2",
    product: "npc-moneyhand",
    profile: "npc-connect-cli",
    instanceId: "instance_connect_cli",
    bootId: "boot_connect_cli",
    version: "1.0.0",
    auth: { mode: "none" },
    focus: { windowId: 2, focused: true, lastFocusedAt: 2 },
    browser: { platform: { os: "test" } },
    unknownOutcomeIds: [],
    capabilities: { coordinateContract: "css-viewport-v1" },
  });
  assert.equal((await opened.client.nextJson()).type, "ready");
  const ping = await opened.client.nextJson();
  assert.equal(ping.type, "ping");
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });

  const [code] = await waitForClose(child, 5_000);
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "connect");
  assert.equal(result.ok, true);
  assert.equal(result.value.schema, "npc-moneyhand-connect/1");
  assert.equal(result.value.status, "connected");
  assert.equal(result.value.connected, true);
  assert.equal(result.value.nextAction, "ask_user_for_task");
  assert.equal(messages.some((message) => message.event === "moneyhand.listening"), false);
  assert.equal(messages.some((message) => message.event === "moneyhand.connected"), false);
  assert.doesNotMatch(JSON.stringify(messages), /tabId|instance_connect_cli|boot_connect_cli/u);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

async function disconnectedConnect(extraArguments = []) {
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--connect",
    ...extraArguments,
    "--internal-test-port",
    "0",
    "--connect-timeout-ms",
    "25",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const [code] = await waitForClose(child, 5_000);
  return { code, messages };
}

async function missingExtensionConnect(extraArguments = []) {
  const browserRoot = await mkdtemp(join(tmpdir(), "npc-moneyhand-missing-extension-"));
  try {
    const child = spawn(process.execPath, [
      moneyhandPath,
      "--connect",
      ...extraArguments,
      "--internal-test-port",
      "0",
      "--browser-root",
      browserRoot,
      "--launch-grace-ms",
      "0",
      "--connect-timeout-ms",
      "25",
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const messages = [];
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => messages.push(JSON.parse(line)));
    const [code] = await waitForClose(child, 5_000);
    return { code, messages };
  } finally {
    await rm(browserRoot, { recursive: true, force: true });
  }
}

test("CLI --connect returns one fixed user action instead of open-ended troubleshooting", async () => {
  const { code, messages } = await disconnectedConnect();
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "connect");
  assert.equal(result.ok, true);
  assert.deepEqual({
    status: result.value.status,
    connected: result.value.connected,
    action: result.value.action,
    nextAction: result.value.nextAction,
    retryCommand: result.value.retryCommand,
  }, {
    status: "user_action_required",
    connected: false,
    action: "open_browser_and_click_extension",
    nextAction: "wait_for_user_then_retry_once",
    retryCommand: "node scripts/moneyhand.mjs --connect --after-user-action",
  });
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("CLI --connect stops after the single user-confirmed retry", async () => {
  const { code, messages } = await disconnectedConnect(["--after-user-action"]);
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "connect");
  assert.equal(result.ok, true);
  assert.deepEqual({
    status: result.value.status,
    connected: result.value.connected,
    code: result.value.code,
    action: result.value.action,
    nextAction: result.value.nextAction,
  }, {
    status: "blocked",
    connected: false,
    code: "CONNECT_RETRY_EXHAUSTED",
    action: "stop",
    nextAction: "report_and_stop",
  });
  assert.equal("retryCommand" in result.value, false);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("CLI missing-extension recovery uses the same single user-confirmed retry", async () => {
  const { code, messages } = await missingExtensionConnect();
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "connect");
  assert.deepEqual({
    status: result.value.status,
    connected: result.value.connected,
    action: result.value.action,
    nextAction: result.value.nextAction,
    retryCommand: result.value.retryCommand,
  }, {
    status: "user_action_required",
    connected: false,
    action: "install_extension",
    nextAction: "wait_for_user_then_retry_once",
    retryCommand: "node scripts/moneyhand.mjs --connect --after-user-action",
  });
  assert.match(result.value.userMessage, /立即连接/u);
});

test("CLI never repeats missing-extension recovery after the user-confirmed retry", async () => {
  const { code, messages } = await missingExtensionConnect(["--after-user-action"]);
  assert.equal(code, 0);
  const result = messages.find((message) => message.id === "connect");
  assert.deepEqual({
    status: result.value.status,
    connected: result.value.connected,
    code: result.value.code,
    action: result.value.action,
    nextAction: result.value.nextAction,
  }, {
    status: "blocked",
    connected: false,
    code: "CONNECT_RETRY_EXHAUSTED",
    action: "stop",
    nextAction: "report_and_stop",
  });
  assert.equal("retryCommand" in result.value, false);
});

async function waitForClose(child, timeoutMs = 4_000) {
  let timer;
  try {
    return await Promise.race([
      once(child, "close"),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(["timeout"]), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("CLI exits when its parent permanently stops reading stdout", async (t) => {
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--internal-test-port",
    "0",
    "--output-drain-timeout-ms",
    "50",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  child.stdin.on("error", () => {});
  const commands = Array.from({ length: 500 }, (_, index) => JSON.stringify({
    id: `blocked-${index}`,
    op: "capabilities",
  })).join("\n");
  child.stdin.end(`${commands}\n`, "utf8");

  const outcome = await waitForClose(child);
  assert.notEqual(outcome[0], "timeout", "CLI remained alive with a blocked stdout pipe");
  assert.equal(outcome[0], 1);
});

test("CLI fails when the Agent closes stdout before receiving results", async (t) => {
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--once",
    "--internal-test-port",
    "0",
    "--output-drain-timeout-ms",
    "50",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.destroy();
  child.stdin.end(`${JSON.stringify({ id: "closed-output", op: "capabilities" })}\n`);

  const outcome = await waitForClose(child);
  assert.notEqual(outcome[0], "timeout", "CLI remained alive after stdout closed");
  assert.equal(outcome[0], 1);
});

test("persistent CLI stops when stdout closes while stdin remains open", async (t) => {
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--internal-test-port",
    "0",
    "--output-drain-timeout-ms",
    "50",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.destroy();
  child.stdin.write(`${JSON.stringify({ id: "persistent-closed", op: "capabilities" })}\n`);

  const outcome = await waitForClose(child);
  assert.notEqual(outcome[0], "timeout", "persistent CLI ignored its closed stdout");
  assert.equal(outcome[0], 1);
});

test("CLI flushes a consumed result burst before successful exit", async (t) => {
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--internal-test-port",
    "0",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const commandCount = 500;
  const commands = Array.from({ length: commandCount }, (_, index) => JSON.stringify({
    id: `healthy-${index}`,
    op: "capabilities",
  })).join("\n");
  child.stdin.end(`${commands}\n`, "utf8");

  const outcome = await waitForClose(child, 6_000);
  assert.notEqual(outcome[0], "timeout", "CLI did not flush a healthy output consumer");
  assert.equal(outcome[0], 0, stderr);
  assert.equal(stderr, "", "CLI emitted a fatal error or listener warning during a healthy burst");
  const messages = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(messages.length, commandCount + 2);
  assert.equal(messages[0].event, "moneyhand.listening");
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
  assert.equal(
    new Set(messages.filter((message) => message.type === "result").map((message) => message.id))
      .size,
    commandCount,
  );
});
