import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeAgentJsonlCommandEnvelope } from "../skills/npc-moneyhand/scripts/lib/agent-descriptor.mjs";
import { describeMoneyHand } from "../skills/npc-moneyhand/scripts/moneyhand.mjs";

const DESCRIPTOR_SCHEMA = "npc-agent-cli-descriptor/1";
const AGENT_PROTOCOL = "npc-agent-jsonl/1";
const OPERATION_CATALOG_SCHEMA = "npc-agent-operation-catalog/1";
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SECRET_SENTINEL = "offline-discovery-must-not-expose-this";
const SCRIPT = "skills/npc-moneyhand/scripts/moneyhand.mjs";
const CONTRACT = "skills/npc-moneyhand/references/moneyhand-contract.json";
const CATALOG = "skills/npc-moneyhand/references/agent-operations.json";
const PRODUCT = {
  package: "npc-moneyhand",
  version: "1.2.0",
  executable: "moneyhand",
  productProtocol: "npc-moneyhand-control/1",
};

function assertDescriptor(descriptor, contract, catalog) {
  assert.equal(descriptor.schema, DESCRIPTOR_SCHEMA);
  assert.equal(descriptor.product.package, PRODUCT.package);
  assert.equal(descriptor.product.version, PRODUCT.version);
  assert.equal(descriptor.product.executable, PRODUCT.executable);
  assert.equal(descriptor.protocols.agent, AGENT_PROTOCOL);
  assert.equal(descriptor.protocols.product, PRODUCT.productProtocol);
  assert.deepEqual(descriptor.modes, {
    programmatic: true,
    persistentJsonl: true,
    oneShot: true,
    taskModule: true,
  });
  assert.deepEqual(descriptor.discovery, {
    readOnly: true,
    consumesStdin: false,
    startsListener: false,
    startsPlatformWorker: false,
    requiresBrowserSession: false,
    requiresDesktopPermissions: false,
    filesystemWrites: false,
    inputSideEffect: false,
    modelRuntime: false,
  });
  assert.equal(descriptor.capabilities.agentInterop.commandFields.arguments, "args");
  assert.equal(descriptor.capabilities.agentInterop.argumentPolicy.mixedWithTopLevel, "reject");
  assert.equal(
    descriptor.capabilities.agentInterop.operationCatalog.schema,
    OPERATION_CATALOG_SCHEMA,
  );
  assert.deepEqual(descriptor.operationCatalog, catalog);
  assert.equal(catalog.schema, OPERATION_CATALOG_SCHEMA);
  assert.equal(catalog.jsonSchemaDialect, JSON_SCHEMA_DIALECT);
  assert.equal(catalog.package, PRODUCT.package);
  assert.equal(catalog.productProtocol, PRODUCT.productProtocol);
  assert.equal(catalog.agentProtocol, AGENT_PROTOCOL);
  assert.ok(catalog.operations.length > 0);
  assert.deepEqual(
    catalog.operations.map((operation) => operation.op),
    descriptor.capabilities.operations.jsonl,
  );
  assert.equal(Object.keys(contract.operationContracts).length, catalog.operations.length);
  for (const [index, operation] of catalog.operations.entries()) {
    assert.equal(operation.argsSchema.type, "object");
    assert.equal(operation.argsSchema.additionalProperties, false);
    assert.deepEqual(operation.argsSchema.required, operation.args.required);
    assert.equal(operation.schemaPointers.args, `#/operations/${index}/argsSchema`);
    assert.equal(operation.schemaPointers.result, `#/operations/${index}/resultSchema`);
    assert.equal(operation.contractRef, `#/operationContracts/${operation.op}`);
    assert.deepEqual(contract.operationContracts[operation.op].effects, operation.effects);
    assert.deepEqual(contract.operationContracts[operation.op].requires, operation.requires);
  }
  assert.equal(
    catalog.safeProbe.effects.some((effect) => [
      "external-write",
      "filesystem-write",
      "caller-dependent",
      "local-state",
      "process-control",
      "process-lifecycle",
    ].includes(effect)),
    false,
  );
  assert.deepEqual(descriptor.contract, contract);
  assert.deepEqual(descriptor.capabilities.agentInterop, contract.agentInterop);
  assert.deepEqual(
    descriptor.capabilities.transports.taskModule,
    contract.transports.taskModule,
  );
  assert.deepEqual(
    descriptor.capabilities.transports.directCall,
    contract.transports.directCall,
  );
  assert.deepEqual(
    descriptor.capabilities.transports.builtInController,
    contract.transports.builtInController,
  );
  assert.deepEqual(
    descriptor.capabilities.automaticConnection,
    contract.automaticConnection,
  );
  assert.equal(contract.automaticConnection.command, "--connect");
  assert.equal(contract.automaticConnection.resultSchema, "npc-moneyhand-connect/1");
  assert.equal(contract.automaticConnection.successNextAction, "ready_for_tasks");
  assert.equal(contract.automaticConnection.userRetryFlag, "--after-user-action");
  assert.equal(contract.automaticConnection.maximumUserConfirmedRetries, 1);
  assert.equal(contract.automaticConnection.runsBrowserOperation, true);
  assert.equal(contract.automaticConnection.automaticAcceptance.mandatoryOnNormalConnect, true);
  assert.equal(contract.automaticConnection.automaticAcceptance.scope, "localhost-owned-task-window");
  assert.equal(contract.automaticConnection.automaticAcceptance.checks.length, 16);
  assert.equal(contract.automaticConnection.automaticAcceptance.closesTaskWindow, true);
  assert.equal(contract.automaticConnection.automaticAcceptance.resetsBehaviorToRaw, true);
  assert.equal(contract.automaticConnection.automaticAcceptance.removesDownloadArtifact, true);
  assert.equal(contract.automaticConnection.outerOkMeaning, "bounded-result-produced");
  assert.equal(
    contract.automaticConnection.connectedPredicate,
    "value.connected=true-and-value.status=connected",
  );
  assert.equal(contract.automaticConnection.endpoint, "ws://127.0.0.1:19846/extension");
  assert.equal(contract.automaticConnection.fixedEndpoint, true);
  assert.equal(contract.automaticConnection.portDiscovery, false);
  assert.equal(contract.automaticConnection.customEndpoint, false);
  assert.equal(contract.automaticConnection.extensionFirstRunAutoEnabled, true);
  assert.equal(contract.automaticConnection.popupAction, "immediate-reconnect");
  assert.equal(contract.automaticConnection.fullPreflightRequired, false);
  assert.equal(contract.automaticConnection.startsBrowserWhenNeeded, true);
  assert.equal(contract.automaticConnection.closesExistingBrowser, false);
  assert.deepEqual(contract.automaticConnection.extensionDistribution, {
    bundledWithSkill: false,
    automaticDownload: false,
    repositoryUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand",
    releasesUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
    assetName: "npc-moneyhand-extension.zip",
    manualInstallRequired: true,
  });
  assert.equal(contract.controlProtocol ?? contract.protocol, PRODUCT.productProtocol);
  assert.equal(contract.transports.discovery.schema, DESCRIPTOR_SCHEMA);
  assert.equal(contract.transports.discovery.startsProduct, false);
  assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) < 1024 * 1024);
}

