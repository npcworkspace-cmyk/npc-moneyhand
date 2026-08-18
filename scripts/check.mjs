import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const packageJson = readJson("package.json");
const manifest = readJson("extension/manifest.json");

if (packageJson.name !== "npc-moneyhand") fail("package name must be npc-moneyhand");
if (packageJson.version !== "1.0.0") {
  fail("package version must be 1.0.0");
}
if (packageJson.dependencies || packageJson.devDependencies || packageJson.optionalDependencies) {
  fail("npc-moneyhand must not declare external dependencies");
}
if (existsSync(join(root, "package-lock.json"))) {
  fail("package-lock.json is not allowed in the zero-dependency runtime");
}

if (manifest.name !== "npc-moneyhand") fail("extension name must be npc-moneyhand");
if (manifest.version !== "1.0.0") fail("extension version must be 1.0.0");
if (manifest.version_name !== packageJson.version) {
  fail("manifest version_name must match package version");
}
if (Number(manifest.minimum_chrome_version) < 125) {
  fail("minimum Chrome version must be at least 125");
}
if (manifest.background?.service_worker !== "background.js"
  || manifest.background?.type !== "module") {
  fail("extension must use the module background service worker");
}
const manifestIcons = new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
]);
for (const path of manifestIcons) {
  if (!existsSync(join(root, "extension", path))) fail(`missing manifest icon: extension/${path}`);
}
for (const color of ["red", "yellow", "green", "blue"]) {
  for (const size of [16, 32, 48, 128]) {
    const path = `extension/icons/smile-${color}-${size}.png`;
    if (!existsSync(join(root, path))) fail(`missing state icon: ${path}`);
  }
}

const requiredFiles = [
  "extension/background.js",
  "extension/bridge.js",
  "extension/executor.js",
  "extension/protocol.js",
  "extension/manifest.json",
  "extension/popup.html",
  "extension/popup.js",
  "extension/popup.css",
  "skills/npc-moneyhand/SKILL.md",
  "skills/npc-moneyhand/LICENSE",
  "skills/npc-moneyhand/package.json",
  "skills/npc-moneyhand/agents/openai.yaml",
  "skills/npc-moneyhand/assets/disposable-task.mjs",
  "skills/npc-moneyhand/references/moneyhand-contract.json",
  "skills/npc-moneyhand/references/agent-operations.json",
  "skills/npc-moneyhand/references/agent-hosts.md",
  "skills/npc-moneyhand/references/extension-integrity.json",
  "skills/npc-moneyhand/references/learning-and-approvals.md",
  "skills/npc-moneyhand/scripts/lib/browser-discovery.mjs",
  "skills/npc-moneyhand/scripts/lib/browser-launch.mjs",
  "skills/npc-moneyhand/scripts/moneyhand.mjs",
  "skills/npc-moneyhand/scripts/lib/agent-descriptor.mjs",
  "skills/npc-moneyhand/scripts/lib/peer.mjs",
  "skills/npc-moneyhand/scripts/lib/protocol.mjs",
  "skills/npc-moneyhand/scripts/lib/websocket.mjs",
  "skills/npc-moneyhand/scripts/lib/rate-control.mjs",
  "skills/npc-moneyhand/scripts/lib/semantic-snapshot.mjs",
  "skills/npc-moneyhand/scripts/lib/site-learnings.mjs",
  "skills/npc-moneyhand/scripts/lib/surface-router.mjs",
  "skills/npc-moneyhand/scripts/lib/task-approvals.mjs",
  "skills/npc-moneyhand/scripts/lib/task-spaces.mjs",
  "scripts/build-portable-skill.mjs",
  "scripts/audit-product-boundaries.mjs",
  "scripts/install-skill.mjs",
  "scripts/moneyhand-isolated-multiprofile-acceptance.mjs",
  "tests/fixtures/isolated-desktop-launcher.ps1",
  "tests/fixtures/moneyhand-chromium-profile.ps1",
];
for (const path of requiredFiles) {
  if (!existsSync(join(root, path))) fail(`missing required file: ${path}`);
}
for (const path of [
  "agent/index.js",
  "packages/npc-moneyhand/package.json",
  "packages/npc-moneydesk/package.json",
  "skills/npc-moneyoperator/package.json",
  "skills/npc-moneyhand/scripts/operator.mjs",
  "packaging/npm/npc-moneyoperator.README.md",
]) {
  if (existsSync(join(root, path))) fail(`retired product path must stay removed: ${path}`);
}

