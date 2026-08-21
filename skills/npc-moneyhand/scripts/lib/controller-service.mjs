import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROLLER_SERVICE_PROTOCOL = "npc-moneyhand-controller/2";
export const DEFAULT_CONTROLLER_HOST = "127.0.0.1";
export const DEFAULT_CONTROLLER_PORT = 19_845;
export const DEFAULT_CONTROLLER_IDLE_MS = 15 * 60_000;

const CONTROLLER_STATE_SCHEMA = "npc-moneyhand-controller-state/1";
const CONTROLLER_TOKEN_ENV = "NPC_MONEYHAND_INTERNAL_CONTROLLER_TOKEN";
const CONTROLLER_MODULE_PATH = fileURLToPath(import.meta.url);
const MAX_BUILD_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_BUILD_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_BUILD_FILES = 512;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 86_700_000;
const START_TIMEOUT_MS = 5_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CONTROLLER_STATE_USER = typeof process.getuid === "function"
  ? String(process.getuid())
  : sha256(userInfo().username).slice(0, 16);
const CONTROLLER_STATE_DIRECTORY = join(tmpdir(), `npc-moneyhand-controller-${CONTROLLER_STATE_USER}`);

function boundedFileBytes(path, name) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_BUILD_SOURCE_BYTES) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_SOURCE",
      `${name} must be a file no larger than ${MAX_BUILD_SOURCE_BYTES} bytes`,
    );
  }
  return readFileSync(path);
}

