import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS_ROOT = join(ROOT, "artifacts");
const DEFAULT_OUTPUT = join(ARTIFACTS_ROOT, "agent-release");
const RELEASE_OWNER_MARKER = ".npc-moneyhand-release-owner.json";
const RELEASE_OWNER_SCHEMA = "npc-moneyhand-release-output/1";
const CONFORMANCE = join(ROOT, "scripts", "packaged-agent-conformance.mjs");
const SKILL_README = join(ROOT, "packaging", "npm", "npc-moneyhand.README.md");
const NPM = process.platform === "win32"
  ? { executable: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm.cmd"] }
  : { executable: "npm", prefix: [] };

const PRODUCTS = [
  {
    product: "MoneyHand Skill",
    packageName: "npc-moneyhand",
    source: join(ROOT, "skills", "npc-moneyhand"),
    injectReadme: true,
  },
];

export function assertReleaseIdentity({
  rootPackage,
  skillPackage,
  contract,
  extensionManifest,
}) {
  const version = rootPackage?.version;
  if (typeof version !== "string" || !version) {
    throw new Error("Root package version is missing");
  }
  for (const [label, candidate] of [
    ["Skill package", skillPackage?.version],
    ["Skill contract", contract?.version],
    ["Extension version_name", extensionManifest?.version_name],
  ]) {
    if (candidate !== version) {
      throw new Error(`${label} version '${candidate ?? "missing"}' must match root package version '${version}'`);
    }
  }

  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/u
    .exec(version);
  if (!match) {
    throw new Error(`Root package version '${version}' has no Chrome manifest version mapping`);
  }
  const chromeParts = match.slice(1, match[4] === undefined ? 4 : 5);
  if (chromeParts.some((part) => Number(part) > 65_535)
    || chromeParts.every((part) => Number(part) === 0)) {
    throw new Error(`Root package version '${version}' cannot be represented by Chrome`);
  }
  const chromeVersion = chromeParts.join(".");
  if (extensionManifest?.version !== chromeVersion) {
    throw new Error(
      `Extension numeric version '${extensionManifest?.version ?? "missing"}' must map '${version}' to '${chromeVersion}'`,
    );
  }
  return { version, chromeVersion };
}

async function readReleaseIdentity() {
  const [rootPackage, skillPackage, contract, extensionManifest] = await Promise.all([
    readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(join(ROOT, "skills", "npc-moneyhand", "package.json"), "utf8").then(JSON.parse),
    readFile(join(
      ROOT,
      "skills",
      "npc-moneyhand",
      "references",
      "moneyhand-contract.json",
    ), "utf8").then(JSON.parse),
    readFile(join(ROOT, "extension", "manifest.json"), "utf8").then(JSON.parse),
  ]);
  return assertReleaseIdentity({ rootPackage, skillPackage, contract, extensionManifest });
}

function parseArgs(args) {
  let output = DEFAULT_OUTPUT;
  let python = process.env.NPC_AGENT_CONFORMANCE_PYTHON || "python";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path under artifacts/");
      index += 1;
      continue;
    }
    if (value === "--python") {
      python = args[index + 1];
      if (!python) throw new Error("--python requires an executable path");
      index += 1;
      continue;
    }
    if (value === "--help") {
      process.stdout.write([
        "Usage: node scripts/build-agent-release.mjs [--output <artifacts/path>] [--python <path>]",
        "",
        "Builds and conformance-tests one MoneyHand Skill tarball plus the Chrome extension.",
        "",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument '${value}'`);
  }
  return { output: confinedOutput(output), python };
}

function confinedOutput(value) {
  const output = resolve(ROOT, value);
  const pathFromArtifacts = relative(ARTIFACTS_ROOT, output);
  if (!pathFromArtifacts
    || pathFromArtifacts === ".."
    || pathFromArtifacts.startsWith(`..${sep}`)
    || isAbsolute(pathFromArtifacts)) {
    throw new Error("Release output must be a child directory of repository artifacts/");
  }
  return output;
}

function sameFilesystemPath(left, right) {
  const normalize = (value) => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function pathIsInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function existingEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafeReleaseOutput(output) {
  const rootRealPath = await realpath(ROOT);
  const artifactsEntry = await existingEntry(ARTIFACTS_ROOT);
  if (!artifactsEntry) return;
  if (artifactsEntry.isSymbolicLink() || !artifactsEntry.isDirectory()) {
    throw new Error("Repository artifacts/ must be a real directory, not a link or file");
  }
  const artifactsRealPath = await realpath(ARTIFACTS_ROOT);
  if (!sameFilesystemPath(artifactsRealPath, join(rootRealPath, "artifacts"))) {
    throw new Error("Repository artifacts/ resolves outside the repository");
  }

  let cursor = ARTIFACTS_ROOT;
  const segments = relative(ARTIFACTS_ROOT, output).split(sep);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const entry = await existingEntry(cursor);
    if (!entry) break;
    if (entry.isSymbolicLink()) {
      throw new Error(`Release output path cannot contain a symbolic link or junction: ${cursor}`);
    }
    const realCursor = await realpath(cursor);
    if (!pathIsInside(artifactsRealPath, realCursor)) {
      throw new Error(`Release output resolves outside repository artifacts/: ${cursor}`);
    }
  }
}

function filesystemIdentity(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function releaseOwnerRecord(output, ownershipId = randomUUID()) {
  return {
    schema: RELEASE_OWNER_SCHEMA,
    builder: "scripts/build-agent-release.mjs",
    repositoryRoot: filesystemIdentity(await realpath(ROOT)),
    output: filesystemIdentity(output),
    ownershipId,
  };
}

async function readReleaseOwner(output) {
  const markerPath = join(output, RELEASE_OWNER_MARKER);
  const markerEntry = await existingEntry(markerPath);
  if (!markerEntry) return null;
  if (markerEntry.isSymbolicLink() || !markerEntry.isFile()) {
    throw new Error(`Release ownership marker must be a real file: ${markerPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`Release ownership marker is invalid JSON: ${markerPath}`);
  }
  const expected = await releaseOwnerRecord(output, marker?.ownershipId);
  if (marker?.schema !== expected.schema
    || marker.builder !== expected.builder
    || marker.repositoryRoot !== expected.repositoryRoot
    || marker.output !== expected.output
    || typeof marker.ownershipId !== "string"
    || !/^[0-9a-f-]{36}$/iu.test(marker.ownershipId)) {
    throw new Error(`Release ownership marker does not match this repository and output: ${markerPath}`);
  }
  return marker;
}

async function isLegacyDefaultRelease(output) {
  if (!sameFilesystemPath(output, DEFAULT_OUTPUT)) return false;
  try {
    const [manifest, packageJson] = await Promise.all([
      readFile(join(output, "release-manifest.json"), "utf8").then(JSON.parse),
      readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
    ]);
    return manifest?.schema === "npc-agent-release-manifest/1"
      && manifest.suite?.name === packageJson.name;
  } catch {
    return false;
  }
}

async function inspectReleaseOutputOwnership(output) {
  const entry = await existingEntry(output);
  if (!entry) return { exists: false, kind: "absent" };
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Release output must be a real directory, not a link or file: ${output}`);
  }
  const entries = await readdir(output);
  if (entries.length === 0) return { exists: true, kind: "empty" };
  const marker = await readReleaseOwner(output);
  if (marker) return { exists: true, kind: "managed", marker };
  if (await isLegacyDefaultRelease(output)) {
    return { exists: true, kind: "legacy-default" };
  }
  throw new Error(
    `Refusing to replace an unowned non-empty release output: ${output}`,
  );
}

async function writeReleaseOwner(directory, output) {
  const marker = await releaseOwnerRecord(output);
  await writeFile(
    join(directory, RELEASE_OWNER_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  return marker;
}

async function replaceReleaseOutput(output, builtDirectory, previous) {
  if (!previous.exists) {
    await rename(builtDirectory, output);
    return;
  }
  const parent = dirname(output);
  const backupPlaceholder = await mkdtemp(join(parent, ".npc-moneyhand-release-previous-"));
  await rm(backupPlaceholder, { recursive: true, force: true });
  await rename(output, backupPlaceholder);
  try {
    await rename(builtDirectory, output);
  } catch (error) {
    await rename(backupPlaceholder, output);
    throw error;
  }
  await rm(backupPlaceholder, { recursive: true, force: true });
}

function runtimeDependencies(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ];
}

function portablePath(path) {
  return path.split(sep).join("/");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolute = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Release sources cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, path));
    else if (entry.isFile()) files.push({ absolute, path });
    else throw new Error(`Unsupported release source entry: ${absolute}`);
  }
  return files;
}

async function npm(args, options) {
  return await run(NPM.executable, [...NPM.prefix, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
      npm_config_update_notifier: "false",
      ...options?.env,
    },
  });
}

async function stageSkill(source, stagingRoot) {
  const destination = join(stagingRoot, "npc-moneyhand");
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(destination, "README.md"), await readFile(SKILL_README));
  const packagePath = join(destination, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.files = [...new Set([...(packageJson.files ?? []), "README.md"])];
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return destination;
}

async function packProducts(releaseDirectory, stagingRoot) {
  const artifacts = [];
  for (const product of PRODUCTS) {
    const packageRoot = product.injectReadme
      ? await stageSkill(product.source, stagingRoot)
      : product.source;
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const dependencies = runtimeDependencies(packageJson);
    if (packageJson.name !== product.packageName || dependencies.length) {
      throw new Error(`${product.product} package identity or zero-dependency boundary is invalid`);
    }
    const { stdout } = await npm([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      releaseDirectory,
    ], {
      cwd: packageRoot,
      env: { npm_config_cache: join(stagingRoot, ".npm-cache") },
    });
    const [packed] = JSON.parse(stdout);
    if (packed.name !== product.packageName
      || packed.version !== packageJson.version
      || packed.bundled?.length !== 0) {
      throw new Error(`${product.product} tarball metadata is invalid`);
    }
    const packedPaths = new Set((packed.files ?? []).map((entry) => entry.path));
    if (product.injectReadme && !packedPaths.has("README.md")) {
      throw new Error("MoneyHand Skill release tarball is missing README.md");
    }
    if (packedPaths.has("scripts/operator.mjs")) {
      throw new Error("MoneyHand Skill release tarball contains the retired Operator entrypoint");
    }
    const artifactPath = join(releaseDirectory, packed.filename);
    artifacts.push({
      kind: "npm-tarball",
      product: product.product,
      package: packed.name,
      version: packed.version,
      path: portablePath(relative(releaseDirectory, artifactPath)),
      bytes: (await lstat(artifactPath)).size,
      sha256: await sha256(artifactPath),
      runtimeDependencies: 0,
      bundledPackages: 0,
      lifecycleScriptsExecuted: false,
    });
  }
  return artifacts;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function writeDeterministicZip(path, rootName, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const data = await readFile(file.absolute);
    const name = Buffer.from(`${rootName}/${file.path}`, "utf8");
    if (data.length > 0xffffffff || name.length > 0xffff) {
      throw new Error(`ZIP32 limit exceeded by ${file.path}`);
    }
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  if (files.length > 0xffff || offset > 0xffffffff) throw new Error("ZIP32 archive limit exceeded");
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(path, Buffer.concat([...localParts, centralDirectory, end]));
}

async function copyExtension(output) {
  const source = join(ROOT, "extension");
  const extensionDirectory = join(output, "extension", "npc-moneyhand");
  await cp(source, extensionDirectory, { recursive: true, errorOnExist: true, force: false });
  const manifest = JSON.parse(await readFile(join(extensionDirectory, "manifest.json"), "utf8"));
  const files = await filesBelow(extensionDirectory);
  const fileEvidence = [];
  for (const file of files) {
    fileEvidence.push({
      path: `extension/npc-moneyhand/${file.path}`,
      bytes: (await lstat(file.absolute)).size,
      sha256: await sha256(file.absolute),
    });
  }
  const zipName = `npc-moneyhand-extension-${manifest.version_name ?? manifest.version}.zip`;
  const zipPath = join(output, zipName);
  await writeDeterministicZip(zipPath, "npc-moneyhand", files);
  return {
    kind: "chrome-extension-unpacked",
    product: "MoneyHand Extension",
    path: "extension/npc-moneyhand",
    archive: {
      path: zipName,
      bytes: (await lstat(zipPath)).size,
      sha256: await sha256(zipPath),
    },
    version: manifest.version,
    versionName: manifest.version_name ?? manifest.version,
    manifestVersion: manifest.manifest_version,
    files: fileEvidence,
  };
}

async function writeManifestAndChecksums(output, packages, extension) {
  const rootPackage = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const manifest = {
    schema: "npc-agent-release-manifest/1",
    suite: { name: rootPackage.name, version: rootPackage.version },
    reproducible: true,
    runtimeExternalPackages: 0,
    lifecycleScriptsExecuted: false,
    packages,
    extension,
  };
  const manifestPath = join(output, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const entries = [
    ...packages.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    { path: extension.archive.path, sha256: extension.archive.sha256 },
    { path: "release-manifest.json", sha256: await sha256(manifestPath) },
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  await writeFile(
    join(output, "SHA256SUMS.txt"),
    `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
    "utf8",
  );
  return manifest;
}

async function runPackagedConformance(output, python) {
  const { stdout } = await run(process.execPath, [
    CONFORMANCE,
    "--release-dir",
    output,
    "--python",
    python,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  if (report.schema !== "npc-packaged-agent-conformance/1"
    || report.source !== "release-directory"
    || report.products?.length !== PRODUCTS.length
    || report.packScriptsExecuted !== false
    || report.installScriptsExecuted !== false) {
    throw new Error("Release package conformance returned invalid evidence");
  }
  return report;
}

export async function buildAgentRelease({
  output = DEFAULT_OUTPUT,
  python = process.env.NPC_AGENT_CONFORMANCE_PYTHON || "python",
  conformance = true,
} = {}) {
  await readReleaseIdentity();
  const confined = confinedOutput(output);
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  await assertSafeReleaseOutput(confined);
  await mkdir(dirname(confined), { recursive: true });
  await assertSafeReleaseOutput(confined);
  const previous = await inspectReleaseOutputOwnership(confined);
  const builtDirectory = await mkdtemp(join(
    dirname(confined),
    ".npc-moneyhand-release-stage-",
  ));
  const stagingRoot = await mkdtemp(join(builtDirectory, ".staging-"));
  try {
    await writeReleaseOwner(builtDirectory, confined);
    await mkdir(join(builtDirectory, "extension"), { recursive: true });
    const packages = await packProducts(builtDirectory, stagingRoot);
    const extension = await copyExtension(builtDirectory);
    const manifest = await writeManifestAndChecksums(builtDirectory, packages, extension);
    await rm(stagingRoot, { recursive: true, force: true });
    const conformanceReport = conformance
      ? await runPackagedConformance(builtDirectory, python)
      : null;
    await replaceReleaseOutput(confined, builtDirectory, previous);
    return {
      schema: "npc-agent-release-build/1",
      output: confined,
      manifest,
      checksums: join(confined, "SHA256SUMS.txt"),
      conformance: conformanceReport,
    };
  } catch (error) {
    await rm(builtDirectory, { recursive: true, force: true });
    throw error;
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildAgentRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
