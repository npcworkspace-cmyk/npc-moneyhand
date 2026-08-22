import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("MoneyHand task worker requires a parent message port");

const pending = new Map();
const taskController = new AbortController();
let nextRequestId = 0;

function serializedError(error, fallbackCode = "MONEYHAND_TASK_FAILED") {
  const output = {
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error?.details !== undefined) output.details = error.details;
  return output;
}

function errorFromMessage(value = {}) {
  const error = new Error(typeof value.message === "string" ? value.message : "MoneyHand task call failed");
  error.name = typeof value.name === "string" ? value.name : "Error";
  if (typeof value.code === "string") error.code = value.code;
  if (value.details !== undefined) error.details = value.details;
  return error;
}

function withoutSignals(args) {
  return args.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, "signal")) {
      return value;
    }
    const { signal: _signal, ...rest } = value;
    return rest;
  });
}

function callParent(kind, method, args, allowAfterAbort = false) {
  if (taskController.signal.aborted && !allowAfterAbort) {
    return Promise.reject(taskController.signal.reason ?? new Error("MoneyHand task was aborted"));
  }
  const id = `${kind}:${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      parentPort.postMessage({ type: "call", id, kind, method, args });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

const moneyhand = new Proxy(Object.create(null), {
  get(_target, property) {
    if (property === "then") return undefined;
    if (typeof property !== "string") return undefined;
    if (Object.prototype.hasOwnProperty.call(workerData.synchronousMethods ?? {}, property)) {
      return () => structuredClone(workerData.synchronousMethods[property]);
    }
    return async (...args) => await callParent(
      "moneyhand",
      property,
      withoutSignals(args),
      property === "completeTaskContext",
    );
  },
});

const progress = async (value = {}) => await callParent("progress", "progress", [value]);

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "abort") {
    if (!taskController.signal.aborted) taskController.abort(errorFromMessage(message.reason));
    return;
  }
  if (message.type !== "response" || typeof message.id !== "string") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok === true) request.resolve(message.value);
  else request.reject(errorFromMessage(message.error));
});

Promise.resolve()
  .then(async () => {
    if (taskController.signal.aborted) throw taskController.signal.reason;
    const taskModule = await import(workerData.taskModuleUrl);
    if (taskController.signal.aborted) throw taskController.signal.reason;
    if (taskModule.MONEYHAND_TASK_TEMPLATE === "replace-before-running") {
      const error = new Error(
        "The packaged task template or an unchanged copy cannot run; copy it to a task-owned path, replace the placeholder with the concrete user task, and remove MONEYHAND_TASK_TEMPLATE before submitting",
      );
      error.code = "TASK_TEMPLATE_NOT_IMPLEMENTED";
      error.details = { actionDispatched: false, retry: "implement-task-before-submitting" };
      throw error;
    }
    if (typeof taskModule.run !== "function") {
      const error = new Error("MoneyHand task module must export async function run");
      error.code = "INVALID_TASK";
      throw error;
    }
    return await taskModule.run({
      moneyhand,
      signal: taskController.signal,
      args: workerData.args,
      progress,
      taskExecutionId: workerData.taskExecutionId,
    });
  })
  .then(
    (value) => parentPort.postMessage({ type: "settled", ok: true, value }),
    (error) => parentPort.postMessage({
      type: "settled",
      ok: false,
      error: serializedError(error),
    }),
  )
  .catch((error) => {
    parentPort.postMessage({
      type: "settled",
      ok: false,
      error: serializedError(error, "TASK_RESULT_NOT_SERIALIZABLE"),
    });
  });