function canonicalSourcePath(sourcePath) {
  const candidate = resolve(sourcePath ?? CONTROLLER_MODULE_PATH);
  const canonical = realpathSync.native(candidate);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function runtimePackageForSource(canonicalSource) {
  let candidate = dirname(canonicalSource);
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = join(candidate, "package.json");
    const scriptsPath = join(candidate, "scripts");
    try {
      const packageStats = lstatSync(packagePath);
      const scriptsStats = lstatSync(scriptsPath);
      const sourceRelative = relative(realpathSync.native(scriptsPath), canonicalSource);
      if (packageStats.isSymbolicLink() || scriptsStats.isSymbolicLink()) {
        throw new ControllerServiceError(
          "INVALID_CONTROLLER_SOURCE",
          "MoneyHand runtime package and scripts directory must not be symbolic links",
        );
      }
      if (packageStats.isFile() && scriptsStats.isDirectory()
        && sourceRelative !== ".."
        && !sourceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        return { packagePath, rootPath: candidate, scriptsPath: realpathSync.native(scriptsPath) };
      }
    } catch (error) {
      if (error instanceof ControllerServiceError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new ControllerServiceError(
    "INVALID_CONTROLLER_SOURCE",
    "Controller source must belong to a Skill containing package.json and scripts/",
  );
}

function runtimeMjsFiles(directory, root, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => lexicalCompare(left.name, right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ControllerServiceError(
        "INVALID_CONTROLLER_SOURCE",
        `MoneyHand runtime must not contain symbolic links: ${relative(root, path)}`,
      );
    }
    if (entry.isDirectory()) runtimeMjsFiles(path, root, output);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(path);
  }
  return output;
}

function controllerRuntimeIdentity(sourcePath) {
  const canonicalSource = canonicalSourcePath(sourcePath);
  const runtime = runtimePackageForSource(canonicalSource);
  const files = [runtime.packagePath, ...runtimeMjsFiles(runtime.scriptsPath, runtime.rootPath)]
    .map((path) => ({ path, name: relative(runtime.rootPath, path).replaceAll("\\", "/") }))
    .sort((left, right) => lexicalCompare(left.name, right.name));
  if (files.length > MAX_RUNTIME_BUILD_FILES) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_SOURCE",
      `MoneyHand runtime exceeds ${MAX_RUNTIME_BUILD_FILES} hashed files`,
    );
  }
  const hash = createHash("sha256");
  let totalBytes = 0;
  let packageValue;
  for (const file of files) {
    if (lstatSync(file.path).isSymbolicLink()) {
      throw new ControllerServiceError("INVALID_CONTROLLER_SOURCE", `Runtime file is a symbolic link: ${file.name}`);
    }
    const bytes = boundedFileBytes(file.path, file.name);
    totalBytes += bytes.length;
    if (totalBytes > MAX_RUNTIME_BUILD_BYTES) {
      throw new ControllerServiceError(
        "INVALID_CONTROLLER_SOURCE",
        `MoneyHand runtime exceeds ${MAX_RUNTIME_BUILD_BYTES} hashed bytes`,
      );
    }
    hash.update(`${file.name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
    if (file.path === runtime.packagePath) {
      try {
        packageValue = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ControllerServiceError("INVALID_CONTROLLER_SOURCE", "MoneyHand package.json is not valid JSON");
      }
    }
  }
  if (typeof packageValue?.name !== "string" || packageValue.name.length === 0
    || typeof packageValue?.version !== "string" || packageValue.version.length === 0) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_SOURCE",
      "MoneyHand package.json must declare non-empty name and version",
    );
  }
  return {
    build: hash.digest("hex"),
    canonicalSource,
    product: packageValue.name,
    version: packageValue.version,
  };
}

export function controllerServiceIdentity(sourcePath) {
  const runtime = controllerRuntimeIdentity(sourcePath ?? CONTROLLER_MODULE_PATH);
  return Object.freeze({
    protocol: CONTROLLER_SERVICE_PROTOCOL,
    product: runtime.product,
    version: runtime.version,
    build: runtime.build,
    sourceId: sha256(runtime.canonicalSource),
  });
}

function controllerStatePath(port) {
  return join(CONTROLLER_STATE_DIRECTORY, `controller-${port}.json`);
}

export function controllerServiceStateFile(options = {}) {
  const port = positiveInteger(options.port, DEFAULT_CONTROLLER_PORT, "port");
  return controllerStatePath(port);
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function privateToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_OPTION",
      "Controller private token must be a 32-byte base64url value",
    );
  }
  return value;
}

function sameString(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sameBuild(left, right) {
  return left?.protocol === right?.protocol
    && left?.product === right?.product
    && left?.version === right?.version
    && left?.build === right?.build;
}

function sameIdentity(left, right) {
  return sameBuild(left, right) && left?.sourceId === right?.sourceId;
}

function sameController(left, right) {
  return sameIdentity(left, right)
    && left?.pid === right?.pid
    && left?.instanceNonce === right?.instanceNonce;
}

function controllerDescriptor(value) {
  return {
    protocol: value.protocol,
    product: value.product,
    version: value.version,
    build: value.build,
    sourceId: value.sourceId,
    pid: value.pid,
    instanceNonce: value.instanceNonce,
  };
}

export class ControllerServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ControllerServiceError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const CONTROLLER_PACKAGE_IDENTITY = controllerRuntimeIdentity(CONTROLLER_MODULE_PATH);
export const CONTROLLER_SERVICE_PRODUCT = CONTROLLER_PACKAGE_IDENTITY.product;
export const CONTROLLER_SERVICE_VERSION = CONTROLLER_PACKAGE_IDENTITY.version;

function normalizedError(error, fallbackCode = "CONTROLLER_FAILED") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

function controllerState(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== CONTROLLER_STATE_SCHEMA
    || value.host !== DEFAULT_CONTROLLER_HOST
    || !Number.isInteger(value.port)
    || !Number.isInteger(value.pid)
    || value.pid < 1
    || typeof value.instanceNonce !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.instanceNonce)
    || typeof value.token !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)
    || typeof value.protocol !== "string"
    || typeof value.product !== "string"
    || typeof value.version !== "string"
    || typeof value.build !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.build)
    || typeof value.sourceId !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.sourceId)) {
    throw new ControllerServiceError(
      "CONTROLLER_STATE_INVALID",
      "Controller private state is invalid; refusing to trust or replace it",
    );
  }
  if (expected.port !== undefined && value.port !== expected.port) {
    throw new ControllerServiceError("CONTROLLER_STATE_INVALID", "Controller state port does not match");
  }
  if (expected.sourceId !== undefined && value.sourceId !== expected.sourceId) {
    throw new ControllerServiceError(
      "CONTROLLER_STATE_FOREIGN",
      "Controller state belongs to another MoneyHand source",
    );
  }
  return value;
}

async function readControllerStateRecord(path, expected = {}) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return { contents, state: controllerState(JSON.parse(contents), expected) };
  } catch (error) {
    if (error instanceof ControllerServiceError) throw error;
    throw new ControllerServiceError(
      "CONTROLLER_STATE_INVALID",
      "Controller private state is not valid JSON; refusing to replace it",
    );
  }
}

async function readControllerState(path, expected = {}) {
  return (await readControllerStateRecord(path, expected))?.state ?? null;
}

async function writeControllerState(path, state) {
  await mkdir(CONTROLLER_STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  await chmod(CONTROLLER_STATE_DIRECTORY, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporaryPath, path);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ControllerServiceError(
        "CONTROLLER_STATE_CONFLICT",
        "Controller private state already exists; refusing to replace it",
      );
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function removeControllerState(path, owner, expectedContents) {
  const currentRecord = await readControllerStateRecord(path, { port: owner.port });
  if (currentRecord === null) return false;
  if (expectedContents !== undefined && currentRecord.contents !== expectedContents) return false;
  const current = currentRecord.state;
  if (!sameController(current, owner) || !sameString(current.token, owner.token)) return false;
  await rm(path, { force: true });
  return true;
}

function serviceCredentials(service) {
  return {
    port: service.port,
    controller: service.descriptor(),
    token: service.authToken,
  };
}

async function sourceCredentials(options, requireCurrentIdentity = true) {
  if (options.controller && typeof options.token === "string") {
    return { controller: controllerDescriptor(options.controller), token: options.token };
  }
  if (typeof options.sourcePath !== "string" || options.sourcePath.length === 0) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_OPTION",
      "sourcePath or controller credentials are required",
    );
  }
  const port = positiveInteger(options.port, DEFAULT_CONTROLLER_PORT, "port");
  const expectedIdentity = controllerServiceIdentity(options.sourcePath);
  const state = await readControllerState(controllerStatePath(port), { port });
  if (state === null) {
    throw new ControllerServiceError("CONTROLLER_UNAVAILABLE", "Controller private state was not found");
  }
  if (requireCurrentIdentity && !sameBuild(state, expectedIdentity)) {
    throw new ControllerServiceError(
      "CONTROLLER_IDENTITY_MISMATCH",
      "Controller state belongs to another MoneyHand build; refusing to reuse it",
      { expected: expectedIdentity, actual: {
        protocol: state.protocol,
        product: state.product,
        version: state.version,
        build: state.build,
        sourceId: state.sourceId,
      } },
    );
  }
  return { controller: controllerDescriptor(state), token: state.token };
}

async function controllerPortOccupied(port, timeoutMs = 150) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host: DEFAULT_CONTROLLER_HOST, port });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(occupied);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error?.code !== "ECONNREFUSED"));
  });
}

async function controllerPortDefinitelyFree(port) {
  if (await controllerPortOccupied(port)) return false;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  return !(await controllerPortOccupied(port));
}

async function recoverOwnedStaleState(path, record, expectedIdentity) {
  const state = record.state;
  if (state.protocol !== expectedIdentity.protocol || state.product !== expectedIdentity.product) {
    throw identityMismatch(expectedIdentity, state);
  }
  if (!(await controllerPortDefinitelyFree(state.port))) throw identityMismatch(expectedIdentity, state);
  if (!(await removeControllerState(path, state, record.contents))) {
    throw new ControllerServiceError(
      "CONTROLLER_STATE_CONFLICT",
      "Controller state changed during stale-state recovery; refusing to replace it",
    );
  }
}

function identityMismatch(expected, actual) {
  return new ControllerServiceError(
    "CONTROLLER_IDENTITY_MISMATCH",
    "Controller belongs to another MoneyHand build; refusing to reuse or stop it",
    { expected, actual: {
      protocol: actual.protocol,
      product: actual.product,
      version: actual.version,
      build: actual.build,
      sourceId: actual.sourceId,
    } },
  );
}

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65_535) {
    throw new ControllerServiceError("INVALID_CONTROLLER_OPTION", `${name} must be an integer from 1 to 65535`);
  }
  return resolved;
}

function timeoutInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 10 || resolved > MAX_REQUEST_TIMEOUT_MS) {
    throw new ControllerServiceError(
      "INVALID_CONTROLLER_OPTION",
      `${name} must be an integer from 10 to ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return resolved;
}

async function writeLine(socket, value) {
  if (socket.destroyed || socket.writable === false) {
    throw new ControllerServiceError("CONTROLLER_CLIENT_CLOSED", "Controller client connection closed");
  }
  const line = `${JSON.stringify(value)}\n`;
  if (socket.write(line, "utf8")) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolvePromise);
    const onError = (error) => finish(rejectPromise, error);
    const onClose = () => finish(
      rejectPromise,
      new ControllerServiceError("CONTROLLER_CLIENT_CLOSED", "Controller client connection closed"),
    );
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (socket.destroyed || socket.writable === false) onClose();
  });
}

