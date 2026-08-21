import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const CHECK_TOTAL = 15;

function normalizedError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "CONNECT_ACCEPTANCE_FAILED",
    message: String(error?.message ?? error).slice(0, 4_096),
  };
}

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
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function fixtureHtml(token, downloadPath) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MoneyHand automatic acceptance</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:16px system-ui;margin:32px;line-height:1.5}main{max-width:760px}label,button,a{display:block;margin:14px 0}
input,button,select,a{font:inherit;padding:9px}.spacer{height:1400px;background:linear-gradient(#fff,#eef6ff)}
#bottom{padding:24px;background:#eaf7ee}
</style></head><body><main>
<h1>MoneyHand automatic acceptance</h1><p>Local fixture ${token}</p>
<label for="acceptance-text">Acceptance text</label>
<input id="acceptance-text" aria-label="Acceptance text" autocomplete="off">
<button id="acceptance-button" type="button">Apply acceptance input</button>
<output id="acceptance-output" aria-live="polite">idle</output>
<label><input id="acceptance-check" type="checkbox" aria-label="Acceptance checkbox"> Acceptance checkbox</label>
<label for="acceptance-select">Acceptance select</label>
<select id="acceptance-select" aria-label="Acceptance select"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
<label for="acceptance-upload">Acceptance upload</label>
<input id="acceptance-upload" type="file" aria-label="Acceptance upload">
<a id="acceptance-download" href="${downloadPath}">Download acceptance file</a>
<div class="spacer" aria-hidden="true"></div><p id="bottom">Acceptance page bottom</p>
</main><script>
globalThis.__moneyhandAcceptance={clicks:0,uploadName:""};
document.querySelector("#acceptance-button").addEventListener("click",()=>{
  globalThis.__moneyhandAcceptance.clicks+=1;
  document.querySelector("#acceptance-output").value="accepted:"+document.querySelector("#acceptance-text").value;
});
document.querySelector("#acceptance-upload").addEventListener("change",(event)=>{
  globalThis.__moneyhandAcceptance.uploadName=event.target.files?.[0]?.name||"";
});
</script></body></html>`;
}

function createFixtureServer(token, downloadFilename) {
  const pagePath = `/fixture/${token}`;
  const downloadPath = `/download/${token}`;
  const html = fixtureHtml(token, downloadPath);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === downloadPath) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${downloadFilename}"`,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("npc-moneyhand automatic acceptance download\n");
      return;
    }
    if (url.pathname !== pagePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(html);
  });
  return { server, pagePath, downloadPath };
}

function requireTerminal(terminal, label) {
  if (terminal?.ok !== true) {
    const error = new Error(`${label} did not return a successful terminal result`);
    error.code = terminal?.error?.code ?? "CONNECT_ACCEPTANCE_TERMINAL_FAILED";
    throw error;
  }
  return terminal.result;
}

async function evaluate(moneyhand, task, expression) {
  const terminal = await moneyhand.taskRequest({
    taskSpaceId: task.taskSpaceId,
    effect: "read-only",
    request: {
      method: "cdp.send",
      params: {
        target: { tabId: task.tabId },
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      },
    },
  });
  const command = requireTerminal(terminal, "Runtime.evaluate");
  const value = command?.result?.result?.value;
  if (value === undefined) {
    const error = new Error("Runtime.evaluate returned no serializable value");
    error.code = "CONNECT_ACCEPTANCE_READ_FAILED";
    throw error;
  }
  return value;
}

async function chromeCall(moneyhand, task, method, args) {
  const terminal = await moneyhand.request({
    method: "chrome.call",
    params: { method, args },
  }, { selector: task.selector });
  const value = requireTerminal(terminal, method);
  if (value?.method !== method) {
    const error = new Error(`${method} returned an invalid method envelope`);
    error.code = "CONNECT_ACCEPTANCE_CHROME_CALL_FAILED";
    throw error;
  }
  return value.result;
}

