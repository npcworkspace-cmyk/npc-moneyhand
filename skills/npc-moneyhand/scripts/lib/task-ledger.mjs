import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";

export const TASK_LEDGER_SCHEMA = "npc-moneyhand-task-ledger/1";
export const TASK_LEDGER_EVENT_SCHEMA = "npc-moneyhand-task-ledger-event/1";
export const TASK_STATUS_SCHEMA = "npc-moneyhand-task-status/1";
export const TASK_SUMMARY_SCHEMA = "npc-moneyhand-task-summary/1";

const TASK_EXECUTION_ID = /^task-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const BUILD_ID = /^[a-f0-9]{64}$/u;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_TERMINAL_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_FILES = 4_096;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const TASK_LEDGER_USER = typeof process.getuid === "function"
  ? String(process.getuid())
  : sha256(userInfo().username).slice(0, 16);
const DEFAULT_TASK_LEDGER_ROOT = join(tmpdir(), `npc-moneyhand-tasks-${TASK_LEDGER_USER}`);

export class TaskLedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TaskLedgerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function taskExecutionId(value) {
  if (typeof value !== "string" || !TASK_EXECUTION_ID.test(value)) {
    throw new TaskLedgerError("INVALID_TASK_EXECUTION_ID", "taskExecutionId is invalid");
  }
  return value;
}

function buildId(value) {
  if (typeof value !== "string" || !BUILD_ID.test(value)) {
    throw new TaskLedgerError("INVALID_TASK_LEDGER", "MoneyHand build identity is invalid");
  }
  return value;
}

function controllerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isInteger(value.pid) || value.pid < 1
    || typeof value.instanceNonce !== "string"
    || typeof value.build !== "string") {
    throw new TaskLedgerError("INVALID_TASK_LEDGER", "Controller identity is invalid");
  }
  return {
    pid: value.pid,
    instanceNonce: value.instanceNonce,
    build: buildId(value.build),
  };
}

function ledgerRoot(value) {
  return resolve(value ?? DEFAULT_TASK_LEDGER_ROOT);
}

function ledgerPaths({ root, build, id }) {
  const directory = join(ledgerRoot(root), buildId(build));
  const safeId = taskExecutionId(id);
  return {
    directory,
    evidencePath: join(directory, `${safeId}.evidence.json`),
    eventsPath: join(directory, `${safeId}.jsonl`),
    metaPath: join(directory, `${safeId}.meta.json`),
  };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TaskLedgerError("TASK_LEDGER_UNSAFE", "Task ledger path must be a real directory");
  }
  await chmod(path, 0o700);
}

async function privateFile(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TaskLedgerError("TASK_LEDGER_UNSAFE", "Task ledger entry must be a real file");
  }
  await chmod(path, 0o600);
  return stats;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedMessage(message, terminal = false) {
  const maximum = terminal ? MAX_TERMINAL_BYTES : MAX_EVENT_BYTES;
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch (error) {
    return {
      type: "event",
      event: "moneyhand.task_journal_omission",
      schema: TASK_LEDGER_EVENT_SCHEMA,
      reason: "message-not-json-compatible",
      error: String(error?.message ?? error).slice(0, 1_000),
    };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maximum) return message;
  return {
    type: terminal ? "result" : "event",
    ...(terminal ? { id: "task", ok: message?.ok === true } : {
      event: "moneyhand.task_journal_omission",
      schema: TASK_LEDGER_EVENT_SCHEMA,
    }),
    taskExecutionId: message?.taskExecutionId,
    omitted: {
      reason: "message-too-large",
      bytes,
      sha256: sha256(serialized),
      maximumBytes: maximum,
    },
    ...(message?.error === undefined ? {} : { error: message.error }),
  };
}

function safeTaskDigest(value) {
  try {
    return sha256(JSON.stringify(value ?? null));
  } catch {
    return sha256("unserializable-task-args");
  }
}

function normalizeMeta(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== TASK_LEDGER_SCHEMA
    || typeof value.startedAt !== "string"
    || Number.isNaN(Date.parse(value.startedAt))) {
    throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger metadata is invalid");
  }
  const id = taskExecutionId(value.taskExecutionId);
  const build = buildId(value.build);
  if (expected.id !== undefined && id !== expected.id) {
    throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger ID does not match its filename");
  }
  if (expected.build !== undefined && build !== expected.build) {
    throw new TaskLedgerError("TASK_LEDGER_BUILD_MISMATCH", "Task ledger belongs to another MoneyHand build");
  }
  return {
    ...value,
    taskExecutionId: id,
    build,
    controller: controllerIdentity(value.controller),
  };
}