function readOneLine(socket, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_REQUEST_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0);
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onEnd = () => finish(reject, new ControllerServiceError(
      "CONTROLLER_PROTOCOL_ERROR",
      "Controller connection ended before a complete JSON line",
    ));
    const onClose = () => finish(reject, new ControllerServiceError(
      "CONTROLLER_CLIENT_CLOSED",
      "Controller connection closed before a complete JSON line",
    ));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        finish(reject, new ControllerServiceError(
          "CONTROLLER_REQUEST_TOO_LARGE",
          `Controller JSON line exceeds ${maxBytes} bytes`,
        ));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      try {
        finish(resolvePromise, JSON.parse(line));
      } catch {
        finish(reject, new ControllerServiceError(
          "CONTROLLER_PROTOCOL_ERROR",
          "Controller message is not valid JSON",
        ));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    timer = setTimeout(() => finish(reject, new ControllerServiceError(
      "CONTROLLER_TIMEOUT",
      `Controller message exceeded ${timeoutMs}ms`,
    )), timeoutMs);
    timer.unref?.();
  });
}

class ControllerService extends EventEmitter {
  constructor(options) {
    super();
    this.host = DEFAULT_CONTROLLER_HOST;
    this.port = options.port;
    this.pid = process.pid;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.handle = options.handle;
    this.onStop = options.onStop;
    this.identity = options.identity;
    this.instanceNonce = randomUUID();
    this.authToken = options.authToken;
    this.statePath = options.statePath;
    this.stateWritten = false;
    this.closed = false;
    this.stopping = false;
    this.shutdownPending = false;
    this.active = 0;
    this.activeController = undefined;
    this.queue = Promise.resolve();
    this.sockets = new Set();
    this.idleTimer = undefined;
    this.stopPromise = undefined;
    this.runtimeStopPromise = undefined;
    this.server = createServer((socket) => this.#accept(socket));
    this.on("error", () => {});
    this.server.on("error", (error) => this.emit("error", error));
  }

  async start() {
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolvePromise();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    if (this.statePath) {
      try {
        await writeControllerState(this.statePath, {
          schema: CONTROLLER_STATE_SCHEMA,
          host: this.host,
          port: this.port,
          ...this.descriptor(),
          token: this.authToken,
        });
        this.stateWritten = true;
      } catch (error) {
        await new Promise((resolvePromise) => this.server.close(resolvePromise));
        throw error;
      }
    }
    this.#armIdleTimer();
    return this;
  }

  descriptor() {
    return controllerDescriptor({
      ...this.identity,
      pid: this.pid,
      instanceNonce: this.instanceNonce,
    });
  }

  clientOptions() {
    return serviceCredentials(this);
  }

  #envelope(type, id, value) {
    return {
      protocol: CONTROLLER_SERVICE_PROTOCOL,
      controller: this.descriptor(),
      type,
      id,
      ...value,
    };
  }