function semanticNode(snapshot, name) {
  const node = snapshot.nodes.find((candidate) => candidate.name === name);
  if (node) return node;
  const error = new Error(`Semantic snapshot did not expose '${name}'`);
  error.code = "CONNECT_ACCEPTANCE_TARGET_MISSING";
  throw error;
}

export async function run({ moneyhand, signal, args = {}, progress }) {
  const token = randomUUID();
  const downloadFilename = `npc-moneyhand-acceptance-${token}.txt`;
  const fixture = createFixtureServer(token, downloadFilename);
  const taskRoot = await mkdtemp(join(tmpdir(), "npc-moneyhand-acceptance-"));
  const uploadPath = join(taskRoot, "acceptance-upload.txt");
  const viewportPath = join(taskRoot, "acceptance-viewport.png");
  const fullPagePath = join(taskRoot, "acceptance-full-page.png");
  await writeFile(uploadPath, "npc-moneyhand automatic acceptance upload\n", "utf8");

  const checks = [];
  const evidence = [];
  let activeCheck = "fixture_server";
  let task;
  let lifecycle;
  let downloadId;
  const pass = async (name, detail = {}) => {
    checks.push({ name, status: "passed", ...detail });
    await progress({
      phase: "acceptance",
      current: checks.length,
      total: CHECK_TOTAL,
      checkpoint: name,
      message: `Automatic acceptance passed: ${name}`,
    });
  };

  let outcome;
  try {
    const address = await listen(fixture.server);
    const origin = `http://127.0.0.1:${address.port}`;
    const fixtureUrl = `${origin}${fixture.pagePath}`;
    const downloadUrl = `${origin}${fixture.downloadPath}`;

    activeCheck = "task_context_and_human_mode";
    task = await moneyhand.beginTaskContext({
      ...(args.taskId ? { id: args.taskId } : {}),
      behavior: "human",
      behaviorOptions: {
        beforeMs: 0,
        afterMs: 0,
        betweenStepsMs: 0,
        typingDelayMs: 5,
        pointerSteps: 3,
        pointerDurationMs: 30,
        ttlMs: 60_000,
      },
      signal,
    });
    if (task.behavior?.mode !== "human" || task.page?.ownedWindow !== true) {
      throw Object.assign(new Error("Task context did not confirm a human-mode owned window"), {
        code: "CONNECT_ACCEPTANCE_TASK_CONTEXT_FAILED",
      });
    }
    await pass(activeCheck, { mode: "human", ownedWindow: true });

    activeCheck = "localhost_navigation";
    const navigation = await moneyhand.navigateTaskTab({
      taskSpaceId: task.taskSpaceId,
      tabId: task.tabId,
      url: fixtureUrl,
      expectedUrl: fixtureUrl,
      urlMatch: "exact",
      effect: "navigation",
      waitUntil: "domcontentloaded",
      timeoutMs: 10_000,
      signal,
    });
    if (navigation.loaded !== true) {
      throw Object.assign(new Error("Local fixture navigation was not proven loaded"), {
        code: "CONNECT_ACCEPTANCE_NAVIGATION_FAILED",
      });
    }
    await pass(activeCheck, { loaded: true, transport: navigation.navigation?.transport ?? "cdp" });

    activeCheck = "semantic_snapshot";
    const captured = await moneyhand.captureSemanticSnapshot({
      tabId: task.tabId,
      selector: task.selector,
      includeDomSnapshot: true,
      maxNodes: 200,
      signal,
    });
    if (!captured.snapshot) {
      throw Object.assign(new Error("Semantic snapshot returned no snapshot"), {
        code: "CONNECT_ACCEPTANCE_SNAPSHOT_FAILED",
      });
    }
    const snapshot = captured.snapshot;
    const targets = {
      text: semanticNode(snapshot, "Acceptance text"),
      button: semanticNode(snapshot, "Apply acceptance input"),
      check: semanticNode(snapshot, "Acceptance checkbox"),
      select: semanticNode(snapshot, "Acceptance select"),
      upload: semanticNode(snapshot, "Acceptance upload"),
      download: semanticNode(snapshot, "Download acceptance file"),
    };
    await pass(activeCheck, { nodes: snapshot.nodes.length, hrefExposed: targets.download.href === downloadUrl });

    const action = async (target, actionName, fields = {}) => await moneyhand.actSemanticRef({
      taskSpaceId: task.taskSpaceId,
      snapshotId: snapshot.id,
      ref: target.ref,
      action: actionName,
      effect: actionName === "download" ? "download" : actionName === "upload" ? "upload" : "input",
      signal,
      ...fields,
    });

    activeCheck = "text_input";
    const typed = await action(targets.text, "type", {
      text: "moneyhand-ready",
      replace: true,
      verification: { kind: "target-value-equals", value: "moneyhand-ready" },
    });
    if (typed.actionDispatched !== true) throw new Error("Text input was not dispatched");
    await pass(activeCheck, { verified: true });

    activeCheck = "pointer_click";
    const clicked = await action(targets.button, "click", {
      verification: { kind: "target-focused" },
    });
    if (clicked.actionDispatched !== true) throw new Error("Pointer click was not dispatched");
    await pass(activeCheck, { verified: true });

    activeCheck = "checkbox";
    const checked = await action(targets.check, "check");
    if (checked.checkedState?.after !== true) throw new Error("Checkbox did not reach checked state");
    await pass(activeCheck, { checked: true });

    activeCheck = "select";
    const selected = await action(targets.select, "select", { options: ["beta"] });
    if (selected.selection?.options?.[0]?.value !== "beta") {
      throw new Error("Select did not reach the beta option");
    }
    await pass(activeCheck, { value: "beta" });

    activeCheck = "upload";
    const uploaded = await action(targets.upload, "upload", {
      fileRoot: taskRoot,
      files: [uploadPath],
    });
    if (uploaded.fileSelection?.count !== 1) throw new Error("Upload did not select one file");
    await pass(activeCheck, { count: 1, filename: basename(uploadPath) });

    activeCheck = "human_scroll";
    const scrolled = await moneyhand.scrollTaskTab({
      taskSpaceId: task.taskSpaceId,
      tabId: task.tabId,
      deltaY: 700,
      signal,
    });
    if (scrolled.actionDispatched !== true) throw new Error("Human scroll was not dispatched");
    await pass(activeCheck, { deltaY: 700 });

    activeCheck = "bounded_cdp_read";
    const state = await evaluate(moneyhand, task, `({
      value:document.querySelector("#acceptance-text").value,
      output:document.querySelector("#acceptance-output").value,
      checked:document.querySelector("#acceptance-check").checked,
      selected:document.querySelector("#acceptance-select").value,
      uploadName:globalThis.__moneyhandAcceptance.uploadName,
      clicks:globalThis.__moneyhandAcceptance.clicks,
      scrollY:globalThis.scrollY
    })`);
    if (state.value !== "moneyhand-ready" || state.output !== "accepted:moneyhand-ready"
      || state.checked !== true || state.selected !== "beta"
      || state.uploadName !== basename(uploadPath) || state.clicks !== 1 || state.scrollY <= 0) {
      throw Object.assign(new Error("Local fixture state did not match all dispatched actions"), {
        code: "CONNECT_ACCEPTANCE_STATE_MISMATCH",
      });
    }
    await pass(activeCheck, { allActionPostconditions: true });

    activeCheck = "viewport_screenshot";
    const viewport = await moneyhand.captureStableViewport({
      taskSpaceId: task.taskSpaceId,
      outputPath: viewportPath,
      signal,
    });
    const viewportFile = await stat(viewportPath);
    if (viewport.stable !== true || viewportFile.size < 100) throw new Error("Viewport screenshot was empty");
    await pass(activeCheck, { bytes: viewportFile.size, sha256: viewport.bundle?.image?.sha256 });

    activeCheck = "full_page_screenshot";
    const fullPage = await moneyhand.captureFullPage({
      taskSpaceId: task.taskSpaceId,
      outputPath: fullPagePath,
      signal,
    });
    const fullPageFile = await stat(fullPagePath);
    if (fullPage.observationOnly !== true || fullPageFile.size < 100) throw new Error("Full-page screenshot was empty");
    await pass(activeCheck, { bytes: fullPageFile.size, sha256: fullPage.image?.sha256 });

    activeCheck = "download";
    const downloaded = await action(targets.download, "download", {
      download: {
        timeoutMs: 10_000,
        pollIntervalMs: 100,
        match: { filename: downloadFilename },
      },
    });
    downloadId = downloaded.download?.id;
    if (!Number.isInteger(downloadId) || downloaded.download?.state !== "complete") {
      throw new Error("Download did not return a complete receipt");
    }
    await pass(activeCheck, { state: "complete", filename: downloadFilename });

    activeCheck = "download_cleanup";
    await chromeCall(moneyhand, task, "downloads.removeFile", [downloadId]);
    await chromeCall(moneyhand, task, "downloads.erase", [{ id: downloadId }]);
    downloadId = undefined;
    await pass(activeCheck, { fileRemoved: true, historyRemoved: true });

    evidence.push({
      type: "automatic-browser-acceptance",
      scope: "localhost-owned-task-window",
      externalWebsiteRequested: false,
      allActionPostconditions: true,
    });
    outcome = {
      status: "complete",
      reason: null,
      checks,
      evidence,
    };
  } catch (error) {
    const failure = normalizedError(error);
    if (!checks.some((check) => check.name === activeCheck)) {
      checks.push({ name: activeCheck, status: "failed", error: failure });
    }
    const visualFallback = error?.details?.visualFallback;
    outcome = {
      status: "incomplete",
      reason: failure.code,
      error: failure,
      checks,
      evidence: visualFallback?.captured
        ? [{ type: "visual-fallback", path: visualFallback.screenshot.path }]
        : evidence,
    };
  } finally {
    if (downloadId !== undefined && task) {
      await chromeCall(moneyhand, task, "downloads.removeFile", [downloadId]).catch(() => undefined);
      await chromeCall(moneyhand, task, "downloads.erase", [{ id: downloadId }]).catch(() => undefined);
    }
    if (task) {
      try {
        lifecycle = await moneyhand.completeTaskContext({
          taskSpaceId: task.taskSpaceId,
          keep: false,
          resetBehavior: true,
        });
      } catch (error) {
        lifecycle = { cleanupComplete: false, error: normalizedError(error) };
      }
    }
    await closeServer(fixture.server).catch(() => undefined);
    await rm(taskRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  activeCheck = "task_window_and_behavior_cleanup";
  const cleanupPassed = lifecycle?.cleanupComplete === true
    && lifecycle?.windowCleanup?.ok === true
    && lifecycle?.behaviorReset?.ok === true
    && lifecycle?.behaviorReset?.value?.behavior?.mode === "raw";
  checks.push(cleanupPassed
    ? { name: activeCheck, status: "passed", windowClosed: true, behavior: "raw" }
    : {
        name: activeCheck,
        status: "failed",
        error: lifecycle?.error ?? { code: "CONNECT_ACCEPTANCE_CLEANUP_FAILED", message: "Task cleanup was not proven" },
      });
  if (cleanupPassed && outcome.status === "complete") {
    await progress({
      phase: "acceptance",
      current: CHECK_TOTAL,
      total: CHECK_TOTAL,
      checkpoint: activeCheck,
      message: `Automatic acceptance passed: ${activeCheck}`,
    });
  } else {
    outcome = {
      ...outcome,
      status: "incomplete",
      reason: outcome.reason ?? "CONNECT_ACCEPTANCE_CLEANUP_FAILED",
      checks,
    };
  }

  return {
    schema: "npc-moneyhand-connect-acceptance-task/1",
    outcome: { ...outcome, checks },
    lifecycle: {
      cleanupComplete: lifecycle?.cleanupComplete === true,
      windowClosed: lifecycle?.windowCleanup?.ok === true,
      behaviorReset: lifecycle?.behaviorReset?.value?.behavior?.mode ?? null,
    },
  };
}
