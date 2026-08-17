import { createHash, randomUUID } from "node:crypto";

export const TASK_EFFECTS = Object.freeze([
  "read-only",
  "focus",
  "input",
  "navigation",
  "download",
  "delete",
  "payment",
  "publish",
  "send",
  "upload",
  "external-write",
]);
export const HIGH_IMPACT_TASK_EFFECTS = Object.freeze([
  "delete",
  "payment",
  "publish",
  "send",
  "upload",
  "external-write",
]);

const EFFECT_SET = new Set(TASK_EFFECTS);
const HIGH_IMPACT_SET = new Set(HIGH_IMPACT_TASK_EFFECTS);
const TASK_SPACE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export class TaskApprovalError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TaskApprovalError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskApprovalError("INVALID_TASK_APPROVAL", `${label} must be an object`);
  }
  return value;
}

function canonical(value) {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  throw new TaskApprovalError(
    "INVALID_TASK_APPROVAL",
    "Approved requests must contain only JSON-compatible values",
  );
}

function digest(value) {
  return createHash("sha256").update(canonical(object(value, "request"))).digest("hex");
}

function taskSpaceId(value) {
  if (typeof value !== "string" || !TASK_SPACE_ID.test(value)) {
    throw new TaskApprovalError("INVALID_TASK_APPROVAL", "taskSpaceId is invalid");
  }
  return value;
}

export function normalizeTaskEffect(value = "read-only") {
  if (typeof value !== "string" || !EFFECT_SET.has(value)) {
    throw new TaskApprovalError(
      "INVALID_TASK_EFFECT",
      `effect must be one of: ${TASK_EFFECTS.join(", ")}`,
    );
  }
  return value;
}

export function taskEffectRequiresApproval(value) {
  return HIGH_IMPACT_SET.has(normalizeTaskEffect(value));
}

function validConfirmation(value, now, maximumAgeMs, futureSkewMs) {
  if (!value || typeof value !== "object" || value.approved !== true || value.source !== "user") {
    return false;
  }
  const confirmedAt = Date.parse(value.confirmedAt);
  return Number.isFinite(confirmedAt)
    && confirmedAt >= now - maximumAgeMs
    && confirmedAt <= now + futureSkewMs;
}

export class TaskApprovalLedger {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.maximum = Number.isInteger(options.maximum) ? options.maximum : 256;
    this.maximumActivity = Number.isInteger(options.maximumActivity)
      ? options.maximumActivity
      : 512;
    this.maximumConfirmationAgeMs = Number.isInteger(options.maximumConfirmationAgeMs)
      ? options.maximumConfirmationAgeMs
      : 5 * 60_000;
    this.futureSkewMs = Number.isInteger(options.futureSkewMs) ? options.futureSkewMs : 30_000;
    this.pending = new Map();
    this.activity = [];
  }

  approve(input = {}) {
    const value = object(input, "approval");
    const id = taskSpaceId(value.taskSpaceId);
    const effect = normalizeTaskEffect(value.effect);
    if (!HIGH_IMPACT_SET.has(effect)) {
      throw new TaskApprovalError(
        "TASK_APPROVAL_NOT_REQUIRED",
        `Effect '${effect}' does not require a high-impact approval token`,
      );
    }
    const now = this.now();
    if (!validConfirmation(
      value.confirmation,
      now,
      this.maximumConfirmationAgeMs,
      this.futureSkewMs,
    )) {
      throw new TaskApprovalError(
        "USER_CONFIRMATION_REQUIRED",
        "A recent explicit user confirmation record is required",
      );
    }
    this.prune();
    if (this.pending.size >= this.maximum) {
      throw new TaskApprovalError(
        "TASK_APPROVAL_LIMIT",
        `Pending task-approval limit ${this.maximum} reached`,
      );
    }
    const ttlMs = value.ttlMs === undefined ? 60_000 : value.ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) {
      throw new TaskApprovalError(
        "INVALID_TASK_APPROVAL",
        "ttlMs must be an integer between 1000 and 120000",
      );
    }
    const approvalId = `approval:${randomUUID()}`;
    const token = `approval-token:${randomUUID()}`;
    const record = {
      approvalId,
      token,
      taskSpaceId: id,
      effect,
      requestDigest: digest(value.request),
      issuedAt: new Date(now).toISOString(),
      expiresAtMs: now + ttlMs,
    };
    this.pending.set(token, record);
    this.record("issued", record);
    return {
      approvalId,
      token,
      taskSpaceId: id,
      effect,
      requestDigest: record.requestDigest,
      issuedAt: record.issuedAt,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      oneTime: true,
    };
  }

  consume(input = {}) {
    const value = object(input, "approval use");
    const id = taskSpaceId(value.taskSpaceId);
    const effect = normalizeTaskEffect(value.effect);
    if (!HIGH_IMPACT_SET.has(effect)) return { required: false, effect };
    if (typeof value.token !== "string") {
      throw new TaskApprovalError(
        "TASK_APPROVAL_REQUIRED",
        `Effect '${effect}' requires a one-time approval token`,
      );
    }
    this.prune();
    const record = this.pending.get(value.token);
    if (!record) {
      throw new TaskApprovalError(
        "TASK_APPROVAL_REQUIRED",
        "Approval token is missing, expired or already consumed",
      );
    }
    this.pending.delete(value.token);
    const requestDigest = digest(value.request);
    if (record.taskSpaceId !== id || record.effect !== effect || record.requestDigest !== requestDigest) {
      this.record("rejected", record, { reason: "binding-mismatch" });
      throw new TaskApprovalError(
        "TASK_APPROVAL_MISMATCH",
        "Approval token is bound to a different taskSpace, effect or request",
      );
    }
    this.record("consumed", record);
    return {
      required: true,
      consumed: true,
      approvalId: record.approvalId,
      taskSpaceId: id,
      effect,
      requestDigest,
    };
  }

  prune() {
    const now = this.now();
    for (const [token, record] of this.pending) {
      if (record.expiresAtMs > now) continue;
      this.pending.delete(token);
      this.record("expired", record);
    }
  }

  listActivity(options = {}) {
    const limit = options.limit === undefined ? 100 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maximumActivity) {
      throw new TaskApprovalError(
        "INVALID_TASK_APPROVAL",
        `limit must be an integer between 1 and ${this.maximumActivity}`,
      );
    }
    return this.activity.slice(-limit).map((entry) => ({ ...entry }));
  }

  status() {
    this.prune();
    return {
      pending: this.pending.size,
      activityEntries: this.activity.length,
      maximumPending: this.maximum,
      maximumActivity: this.maximumActivity,
      highImpactEffects: [...HIGH_IMPACT_TASK_EFFECTS],
    };
  }

  record(event, record, details = {}) {
    this.activity.push({
      event,
      approvalId: record.approvalId,
      taskSpaceId: record.taskSpaceId,
      effect: record.effect,
      requestDigest: record.requestDigest,
      at: new Date(this.now()).toISOString(),
      ...details,
    });
    if (this.activity.length > this.maximumActivity) {
      this.activity.splice(0, this.activity.length - this.maximumActivity);
    }
  }
}