  #armIdleTimer() {
    clearTimeout(this.idleTimer);
    if (this.closed || this.stopping || this.active !== 0) return;
    this.idleTimer = setTimeout(() => this.stop().catch((error) => this.emit("error", error)), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #accept(socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    // A caller may disappear with a TCP reset (process crash, tool timeout, or
    // Agent restart). The command lifecycle is driven by `close`; consuming the
    // transport error here keeps that client failure from terminating the
    // resident controller process.
    socket.on("error", (error) => this.emit("clientError", error));
    socket.once("close", () => this.sockets.delete(socket));
    this.#readRequest(socket).catch(async (error) => {
      if (!socket.destroyed) {
        await writeLine(socket, this.#envelope("complete", null, {
          ok: false,
          error: normalizedError(error, "CONTROLLER_PROTOCOL_ERROR"),
        })).catch(() => {});
        socket.end();
      }
    });
  }

  async #readRequest(socket) {
    const envelope = await readOneLine(socket);
    if (envelope?.protocol !== CONTROLLER_SERVICE_PROTOCOL || typeof envelope?.id !== "string") {
      throw new ControllerServiceError(
        "CONTROLLER_PROTOCOL_ERROR",
        `Expected ${CONTROLLER_SERVICE_PROTOCOL} request envelope`,
      );
    }
    const expectedController = this.descriptor();
    if (!sameController(envelope.controller, expectedController)
      || !sameString(envelope.auth?.token, this.authToken)) {
      throw new ControllerServiceError(
        "CONTROLLER_AUTH_FAILED",
        "Controller identity or private instance proof did not match",
      );
    }
    const request = envelope.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ControllerServiceError("CONTROLLER_PROTOCOL_ERROR", "Controller request must be an object");
    }
    if (request.command === "ping") {
      await writeLine(socket, this.#envelope("complete", envelope.id, {
        ok: true,
        value: this.status(),
      }));
      socket.end();
      return;
    }
    if (request.command === "shutdown") {
      this.stopping = true;
      this.shutdownPending = true;
      clearTimeout(this.idleTimer);
      this.activeController?.abort(new ControllerServiceError(
        "CONTROLLER_SHUTDOWN",
        "Controller shutdown interrupted the active command",
      ));
    }
    const operation = this.queue.then(() => this.#execute(socket, envelope.id, request));
    this.queue = operation.catch(() => {});
    await operation;
  }

  async #execute(socket, id, request) {
    clearTimeout(this.idleTimer);
    this.active += 1;
    const controller = new AbortController();
    if (request.command !== "shutdown") this.activeController = controller;
    const survivesClientClose = request.command === "task";
    let completed = false;
    let stopAfterComplete = false;
    const abortOnClose = () => {
      if (!completed && !survivesClientClose) controller.abort(new ControllerServiceError(
        "CONTROLLER_CLIENT_CLOSED",
        "Controller client disconnected before command completion",
      ));
    };
    const respond = async (envelope) => {
      if (socket.destroyed || socket.writable === false) {
        if (survivesClientClose) return false;
        throw new ControllerServiceError(
          "CONTROLLER_CLIENT_CLOSED",
          "Controller client disconnected before command completion",
        );
      }
      try {
        await writeLine(socket, envelope);
        return true;
      } catch (error) {
        if (survivesClientClose && [
          "CONTROLLER_CLIENT_CLOSED",
          "ECONNRESET",
          "EPIPE",
          "ERR_STREAM_DESTROYED",
          "ERR_STREAM_WRITE_AFTER_END",
        ].includes(error?.code)) {
          return false;
        }
        throw error;
      }
    };
    socket.once("close", abortOnClose);
    try {
      if (this.stopping && request.command !== "shutdown") {
        throw new ControllerServiceError(
          "CONTROLLER_STOPPING",
          "Controller is stopping and will not accept another command",
        );
      }
      if (request.command === "shutdown") {
        await this.#stopRuntime();
        await respond(this.#envelope("message", id, {
          message: { type: "result", id: "shutdown", ok: true, value: { stopped: true } },
        }));
      } else {
        await this.handle(request, {
          signal: controller.signal,
          status: () => this.status(),
          stopAfterCommand: () => {
            stopAfterComplete = true;
            this.stopping = true;
            clearTimeout(this.idleTimer);
          },
          send: async (message) => respond(this.#envelope("message", id, {
            message,
          })),
        });
      }
      await respond(this.#envelope("complete", id, {
        ok: true,
        value: this.status(),
      }));
    } catch (error) {
      await respond(this.#envelope("complete", id, {
        ok: false,
        error: normalizedError(error),
      })).catch(() => {});
    } finally {
      completed = true;
      socket.off("close", abortOnClose);
      if (!socket.destroyed) socket.end();
      this.active -= 1;
      if (this.activeController === controller) this.activeController = undefined;
      if (request.command === "shutdown") {
        this.shutdownPending = false;
        setImmediate(() => this.stop().catch((error) => this.emit("error", error)));
      }
      else if (stopAfterComplete && !this.shutdownPending) {
        setImmediate(() => this.stop().catch((error) => this.emit("error", error)));
      }
      else if (!this.shutdownPending) this.#armIdleTimer();
    }
  }

  status() {
    return {
      status: this.stopping ? "stopping" : "running",
      host: this.host,
      port: this.port,
      pid: this.pid,
      active: this.active,
      protocol: this.identity.protocol,
      product: this.identity.product,
      version: this.identity.version,
      build: this.identity.build,
      sourceId: this.identity.sourceId,
      instanceNonce: this.instanceNonce,
    };
  }

  async #stopRuntime() {
    this.runtimeStopPromise ??= Promise.resolve().then(() => this.onStop?.());
    return await this.runtimeStopPromise;
  }

  async stop() {
    if (this.stopPromise) return await this.stopPromise;
    this.stopPromise = (async () => {
      if (this.closed) return;
      this.closed = true;
      this.stopping = true;
      clearTimeout(this.idleTimer);
      this.activeController?.abort(new ControllerServiceError(
        "CONTROLLER_SHUTDOWN",
        "Controller stopped while a command was active",
      ));
      const serverClosed = new Promise((resolvePromise) => this.server.close(resolvePromise));
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await this.queue.catch(() => {});
      await this.#stopRuntime();
      await serverClosed;
      if (this.stateWritten) {
        await removeControllerState(this.statePath, {
          host: this.host,
          port: this.port,
          ...this.descriptor(),
          token: this.authToken,
        });
        this.stateWritten = false;
      }
      this.emit("close");
    })();
    return await this.stopPromise;
  }
}

