import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

// Runnable platform-neutral reference task. Copy it to a task-owned path. When the generic
// selectors fit, keep the source unchanged. In args.acceptance, declare only expectations explicitly
// supplied by the user or authoritative task input; omit unknown values instead of guessing them.
// Otherwise adapt collectPage() while preserving the fixed run() lifecycle.

function taskError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "TASK_FAILED",
    message: String(error?.message ?? error).slice(0, 4_096),
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableEffectId(prefix, key) {
  const safePrefix = String(prefix ?? "effect")
    .replace(/[^A-Za-z0-9._:-]/gu, "_")
    .slice(0, 32) || "effect";
  const stableKey = String(key ?? "");
  if (!stableKey) fail("INVALID_EFFECT_KEY", "stableEffectId() requires a canonical key");
  const digest = createHash("sha256").update(stableKey).digest("hex").slice(0, 24);
  return `${safePrefix}:${digest}`;
}

function stableRequirementId(prefix, key) {
  const visible = String(key ?? "")
    .replace(/[^A-Za-z0-9._:-]/gu, "_")
    .slice(0, 64) || "value";
  const digest = createHash("sha256").update(String(key ?? "")).digest("hex").slice(0, 8);
  return `${prefix}:${visible}:${digest}`;
}

export function pageExpression(pageFunction, input) {
  if (typeof pageFunction !== "function") {
    fail("INVALID_PAGE_EXPRESSION", "pageExpression() requires an arrow or function expression");
  }
  let encodedInput;
  try {
    encodedInput = JSON.stringify(input);
  } catch {
    fail("INVALID_PAGE_EXPRESSION_INPUT", "pageExpression() input must be JSON-serializable");
  }
  if (encodedInput === undefined) encodedInput = "null";
  return `(${Function.prototype.toString.call(pageFunction)})(${encodedInput})`;
}

export function recordGroupOrderRequirement(records, expectedPageKeys, key = "pageKey") {
  if (!Array.isArray(records) || !Array.isArray(expectedPageKeys) || expectedPageKeys.length < 1) {
    fail("INVALID_RECORD_GROUP_ORDER_INPUT", "records and expected page keys are required");
  }
  const expected = expectedPageKeys.map((value) => String(value));
  const actual = [];
  for (const record of records) {
    const value = record && typeof record === "object" && !Array.isArray(record)
      ? String(record[key] ?? "")
      : "";
    if (!value) fail("INVALID_RECORD_GROUP_ORDER_INPUT", `Every record needs '${key}'`);
    if (actual.at(-1) !== value) actual.push(value);
  }
  return {
    id: "record-page-order",
    satisfied: actual.length === expected.length
      && actual.every((value, index) => value === expected[index]),
    expected: expected.join("\n"),
    actual: actual.join("\n"),
  };
}

