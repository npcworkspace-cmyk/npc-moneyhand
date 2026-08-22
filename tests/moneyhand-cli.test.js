import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openRawWebSocket } from "./helpers/raw-websocket.js";
import {
  controllerServiceIdentity,
  pingControllerService,
  requestControllerService,
} from "../skills/npc-moneyhand/scripts/lib/controller-service.mjs";
import {
  createTaskExecutionId,
  __test__ as taskLedgerTest,
} from "../skills/npc-moneyhand/scripts/lib/task-ledger.mjs";

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
  const progress = messages.filter((message) => message.event === "moneyhand.task_progress");
  assert.equal(progress[0].state, "started");
  assert.equal(progress.at(-1).state, "completed");
  assert.equal(messages.indexOf(progress[0]) < messages.indexOf(result), true);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

async function runCli(argumentsList, timeoutMs = 5_000) {
  const child = spawn(process.execPath, [moneyhandPath, ...argumentsList], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const outcome = await waitForClose(child, timeoutMs);
  if (outcome[0] === "timeout") child.kill();
  return {
    code: outcome[0],
    stderr,
    messages: stdout.trim()
      ? stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
      : [],
  };
}

async function readTextEventually(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${path}`);
}

test("CLI --ensure is idempotent under concurrent startup", async (t) => {
  const controllerPort = await unusedPort();
  const extensionPort = await unusedPort();
  t.after(() => runCli([
    "--internal-stop-controller",
    "--internal-controller-port",
    String(controllerPort),
  ]));

  const results = await Promise.all(Array.from({ length: 4 }, () => runCli([
    "--ensure",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--internal-controller-idle-ms",
    "60000",
    "--no-browser-launch",
  ])));

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    const envelope = result.messages.find((message) => message.id === "ensure");
    assert.equal(envelope.ok, true);
    assert.equal(envelope.value.status, "running");
    assert.equal(envelope.value.host, "127.0.0.1");
    assert.equal(envelope.value.port, controllerPort);
    assert.equal(envelope.value.protocol, "npc-moneyhand-controller/2");
    assert.equal(envelope.value.product, "npc-moneyhand");
    assert.equal(envelope.value.version, "1.2.0");
    assert.match(envelope.value.build, /^[a-f0-9]{64}$/u);
    assert.match(envelope.value.sourceId, /^[a-f0-9]{64}$/u);
    assert.match(envelope.value.instanceNonce, /^[a-f0-9-]{36}$/u);
    assert.equal(Object.hasOwn(envelope.value, "token"), false);
  }
  assert.equal(new Set(results.map((result) => (
    result.messages.find((message) => message.id === "ensure").value.pid
  ))).size, 1);
  assert.equal(new Set(results.map((result) => (
    result.messages.find((message) => message.id === "ensure").value.instanceNonce
  ))).size, 1);
});

test("CLI ensure and stop fail closed around an unknown localhost listener", async (t) => {
  const controllerPort = await unusedPort();
  const occupant = createServer(() => {});
  await new Promise((resolvePromise, reject) => {
    occupant.once("error", reject);
    occupant.listen(controllerPort, "127.0.0.1", resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => occupant.close(resolvePromise)));

  const ensured = await runCli([
    "--ensure",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-controller-idle-ms",
    "60000",
    "--no-browser-launch",
  ]);
  assert.equal(ensured.code, 1);
  assert.equal(
    ensured.messages.find((message) => message.type === "fatal").error.code,
    "CONTROLLER_PORT_OCCUPIED",
  );
  assert.equal(occupant.listening, true);

  const stopped = await runCli([
    "--stop",
    "--internal-controller-port",
    String(controllerPort),
  ]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(
    stopped.messages.find((message) => message.id === "shutdown").value,
    { stopped: false },
  );
  assert.equal(occupant.listening, true);
});

test("CLI --stop closes only the selected resident controller", async (t) => {
  const firstPort = await unusedPort();
  const secondPort = await unusedPort();
  t.after(() => Promise.all([firstPort, secondPort].map((port) => runCli([
    "--stop",
    "--internal-controller-port",
    String(port),
  ]))));
  const first = await runCli([
    "--ensure", "--internal-controller-port", String(firstPort),
    "--internal-controller-idle-ms", "60000", "--no-browser-launch",
  ]);
  const second = await runCli([
    "--ensure", "--internal-controller-port", String(secondPort),
    "--internal-controller-idle-ms", "60000", "--no-browser-launch",
  ]);
  const firstPid = first.messages.find((message) => message.id === "ensure").value.pid;
  const secondPid = second.messages.find((message) => message.id === "ensure").value.pid;
  assert.notEqual(firstPid, secondPid);

  const stopped = await runCli([
    "--stop", "--internal-controller-port", String(firstPort),
  ]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(
    stopped.messages.find((message) => message.id === "shutdown").value,
    { stopped: true },
  );
  const secondStillRunning = await runCli([
    "--ensure", "--internal-controller-port", String(secondPort),
    "--internal-controller-idle-ms", "60000", "--no-browser-launch",
  ]);
  const status = secondStillRunning.messages.find((message) => message.id === "ensure").value;
  assert.equal(status.pid, secondPid);
  assert.equal(status.reused, true);
});

test("CLI --stop preempts an unresponsive isolated task and releases its Node handles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-stop-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  const portPath = join(directory, "worker-port.txt");
  await writeFile(taskPath, [
    "import { createServer } from 'node:net';",
    "import { writeFile } from 'node:fs/promises';",
    "export async function run({ args }) {",
    "  const server = createServer((socket) => socket.end('worker'));",
    "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });",
    "  await writeFile(args.portPath, String(server.address().port), 'utf8');",
    "  await new Promise(() => {});",
    "}",
  ].join("\n"), "utf8");
  const controllerPort = await unusedPort();
  const extensionPort = await unusedPort();
  t.after(() => runCli([
    "--internal-stop-controller",
    "--internal-controller-port",
    String(controllerPort),
  ]));
  const ensured = await runCli([
    "--ensure",
    "--internal-controller-port", String(controllerPort),
    "--internal-test-port", String(extensionPort),
    "--internal-controller-idle-ms", "60000",
    "--connect-timeout-ms", "3000",
    "--no-browser-launch",
  ]);
  assert.equal(ensured.code, 0, ensured.stderr);

  const taskChild = spawn(process.execPath, [
    moneyhandPath,
    "--task", taskPath,
    "--args-json", JSON.stringify({ portPath }),
    "--internal-controller-port", String(controllerPort),
    "--internal-test-port", String(extensionPort),
    "--connect-timeout-ms", "3000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (taskChild.exitCode === null && taskChild.signalCode === null) taskChild.kill();
  });
  const taskMessages = [];
  createInterface({ input: taskChild.stdout, crlfDelay: Infinity })
    .on("line", (line) => taskMessages.push(JSON.parse(line)));
  const opened = await openWebSocketEventually(extensionPort);
  t.after(() => opened.client.destroy());
  opened.client.sendJson({
    v: 2,
    type: "hello",
    protocol: "npc-moneyhand/2",
    product: "npc-moneyhand",
    profile: "npc-stop-task-cli",
    instanceId: "instance_stop_task_cli",
    bootId: "boot_stop_task_cli",
    version: "1.2.0",
    auth: { mode: "none" },
    focus: { windowId: 9, focused: true, lastFocusedAt: 9 },
    browser: { platform: { os: "test" } },
    unknownOutcomeIds: [],
    capabilities: { coordinateContract: "css-viewport-v1" },
  });
  assert.equal((await opened.client.nextJson()).type, "ready");
  const ping = await opened.client.nextJson();
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });
  const workerPort = Number(await readTextEventually(portPath));
  assert.equal(Number.isInteger(workerPort), true);

  const stopStartedAt = Date.now();
  const stopped = await runCli([
    "--stop",
    "--internal-controller-port", String(controllerPort),
  ], 12_000);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(Date.now() - stopStartedAt < 10_000, true);
  assert.equal(stopped.messages.find((message) => message.id === "shutdown")?.value?.stopped, true);
  const taskExit = taskChild.exitCode === null
    ? (await waitForClose(taskChild, 3_000))[0]
    : taskChild.exitCode;
  assert.equal(taskExit, 1);
  assert.equal(taskMessages.find((message) => message.id === "task")?.error?.code, "CONTROLLER_SHUTDOWN");
  await assert.rejects(new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: "127.0.0.1", port: workerPort });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", rejectPromise);
  }));
  await assert.rejects(
    pingControllerService({ sourcePath: moneyhandPath, port: controllerPort, timeoutMs: 100 }),
  );
});

test("CLI resident controller keeps the extension connection across connect and task", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-resident-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, progress }) {",
    "  await progress({ phase: 'collect', current: 0, total: 1, message: 'Preparing one request' });",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10500);",
    "  return await moneyhand.request({ method: 'target.list', params: {} });",
    "}",
  ].join("\n"), "utf8");
  const controllerPort = await unusedPort();
  const extensionPort = await unusedPort();
  t.after(() => runCli([
    "--internal-stop-controller",
    "--internal-controller-port",
    String(controllerPort),
  ]));
  const connectChild = spawn(process.execPath, [
    moneyhandPath,
    "--connect",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--connect-timeout-ms",
    "3000",
    "--internal-controller-idle-ms",
    "60000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const connectMessages = [];
  createInterface({ input: connectChild.stdout, crlfDelay: Infinity })
    .on("line", (line) => connectMessages.push(JSON.parse(line)));
  const opened = await openWebSocketEventually(extensionPort);
  t.after(() => opened.client.destroy());
  opened.client.sendJson({
    v: 2,
    type: "hello",
    protocol: "npc-moneyhand/2",
    product: "npc-moneyhand",
    profile: "npc-resident-cli",
    instanceId: "instance_resident_cli",
    bootId: "boot_resident_cli",
    version: "1.2.0",
    auth: { mode: "none" },
    focus: { windowId: 3, focused: true, lastFocusedAt: 3 },
    browser: { platform: { os: "test" } },
    unknownOutcomeIds: [],
    capabilities: { coordinateContract: "css-viewport-v1" },
  });
  assert.equal((await opened.client.nextJson()).type, "ready");
  const ping = await opened.client.nextJson();
  assert.equal(ping.type, "ping");
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });
  assert.equal((await waitForClose(connectChild, 5_000))[0], 0);
  assert.equal(connectMessages.find((message) => message.id === "connect").ok, true);

  const taskChild = spawn(process.execPath, [
    moneyhandPath,
    "--task",
    taskPath,
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--connect-timeout-ms",
    "3000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const taskMessages = [];
  const taskLines = createInterface({ input: taskChild.stdout, crlfDelay: Infinity });
  const isolatedHeartbeatSeen = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for isolated task heartbeat")), 13_000);
    taskLines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.event === "moneyhand.task_progress" && message.phase === "heartbeat") {
        clearTimeout(timer);
        resolvePromise(message);
      }
    });
  });
  const progressSeen = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for streamed task progress")), 2_000);
    taskLines.on("line", (line) => {
      const message = JSON.parse(line);
      taskMessages.push(message);
      if (message.event === "moneyhand.task_progress"
        && message.phase === "collect"
        && message.current === 0) {
        clearTimeout(timer);
        resolvePromise(message);
      }
    });
  });
  const streamedProgress = await progressSeen;
  assert.equal(streamedProgress.state, "running");
  assert.equal(taskChild.exitCode, null, "progress was buffered until task completion");
  const isolatedHeartbeat = await isolatedHeartbeatSeen;
  assert.equal(isolatedHeartbeat.schema, "npc-moneyhand-task-progress/1");
  assert.equal(isolatedHeartbeat.silenceMs >= 10_000, true);
  assert.equal(taskChild.exitCode, null, "the isolated task blocked the resident controller");
  while (true) {
    const request = await opened.client.nextJson();
    if (request.type === "ping") {
      opened.client.sendJson({ v: 2, type: "pong", timestamp: request.timestamp });
      continue;
    }
    assert.equal(request.method, "target.list");
    opened.client.sendJson({
      v: 2,
      type: "response",
      id: request.id,
      ok: true,
      result: { targets: [{ tabId: 77 }] },
    });
    break;
  }
  assert.equal((await waitForClose(taskChild, 5_000))[0], 0);
  assert.equal(taskMessages.find((message) => message.id === "task").value.result.targets[0].tabId, 77);
  assert.equal(taskMessages.filter((message) => message.event === "moneyhand.task_progress").at(-1).state, "completed");
  assert.equal(taskMessages.some((message) => message.error?.code === "EADDRINUSE"), false);

  const callChild = spawn(process.execPath, [
    moneyhandPath,
    "--call",
    "target.list",
    "--params-json",
    "{}",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--connect-timeout-ms",
    "3000",
    "--no-browser-launch",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let callStdout = "";
  callChild.stdout.setEncoding("utf8");
  callChild.stdout.on("data", (chunk) => { callStdout += chunk; });
  while (true) {
    const request = await opened.client.nextJson();
    if (request.type === "ping") {
      opened.client.sendJson({ v: 2, type: "pong", timestamp: request.timestamp });
      continue;
    }
    assert.equal(request.method, "target.list");
    opened.client.sendJson({
      v: 2,
      type: "response",
      id: request.id,
      ok: true,
      result: { targets: [{ tabId: 88 }] },
    });
    break;
  }
  assert.equal((await waitForClose(callChild, 5_000))[0], 0);
  const callMessages = callStdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(callMessages.find((message) => message.id === "call").value.result.targets[0].tabId, 88);
  assert.equal(callMessages.some((message) => message.error?.code === "EADDRINUSE"), false);
});

test("CLI task survives client loss and a fresh Agent follows its private journal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-reattach-"));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, [
    "export async function run({ moneyhand, progress }) {",
    "  await progress({ phase: 'collect', current: 0, total: 1, checkpoint: 'before-read', message: 'Checkpointed before delayed read' });",
    "  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));",
    "  const terminal = await moneyhand.request({ method: 'target.list', params: {} });",
    "  return { status: 'complete', terminal, requirements: [{ id: 'one-read', satisfied: true, expected: 1, actual: 1 }] };",
    "}",
  ].join("\n"), "utf8");
  const controllerPort = await unusedPort();
  const extensionPort = await unusedPort();
  const taskExecutionId = createTaskExecutionId();
  t.after(async () => {
    await runCli([
      "--stop",
      "--internal-controller-port",
      String(controllerPort),
    ]).catch(() => {});
    const build = controllerServiceIdentity(moneyhandPath).build;
    const paths = taskLedgerTest.ledgerPaths({ build, id: taskExecutionId });
    await Promise.all([
      rm(paths.eventsPath, { force: true }),
      rm(paths.metaPath, { force: true }),
      rm(paths.evidencePath, { force: true }),
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const ensured = await runCli([
    "--ensure",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--internal-controller-idle-ms",
    "60000",
    "--connect-timeout-ms",
    "3000",
    "--no-browser-launch",
  ]);
  assert.equal(ensured.code, 0, ensured.stderr);

  const detacher = new AbortController();
  let resolveCheckpoint;
  const checkpoint = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for journaled checkpoint")), 5_000);
    resolveCheckpoint = (message) => {
      if (message.event === "moneyhand.task_progress" && message.checkpoint === "before-read") {
        clearTimeout(timer);
        resolvePromise(message);
      }
    };
  });
  const detachedRequest = requestControllerService({
    sourcePath: moneyhandPath,
    port: controllerPort,
    request: {
      command: "task",
      taskExecutionId,
      taskPath,
      taskArgs: {},
      taskTimeoutMs: 10_000,
      taskAbortGraceMs: 1_000,
      connectTimeoutMs: 3_000,
      autoLaunchBrowser: false,
    },
    timeoutMs: 15_000,
    signal: detacher.signal,
    onMessage(message) {
      resolveCheckpoint?.(message);
    },
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

  const opened = await openWebSocketEventually(extensionPort);
  t.after(() => opened.client.destroy());
  opened.client.sendJson({
    v: 2,
    type: "hello",
    protocol: "npc-moneyhand/2",
    product: "npc-moneyhand",
    profile: "npc-reattach-cli",
    instanceId: "instance_reattach_cli",
    bootId: "boot_reattach_cli",
    version: "1.2.0",
    auth: { mode: "none" },
    focus: { windowId: 5, focused: true, lastFocusedAt: 5 },
    browser: { platform: { os: "test" } },
    unknownOutcomeIds: [],
    capabilities: { coordinateContract: "css-viewport-v1" },
  });
  assert.equal((await opened.client.nextJson(3_000)).type, "ready");
  const confirmation = await opened.client.nextJson(3_000);
  assert.equal(confirmation.type, "ping");
  opened.client.sendJson({ v: 2, type: "pong", timestamp: confirmation.timestamp });
  await checkpoint;
  detacher.abort(new Error("simulated Agent disconnect"));
  const detached = await detachedRequest;
  assert.equal(detached.ok, false);

  const followChild = spawn(process.execPath, [
    moneyhandPath,
    "--task-follow",
    taskExecutionId,
    "--internal-controller-port",
    String(controllerPort),
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (followChild.exitCode === null && followChild.signalCode === null) followChild.kill();
  });
  followChild.stderr.setEncoding("utf8");
  let followError = "";
  followChild.stderr.on("data", (chunk) => { followError += chunk; });
  const followMessages = [];
  createInterface({ input: followChild.stdout, crlfDelay: Infinity })
    .on("line", (line) => followMessages.push(JSON.parse(line)));

  while (true) {
    const request = await opened.client.nextJson(4_000);
    if (request.type === "ping") {
      opened.client.sendJson({ v: 2, type: "pong", timestamp: request.timestamp });
      continue;
    }
    assert.equal(request.method, "target.list");
    opened.client.sendJson({
      v: 2,
      type: "response",
      id: request.id,
      ok: true,
      result: { targets: [{ tabId: 501 }] },
    });
    break;
  }
  assert.equal((await waitForClose(followChild, 8_000))[0], 0, followError);
  const status = followMessages.find((message) => message.event === "moneyhand.task_status");
  assert.equal(status.status.state, "running");
  assert.equal(status.taskSummary.schema, "npc-moneyhand-task-summary/1");
  assert.equal(status.taskSummary.state, "running");
  assert.deepEqual(status.taskSummary, status.status.taskSummary);
  assert.equal(status.taskSummary.nextAction, "continue-task-follow");
  const terminal = followMessages.find((message) => message.type === "result" && message.id === "task");
  assert.equal(terminal.ok, true);
  assert.equal(terminal.reattached, true);
  assert.equal(terminal.value.terminal.result.targets[0].tabId, 501);
  assert.equal(terminal.completionGate.passed, true);
  assert.equal(terminal.taskEvidence.artifact.private, true);
  assert.equal(terminal.taskSummary.state, "completed");
  assert.equal(terminal.taskSummary.nextAction, "none");

  const queried = await runCli([
    "--task-status",
    taskExecutionId,
    "--internal-controller-port",
    String(controllerPort),
  ]);
  assert.equal(queried.code, 0, queried.stderr);
  const queriedStatus = queried.messages.find((message) => message.id === "task-status").value;
  assert.equal(queriedStatus.state, "completed");
  assert.equal(queriedStatus.terminal.ok, true);
  assert.equal(queriedStatus.taskSummary.state, "completed");
  assert.equal(queriedStatus.taskSummary.nextAction, "none");
});

test("CLI exits nonzero when a task result is ok false", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-failing-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, "export async function run() { throw new Error('task exploded'); }\n", "utf8");
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--task",
    taskPath,
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
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  const [firstLine] = await once(lines, "line");
  const endpoint = new URL(JSON.parse(firstLine).endpoint);
  const opened = await openRawWebSocket({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  opened.client.sendJson({
    v: 2, type: "hello", protocol: "npc-moneyhand/2", product: "npc-moneyhand",
    profile: "npc-failure-cli", instanceId: "instance_failure_cli", bootId: "boot_failure_cli",
    version: "1.2.0", auth: { mode: "none" }, focus: { windowId: 1, focused: true, lastFocusedAt: 1 },
    browser: { platform: { os: "test" } }, unknownOutcomeIds: [], capabilities: { coordinateContract: "css-viewport-v1" },
  });
  await opened.client.nextJson();
  const ping = await opened.client.nextJson();
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });
  assert.equal((await waitForClose(child, 5_000))[0], 1);
  const result = messages.find((message) => message.id === "task");
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "task exploded");
  assert.equal(result.error.details.recovery.schema, "npc-moneyhand-task-recovery/1");
  assert.equal(result.error.details.recovery.rootCause.message, "task exploded");
  assert.equal(typeof result.error.details.recovery.nextAction, "string");
  assert.equal(result.taskSummary.schema, "npc-moneyhand-task-summary/1");
  assert.equal(result.taskSummary.state, "failed");
  assert.equal(result.taskSummary.nextAction, result.error.details.recovery.nextAction);
  opened.client.destroy();
});

test("CLI --task emits one bounded TASK_TIMEOUT when a module ignores abort", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-cli-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "task.mjs");
  await writeFile(taskPath, "export async function run() { await new Promise(() => {}); }\n", "utf8");
  const child = spawn(process.execPath, [
    moneyhandPath,
    "--task", taskPath,
    "--task-timeout-ms", "20",
    "--internal-task-abort-grace-ms", "20",
    "--internal-test-port", "0",
    "--connect-timeout-ms", "3000",
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
  const endpoint = new URL(JSON.parse(firstLine).endpoint);
  const opened = await openRawWebSocket({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  opened.client.sendJson({
    v: 2, type: "hello", protocol: "npc-moneyhand/2", product: "npc-moneyhand",
    profile: "npc-timeout-cli", instanceId: "instance_timeout_cli", bootId: "boot_timeout_cli",
    version: "1.2.0", auth: { mode: "none" }, focus: { windowId: 1, focused: true, lastFocusedAt: 1 },
    browser: { platform: { os: "test" } }, unknownOutcomeIds: [], capabilities: { coordinateContract: "css-viewport-v1" },
  });
  await opened.client.nextJson();
  const ping = await opened.client.nextJson();
  opened.client.sendJson({ v: 2, type: "pong", timestamp: ping.timestamp });

  assert.equal((await waitForClose(child, 5_000))[0], 1);
  const results = messages.filter((message) => message.id === "task");
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, "TASK_TIMEOUT");
  assert.equal(results[0].error.details.taskAcknowledgedAbort, false);
  assert.equal(results[0].error.details.controllerReusable, false);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
  opened.client.destroy();
});

test("CLI --connect returns one bounded ready result on its isolated test port", async (t) => {
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
    version: "1.2.0",
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
  assert.equal(result.value.nextAction, "ready_for_tasks");
  assert.deepEqual(result.value.taskRouting, {
    currentConversationHasTask: "continue_immediately_without_reconfirmation",
    noConcreteTask: "ask_user_for_task",
    stopAfterConnectWhenTaskExists: "invalid",
    taskModule: "copy_and_implement_never_run_packaged_template",
  });
  assert.match(result.value.userMessage, /已有具体任务.*立即继续/u);
  assert.equal(result.value.acceptance.status, "not_run");
  assert.equal(result.value.acceptance.reason, "isolated-test-port");
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

test("resident controller stops itself after a terminal blocked connect result", async (t) => {
  const controllerPort = await unusedPort();
  const extensionPort = await unusedPort();
  t.after(() => runCli([
    "--stop",
    "--internal-controller-port",
    String(controllerPort),
  ]));
  const result = await runCli([
    "--connect",
    "--after-user-action",
    "--internal-controller-port",
    String(controllerPort),
    "--internal-test-port",
    String(extensionPort),
    "--internal-controller-idle-ms",
    "60000",
    "--connect-timeout-ms",
    "25",
    "--no-browser-launch",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.messages.find((message) => message.id === "connect").value.status, "blocked");

  let stopped = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pingControllerService({ sourcePath: moneyhandPath, port: controllerPort, timeoutMs: 50 });
    } catch {
      stopped = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(stopped, true, "blocked connect left the resident controller running");
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