function normalizeEntry(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== TASK_LEDGER_EVENT_SCHEMA
    || value.taskExecutionId !== expected.id
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))
    || !value.message || typeof value.message !== "object" || Array.isArray(value.message)) {
    throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal entry is invalid");
  }
  return value;
}

function controllerMatches(expected, current) {
  return Boolean(current
    && expected.pid === current.pid
    && expected.instanceNonce === current.instanceNonce
    && expected.build === current.build);
}

function latest(values, predicate = () => true) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return values[index];
  }
  return undefined;
}

function evidenceFromEntries(entries) {
  const messages = entries.map((entry) => entry.message);
  const progress = messages.filter((message) => message.event === "moneyhand.task_progress");
  return {
    progress,
    checkpoints: progress
      .filter((message) => typeof message.checkpoint === "string")
      .map((message) => ({ checkpoint: message.checkpoint })),
    visuals: progress
      .filter((message) => message.visualFallback !== undefined)
      .map((message) => ({
        captured: message.visualFallback?.captured === true,
        path: message.visualFallback?.screenshot?.path ?? null,
        waitingForInstruction: message.visualFallback?.waitingForInstruction === true,
      })),
    rateControl: messages.filter((message) => message.event === "moneyhand.task_rate_control"),
    recoveries: messages.filter((message) => message.event === "moneyhand.task_recovery"),
  };
}

function summaryNextAction(state, rate, visual, recovery, terminal) {
  if (state === "completed") return "none";
  if (state === "interrupted") return "restart-from-last-checkpoint";
  if (visual?.waitingForInstruction === true || recovery?.waitingForInstruction === true) {
    return "resolve-task-blocker";
  }
  if (state === "failed") {
    return terminal?.error?.details?.recovery?.nextAction
      ?? recovery?.nextAction
      ?? "inspect-terminal-error";
  }
  if (rate?.stop === true) return "stop-and-preserve-checkpoint";
  if (rate?.waitMs > 0) return "wait-for-rate-window";
  if (typeof recovery?.nextAction === "string") return recovery.nextAction;
  return "continue-task-follow";
}

export function buildTaskSummary(options = {}) {
  const state = typeof options.state === "string" ? options.state : "interrupted";
  const evidence = options.evidence && typeof options.evidence === "object"
    ? options.evidence
    : {};
  const progress = Array.isArray(evidence.progress) ? evidence.progress : [];
  const checkpoints = Array.isArray(evidence.checkpoints) ? evidence.checkpoints : [];
  const rateControl = Array.isArray(evidence.rateControl) ? evidence.rateControl : [];
  const visuals = Array.isArray(evidence.visuals) ? evidence.visuals : [];
  const recoveries = Array.isArray(evidence.recoveries) ? evidence.recoveries : [];
  const lastProgress = latest(progress);
  const countedProgress = latest(progress, (entry) => (
    Number.isFinite(entry?.current) || Number.isFinite(entry?.total)
  ));
  const checkpoint = latest(checkpoints, (entry) => typeof entry?.checkpoint === "string");
  const latestRate = latest(rateControl);
  const latestVisual = latest(visuals);
  const latestRecovery = options.terminal?.error?.details?.recovery ?? latest(recoveries);
  const rate = latestRate ? {
    state: typeof latestRate.state === "string" ? latestRate.state : null,
    phase: typeof latestRate.phase === "string" ? latestRate.phase : null,
    waitMs: Number.isFinite(latestRate.waitMs) ? Math.max(0, latestRate.waitMs) : 0,
    stop: latestRate.stop === true,
    checkpointRequired: latestRate.checkpointRequired === true,
  } : null;
  const visual = latestVisual ? {
    captured: latestVisual.captured === true,
    path: typeof latestVisual.path === "string" ? latestVisual.path : null,
    waitingForInstruction: latestVisual.waitingForInstruction === true,
  } : null;
  const updatedAtMs = Date.parse(options.updatedAt ?? "");
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const phase = state === "completed" || state === "failed"
    ? "complete"
    : state === "interrupted"
      ? "interrupted"
      : typeof lastProgress?.phase === "string"
        ? lastProgress.phase
        : typeof latestRate?.phase === "string" ? latestRate.phase : "task";
  return {
    schema: TASK_SUMMARY_SCHEMA,
    state,
    phase,
    progress: {
      current: Number.isFinite(countedProgress?.current) ? countedProgress.current : null,
      total: Number.isFinite(countedProgress?.total) ? countedProgress.total : null,
    },
    lastCheckpoint: checkpoint?.checkpoint ?? null,
    lastActivityAgoMs: Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null,
    rate,
    visual,
    nextAction: summaryNextAction(state, rate, visual, latestRecovery, options.terminal),
  };
}

