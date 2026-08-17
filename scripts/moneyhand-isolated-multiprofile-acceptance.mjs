import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createMoneyHand } from "../skills/npc-moneyhand/scripts/moneyhand.mjs";

if (process.platform !== "win32") {
  process.stdout.write(`${JSON.stringify({
    skipped: true,
    reason: "windows-isolated-desktop-acceptance-only",
  }, null, 2)}\n`);
  process.exit(0);
}

if (typeof globalThis.WebSocket !== "function") {
  throw new Error("This acceptance requires the Node.js 22+ global WebSocket client");
}

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LAUNCHER = join(ROOT, "tests", "fixtures", "isolated-desktop-launcher.ps1");
const PROFILE_HOST = join(ROOT, "tests", "fixtures", "moneyhand-chromium-profile.ps1");
const EXTENSION_ROOT = join(ROOT, "extension");
const MONEYHAND_WORKER_PATH = "/background.js";
const PROFILE_COUNT = 2;
const EVALUATION_DELAY_MS = 800;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function chromiumCandidates() {
  const explicit = process.env.NPC_MONEYHAND_ACCEPTANCE_TEST_CHROMIUM;
  const candidates = explicit ? [resolve(explicit)] : [];
  const playwrightRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "ms-playwright")
    : undefined;
  if (playwrightRoot && existsSync(playwrightRoot)) {
    const versions = readdirSync(playwrightRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
      .sort((left, right) => Number(right.name.slice(9)) - Number(left.name.slice(9)));
    for (const entry of versions) {
      candidates.push(join(playwrightRoot, entry.name, "chrome-win64", "chrome.exe"));
    }
  }
  return [...new Set(candidates)].filter((path) => existsSync(path));
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${options.label ?? "condition"} did not become true within ${timeoutMs}ms${
    lastError ? `; last error=${lastError.message}` : ""
  }`);
}

function startFixtureServer(tokens) {
  const allowed = new Map([
    ["/a", { title: "MoneyHand Profile A", token: tokens.a, kind: "checkable" }],
    ["/b", { title: "MoneyHand Profile B", token: tokens.b, kind: "frame-parent" }],
    ["/frame-child", { title: "MoneyHand OOPIF Child", token: tokens.b, kind: "frame-child" }],
  ]);
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method,
      host: request.headers.host ?? "",
      path: url.pathname,
      token: url.searchParams.get("token"),
    });
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const fixture = allowed.get(url.pathname);
    if (!fixture || url.searchParams.get("token") !== fixture.token) {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return;
    }
    const port = server.address().port;
    const contentSecurityPolicy = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      ...(fixture.kind === "frame-parent" ? [`frame-src http://localhost:${port}`] : []),
      ...(["checkable", "frame-child"].includes(fixture.kind)
        ? ["script-src 'unsafe-inline'"]
        : []),
    ].join("; ");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy,
      "content-type": "text/html; charset=utf-8",
    });
    const body = [
      "<!doctype html>",
      `<title>${fixture.title}</title>`,
      "<style>body{font:16px system-ui;margin:40px}button,label{display:block;margin:18px 0;padding:10px}iframe{width:560px;height:280px;border:2px solid #222}</style>",
      `<h1>${fixture.title}</h1>`,
      `<p data-token="${fixture.token}">Disposable localhost acceptance fixture.</p>`,
    ];
    if (fixture.kind === "checkable") {
      body.push(
        '<label><input id="native-check" type="checkbox"> Native approval</label>',
        '<button id="aria-switch" type="button" role="switch" aria-checked="false">ARIA delivery</button>',
        "<script>",
        "globalThis.fixtureEvents = [];",
        "const nativeCheck = document.querySelector('#native-check');",
        "const ariaSwitch = document.querySelector('#aria-switch');",
        "nativeCheck.addEventListener('change', (event) => {",
        "  globalThis.fixtureEvents.push({ control: 'native', type: event.type, trusted: event.isTrusted, checked: nativeCheck.checked });",
        "});",
        "ariaSwitch.addEventListener('click', (event) => {",
        "  const checked = ariaSwitch.getAttribute('aria-checked') !== 'true';",
        "  ariaSwitch.setAttribute('aria-checked', String(checked));",
        "  globalThis.fixtureEvents.push({ control: 'aria', type: event.type, trusted: event.isTrusted, checked });",
        "});",
        "</script>",
      );
    } else if (fixture.kind === "frame-parent") {
      body.push(
        `<iframe id="cross-site-frame" title="Cross-site action frame" src="http://localhost:${port}/frame-child?token=${fixture.token}"></iframe>`,
      );
    } else if (fixture.kind === "frame-child") {
      body.push(
        '<button id="oopif-action" type="button">OOPIF action</button>',
        "<script>",
        "globalThis.frameEvents = [];",
        "const action = document.querySelector('#oopif-action');",
        "action.addEventListener('click', (event) => {",
        "  globalThis.frameEvents.push({ type: event.type, trusted: event.isTrusted });",
        "  action.dataset.clicks = String(globalThis.frameEvents.length);",
        "});",
        "</script>",
      );
    }
    response.end(body.join(""));
  });
  return { server, requests };
}

