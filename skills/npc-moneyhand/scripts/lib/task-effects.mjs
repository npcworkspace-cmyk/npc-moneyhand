import { createHash } from "node:crypto";

export const TASK_EFFECT_RECEIPT_SCHEMA = "npc-moneyhand-task-effect-receipt/1";

const EFFECT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_RECEIPTS = 4_096;

export class TaskEffectReceiptError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TaskEffectReceiptError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function canonical(value, seen = new Set()) {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      throw new TaskEffectReceiptError(
        "INVALID_EFFECT_INPUT",
        "Idempotent effect input must not contain cycles",
      );
    }
    seen.add(value);
    const output = `{${Object.keys(value)
      .filter((key) => value[key] !== undefined
        && !["signal", "effectId", "approvalToken"].includes(key))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return output;
  }
  throw new TaskEffectReceiptError(
    "INVALID_EFFECT_INPUT",
    "Idempotent effect input must contain only JSON-compatible values",
  );
}

function effectId(value) {
  if (typeof value !== "string" || !EFFECT_ID.test(value)) {
    throw new TaskEffectReceiptError(
      "INVALID_EFFECT_ID",
      "effectId must use 1-128 letters, numbers, '.', '_', ':' or '-'",
    );
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TaskEffectReceiptError("INVALID_EFFECT_INPUT", `${label} is invalid`);
  }
  return value;
}

function publicReceipt(record, replayed = false) {
  return {
    schema: TASK_EFFECT_RECEIPT_SCHEMA,
    effectId: record.effectId,
    effect: record.effect,
    operation: record.operation,
    fingerprint: record.fingerprint,
    status: record.status,
    attempt: 1,
    replayed,
    actionDispatched: record.actionDispatched,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.outcome === undefined ? {} : { outcome: { ...record.outcome } }),
  };
}

function normalizedOutcome(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "TASK_EFFECT_FAILED",
    message: String(error?.message ?? error).slice(0, 4_096),
  };
}

function failureState(error) {
  const dispatched = error?.details?.actionDispatched;
  if (error?.code === "OUTCOME_UNKNOWN"
    || error?.code?.includes?.("OUTCOME_UNKNOWN")
    || dispatched === true) {
    return { status: "outcome_unknown", actionDispatched: dispatched === true ? true : "unknown" };
  }
  if (dispatched === false) return { status: "not_dispatched", actionDispatched: false };
  return { status: "failed", actionDispatched: "unknown" };
}

export class TaskEffectReceipts {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.onReceipt = typeof options.onReceipt === "function" ? options.onReceipt : async () => {};
    this.records = new Map();
  }

  async execute(input = {}, action) {
    if (typeof action !== "function") {
      throw new TaskEffectReceiptError("INVALID_EFFECT_INPUT", "Effect action must be a function");
    }
    const id = effectId(input.effectId);
    const effect = string(input.effect, "effect");
    const operation = string(input.operation, "operation");
    const fingerprint = createHash("sha256")
      .update(canonical({ effect, operation, input: input.input }))
      .digest("hex");
    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskEffectReceiptError(
          "EFFECT_ID_CONFLICT",
          `effectId '${id}' is already bound to another action`,
          {
            effectId: id,
            expectedFingerprint: existing.fingerprint,
            actualFingerprint: fingerprint,
            actionDispatched: false,
          },
        );
      }
      await this.onReceipt(publicReceipt(existing, true));
      return await existing.promise;
    }
    if (this.records.size >= MAX_RECEIPTS) {
      throw new TaskEffectReceiptError(
        "TASK_EFFECT_RECEIPT_LIMIT",
        `Task effect receipt limit ${MAX_RECEIPTS} reached`,
        { actionDispatched: false },
      );
    }
    const timestamp = new Date(this.now()).toISOString();
    const record = {
      effectId: id,
      effect,
      operation,
      fingerprint,
      status: "pending",
      actionDispatched: false,
      startedAt: timestamp,
      updatedAt: timestamp,
      outcome: undefined,
      promise: undefined,
    };
    this.records.set(id, record);
    // Publish the shared promise before the first asynchronous receipt write.
    // A same-tick duplicate must join this exact operation instead of observing
    // an incompletely initialized record and returning early.
    record.promise = Promise.resolve()
      .then(() => this.onReceipt(publicReceipt(record)))
      .then(action)
      .then(
        async (value) => {
          record.status = "completed";
          record.actionDispatched = true;
          record.updatedAt = new Date(this.now()).toISOString();
          record.outcome = { ok: true };
          await this.onReceipt(publicReceipt(record));
          return value;
        },
        async (error) => {
          const failure = failureState(error);
          record.status = failure.status;
          record.actionDispatched = failure.actionDispatched;
          record.updatedAt = new Date(this.now()).toISOString();
          record.outcome = { ok: false, error: normalizedOutcome(error) };
          await this.onReceipt(publicReceipt(record));
          throw error;
        },
      );
    return await record.promise;
  }

  get(id) {
    const record = this.records.get(effectId(id));
    return record ? publicReceipt(record) : null;
  }

  list() {
    return [...this.records.values()].map((record) => publicReceipt(record));
  }
}