function acceptanceInput(value, pages, maxRecordsPerPage) {
  if (value === undefined) {
    return { recordCount: null, recordsByPage: [], pageIds: [], requiredFields: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TASK_ARGS", "args.acceptance must be an object");
  }
  const allowed = new Set(["recordCount", "recordsByPage", "pageIds", "requiredFields"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("INVALID_TASK_ARGS", `args.acceptance has unknown keys: ${unknown.join(", ")}`);
  }
  const pageKeys = new Set(pages.map((page) => page.id));
  let recordCount = null;
  if (Object.hasOwn(value, "recordCount")) {
    if (!Number.isInteger(value.recordCount)
      || value.recordCount < pages.length
      || value.recordCount > pages.length * maxRecordsPerPage) {
      fail(
        "INVALID_TASK_ARGS",
        "args.acceptance.recordCount must fit the bounded per-page record range",
      );
    }
    recordCount = value.recordCount;
  }
  const recordsByPage = [];
  if (Object.hasOwn(value, "recordsByPage")) {
    if (!value.recordsByPage || typeof value.recordsByPage !== "object"
      || Array.isArray(value.recordsByPage)) {
      fail("INVALID_TASK_ARGS", "args.acceptance.recordsByPage must be an object");
    }
    for (const [pageKey, expected] of Object.entries(value.recordsByPage)) {
      if (!pageKeys.has(pageKey) || !Number.isInteger(expected)
        || expected < 1 || expected > maxRecordsPerPage) {
        fail(
          "INVALID_TASK_ARGS",
          "args.acceptance.recordsByPage needs known page keys and bounded positive counts",
        );
      }
      recordsByPage.push({ pageKey, expected });
    }
  }
  const pageIds = [];
  if (Object.hasOwn(value, "pageIds")) {
    if (!value.pageIds || typeof value.pageIds !== "object" || Array.isArray(value.pageIds)) {
      fail("INVALID_TASK_ARGS", "args.acceptance.pageIds must be an object");
    }
    for (const [pageKey, expected] of Object.entries(value.pageIds)) {
      if (!pageKeys.has(pageKey) || typeof expected !== "string"
        || expected.length < 1 || expected.length > 4_096) {
        fail(
          "INVALID_TASK_ARGS",
          "args.acceptance.pageIds needs known page keys and non-empty string values",
        );
      }
      pageIds.push({ pageKey, expected });
    }
  }
  let requiredFields = [];
  if (Object.hasOwn(value, "requiredFields")) {
    if (!Array.isArray(value.requiredFields)
      || value.requiredFields.length < 1 || value.requiredFields.length > 32) {
      fail("INVALID_TASK_ARGS", "args.acceptance.requiredFields must contain 1-32 field names");
    }
    requiredFields = value.requiredFields.map((field) => {
      if (typeof field !== "string" || field.length < 1 || field.length > 128
        || /[\u0000-\u001f\u007f]/u.test(field)) {
        fail("INVALID_TASK_ARGS", "args.acceptance.requiredFields contains an invalid field name");
      }
      return field;
    });
    if (new Set(requiredFields).size !== requiredFields.length) {
      fail("INVALID_TASK_ARGS", "args.acceptance.requiredFields must be unique");
    }
  }
  return { recordCount, recordsByPage, pageIds, requiredFields };
}

function acceptanceRequirements(plan, records, completedPageIds) {
  const requirements = [{
    id: "requested-pages",
    satisfied: completedPageIds.length === plan.pages.length,
    expected: plan.pages.length,
    actual: completedPageIds.length,
  }, {
    id: "requested-page-identifiers",
    satisfied: completedPageIds.every((id, index) => id === plan.pages[index].id),
    expected: plan.pages.map((page) => page.id).join("\n"),
    actual: completedPageIds.join("\n"),
  }, recordGroupOrderRequirement(records, plan.pages.map((page) => page.id))];
  if (plan.acceptance.recordCount !== null) {
    requirements.push({
      id: "requested-record-count",
      satisfied: records.length === plan.acceptance.recordCount,
      expected: plan.acceptance.recordCount,
      actual: records.length,
    });
  }
  for (const { pageKey, expected } of plan.acceptance.recordsByPage) {
    const actual = records.filter((record) => record.pageKey === pageKey).length;
    requirements.push({
      id: stableRequirementId("page-record-count", pageKey),
      satisfied: actual === expected,
      expected,
      actual,
    });
  }
  for (const { pageKey, expected } of plan.acceptance.pageIds) {
    const actualValues = [...new Set(records
      .filter((record) => record.pageKey === pageKey)
      .map((record) => record.pageId))];
    requirements.push({
      id: stableRequirementId("page-id", pageKey),
      satisfied: actualValues.length === 1 && actualValues[0] === expected,
      expected,
      actual: actualValues.join("\n"),
    });
  }
  for (const field of plan.acceptance.requiredFields) {
    const actual = records.filter((record) => Object.hasOwn(record, field)).length;
    requirements.push({
      id: stableRequirementId("required-field", field),
      satisfied: actual === records.length,
      expected: records.length,
      actual,
    });
  }
  return requirements;
}

function inputs(args) {
  if (!Array.isArray(args.pages) || args.pages.length < 1 || args.pages.length > 50) {
    fail("INVALID_TASK_ARGS", "args.pages must contain 1-50 {id,url} entries");
  }
  const seen = new Set();
  const pages = args.pages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_TASK_ARGS", `args.pages[${index}] must be an object`);
    }
    const id = String(entry.id ?? "").trim();
    if (!id || seen.has(id)) fail("INVALID_TASK_ARGS", `args.pages[${index}].id must be unique`);
    seen.add(id);
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      fail("INVALID_TASK_ARGS", `args.pages[${index}].url must be absolute`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      fail("INVALID_TASK_ARGS", `args.pages[${index}].url must be credential-free HTTP(S)`);
    }
    return { id, url: url.href };
  });
  const outputPath = String(args.outputPath ?? "");
  const manifestPath = String(args.manifestPath ?? "");
  const checkpointPath = String(args.checkpointPath ?? "");
  for (const [label, path, suffix] of [
    ["outputPath", outputPath, ".jsonl"],
    ["manifestPath", manifestPath, ".json"],
    ["checkpointPath", checkpointPath, ".json"],
  ]) {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith(suffix)) {
      fail("INVALID_TASK_ARGS", `args.${label} must be an absolute ${suffix} path`);
    }
  }
  if (new Set([outputPath, manifestPath, checkpointPath]).size !== 3) {
    fail("INVALID_TASK_ARGS", "output, manifest and checkpoint paths must differ");
  }
  const maxTextChars = Number.isInteger(args.maxTextChars)
    && args.maxTextChars >= 100 && args.maxTextChars <= 20_000
    ? args.maxTextChars
    : 4_000;
  const maxRecordsPerPage = Number.isInteger(args.maxRecordsPerPage)
    && args.maxRecordsPerPage >= 1 && args.maxRecordsPerPage <= 1_000
    ? args.maxRecordsPerPage
    : 100;
  const acceptance = acceptanceInput(args.acceptance, pages, maxRecordsPerPage);
  return {
    pages,
    outputPath,
    manifestPath,
    checkpointPath,
    maxTextChars,
    maxRecordsPerPage,
    acceptance,
  };
}