function launchProfile(options) {
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    LAUNCHER,
    "-DesktopMode",
    options.desktopMode,
    "-DesktopName",
    options.desktopName,
    "-TargetScript",
    PROFILE_HOST,
    "-VerifyDesktop",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      NPC_MONEYHAND_ACCEPTANCE_CHROMIUM_PATH: options.chromiumPath,
      NPC_MONEYHAND_ACCEPTANCE_PROFILE_ROOT: options.profileRoot,
      NPC_MONEYHAND_ACCEPTANCE_EXTENSION_PATH: EXTENSION_ROOT,
      NPC_MONEYHAND_ACCEPTANCE_START_URL: options.startUrl,
      NPC_MONEYHAND_ACCEPTANCE_DISABLE_CHROMIUM_SANDBOX: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = [];
  const waiters = new Set();
  let stderr = "";
  let spawnError;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of [...waiters]) waiter(event);
    } catch {
      // Chromium diagnostics are not part of the JSON fixture protocol.
    }
  });
  return {
    child,
    events,
    waiters,
    get stderr() {
      return stderr;
    },
    get spawnError() {
      return spawnError;
    },
  };
}

function waitForHostEvent(host, predicate, timeoutMs = 30_000) {
  const existing = host.events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolvePromise, reject) => {
    let timer;
    const accept = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      host.waiters.delete(accept);
      resolvePromise(event);
    };
    host.waiters.add(accept);
    timer = setTimeout(() => {
      host.waiters.delete(accept);
      reject(new Error(
        `Timed out waiting for Chromium host; exitCode=${host.child.exitCode}; `
        + `spawnError=${host.spawnError?.message ?? "none"}; stderr=${host.stderr}`,
      ));
    }, timeoutMs);
  });
}

async function stopProfileHost(host) {
  if (!host || host.child.exitCode !== null || host.child.signalCode !== null) return;
  if (!host.child.stdin.destroyed) host.child.stdin.end("stop\n");
  await Promise.race([
    new Promise((resolvePromise) => host.child.once("close", resolvePromise)),
    delay(10_000),
  ]);
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill();
    await Promise.race([
      new Promise((resolvePromise) => host.child.once("close", resolvePromise)),
      delay(5_000),
    ]);
  }
}

async function cdpCommand(webSocketUrl, method, params = {}, timeoutMs = 8_000) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} open timed out`)), timeoutMs);
    const cleanup = () => clearTimeout(timer);
    socket.addEventListener("open", () => {
      cleanup();
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(`CDP ${method} socket failed: ${event.message ?? "unknown error"}`));
    }, { once: true });
  });
  const id = 1;
  try {
    socket.send(JSON.stringify({ id, method, params }));
    return await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), timeoutMs);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`CDP ${method} failed: ${message.error.message}`));
          return;
        }
        resolvePromise(message.result);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error(`CDP ${method} target closed before responding`));
      }, { once: true });
    });
  } finally {
    socket.close();
  }
}

async function devToolsTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}`);
  return await response.json();
}

function runtimeException(evaluated) {
  return evaluated.exceptionDetails?.exception?.description
    ?? evaluated.exceptionDetails?.text
    ?? "unknown Runtime.evaluate exception";
}