async function fixtures() {
  return await Promise.all([
    readFile(resolve(CONTRACT), "utf8").then(JSON.parse),
    readFile(resolve(CATALOG), "utf8").then(JSON.parse),
  ]);
}

async function runDescribeCli() {
  const child = spawn(process.execPath, [resolve(SCRIPT), "--describe"], {
    env: { ...process.env, NPC_MONEYHAND_PAIRING_TOKEN: SECRET_SENTINEL },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timer;
  const code = await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise("timeout"), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (code === "timeout") child.kill();
  child.stdin.destroy();
  assert.equal(code, 0, `npc-moneyhand --describe failed: ${stderr}`);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(SECRET_SENTINEL), false);
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, "npc-moneyhand must emit one descriptor line");
  return JSON.parse(lines[0]);
}

test("MoneyHand exposes one offline Agent descriptor schema", async () => {
  const [contract, catalog] = await fixtures();
  assertDescriptor(await describeMoneyHand(), contract, catalog);
});

test("MoneyHand CLI describes itself without consuming stdin or starting a listener", async () => {
  const [contract, catalog] = await fixtures();
  assertDescriptor(await runDescribeCli(), contract, catalog);
});

test("MoneyHand normalizes the canonical JSONL args envelope", () => {
  const legacy = { id: "legacy", op: "status" };
  assert.equal(normalizeAgentJsonlCommandEnvelope(legacy), legacy);
  const canonical = {
    id: "canonical",
    op: "request",
    args: { request: { method: "system.status", params: {} }, timeoutMs: 1_000 },
  };
  assert.deepEqual(normalizeAgentJsonlCommandEnvelope(canonical), canonical);
  for (const invalid of [
    { id: "bad-null", op: "status", args: null },
    { id: "bad-array", op: "status", args: [] },
    { id: "bad-mixed", op: "status", args: {}, timeoutMs: 1_000 },
    { id: "bad-id", op: "status", args: { id: "override" } },
    { id: "bad-op", op: "status", args: { op: "shutdown" } },
    { id: "bad-args", op: "status", args: { args: {} } },
  ]) {
    assert.throws(
      () => normalizeAgentJsonlCommandEnvelope(invalid),
      (error) => error.code === "INVALID_COMMAND",
    );
  }
});