async function collectPage({ moneyhand, task, signal, page, maxTextChars, maxRecordsPerPage }) {
  await moneyhand.navigateTaskTab({
    taskSpaceId: task.taskSpaceId,
    tabId: task.tabId,
    url: page.url,
    effectId: stableEffectId("navigate", `${page.id}\n${page.url}`),
    waitUntil: "domcontentloaded",
    timeoutMs: 30_000,
    signal,
  });
  const evaluated = await moneyhand.evaluateTaskTab({
    taskSpaceId: task.taskSpaceId,
    tabId: task.tabId,
    // Replace only these generic record selectors/fields for the concrete site. Collect every
    // bounded matching record; never invent a per-page cardinality the user did not request.
    expression: pageExpression(({ id, maxTextChars, maxRecordsPerPage }) => {
      const pageId = document.querySelector("[data-page-id]")?.getAttribute("data-page-id") ?? id;
      const elements = [...document.querySelectorAll("[data-record], .record-card")]
        .slice(0, maxRecordsPerPage);
      return elements.map((element, index) => ({
        id: `${id}:${index}`,
        pageKey: id,
        pageId,
        url: location.href,
        pageTitle: document.title,
        index,
        text: (element.innerText ?? "").slice(0, maxTextChars),
        literalTemplateTextIsSafe: "literal-${POST_ID}",
      }));
    }, { id: page.id, maxTextChars, maxRecordsPerPage }),
    timeoutMs: 15_000,
    signal,
  });
  const records = evaluated.value;
  if (!Array.isArray(records) || records.length < 1 || records.length > maxRecordsPerPage
    || records.some((record) => !record || typeof record !== "object" || Array.isArray(record)
      || record.pageKey !== page.id || typeof record.id !== "string"
      || typeof record.url !== "string" || typeof record.pageId !== "string"
      || typeof record.pageTitle !== "string" || !Number.isInteger(record.index)
      || typeof record.text !== "string")) {
    fail("PAGE_RECORD_INVALID", `Page '${page.id}' did not return bounded record rows`);
  }
  return records;
}