const normalizedLicense = (path) => readFileSync(path, "utf8")
  .replaceAll("\r\n", "\n")
  .trimEnd();
if (normalizedLicense(join(root, "LICENSE"))
  !== normalizedLicense(join(root, "skills/npc-moneyhand/LICENSE"))) {
  fail("standalone Skill license must match the repository license");
}

const skillPackage = readJson("skills/npc-moneyhand/package.json");
if (skillPackage.name !== "npc-moneyhand"
  || skillPackage.version !== packageJson.version
  || skillPackage.private === true
  || skillPackage.dependencies
  || skillPackage.devDependencies
  || skillPackage.optionalDependencies
  || skillPackage.bin?.moneyhand !== "./scripts/moneyhand.mjs"
  || skillPackage.exports?.["."] !== "./scripts/moneyhand.mjs"
  || Object.keys(skillPackage.bin ?? {}).length !== 1
  || Object.keys(skillPackage.exports ?? {}).length !== 1) {
  fail("npc-moneyhand Skill must remain an independent zero-dependency ESM/CLI package");
}
if (Object.keys(packageJson.exports ?? {}).length !== 1
  || packageJson.scripts?.["skill:pack:portable"]
    !== "node scripts/build-portable-skill.mjs") {
  fail("repository must expose and build the portable MoneyHand Skill");
}

const contract = readJson("skills/npc-moneyhand/references/moneyhand-contract.json");
if ((contract.controlProtocol ?? contract.protocol) !== "npc-moneyhand-control/1"
  || contract.runtime?.externalPackages !== 0
  || contract.agentInterop?.commandFields?.arguments !== "args"
  || contract.agentInterop?.argumentPolicy?.mixedWithTopLevel !== "reject"
  || contract.automaticConnection?.command !== "--connect"
  || contract.automaticConnection?.resultSchema !== "npc-moneyhand-connect/1"
  || contract.automaticConnection?.successNextAction !== "ask_user_for_task"
  || contract.automaticConnection?.userRetryFlag !== "--after-user-action"
  || contract.automaticConnection?.maximumUserConfirmedRetries !== 1
  || contract.automaticConnection?.runsBrowserOperation !== false
  || contract.automaticConnection?.outerOkMeaning !== "bounded-result-produced"
  || contract.automaticConnection?.connectedPredicate
    !== "value.connected=true-and-value.status=connected"
  || contract.automaticConnection?.endpoint !== "ws://127.0.0.1:19846/extension"
  || contract.automaticConnection?.fixedEndpoint !== true
  || contract.automaticConnection?.portDiscovery !== false
  || contract.automaticConnection?.customEndpoint !== false
  || contract.automaticConnection?.extensionFirstRunAutoEnabled !== true
  || contract.automaticConnection?.popupAction !== "immediate-reconnect"
  || contract.automaticConnection?.fullPreflightRequired !== false
  || contract.automaticConnection?.reusesLiveSession !== true
  || contract.automaticConnection?.startsBrowserWhenNeeded !== true
  || contract.automaticConnection?.closesExistingBrowser !== false
  || contract.automaticConnection?.readiness !== "npc-moneyhand-2-handshake"
  || contract.automaticConnection?.customBrowserRootFlag !== "--browser-root"
  || contract.automaticConnection?.extensionDistribution?.bundledWithSkill !== false
  || contract.automaticConnection?.extensionDistribution?.automaticDownload !== false
  || contract.automaticConnection?.extensionDistribution?.releasesUrl
    !== "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases"
  || contract.automaticConnection?.extensionDistribution?.assetName
    !== "npc-moneyhand-extension-1.0.0.zip"
  || contract.automaticConnection?.extensionDistribution?.manualInstallRequired !== true
  || contract.ownership?.taskSpaces?.maximumParallelRequests !== 64
  || contract.ownership?.taskSpaces?.maximumConcurrency !== 16
  || contract.ownership?.taskSpaces?.highImpactApproval?.enforcement !== "optional-caller-policy"
  || contract.transports?.taskModule?.flag !== "--task"
  || contract.transports?.directCall?.connectFlag !== "--connect"
  || contract.transports?.directCall?.stdinRequired !== false
  || contract.transports?.npm?.bin !== "moneyhand"
  || contract.jsonlFieldSeparation?.taskSpaceId !== "taskSpaceId"
  || contract.siteLearnings?.executable !== false
  || contract.siteLearnings?.maximumRecords !== 128
  || contract.highImpactApproval?.effectFieldRequired !== true
  || contract.highImpactApproval?.tokenRequired !== false) {
  fail("standalone MoneyHand Skill contract is invalid");
}
const acquisitionPolicy = contract.agentPolicy?.dataAcquisition;
const expectedAcquisitionPlanes = [
  "existing-structured-data",
  "cdp-network-json",
  "same-session-readonly-replay",
  "cdp-runtime-dom-batch",
  "browser-ui-lazy-load",
  "explicit-screenshot",
];
if (acquisitionPolicy?.objective !== "minimum-total-elapsed-time"
  || acquisitionPolicy.defaultBehaviorMode !== "raw"
  || acquisitionPolicy.pilot?.requiredBeforeScale !== true
  || acquisitionPolicy.pilot?.scale !== "gradual-batch-and-concurrency-ramp"
  || acquisitionPolicy.rateControl?.mode !== "adaptive"
  || !acquisitionPolicy.rateControl?.signals?.includes("http-429")
  || !acquisitionPolicy.rateControl?.onThrottle?.includes("honor-retry-after")
  || !acquisitionPolicy.rateControl?.stopSignals?.includes("access-challenge")
  || JSON.stringify(acquisitionPolicy.orderedPlanes) !== JSON.stringify(expectedAcquisitionPlanes)
  || acquisitionPolicy.rules?.rankEligiblePlanesOnly !== true
  || acquisitionPolicy.rules?.technicalAccessDoesNotGrantAuthorization !== true
  || acquisitionPolicy.rules?.readOnlyByDefault !== true
  || acquisitionPolicy.rules?.screenshotLastResort !== true) {
  fail("standalone Skill data-acquisition policy is invalid");
}
if (contract.operationContracts?.rateControl?.enforcement !== "explicit-caller-scheduler"
  || contract.operationContracts?.rateControl?.implicitRequestGate !== false) {
  fail("standalone Skill rate-control enforcement boundary is invalid");
}

