import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => rejectPromise(error);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise(server.address());
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

function page(token, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body data-page="${name}"><main id="sentinel">${token}:${name}</main></body></html>`;
}

function requireCdpValue(terminal, label) {
  if (terminal?.ok !== true) {
    throw Object.assign(new Error(`${label} returned a failed terminal`), {
      code: terminal?.error?.code ?? "MULTI_NAVIGATION_EVALUATE_FAILED",
    });
  }
  const command = terminal.result;
  if (command?.method !== "Runtime.evaluate") {
    throw Object.assign(new Error(`${label} returned an invalid CDP method envelope`), {
      code: "MULTI_NAVIGATION_EVALUATE_INVALID_RESULT",
    });
  }
  if (command.result?.exceptionDetails) {
    throw Object.assign(new Error(`${label} raised a page exception`), {
      code: "MULTI_NAVIGATION_EVALUATE_PAGE_EXCEPTION",
      details: command.result.exceptionDetails,
    });
  }
  return command.result?.result;
}

async function rawEvaluate(moneyhand, task, expression) {
  return requireCdpValue(await moneyhand.taskRequest({
    taskSpaceId: task.taskSpaceId,
    effect: "read-only",
    request: {
      method: "cdp.send",
      params: {
        target: { tabId: task.tabId },
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          silent: true,
        },
      },
    },
  }), "Runtime.evaluate");
}

export async function run({ moneyhand, progress }) {
  const token = randomUUID();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    const name = url.pathname === "/a" ? "a" : url.pathname === "/b" ? "b" : null;
    if (!name) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(page(token, name));
  });

  let task;
  let lifecycle;
  const observations = [];
  const helperObservations = [];
  try {
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;
    task = await moneyhand.beginTaskContext({
      id: `multi-navigation-${token}`,
      behavior: "raw",
    });
    for (let index = 0; index < 8; index += 1) {
      const pageName = index % 2 === 0 ? "a" : "b";
      const url = `${origin}/${pageName}?round=${index}`;
      const navigation = await moneyhand.navigateTaskTab({
        taskSpaceId: task.taskSpaceId,
        tabId: task.tabId,
        url,
        expectedUrl: url,
        urlMatch: "exact",
        waitUntil: "domcontentloaded",
        timeoutMs: 10_000,
      });
      const remote = await rawEvaluate(moneyhand, task, `Promise.resolve({
        token:document.querySelector("#sentinel")?.textContent,
        page:document.body.dataset.page,
        href:location.href
      })`);
      const expectedToken = `${token}:${pageName}`;
      if (navigation.loaded !== true || remote?.value?.token !== expectedToken
        || remote.value.page !== pageName || remote.value.href !== url) {
        throw Object.assign(new Error(`Round ${index} did not read the current document`), {
          code: "MULTI_NAVIGATION_EVALUATE_MISMATCH",
          details: { index, expectedToken, navigation, remote },
        });
      }
      observations.push({ index, page: pageName, token: remote.value.token });
      const evaluated = await moneyhand.evaluateTaskTab({
        taskSpaceId: task.taskSpaceId,
        expression: `Promise.resolve({
          token:document.querySelector("#sentinel")?.textContent,
          page:document.body.dataset.page,
          href:location.href
        })`,
      });
      if (evaluated.hasValue !== true || evaluated.value?.token !== expectedToken
        || evaluated.value.page !== pageName || evaluated.value.href !== url) {
        throw Object.assign(new Error(`Helper round ${index} did not read the current document`), {
          code: "MULTI_NAVIGATION_HELPER_MISMATCH",
          details: { index, expectedToken, evaluated },
        });
      }
      helperObservations.push({ index, page: pageName, token: evaluated.value.token });
      await progress({
        phase: "multi-navigation-evaluate",
        current: index + 1,
        total: 8,
        checkpoint: `round:${index + 1}`,
        message: `Verified navigation/evaluate round ${index + 1}`,
      });
    }
    const undefinedValue = await moneyhand.evaluateTaskTab({
      taskSpaceId: task.taskSpaceId,
      expression: "void 0",
    });
    if (undefinedValue.isUndefined !== true || undefinedValue.hasValue !== false) {
      throw Object.assign(new Error("evaluateTaskTab did not preserve JavaScript undefined"), {
        code: "MULTI_NAVIGATION_UNDEFINED_MISMATCH",
        details: { undefinedValue },
      });
    }
    let exceptionCode;
    try {
      await moneyhand.evaluateTaskTab({
        taskSpaceId: task.taskSpaceId,
        expression: "throw new Error('multi-navigation-fixture')",
      });
    } catch (error) {
      exceptionCode = error?.code;
    }
    if (exceptionCode !== "TASK_EVALUATION_EXCEPTION") {
      throw Object.assign(new Error("evaluateTaskTab did not classify a page exception"), {
        code: "MULTI_NAVIGATION_EXCEPTION_MISMATCH",
        details: { exceptionCode },
      });
    }
    return {
      status: "complete",
      observations,
      helperObservations,
      requirements: [
        {
          id: "eight-current-document-raw-evaluations",
          satisfied: observations.length === 8,
          expected: 8,
          actual: observations.length,
        },
        {
          id: "eight-current-document-helper-evaluations",
          satisfied: helperObservations.length === 8,
          expected: 8,
          actual: helperObservations.length,
        },
        {
          id: "evaluation-edge-cases-classified",
          satisfied: undefinedValue.isUndefined === true
            && exceptionCode === "TASK_EVALUATION_EXCEPTION",
          expected: true,
          actual: true,
        },
      ],
    };
  } finally {
    if (task) {
      lifecycle = await moneyhand.completeTaskContext({
        taskSpaceId: task.taskSpaceId,
        keep: false,
        resetBehavior: true,
      });
      if (lifecycle.cleanupComplete !== true) {
        throw Object.assign(new Error("Multi-navigation task cleanup was not proven"), {
          code: "MULTI_NAVIGATION_CLEANUP_FAILED",
          details: { lifecycle },
        });
      }
    }
    await closeServer(server);
  }
}