async function executeTask({ moneyhand, task, signal, args, progress }) {
  const plan = inputs(args);
  await Promise.all([
    mkdir(dirname(plan.outputPath), { recursive: true }),
    mkdir(dirname(plan.manifestPath), { recursive: true }),
    mkdir(dirname(plan.checkpointPath), { recursive: true }),
  ]);
  const reserved = [];
  try {
    for (const path of [plan.outputPath, plan.manifestPath, plan.checkpointPath]) {
      await writeFile(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      reserved.push(path);
    }
  } catch (error) {
    await Promise.all(reserved.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
  const records = [];
  const completedPageIds = [];
  for (let index = 0; index < plan.pages.length; index += 1) {
    const page = plan.pages[index];
    records.push(...await collectPage({
      moneyhand,
      task,
      signal,
      page,
      maxTextChars: plan.maxTextChars,
      maxRecordsPerPage: plan.maxRecordsPerPage,
    }));
    completedPageIds.push(page.id);
    await writeFile(plan.checkpointPath, `${JSON.stringify({
      schema: "npc-moneyhand-example-checkpoint/1",
      completed: index + 1,
      total: plan.pages.length,
      completedIds: [...completedPageIds],
      recordCount: records.length,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await progress({
      phase: "collect",
      message: `Collected ${page.id}`,
      current: index + 1,
      total: plan.pages.length,
      checkpoint: `page:${page.id}`,
    });
  }
  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(plan.outputPath, jsonl, { encoding: "utf8", mode: 0o600 });
  const manifest = {
    schema: "npc-moneyhand-task-output/1",
    format: "jsonl",
    path: plan.outputPath,
    count: records.length,
    checkpointPath: plan.checkpointPath,
  };
  await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    outcome: {
      status: "complete",
      requirements: acceptanceRequirements(plan, records, completedPageIds),
      evidence: [
        { type: "output-file", path: plan.outputPath, format: "jsonl", count: records.length },
        { type: "output-manifest", path: plan.manifestPath },
      ],
    },
    output: { ...manifest, manifestPath: plan.manifestPath },
  };
}

async function attachTerminalVisual(moneyhand, task, outcome) {
  if (outcome?.status === "complete" || outcome?.visualFallback?.captured === true) return outcome;
  try {
    const visualFallback = await moneyhand.inspectTaskBlocker({
      taskSpaceId: task.taskSpaceId,
      operation: "task-terminal",
      reason: {
        code: outcome?.error?.code ?? outcome?.reason ?? "TASK_INCOMPLETE",
        message: outcome?.error?.message ?? "Task did not reach a complete outcome",
        retry: "inspect-current-page-before-next-action",
      },
    });
    const evidence = Array.isArray(outcome?.evidence) ? [...outcome.evidence] : [];
    if (visualFallback.captured && !evidence.some((entry) => (
      entry?.type === "visual-fallback" && entry.path === visualFallback.screenshot?.path
    ))) {
      evidence.push({ type: "visual-fallback", path: visualFallback.screenshot.path });
    }
    return { ...outcome, visualFallback, evidence };
  } catch (error) {
    if (outcome?.visualFallback) return outcome;
    return {
      ...outcome,
      visualFallback: {
        captured: false,
        screenshot: { captured: false, error: taskError(error) },
        actionReplayed: false,
      },
    };
  }
}

function taskResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.outcome || typeof value.outcome !== "object") {
    fail("TASK_RESULT_CONTRACT_INVALID", "executeTask() must return { outcome, output? }");
  }
  return { outcome: value.outcome, output: value.output ?? null };
}

export async function run({ moneyhand, signal, args = {}, progress, taskExecutionId }) {
  const task = await moneyhand.beginTaskContext({
    ...(args.taskId ? { id: args.taskId } : {}),
    behavior: args.behavior === "human" ? "human" : "raw",
    ...(args.behavior === "human" && args.behaviorOptions
      ? { behaviorOptions: args.behaviorOptions }
      : {}),
    signal,
  });
  let outcome;
  let output = null;
  let lifecycle;
  try {
    await progress({ phase: "start", message: "Task context is ready" });
    ({ outcome, output } = taskResult(await executeTask({
      moneyhand,
      task,
      signal,
      args,
      progress,
    })));
  } catch (error) {
    const normalized = taskError(error);
    const visualFallback = error?.details?.visualFallback;
    outcome = {
      status: normalized.code.includes("OUTCOME_UNKNOWN") ? "outcome_unknown" : "incomplete",
      reason: normalized.code,
      error: normalized,
      requirements: [{ id: "task-finished-with-proof", satisfied: false }],
      evidence: visualFallback?.captured
        ? [{ type: "visual-fallback", path: visualFallback.screenshot.path }]
        : [],
      ...(visualFallback === undefined ? {} : { visualFallback }),
    };
  } finally {
    outcome = await attachTerminalVisual(moneyhand, task, outcome);
    lifecycle = await moneyhand.completeTaskContext({
      taskSpaceId: task.taskSpaceId,
      keep: false,
      resetBehavior: true,
    });
  }
  if (!lifecycle.cleanupComplete && outcome.status === "complete") {
    outcome = { ...outcome, status: "incomplete", reason: "TASK_CLEANUP_INCOMPLETE" };
  }
  return {
    taskExecutionId,
    args,
    task: { page: task.page, behavior: task.behavior },
    outcome,
    output,
    lifecycle,
  };
}