function publicStatus(meta, entries, currentController, now) {
  const last = entries.at(-1);
  const terminalEntry = [...entries].reverse().find((entry) => (
    entry.message?.type === "result" && entry.message?.id === "task"
  ));
  const lastProgressEntry = [...entries].reverse().find((entry) => (
    typeof entry.message?.event === "string"
  ));
  const state = terminalEntry
    ? (terminalEntry.message.ok === true ? "completed" : "failed")
    : controllerMatches(meta.controller, currentController) ? "running" : "interrupted";
  const updatedAt = last?.at ?? meta.startedAt;
  const evidence = terminalEntry?.message?.taskEvidence ?? evidenceFromEntries(entries);
  return {
    schema: TASK_STATUS_SCHEMA,
    taskExecutionId: meta.taskExecutionId,
    state,
    startedAt: meta.startedAt,
    updatedAt,
    build: meta.build,
    controller: { ...meta.controller },
    task: { ...meta.task },
    lastSequence: last?.sequence ?? 0,
    lastProgress: lastProgressEntry?.message ?? null,
    terminal: terminalEntry?.message ?? null,
    reattachable: state === "running",
    taskSummary: buildTaskSummary({
      state,
      evidence,
      terminal: terminalEntry?.message,
      updatedAt,
      now,
    }),
  };
}

export function createTaskExecutionId() {
  return `task-${randomUUID()}`;
}

export function taskLedgerRoot() {
  return DEFAULT_TASK_LEDGER_ROOT;
}

export class TaskExecutionLedger {
  static async create(options = {}) {
    const id = taskExecutionId(options.taskExecutionId ?? createTaskExecutionId());
    const controller = controllerIdentity(options.controller);
    const paths = ledgerPaths({ root: options.root, build: controller.build, id });
    await privateDirectory(paths.directory);
    const startedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    const meta = {
      schema: TASK_LEDGER_SCHEMA,
      taskExecutionId: id,
      build: controller.build,
      controller,
      startedAt,
      task: {
        name: typeof options.taskPath === "string" ? basename(options.taskPath).slice(0, 255) : "task.mjs",
        pathDigest: typeof options.taskPath === "string" ? sha256(resolve(options.taskPath)) : null,
        argsDigest: safeTaskDigest(options.args),
      },
    };
    let metaCreated = false;
    let eventsCreated = false;
    try {
      await writeFile(paths.metaPath, `${JSON.stringify(meta)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      metaCreated = true;
      await writeFile(paths.eventsPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      eventsCreated = true;
    } catch (error) {
      await Promise.all([
        ...(eventsCreated ? [rm(paths.eventsPath, { force: true })] : []),
        ...(metaCreated ? [rm(paths.metaPath, { force: true })] : []),
      ]);
      if (error?.code === "EEXIST") {
        throw new TaskLedgerError("TASK_EXECUTION_EXISTS", `Task execution '${id}' already exists`);
      }
      throw error;
    }
    await Promise.all([privateFile(paths.metaPath), privateFile(paths.eventsPath)]);
    return new TaskExecutionLedger({ id, meta, paths, now: options.now });
  }

  constructor(options) {
    this.taskExecutionId = options.id;
    this.meta = options.meta;
    this.paths = options.paths;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.sequence = 0;
    this.bytes = 0;
    this.terminal = false;
    this.limitNoted = false;
    this.queue = Promise.resolve();
  }

  async append(message) {
    this.queue = this.queue.then(async () => {
      const terminal = message?.type === "result" && message?.id === "task";
      if (this.terminal) return null;
      const bounded = boundedMessage({
        ...message,
        taskExecutionId: this.taskExecutionId,
      }, terminal);
      const entry = {
        schema: TASK_LEDGER_EVENT_SCHEMA,
        taskExecutionId: this.taskExecutionId,
        sequence: this.sequence + 1,
        at: new Date(this.now()).toISOString(),
        message: bounded,
      };
      let line = `${JSON.stringify(entry)}\n`;
      let bytes = Buffer.byteLength(line, "utf8");
      if (!terminal && this.bytes + bytes > MAX_JOURNAL_BYTES) {
        if (this.limitNoted) return null;
        this.limitNoted = true;
        entry.message = {
          type: "event",
          event: "moneyhand.task_journal_limit",
          schema: TASK_LEDGER_EVENT_SCHEMA,
          taskExecutionId: this.taskExecutionId,
          maximumBytes: MAX_JOURNAL_BYTES,
          message: "Task journal reached its bounded local size; terminal state remains reserved",
        };
        line = `${JSON.stringify(entry)}\n`;
        bytes = Buffer.byteLength(line, "utf8");
      }
      await appendFile(this.paths.eventsPath, line, { encoding: "utf8", mode: 0o600 });
      this.sequence += 1;
      this.bytes += bytes;
      if (terminal) this.terminal = true;
      return entry;
    });
    return await this.queue;
  }

  async finish({ ok, value, error } = {}) {
    return await this.append({
      type: "result",
      id: "task",
      ok: ok === true,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async writeEvidence(value) {
    let serialized = JSON.stringify(value);
    let bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_EVIDENCE_BYTES) {
      serialized = JSON.stringify({
        schema: value?.schema ?? "npc-moneyhand-task-evidence/1",
        taskExecutionId: this.taskExecutionId,
        omitted: {
          reason: "evidence-bundle-too-large",
          bytes,
          sha256: sha256(serialized),
          maximumBytes: MAX_EVIDENCE_BYTES,
        },
        counts: value?.counts ?? null,
        timing: value?.timing ?? null,
        cleanup: value?.cleanup ?? null,
      });
      bytes = Buffer.byteLength(serialized, "utf8");
    }
    await writeFile(this.paths.evidencePath, `${serialized}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await privateFile(this.paths.evidencePath);
    return {
      path: this.paths.evidencePath,
      bytes,
      sha256: sha256(serialized),
      private: true,
    };
  }

  async settled() {
    await this.queue;
  }
}

async function readMeta(options = {}) {
  const id = taskExecutionId(options.taskExecutionId);
  const build = buildId(options.build);
  const paths = ledgerPaths({ root: options.root, build, id });
  let contents;
  try {
    await privateFile(paths.metaPath);
    contents = await readFile(paths.metaPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TaskLedgerError("TASK_EXECUTION_NOT_FOUND", `Task execution '${id}' was not found`);
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger metadata is not valid JSON");
  }
  return { meta: normalizeMeta(value, { id, build }), paths };
}

export async function readTaskExecutionEntries(options = {}) {
  const { meta, paths } = await readMeta(options);
  let contents;
  try {
    const stats = await privateFile(paths.eventsPath);
    if (stats.size > MAX_JOURNAL_BYTES + MAX_TERMINAL_BYTES + MAX_EVENT_BYTES) {
      throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal exceeds its bounded size");
    }
    contents = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal is missing");
    }
    throw error;
  }
  const entries = [];
  let expectedSequence = 1;
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_TERMINAL_BYTES + MAX_EVENT_BYTES) {
      throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal line is too large");
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal is not valid JSONL");
    }
    const entry = normalizeEntry(value, { id: meta.taskExecutionId });
    if (entry.sequence !== expectedSequence) {
      throw new TaskLedgerError("TASK_LEDGER_INVALID", "Task ledger journal sequence is not contiguous");
    }
    expectedSequence += 1;
    if (entry.sequence > (options.afterSequence ?? 0)) entries.push(entry);
  }
  return { meta, entries };
}