export async function startControllerService(options = {}) {
  if (typeof options.handle !== "function") {
    throw new ControllerServiceError("INVALID_CONTROLLER_OPTION", "Controller service requires a handle function");
  }
  const port = positiveInteger(options.port, DEFAULT_CONTROLLER_PORT, "port");
  const identity = controllerServiceIdentity(options.sourcePath);
  const inheritedToken = process.env[CONTROLLER_TOKEN_ENV];
  if (inheritedToken !== undefined) delete process.env[CONTROLLER_TOKEN_ENV];
  const service = new ControllerService({
    port,
    idleTimeoutMs: timeoutInteger(options.idleTimeoutMs, DEFAULT_CONTROLLER_IDLE_MS, "idleTimeoutMs"),
    handle: options.handle,
    onStop: options.onStop,
    identity,
    authToken: privateToken(options.authToken ?? inheritedToken ?? randomToken()),
    statePath: options.sourcePath ? controllerStatePath(port) : undefined,
  });
  return await service.start();
}

export async function requestControllerService(options = {}) {
  const host = DEFAULT_CONTROLLER_HOST;
  const port = positiveInteger(options.port, DEFAULT_CONTROLLER_PORT, "port");
  const timeoutMs = timeoutInteger(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "timeoutMs");
  const credentials = await sourceCredentials(options);
  const id = randomUUID();
  const socket = createConnection({ host, port });
  const messages = [];
  let timer;
  const signal = options.signal;
  const abort = () => socket.destroy(
    signal?.reason instanceof Error
      ? signal.reason
      : new ControllerServiceError("CONTROLLER_ABORTED", "Controller request was aborted"),
  );
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => { throw error; }),
    ]);
    await writeLine(socket, {
      protocol: CONTROLLER_SERVICE_PROTOCOL,
      controller: credentials.controller,
      auth: { token: credentials.token },
      id,
      request: options.request,
    });
    return await new Promise((resolvePromise, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onError = (error) => finish(reject, error);
      const onClose = () => finish(reject, new ControllerServiceError(
        "CONTROLLER_CLIENT_CLOSED",
        "Controller service closed before completing the request",
      ));
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_REQUEST_BYTES) {
          finish(reject, new ControllerServiceError(
            "CONTROLLER_RESPONSE_TOO_LARGE",
            `Controller response buffer exceeds ${MAX_REQUEST_BYTES} bytes`,
          ));
          return;
        }
        while (true) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const line = buffer.subarray(0, newline).toString("utf8");
          buffer = buffer.subarray(newline + 1);
          let envelope;
          try {
            envelope = JSON.parse(line);
          } catch {
            finish(reject, new ControllerServiceError(
              "CONTROLLER_PROTOCOL_ERROR",
              "Controller response is not valid JSON",
            ));
            return;
          }
          if (envelope.protocol !== CONTROLLER_SERVICE_PROTOCOL
            || envelope.id !== id
            || !sameController(envelope.controller, credentials.controller)) {
            finish(reject, new ControllerServiceError(
              "CONTROLLER_PROTOCOL_ERROR",
              "Unexpected controller response protocol, identity, or request id",
            ));
            return;
          }
          if (envelope.type === "message") {
            messages.push(envelope.message);
            options.onMessage?.(envelope.message);
            continue;
          }
          if (envelope.type === "complete") {
            finish(resolvePromise, {
              ok: envelope.ok === true,
              messages,
              ...(envelope.value === undefined ? {} : { value: envelope.value }),
              ...(envelope.error === undefined ? {} : { error: envelope.error }),
            });
            return;
          }
          finish(reject, new ControllerServiceError(
            "CONTROLLER_PROTOCOL_ERROR",
            `Unknown controller response type '${envelope.type}'`,
          ));
          return;
        }
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      timer = setTimeout(() => finish(reject, new ControllerServiceError(
        "CONTROLLER_TIMEOUT",
        `Controller request exceeded ${timeoutMs}ms`,
      )), timeoutMs);
      timer.unref?.();
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

