import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ControllerServiceError,
  controllerServiceIdentity,
  controllerServiceStateFile,
  ensureControllerService,
  pingControllerService,
  requestControllerService,
  shutdownControllerService,
  startControllerService,
} from "../skills/npc-moneyhand/scripts/lib/controller-service.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const controllerModulePath = join(
  root,
  "skills",
  "npc-moneyhand",
  "scripts",
  "lib",
  "controller-service.mjs",
);

function statePathFor(sourcePath, port) {
  return controllerServiceStateFile({ sourcePath, port });
}

function controllerFixtureSource() {
  return [
    `import { startControllerService } from ${JSON.stringify(pathToFileURL(controllerModulePath).href)};`,
    "import './lib/runtime.mjs';",
    "import { once } from 'node:events';",
    "import { fileURLToPath } from 'node:url';",
    "const args = process.argv.slice(2);",
    "const portIndex = args.indexOf('--internal-controller-port');",
    "const port = Number(args[portIndex + 1]);",
    "const service = await startControllerService({",
    "  sourcePath: fileURLToPath(import.meta.url),",
    "  port,",
    "  idleTimeoutMs: 60000,",
    "  async handle() {},",
    "});",
    "if (args.includes('--crash-once')) process.exit(0);",
    "await once(service, 'close');",
  ].join("\n");
}

async function writeControllerFixture(rootPath, options = {}) {
  const scriptsPath = join(rootPath, "scripts");
  const sourcePath = join(scriptsPath, "moneyhand.mjs");
  await mkdir(join(scriptsPath, "lib"), { recursive: true });
  await Promise.all([
    writeFile(join(rootPath, "package.json"), `${JSON.stringify({
      name: "npc-moneyhand",
      version: options.version ?? "1.0.0",
      type: "module",
    })}\n`, "utf8"),
    writeFile(sourcePath, options.source ?? controllerFixtureSource(), "utf8"),
    writeFile(
      join(scriptsPath, "lib", "runtime.mjs"),
      options.runtime ?? "export const runtimeValue = 1;\n",
      "utf8",
    ),
  ]);
  return sourcePath;
}

function serviceRequest(service, options) {
  return requestControllerService({ ...service.clientOptions(), ...options });
}

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

test("controller service is localhost-only and preserves active work past idle timeout", async (t) => {
  const port = await unusedPort();
  const service = await startControllerService({
    port,
    idleTimeoutMs: 40,
    async handle(request, context) {
      assert.equal(request.command, "work");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 90));
      await context.send({ type: "result", id: "work", ok: true, value: 42 });
    },
  });
  t.after(() => service.stop());

  const response = await serviceRequest(service, {
    request: { command: "work" },
    timeoutMs: 1_000,
  });

  assert.equal(service.host, "127.0.0.1");
  assert.equal(response.ok, true);
  assert.equal(response.value.protocol, "npc-moneyhand-controller/2");
  assert.equal(response.value.product, "npc-moneyhand");
  assert.equal(response.value.version, "1.0.0");
  assert.match(response.value.build, /^[a-f0-9]{64}$/u);
  assert.match(response.value.sourceId, /^[a-f0-9]{64}$/u);
  assert.match(response.value.instanceNonce, /^[a-f0-9-]{36}$/u);
  assert.equal(Object.hasOwn(response.value, "token"), false);
  assert.deepEqual(response.messages, [
    { type: "result", id: "work", ok: true, value: 42 },
  ]);
  assert.equal(service.closed, false, "idle timeout fired while the command was active");
  if (!service.closed) await once(service, "close");
  assert.equal(service.closed, true);
});

test("controller stop closes a silent half-open client before awaiting server close", async () => {
  const port = await unusedPort();
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle() {},
  });
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  const clientClosed = once(socket, "close");

  const outcome = await Promise.race([
    service.stop().then(() => "stopped"),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise("timed-out"), 500)),
  ]);

  assert.equal(outcome, "stopped");
  await clientClosed;
  assert.equal(service.closed, true);
  assert.equal(service.server.listening, false);
});

test("controller rejects a client without its private instance proof", async (t) => {
  const port = await unusedPort();
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle() {
      assert.fail("unauthenticated request reached the controller handler");
    },
  });
  t.after(() => service.stop());
  const credentials = service.clientOptions();
  const wrongToken = `${credentials.token.startsWith("A") ? "B" : "A"}${credentials.token.slice(1)}`;

  await assert.rejects(
    requestControllerService({
      ...credentials,
      token: wrongToken,
      request: { command: "work" },
      timeoutMs: 500,
    }),
    (error) => error?.code === "CONTROLLER_PROTOCOL_ERROR",
  );
  assert.equal(service.active, 0);
});