export async function readTaskExecutionStatus(options = {}) {
  const { meta, entries } = await readTaskExecutionEntries({ ...options, afterSequence: 0 });
  return publicStatus(meta, entries, options.controller, options.now);
}

export async function latestTaskExecutionId(options = {}) {
  const build = buildId(options.build);
  const directory = join(ledgerRoot(options.root), build);
  let names;
  try {
    await privateDirectory(directory);
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TaskLedgerError("TASK_EXECUTION_NOT_FOUND", "No MoneyHand task execution was found");
    }
    throw error;
  }
  const metaNames = names.filter((name) => name.endsWith(".meta.json"));
  if (metaNames.length > MAX_LEDGER_FILES) {
    throw new TaskLedgerError("TASK_LEDGER_LIMIT", "Task ledger contains too many local entries");
  }
  let latest;
  for (const name of metaNames) {
    const id = name.slice(0, -".meta.json".length);
    if (!TASK_EXECUTION_ID.test(id)) continue;
    try {
      const { meta } = await readMeta({ ...options, build, taskExecutionId: id });
      if (!latest || Date.parse(meta.startedAt) > Date.parse(latest.startedAt)) latest = meta;
    } catch (error) {
      if (error?.code !== "TASK_LEDGER_INVALID") throw error;
    }
  }
  if (!latest) {
    throw new TaskLedgerError("TASK_EXECUTION_NOT_FOUND", "No MoneyHand task execution was found");
  }
  return latest.taskExecutionId;
}

export async function readLatestTaskExecutionStatus(options = {}) {
  const taskExecutionId = await latestTaskExecutionId(options);
  return await readTaskExecutionStatus({ ...options, taskExecutionId });
}

export const __test__ = Object.freeze({
  boundedMessage,
  controllerMatches,
  jsonBytes,
  ledgerPaths,
});