async function readyMoneyHandWorker(port) {
  const targets = await devToolsTargets(port);
  const candidates = targets.filter((target) => {
    if (target.type !== "service_worker" || typeof target.url !== "string") return false;
    try {
      const url = new URL(target.url);
      return url.protocol === "chrome-extension:" && url.pathname === MONEYHAND_WORKER_PATH;
    } catch {
      return false;
    }
  });
  let lastError;
  for (const target of candidates) {
    try {
      const evaluated = await cdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: [
          "({",
          "  name: globalThis.chrome?.runtime?.getManifest?.().name ?? null,",
          "  worker: globalThis.chrome?.runtime?.getManifest?.().background?.service_worker ?? null,",
          "  storageReady: typeof globalThis.chrome?.storage?.local?.set === 'function',",
          "  reloadReady: typeof globalThis.chrome?.runtime?.reload === 'function',",
          "})",
        ].join("\n"),
        returnByValue: true,
        awaitPromise: false,
      });
      if (evaluated.exceptionDetails) {
        throw new Error(runtimeException(evaluated));
      }
      const identity = evaluated.result?.value;
      if (identity?.name === "npc-moneyhand"
        && identity.worker === "background.js"
        && identity.storageReady === true
        && identity.reloadReady === true) {
        return { target, identity };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return undefined;
}

async function configureMoneyHand(ready, moneyhandPort, instanceId) {
  const settings = { instanceId };
  const storeExpression = [
    "(async () => {",
    `  const settings = ${JSON.stringify(settings)};`,
    "  const manifest = chrome.runtime.getManifest();",
    "  await chrome.storage.local.set(settings);",
    "  return { name: manifest.name, worker: manifest.background.service_worker };",
    "})()",
  ].join("\n");
  return await waitFor(async () => {
    const worker = await readyMoneyHandWorker(ready.devToolsPort);
    if (!worker) return undefined;
    const stored = await cdpCommand(worker.target.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: storeExpression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (stored.exceptionDetails) {
      throw new Error(`MoneyHand configuration failed: ${runtimeException(stored)}`);
    }
    const value = stored.result?.value;
    if (value?.name !== "npc-moneyhand" || value?.worker !== "background.js") {
      throw new Error(`Unexpected unpacked extension target: ${JSON.stringify(value)}`);
    }
    const extensionId = new URL(worker.target.url).hostname;
    const browserWebSocketUrl = `ws://127.0.0.1:${ready.devToolsPort}${ready.browserWebSocketPath}`;
    const created = await cdpCommand(browserWebSocketUrl, "Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html`,
      background: true,
    });
    if (typeof created.targetId !== "string") {
      throw new Error(`Could not create the MoneyHand configuration target: ${JSON.stringify(created)}`);
    }
    try {
      const popup = await waitFor(async () => {
        const targets = await devToolsTargets(ready.devToolsPort);
        return targets.find((target) => target.id === created.targetId && target.type === "page");
      }, {
        timeoutMs: 8_000,
        intervalMs: 50,
        label: "MoneyHand popup target",
      });
      const configureExpression = [
        "chrome.runtime.sendMessage({",
        "  type: 'popup.configure',",
        "  address: '127.0.0.1',",
        `  port: ${moneyhandPort},`,
        "})",
      ].join("\n");
      const configured = await waitFor(async () => {
        const evaluated = await cdpCommand(popup.webSocketDebuggerUrl, "Runtime.evaluate", {
          expression: configureExpression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (evaluated.exceptionDetails) {
          throw new Error(`popup.configure failed: ${runtimeException(evaluated)}`);
        }
        const status = evaluated.result?.value;
        return status?.enabled === true ? status : undefined;
      }, {
        timeoutMs: 8_000,
        intervalMs: 100,
        label: "MoneyHand popup.configure response",
      });
      return { ...value, status: configured };
    } finally {
      await cdpCommand(browserWebSocketUrl, "Target.closeTarget", {
        targetId: created.targetId,
      }).catch(() => {});
    }
  }, {
    timeoutMs: 15_000,
    intervalMs: 100,
    label: "ready MoneyHand extension service worker",
  });
}

function exactSession(status, instanceId) {
  return status.sessions.find((session) => session.instanceId === instanceId);
}

async function fixtureTab(moneyhand, session, expectedUrl) {
  const response = await moneyhand.request({
    method: "chrome.call",
    params: { method: "tabs.query", args: [{}] },
  }, {
    selector: { instanceId: session.instanceId, bootId: session.bootId },
    connectTimeoutMs: 5_000,
    timeoutMs: 5_000,
  });
  if (response.ok !== true || !Array.isArray(response.result?.result)) {
    throw new Error(`tabs.query failed for ${session.instanceId}: ${JSON.stringify(response)}`);
  }
  const tab = response.result.result.find((candidate) => candidate.url === expectedUrl);
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error(`Disposable fixture tab was not found in ${session.instanceId}`);
  }
  return tab;
}

function evaluationRequest(tabId) {
  const expression = [
    "new Promise((resolve) => {",
    "  const started = Date.now();",
    "  setTimeout(() => resolve({",
    "    path: location.pathname,",
    "    token: new URL(location.href).searchParams.get('token'),",
    "    title: document.title,",
    "    started,",
    "    ended: Date.now(),",
    `  }), ${EVALUATION_DELAY_MS});`,
    "})",
  ].join("\n");
  return {
    method: "cdp.send",
    params: {
      target: { tabId },
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    },
  };
}

function evaluationValue(entry, expectedTabId) {
  if (entry.ok !== true || entry.value?.ok !== true) {
    throw new Error(`Parallel Task Space request failed: ${JSON.stringify(entry)}`);
  }
  const cdp = entry.value.result;
  if (cdp?.target?.tabId !== expectedTabId || cdp?.method !== "Runtime.evaluate") {
    throw new Error(`Parallel Task Space request returned the wrong target: ${JSON.stringify(cdp)}`);
  }
  const value = cdp.result?.result?.value;
  if (!value || !Number.isSafeInteger(value.started) || !Number.isSafeInteger(value.ended)) {
    throw new Error(`Runtime.evaluate did not return the concurrency oracle: ${JSON.stringify(cdp)}`);
  }
  return value;
}

async function taskRuntimeValue(moneyhand, taskSpaceId, tabId, expression, sessionId) {
  const terminal = await moneyhand.taskRequest({
    taskSpaceId,
    effect: "read-only",
    request: {
      method: "cdp.send",
      params: {
        target: {
          tabId,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      },
    },
    timeoutMs: 10_000,
  });
  if (terminal.ok !== true
    || terminal.result?.method !== "Runtime.evaluate"
    || terminal.result?.target?.tabId !== tabId
    || (sessionId !== undefined && terminal.result?.target?.sessionId !== sessionId)) {
    throw new Error(`Runtime probe returned the wrong target: ${JSON.stringify(terminal)}`);
  }
  return terminal.result?.result?.result?.value;
}

async function captureSemanticNode(moneyhand, options, predicate, label) {
  let lastSnapshot;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const captured = await moneyhand.captureSemanticSnapshot(options);
    if (captured.terminal) {
      throw new Error(`${label} snapshot failed: ${JSON.stringify(captured.terminal)}`);
    }
    lastSnapshot = captured.snapshot;
    const node = lastSnapshot?.nodes?.find(predicate);
    if (node) return { snapshot: lastSnapshot, node };
    if (attempt < 6) await delay(200);
  }
  throw new Error(`${label} was absent from semantic snapshots: ${JSON.stringify({
    mode: lastSnapshot?.mode,
    frameScope: lastSnapshot?.frameScope,
    nodes: lastSnapshot?.nodes?.map((node) => ({
      ref: node.ref,
      role: node.role,
      name: node.name,
      frame: node.frame,
    })),
  })}`);
}

function assertCheckableResult(result, expected) {
  const checkedState = result?.checkedState;
  if (result?.action !== expected.action
    || result?.actionDispatched !== expected.dispatched
    || result?.verification?.matched !== true
    || result?.cleanup?.released !== true
    || checkedState?.source !== expected.source
    || checkedState?.kind !== expected.kind
    || checkedState?.desired !== expected.desired
    || checkedState?.before !== expected.before
    || checkedState?.after !== expected.after
    || checkedState?.initiallySatisfied !== expected.initiallySatisfied
    || checkedState?.changed !== expected.changed
    || (expected.dispatched ? result?.terminal?.ok !== true : result?.terminal !== null)) {
    throw new Error(`Semantic checkable action did not prove the expected state: ${JSON.stringify({
      expected,
      result,
    })}`);
  }
}

async function terminateOwnedChromium(chromiumPath, profileRoots) {
  const processScript = [
    "$ErrorActionPreference = 'Stop'",
    "$roots = @((ConvertFrom-Json -InputObject $env:NPC_MONEYHAND_ACCEPTANCE_PROFILE_ROOTS_JSON))",
    "$executable = [System.IO.Path]::GetFullPath($env:NPC_MONEYHAND_ACCEPTANCE_CHROMIUM_PATH)",
    "function Owned-Chromium {",
    "  @(Get-CimInstance Win32_Process | Where-Object {",
    "    $pathMatches = [string]::Equals($_.ExecutablePath, $executable, [System.StringComparison]::OrdinalIgnoreCase)",
    "    $ownedMatch = $false",
    "    if ($pathMatches -and -not [string]::IsNullOrEmpty($_.CommandLine)) {",
    "      foreach ($root in $roots) {",
    "        if ($_.CommandLine.IndexOf([string]$root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {",
    "          $ownedMatch = $true",
    "          break",
    "        }",
    "      }",
    "    }",
    "    $ownedMatch",
    "  })",
    "}",
    "$owned = @(Owned-Chromium)",
    "foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }",
    "if ($owned.Count) { Start-Sleep -Milliseconds 200 }",
    "$remaining = @(Owned-Chromium)",
    "[pscustomobject]@{ terminated = $owned.Count; remaining = $remaining.Count; remainingPids = @($remaining.ProcessId) } | ConvertTo-Json -Compress",
  ].join("\n");
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    processScript,
  ], {
    env: {
      ...process.env,
      NPC_MONEYHAND_ACCEPTANCE_CHROMIUM_PATH: chromiumPath,
      NPC_MONEYHAND_ACCEPTANCE_PROFILE_ROOTS_JSON: JSON.stringify(profileRoots),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await new Promise((resolvePromise) => child.once("close", (...values) => resolvePromise(values)));
  if (code !== 0) throw new Error(`Owned Chromium cleanup failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

const [chromiumPath] = chromiumCandidates();
if (!chromiumPath) {
  process.stdout.write(`${JSON.stringify({
    skipped: true,
    reason: "unbranded-playwright-chromium-not-installed",
  }, null, 2)}\n`);
  process.exit(0);
}

const tokens = {
  a: randomUUID().replaceAll("-", ""),
  b: randomUUID().replaceAll("-", ""),
};
const instanceIds = { a: randomUUID(), b: randomUUID() };
const desktopName = `NPCMoneyHandAcceptance_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const fixture = startFixtureServer(tokens);
const hosts = [];
const moneyhand = createMoneyHand({
  host: "127.0.0.1",
  port: 0,
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  handshakeTimeoutMs: 4_500,
  heartbeatMs: 5_000,
  maxInflight: 64,
});
const profileRoots = [];
let result;
let failure;
let cleanup;

try {
  profileRoots.push(await mkdtemp(join(tmpdir(), "npc-moneyhand-profile-a-")));
  profileRoots.push(await mkdtemp(join(tmpdir(), "npc-moneyhand-profile-b-")));
  await new Promise((resolvePromise, reject) => {
    fixture.server.once("error", reject);
    fixture.server.listen(0, "127.0.0.1", resolvePromise);
  });
  const fixturePort = fixture.server.address().port;
  const urls = {
    a: `http://127.0.0.1:${fixturePort}/a?token=${tokens.a}`,
    b: `http://127.0.0.1:${fixturePort}/b?token=${tokens.b}`,
  };
  await moneyhand.start();
  const moneyhandPort = moneyhand.peer.boundPort;
  if (!Number.isInteger(moneyhandPort) || moneyhandPort < 1) {
    throw new Error("MoneyHand did not bind an ephemeral loopback port");
  }

  const firstHost = launchProfile({
    chromiumPath,
    profileRoot: profileRoots[0],
    startUrl: urls.a,
    desktopMode: "Create",
    desktopName,
  });
  hosts.push(firstHost);
  const firstReady = await waitForHostEvent(firstHost, (event) => event.event === "chromium.ready");
  const secondHost = launchProfile({
    chromiumPath,
    profileRoot: profileRoots[1],
    startUrl: urls.b,
    desktopMode: "Open",
    desktopName,
  });
  hosts.push(secondHost);
  const secondReady = await waitForHostEvent(secondHost, (event) => event.event === "chromium.ready");
  const readyEvents = [firstReady, secondReady];
  for (const ready of readyEvents) {
    if (ready.desktopName !== desktopName
      || ready.isolatedDesktop !== true
      || ready.browserSandboxDisabled !== true
      || typeof ready.inputDesktopName !== "string"
      || ready.inputDesktopName.toLowerCase() === desktopName.toLowerCase()) {
      throw new Error(`Chromium did not prove its isolated desktop boundary: ${JSON.stringify(ready)}`);
    }
  }
  if (new Set(readyEvents.map((ready) => ready.devToolsPort)).size !== PROFILE_COUNT
    || new Set(readyEvents.map((ready) => ready.browserPid)).size !== PROFILE_COUNT) {
    throw new Error("Disposable Chromium Profiles did not start as distinct browser processes");
  }

  const configured = await Promise.all([
    configureMoneyHand(readyEvents[0], moneyhandPort, instanceIds.a),
    configureMoneyHand(readyEvents[1], moneyhandPort, instanceIds.b),
  ]);
  let lastSessionStatus;
  const sessions = await waitFor(() => {
    const status = moneyhand.status();
    lastSessionStatus = status;
    const a = exactSession(status, instanceIds.a);
    const b = exactSession(status, instanceIds.b);
    return a && b ? { a, b, status } : undefined;
  }, {
    timeoutMs: 15_000,
    intervalMs: 50,
    label: "two real MoneyHand sessions",
  }).catch((error) => {
    throw new Error(`${error.message}; moneyhandStatus=${JSON.stringify(lastSessionStatus)}`);
  });
  if (sessions.status.sessions.length !== PROFILE_COUNT
    || sessions.a.instanceId === sessions.b.instanceId
    || sessions.a.bootId === sessions.b.bootId
    || sessions.a.profile === sessions.b.profile) {
    throw new Error(`Real Profile identities were not distinct: ${JSON.stringify(sessions.status.sessions)}`);
  }

  const [tabA, tabB] = await Promise.all([
    fixtureTab(moneyhand, sessions.a, urls.a),
    fixtureTab(moneyhand, sessions.b, urls.b),
  ]);
  const spaces = await Promise.all([
    moneyhand.createTaskSpace({
      id: "real-profile-a",
      selector: { instanceId: sessions.a.instanceId, bootId: sessions.a.bootId },
      tabIds: [tabA.id],
    }),
    moneyhand.createTaskSpace({
      id: "real-profile-b",
      selector: { instanceId: sessions.b.instanceId, bootId: sessions.b.bootId },
      tabIds: [tabB.id],
    }),
  ]);
  const batchStarted = Date.now();
  const batch = await moneyhand.parallelTaskRequests({
    concurrency: 2,
    requests: [
      {
        taskSpaceId: spaces[0].id,
        request: evaluationRequest(tabA.id),
        options: { effect: "read-only", timeoutMs: 12_000 },
      },
      {
        taskSpaceId: spaces[1].id,
        request: evaluationRequest(tabB.id),
        options: { effect: "read-only", timeoutMs: 12_000 },
      },
    ],
  });
  const batchElapsedMs = Date.now() - batchStarted;
  const values = [
    evaluationValue(batch.results[0], tabA.id),
    evaluationValue(batch.results[1], tabB.id),
  ];
  if (values[0].path !== "/a" || values[0].token !== tokens.a
    || values[1].path !== "/b" || values[1].token !== tokens.b) {
    throw new Error(`Task Spaces crossed Profile boundaries: ${JSON.stringify(values)}`);
  }
  const durations = values.map((value) => value.ended - value.started);
  const overlapMs = Math.min(values[0].ended, values[1].ended)
    - Math.max(values[0].started, values[1].started);
  if (durations.some((duration) => duration < EVALUATION_DELAY_MS - 25) || overlapMs < 500) {
    throw new Error(`Real Profile requests did not overlap: ${JSON.stringify({ durations, overlapMs })}`);
  }
  if (!fixture.requests.some((request) => request.path === "/a" && request.token === tokens.a)
    || !fixture.requests.some((request) => request.path === "/b" && request.token === tokens.b)) {
    throw new Error("Both disposable Profile fixtures were not requested");
  }

  const semanticOptionsA = {
    selector: { instanceId: sessions.a.instanceId, bootId: sessions.a.bootId },
    tabId: tabA.id,
    maxNodes: 200,
    timeoutMs: 10_000,
  };
  const nativeCapture = await captureSemanticNode(
    moneyhand,
    semanticOptionsA,
    (node) => node.role === "checkbox" && node.name === "Native approval",
    "Native checkbox",
  );
  const ariaNode = nativeCapture.snapshot.nodes.find(
    (node) => node.role === "switch" && node.name === "ARIA delivery",
  );
  const ariaCapture = ariaNode
    ? { snapshot: nativeCapture.snapshot, node: ariaNode }
    : await captureSemanticNode(
        moneyhand,
        semanticOptionsA,
        (node) => node.role === "switch" && node.name === "ARIA delivery",
        "ARIA switch",
      );
  const semanticIntent = (capture, action) => ({
    taskSpaceId: spaces[0].id,
    snapshotId: capture.snapshot.id,
    ref: capture.node.ref,
    action,
    effect: "input",
    timeoutMs: 10_000,
  });
  const nativeCheck = await moneyhand.actSemanticRef(semanticIntent(nativeCapture, "check"));
  assertCheckableResult(nativeCheck, {
    action: "check",
    dispatched: true,
    source: "native",
    kind: "checkbox",
    desired: true,
    before: false,
    after: true,
    initiallySatisfied: false,
    changed: true,
  });
  const nativeCheckNoop = await moneyhand.actSemanticRef(semanticIntent(nativeCapture, "check"));
  assertCheckableResult(nativeCheckNoop, {
    action: "check",
    dispatched: false,
    source: "native",
    kind: "checkbox",
    desired: true,
    before: true,
    after: true,
    initiallySatisfied: true,
    changed: false,
  });
  const nativeUncheck = await moneyhand.actSemanticRef(semanticIntent(nativeCapture, "uncheck"));
  assertCheckableResult(nativeUncheck, {
    action: "uncheck",
    dispatched: true,
    source: "native",
    kind: "checkbox",
    desired: false,
    before: true,
    after: false,
    initiallySatisfied: false,
    changed: true,
  });
  const ariaCheck = await moneyhand.actSemanticRef(semanticIntent(ariaCapture, "check"));
  assertCheckableResult(ariaCheck, {
    action: "check",
    dispatched: true,
    source: "aria",
    kind: "switch",
    desired: true,
    before: false,
    after: true,
    initiallySatisfied: false,
    changed: true,
  });
  const ariaCheckNoop = await moneyhand.actSemanticRef(semanticIntent(ariaCapture, "check"));
  assertCheckableResult(ariaCheckNoop, {
    action: "check",
    dispatched: false,
    source: "aria",
    kind: "switch",
    desired: true,
    before: true,
    after: true,
    initiallySatisfied: true,
    changed: false,
  });
  const ariaUncheck = await moneyhand.actSemanticRef(semanticIntent(ariaCapture, "uncheck"));
  assertCheckableResult(ariaUncheck, {
    action: "uncheck",
    dispatched: true,
    source: "aria",
    kind: "switch",
    desired: false,
    before: true,
    after: false,
    initiallySatisfied: false,
    changed: true,
  });
  const fixtureEvents = await taskRuntimeValue(
    moneyhand,
    spaces[0].id,
    tabA.id,
    "globalThis.fixtureEvents",
  );
  const expectedFixtureEvents = [
    { control: "native", type: "change", trusted: true, checked: true },
    { control: "native", type: "change", trusted: true, checked: false },
    { control: "aria", type: "click", trusted: true, checked: true },
    { control: "aria", type: "click", trusted: true, checked: false },
  ];
  if (!Array.isArray(fixtureEvents)
    || fixtureEvents.length !== expectedFixtureEvents.length
    || fixtureEvents.some((event, index) => Object.entries(expectedFixtureEvents[index])
      .some(([key, value]) => event?.[key] !== value))) {
    throw new Error(`Semantic checkable events were not exact and trusted: ${JSON.stringify(fixtureEvents)}`);
  }

  await waitFor(async () => await taskRuntimeValue(
    moneyhand,
    spaces[1].id,
    tabB.id,
    "document.readyState === 'complete' && Boolean(document.querySelector('#cross-site-frame'))",
  ), {
    timeoutMs: 10_000,
    intervalMs: 100,
    label: "cross-site iframe document",
  });
  const childRequest = await waitFor(() => fixture.requests.find((request) => (
    request.path === "/frame-child" && request.token === tokens.b
  )), {
    timeoutMs: 10_000,
    intervalMs: 50,
    label: "cross-site iframe fixture request",
  });
  if (!childRequest.host.toLowerCase().startsWith("localhost:")) {
    throw new Error(`Iframe fixture did not use a cross-site localhost host: ${JSON.stringify(childRequest)}`);
  }
  const oopifCapture = await captureSemanticNode(
    moneyhand,
    {
      selector: { instanceId: sessions.b.instanceId, bootId: sessions.b.bootId },
      tabId: tabB.id,
      includeFrames: true,
      maxFrames: 8,
      maxNodes: 200,
      timeoutMs: 10_000,
    },
    (node) => node.role === "button"
      && node.name === "OOPIF action"
      && node.frame?.topLevel === false
      && typeof node.frame?.sessionId === "string",
    "OOPIF action",
  );
  const oopifFrame = oopifCapture.node.frame;
  const oopifUrl = new URL(oopifFrame.url);
  if (oopifCapture.snapshot.frameScope?.included !== true
    || oopifCapture.snapshot.frameScope?.selectedFrames < 2
    || !oopifFrame.frameId
    || !oopifFrame.sessionId
    || !oopifFrame.targetId
    || oopifUrl.hostname !== "localhost"
    || oopifUrl.pathname !== "/frame-child"
    || oopifUrl.searchParams.get("token") !== tokens.b) {
    throw new Error(`Semantic snapshot did not preserve the OOPIF identity: ${JSON.stringify({
      frameScope: oopifCapture.snapshot.frameScope,
      frame: oopifFrame,
    })}`);
  }
  const oopifClick = await moneyhand.actSemanticRef({
    taskSpaceId: spaces[1].id,
    snapshotId: oopifCapture.snapshot.id,
    ref: oopifCapture.node.ref,
    action: "click",
    effect: "input",
    timeoutMs: 10_000,
  });
  if (oopifClick.actionDispatched !== true
    || oopifClick.terminal?.ok !== true
    || oopifClick.target?.frameId !== oopifFrame.frameId
    || oopifClick.verification?.claim !== "observation-only"
    || oopifClick.cleanup?.released !== true) {
    throw new Error(`Semantic OOPIF click was not safely dispatched: ${JSON.stringify(oopifClick)}`);
  }
  const frameEvents = await taskRuntimeValue(
    moneyhand,
    spaces[1].id,
    tabB.id,
    "globalThis.frameEvents",
    oopifFrame.sessionId,
  );
  if (!Array.isArray(frameEvents)
    || frameEvents.length !== 1
    || frameEvents[0]?.type !== "click"
    || frameEvents[0]?.trusted !== true) {
    throw new Error(`OOPIF did not observe one trusted click: ${JSON.stringify(frameEvents)}`);
  }

  result = {
    protocol: moneyhand.status().protocol,
    chromium: "unbranded-disposable",
    profiles: PROFILE_COUNT,
    distinctBrowserProcesses: true,
    distinctInstanceIds: true,
    distinctBootIds: true,
    isolatedDesktopVerified: true,
    sharedNonInputDesktop: desktopName,
    switchDesktopRequested: false,
    browserSandboxDisabledForDisposableAcceptance: true,
    productRuntimeSandboxChanged: false,
    unpackedMoneyHandWorkers: configured.length,
    explicitTaskSpacePins: spaces.map((space) => ({
      id: space.id,
      instanceId: space.selector.instanceId,
      bootId: space.selector.bootId,
      tabCount: space.tabIds.length,
    })),
    concurrency: batch.concurrency,
    evaluationDelayMs: EVALUATION_DELAY_MS,
    durationsMs: durations,
    overlapMs,
    batchElapsedMs,
    observedPaths: values.map((value) => value.path),
    browserCdpInputUsed: true,
    semanticCheckable: {
      controls: 2,
      intents: 6,
      dispatchedClicks: 4,
      idempotentNoInput: 2,
      trustedEvents: fixtureEvents.length,
      nativeCheckboxVerified: true,
      ariaSwitchVerified: true,
      finalStateRestored: true,
    },
    semanticOopif: {
      selectedFrames: oopifCapture.snapshot.frameScope.selectedFrames,
      frameId: oopifFrame.frameId,
      sessionId: oopifFrame.sessionId,
      targetId: oopifFrame.targetId,
      identityFieldsPresent: true,
      sessionAndTargetIdsDistinct: oopifFrame.sessionId !== oopifFrame.targetId,
      targetAndPageFrameIdsDistinct: oopifFrame.targetId !== oopifFrame.frameId,
      localhostCrossSiteFixture: true,
      trustedClick: true,
    },
    activeUserProfileUsed: false,
    nativeInputUsed: false,
    externalEffects: 0,
  };
} catch (error) {
  failure = error;
} finally {
  await moneyhand.stop({ graceMs: 0 }).catch((error) => {
    failure ??= error;
  });
  await Promise.all(hosts.map((host) => stopProfileHost(host))).catch((error) => {
    failure ??= error;
  });
  await closeServer(fixture.server).catch((error) => {
    failure ??= error;
  });
  cleanup = profileRoots.length
    ? await terminateOwnedChromium(chromiumPath, profileRoots).catch((error) => {
      failure ??= error;
      return { terminated: -1, remaining: -1, remainingPids: [] };
    })
    : { terminated: 0, remaining: 0, remainingPids: [] };
  await Promise.all(profileRoots.map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }))).catch((error) => {
    failure ??= error;
  });
}

if (cleanup?.remaining !== 0) {
  failure ??= new Error(`Disposable Chromium cleanup left processes: ${JSON.stringify(cleanup)}`);
}
if (cleanup?.terminated !== 0) {
  failure ??= new Error(`Kill-on-close Job required fallback cleanup: ${JSON.stringify(cleanup)}`);
}
if (failure) throw failure;
result.cleanup = {
  fallbackProcessesTerminated: cleanup.terminated,
  orphanProcesses: cleanup.remaining,
  disposableProfilesRemoved: profileRoots.length,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