for (const path of [
  "src",
  "dist",
  "integrations",
  "examples",
  "config.example.yaml",
  "tsconfig.json",
]) {
  if (existsSync(join(root, path))) fail(`legacy 1.x runtime path must stay removed: ${path}`);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const scripts = ["agent", "extension", "packages", "scripts", "skills", "tests"]
  .map((path) => join(root, path))
  .filter(existsSync)
  .flatMap(walk)
  .filter((path) => [".js", ".mjs"].includes(extname(path)));

let runtimeLines = 0;
const standaloneSkillRoot = join(root, "skills", "npc-moneyhand");
for (const path of scripts) {
  const source = readFileSync(path, "utf8");
  if (path.startsWith(standaloneSkillRoot)) {
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    for (const specifier of imports) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) fail(`external Skill import found in ${relative(root, path)}`);
      const target = resolve(dirname(path), specifier);
      const escaped = relative(standaloneSkillRoot, target);
      if (escaped === ".."
        || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        || isAbsolute(escaped)) {
        fail(`Skill import escapes its standalone directory in ${relative(root, path)}`);
      }
    }
  }
  if (path.startsWith(join(root, "extension"))) {
    runtimeLines += source.split(/\r?\n/u).filter((line) => line.trim()).length;
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    if (imports.some((specifier) => !specifier.startsWith("./"))) {
      fail(`external module import found in ${relative(root, path)}`);
    }
    if (/\brequire\s*\(/u.test(source)) fail(`CommonJS require found in ${relative(root, path)}`);
  }
  execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
}

if (runtimeLines > 2_400) {
  fail(`nonblank extension JavaScript line budget exceeded: ${runtimeLines}/2400`);
}
const runtimeFiles = walk(join(root, "extension"));
const skillFiles = walk(standaloneSkillRoot);
console.log(JSON.stringify({
  product: packageJson.name,
  version: packageJson.version,
  externalDependencies: 0,
  extensionFiles: runtimeFiles.length,
  extensionBytes: runtimeFiles.reduce((sum, path) => sum + statSync(path).size, 0),
  extensionJavaScriptNonblankLines: runtimeLines,
  skillFiles: skillFiles.length,
  skillBytes: skillFiles.reduce((sum, path) => sum + statSync(path).size, 0),
  syntaxCheckedFiles: scripts.length,
}, null, 2));