test("controller build identity binds both the source path and source bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-controller-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstPath = await writeControllerFixture(join(directory, "first"));
  const secondPath = await writeControllerFixture(join(directory, "second"));
  const initial = controllerServiceIdentity(firstPath);
  const otherPath = controllerServiceIdentity(secondPath);
  assert.notEqual(initial.sourceId, otherPath.sourceId);
  assert.equal(initial.build, otherPath.build);

  await writeFile(
    join(directory, "second", "scripts", "lib", "runtime.mjs"),
    "export const runtimeValue = 2;\n",
    "utf8",
  );
  const changedLib = controllerServiceIdentity(secondPath);
  assert.equal(changedLib.sourceId, otherPath.sourceId);
  assert.notEqual(changedLib.build, initial.build);

  await writeFile(join(directory, "second", "package.json"), `${JSON.stringify({
    name: "npc-moneyhand",
    version: "1.0.1",
    type: "module",
  })}\n`, "utf8");
  const changedPackage = controllerServiceIdentity(secondPath);
  assert.equal(changedPackage.version, "1.0.1");
  assert.notEqual(changedPackage.build, changedLib.build);
});

test("identical Skill bytes at different paths reuse one controller across client processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-controller-path-reuse-"));
  const clientPath = join(directory, "ensure-client.mjs");
  const port = await unusedPort();
  let controllerStarted = false;
  t.after(async () => {
    if (controllerStarted) {
      await shutdownControllerService({ sourcePath: firstPath, port, timeoutMs: 1_000 }).catch(() => {});
    }
    await rm(statePathFor(firstPath, port), { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const [firstPath, secondPath, changedPath] = await Promise.all([
    writeControllerFixture(join(directory, "codex")),
    writeControllerFixture(join(directory, "workbuddy")),
    writeControllerFixture(join(directory, "claude"), {
      runtime: "export const runtimeValue = 2;\n",
    }),
  ]);
  await writeFile(clientPath, [
      `import { ensureControllerService } from ${JSON.stringify(pathToFileURL(controllerModulePath).href)};`,
      "const value = await ensureControllerService({ sourcePath: process.argv[2], port: Number(process.argv[3]) });",
      "process.stdout.write(`${JSON.stringify(value)}\\n`);",
    ].join("\n"), "utf8");
  const firstIdentity = controllerServiceIdentity(firstPath);
  const secondIdentity = controllerServiceIdentity(secondPath);
  const changedIdentity = controllerServiceIdentity(changedPath);
  assert.equal(firstIdentity.build, secondIdentity.build);
  assert.notEqual(firstIdentity.sourceId, secondIdentity.sourceId);
  assert.notEqual(firstIdentity.build, changedIdentity.build);

  const first = await ensureControllerService({ sourcePath: firstPath, port, startTimeoutMs: 3_000 });
  controllerStarted = true;
  assert.equal(first.reused, false);
  assert.equal(first.sourceId, firstIdentity.sourceId);
  const stateBeforeMismatch = await readFile(statePathFor(firstPath, port), "utf8");

  const secondClient = spawnSync(process.execPath, [clientPath, secondPath, String(port)], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(secondClient.status, 0, secondClient.stderr);
  const second = JSON.parse(secondClient.stdout);
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(second.instanceNonce, first.instanceNonce);
  assert.equal(second.sourceId, firstIdentity.sourceId, "status must audit the resident source path");

  await assert.rejects(
    ensureControllerService({ sourcePath: changedPath, port, startTimeoutMs: 250 }),
    (error) => error?.code === "CONTROLLER_IDENTITY_MISMATCH",
  );
  assert.equal(await readFile(statePathFor(changedPath, port), "utf8"), stateBeforeMismatch);
  const stillRunning = await pingControllerService({ sourcePath: firstPath, port, timeoutMs: 500 });
  assert.equal(stillRunning.pid, first.pid);
  assert.equal(stillRunning.instanceNonce, first.instanceNonce);
});

test("ensure recovers an owned state left by an exited controller process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-controller-stale-"));
  const sourcePath = await writeControllerFixture(join(directory, "skill"));
  const port = await unusedPort();
  let statePath;
  let controllerStarted = false;
  t.after(async () => {
    if (controllerStarted) {
      await shutdownControllerService({ sourcePath, port, timeoutMs: 1_000 }).catch(() => {});
    }
    if (statePath) await rm(statePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  statePath = statePathFor(sourcePath, port);

  const crashed = spawnSync(process.execPath, [
    sourcePath,
    "--crash-once",
    "--internal-controller-port",
    String(port),
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(crashed.status, 0, crashed.stderr);
  const rawState = await readFile(statePath, "utf8");
  const staleState = JSON.parse(rawState);
  assert.equal(staleState.schema, "npc-moneyhand-controller-state/1");
  assert.equal(staleState.host, "127.0.0.1");
  assert.equal(staleState.port, port);
  assert.equal(rawState.includes(sourcePath), false);
  assert.equal(statePath.includes("controller-fixture"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(statePath))).mode & 0o777, 0o700);
  }
  assert.equal(staleState.pid, crashed.pid);

  const status = await ensureControllerService({
    sourcePath,
    port,
    startTimeoutMs: 3_000,
  });
  controllerStarted = true;
  assert.equal(status.status, "running");
  assert.equal(status.reused, false);
  assert.notEqual(status.pid, staleState.pid);
  assert.notEqual(status.instanceNonce, staleState.instanceNonce);
  const liveState = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(liveState.pid, status.pid);
  assert.equal(liveState.instanceNonce, status.instanceNonce);
  assert.notEqual(liveState.token, staleState.token);
});

test("ensure replaces a dead owned state after an imported runtime library changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-moneyhand-controller-stale-upgrade-"));
  const sourcePath = await writeControllerFixture(join(directory, "skill"));
  const runtimePath = join(directory, "skill", "scripts", "lib", "runtime.mjs");
  const port = await unusedPort();
  const statePath = statePathFor(sourcePath, port);
  let controllerStarted = false;
  t.after(async () => {
    if (controllerStarted) {
      await shutdownControllerService({ sourcePath, port, timeoutMs: 1_000 }).catch(() => {});
    }
    await rm(statePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  });

  const crashed = spawnSync(process.execPath, [
    sourcePath,
    "--crash-once",
    "--internal-controller-port",
    String(port),
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(crashed.status, 0, crashed.stderr);
  const staleContents = await readFile(statePath, "utf8");
  const staleState = JSON.parse(staleContents);

  await writeFile(runtimePath, "export const runtimeValue = 2;\n", "utf8");
  const currentIdentity = controllerServiceIdentity(sourcePath);
  assert.notEqual(currentIdentity.build, staleState.build);
  const status = await ensureControllerService({ sourcePath, port, startTimeoutMs: 3_000 });
  controllerStarted = true;
  assert.equal(status.reused, false);
  assert.equal(status.build, currentIdentity.build);
  assert.notEqual(status.pid, staleState.pid);
  const currentContents = await readFile(statePath, "utf8");
  assert.notEqual(currentContents, staleContents);
  assert.equal(JSON.parse(currentContents).build, currentIdentity.build);
});

test("ensure leaves unknown private-state content untouched", async (t) => {
  const port = await unusedPort();
  const statePath = statePathFor(controllerModulePath, port);
  const unknownState = "{\"owner\":\"not-moneyhand\"}\n";
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, unknownState, { encoding: "utf8", flag: "wx" });
  t.after(() => rm(statePath, { force: true }));

  await assert.rejects(
    ensureControllerService({ sourcePath: controllerModulePath, port, startTimeoutMs: 250 }),
    (error) => error?.code === "CONTROLLER_STATE_INVALID",
  );
  assert.equal(await readFile(statePath, "utf8"), unknownState);
});

test("controller service serializes concurrent task commands", async (t) => {
  const port = await unusedPort();
  const order = [];
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle(request, context) {
      order.push(`start:${request.name}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      order.push(`end:${request.name}`);
      await context.send({ type: "result", id: request.name, ok: true });
    },
  });
  t.after(() => service.stop());

  const [first, second] = await Promise.all([
    serviceRequest(service, { request: { command: "task", name: "a" } }),
    serviceRequest(service, { request: { command: "task", name: "b" } }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
});

test("controller task survives a lost client and discards only that client's later delivery", async (t) => {
  const port = await unusedPort();
  let releaseTask;
  let markStarted;
  let markFinished;
  let signalAborted;
  let delivered;
  const taskStarted = new Promise((resolvePromise) => { markStarted = resolvePromise; });
  const taskRelease = new Promise((resolvePromise) => { releaseTask = resolvePromise; });
  const taskFinished = new Promise((resolvePromise) => { markFinished = resolvePromise; });
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle(request, context) {
      if (request.command === "quick") {
        await context.send({ type: "result", id: "quick", ok: true });
        return;
      }
      assert.equal(request.command, "task");
      markStarted();
      await taskRelease;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      signalAborted = context.signal.aborted;
      delivered = await context.send({ type: "result", id: "task", ok: true });
      markFinished();
    },
  });
  t.after(() => service.stop());

  const controller = new AbortController();
  const request = serviceRequest(service, {
    request: { command: "task" },
    signal: controller.signal,
  });
  await taskStarted;
  controller.abort(new Error("Agent client disappeared"));
  await assert.rejects(request, /Agent client disappeared/u);
  releaseTask();
  await taskFinished;

  assert.equal(signalAborted, false);
  assert.equal(delivered, false);
  const next = await serviceRequest(service, { request: { command: "quick" } });
  assert.equal(next.ok, true);
});

test("controller client disconnect aborts active work and leaves the service reusable", async (t) => {
  const port = await unusedPort();
  let aborted = false;
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle(request, context) {
      if (request.command === "quick") {
        await context.send({ type: "result", id: "quick", ok: true });
        return;
      }
      await new Promise((resolvePromise, rejectPromise) => {
        const onAbort = () => {
          aborted = true;
          rejectPromise(context.signal.reason);
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  t.after(() => service.stop());
  const controller = new AbortController();
  const request = serviceRequest(service, {
    request: { command: "long" },
    signal: controller.signal,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  controller.abort(new Error("caller stopped"));
  await assert.rejects(request, /caller stopped/u);
  for (let attempt = 0; attempt < 20 && !aborted; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(aborted, true);
  const next = await serviceRequest(service, { request: { command: "quick" } });
  assert.equal(next.ok, true);
});

test("controller shutdown aborts active work, skips queued work, and closes its own listener", async () => {
  const port = await unusedPort();
  let releaseStarted;
  const started = new Promise((resolvePromise) => { releaseStarted = resolvePromise; });
  const handled = [];
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle(request, context) {
      handled.push(request.command);
      if (request.command !== "long") {
        await context.send({ type: "result", id: request.command, ok: true });
        return;
      }
      releaseStarted();
      await new Promise((resolvePromise, rejectPromise) => {
        context.signal.addEventListener(
          "abort",
          () => rejectPromise(context.signal.reason),
          { once: true },
        );
      });
    },
  });

  const long = serviceRequest(service, {
    request: { command: "long" },
    timeoutMs: 2_000,
  });
  await started;
  const queued = serviceRequest(service, {
    request: { command: "queued" },
    timeoutMs: 2_000,
  });
  const shutdown = serviceRequest(service, {
    request: { command: "shutdown" },
    timeoutMs: 2_000,
  });

  const [longResult, queuedResult, shutdownResult] = await Promise.all([
    long,
    queued,
    shutdown,
  ]);
  assert.equal(longResult.ok, false);
  assert.equal(longResult.error.code, "CONTROLLER_SHUTDOWN");
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.error.code, "CONTROLLER_STOPPING");
  assert.deepEqual(shutdownResult.messages, [
    { type: "result", id: "shutdown", ok: true, value: { stopped: true } },
  ]);
  assert.deepEqual(handled, ["long"]);
  if (!service.closed) await once(service, "close");
  await assert.rejects(
    serviceRequest(service, { request: { command: "ping" }, timeoutMs: 100 }),
    /ECONNREFUSED|closed/u,
  );
});

test("controller handler can fail closed after an unresponsive command", async () => {
  const port = await unusedPort();
  const service = await startControllerService({
    port,
    idleTimeoutMs: 5_000,
    async handle(request, context) {
      context.stopAfterCommand();
      await context.send({
        type: "result",
        id: request.command,
        ok: false,
        error: { code: "TASK_TIMEOUT", message: "task ignored abort" },
      });
      throw new ControllerServiceError("TASK_TIMEOUT", "task ignored abort");
    },
  });

  const response = await serviceRequest(service, {
    request: { command: "task" },
    timeoutMs: 2_000,
  });
  assert.equal(response.ok, false);
  assert.equal(response.messages.length, 1);
  assert.equal(response.messages[0].error.code, "TASK_TIMEOUT");
  if (!service.closed) await once(service, "close");
});