export async function pingControllerService(options = {}) {
  const response = await requestControllerService({
    ...options,
    timeoutMs: options.timeoutMs ?? 500,
    request: { command: "ping" },
  });
  if (!response.ok || response.value?.status !== "running") {
    throw new ControllerServiceError("CONTROLLER_UNAVAILABLE", "Controller service did not return a healthy status");
  }
  return response.value;
}

export async function shutdownControllerService(options = {}) {
  return await requestControllerService({
    ...options,
    request: { command: "shutdown" },
  });
}

export async function ensureControllerService(options = {}) {
  const port = positiveInteger(options.port, DEFAULT_CONTROLLER_PORT, "port");
  if (typeof options.sourcePath !== "string" || options.sourcePath.length === 0) {
    throw new ControllerServiceError("INVALID_CONTROLLER_OPTION", "sourcePath is required to start the controller service");
  }
  const identity = controllerServiceIdentity(options.sourcePath);
  const statePath = controllerStatePath(port);
  const existingRecord = await readControllerStateRecord(statePath, { port });
  if (existingRecord) {
    const existingState = existingRecord.state;
    if (!sameBuild(existingState, identity)) {
      await recoverOwnedStaleState(statePath, existingRecord, identity);
    } else {
      try {
        const status = await pingControllerService({
          port,
          controller: existingState,
          token: existingState.token,
          timeoutMs: 150,
        });
        return { ...status, reused: true };
      } catch (error) {
        if (error?.code !== "ECONNREFUSED") throw error;
        await recoverOwnedStaleState(statePath, existingRecord, identity);
      }
    }
  }
  if (await controllerPortOccupied(port)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const racedState = await readControllerState(statePath, { port });
      if (racedState) {
        if (!sameBuild(racedState, identity)) throw identityMismatch(identity, racedState);
        const status = await pingControllerService({
          port,
          controller: racedState,
          token: racedState.token,
          timeoutMs: 150,
        });
        return { ...status, reused: true };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new ControllerServiceError(
      "CONTROLLER_PORT_OCCUPIED",
      `Port ${DEFAULT_CONTROLLER_HOST}:${port} is occupied without matching MoneyHand private state`,
    );
  }
  const bootstrapToken = randomToken();
  const child = spawn(process.execPath, [
    options.sourcePath,
    "--internal-controller-service",
    "--internal-controller-port",
    String(port),
    ...(options.spawnArguments ?? []),
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, [CONTROLLER_TOKEN_ENV]: bootstrapToken },
  });
  child.unref();
  const deadline = Date.now() + (options.startTimeoutMs ?? START_TIMEOUT_MS);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await readControllerState(statePath, { port });
      if (!state) throw new ControllerServiceError("CONTROLLER_UNAVAILABLE", "Controller state is not ready");
      if (!sameBuild(state, identity)) throw identityMismatch(identity, state);
      const status = await pingControllerService({
        port,
        controller: state,
        token: state.token,
        timeoutMs: 150,
      });
      return { ...status, reused: status.pid !== child.pid };
    } catch (error) {
      if ([
        "CONTROLLER_IDENTITY_MISMATCH",
        "CONTROLLER_STATE_FOREIGN",
        "CONTROLLER_STATE_INVALID",
        "CONTROLLER_AUTH_FAILED",
      ].includes(error?.code)) throw error;
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new ControllerServiceError(
    "CONTROLLER_START_FAILED",
    `MoneyHand controller did not start on ${DEFAULT_CONTROLLER_HOST}:${port}`,
    normalizedError(lastError),
  );
}
