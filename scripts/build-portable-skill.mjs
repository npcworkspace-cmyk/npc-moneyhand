import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
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
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS_ROOT = join(ROOT, "artifacts");
const DEFAULT_OUTPUT = join(ARTIFACTS_ROOT, "portable-skill");
const SKILL_SOURCE = join(ROOT, "skills", "npc-moneyhand");
const EXTENSION_SOURCE = join(ROOT, "extension");
const ARCHIVE_ROOT = "npc-moneyhand";
const OWNER_MARKER = ".npc-moneyhand-portable-skill-owner.json";
const OWNER_SCHEMA = "npc-moneyhand-portable-skill-output/2";
const LEGACY_OWNER_SCHEMA = "npc-moneyhand-portable-skill-output/1";
const MANIFEST_SCHEMA = "npc-moneyhand-portable-skill-manifest/2";
const EXTENSION_INTEGRITY_SCHEMA = "npc-moneyhand-extension-integrity/1";
const EXTENSION_INTEGRITY_PATH = "references/extension-integrity.json";
const REPOSITORY_URL = "https://github.com/npcworkspace-cmyk/npc-moneyhand";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

function parseArgs(args) {
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path under artifacts/");
      index += 1;
      continue;
    }
    if (value === "--help") {
      process.stdout.write([
        "Usage: node scripts/build-portable-skill.mjs [--output <artifacts/path>]",
        "",
        "Builds a deterministic, zero-dependency MoneyHand Skill-only ZIP.",
        "",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument '${value}'`);
  }
  return { output: confinedOutput(output) };
}

function confinedOutput(value) {
  const output = resolve(ROOT, value);
  const pathFromArtifacts = relative(ARTIFACTS_ROOT, output);
  if (!pathFromArtifacts
    || pathFromArtifacts === ".."
    || pathFromArtifacts.startsWith(`..${sep}`)
    || isAbsolute(pathFromArtifacts)) {
    throw new Error("Portable Skill output must be a child directory of repository artifacts/");
  }
  return output;
}

function normalizeFilesystemPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFilesystemPath(left, right) {
  return normalizeFilesystemPath(left) === normalizeFilesystemPath(right);
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

async function assertSafeOutputPath(output) {
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
  for (const segment of relative(ARTIFACTS_ROOT, output).split(sep)) {
    cursor = join(cursor, segment);
    const entry = await existingEntry(cursor);
    if (!entry) break;
    if (entry.isSymbolicLink()) {
      throw new Error(`Portable Skill output path cannot contain a symbolic link or junction: ${cursor}`);
    }
    const realCursor = await realpath(cursor);
    if (!pathIsInside(artifactsRealPath, realCursor)) {
      throw new Error(`Portable Skill output resolves outside repository artifacts/: ${cursor}`);
    }
  }
}

async function ownerRecord(output, ownershipId = randomUUID()) {
  const repositoryRoot = normalizeFilesystemPath(await realpath(ROOT));
  return {
    schema: OWNER_SCHEMA,
    builder: "scripts/build-portable-skill.mjs",
    repositoryId: createHash("sha256")
      .update("npc-moneyhand-portable-skill-owner/2\0", "utf8")
      .update(repositoryRoot, "utf8")
      .digest("hex"),
    artifactsRelativeOutput: portablePath(relative(ARTIFACTS_ROOT, output)),
    ownershipId,
  };
}

async function readOwner(output) {
  const markerPath = join(output, OWNER_MARKER);
  const entry = await existingEntry(markerPath);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Portable Skill ownership marker must be a real file: ${markerPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(`Portable Skill ownership marker is invalid JSON: ${markerPath}`);
  }
  const expected = await ownerRecord(output, marker?.ownershipId);
  const validOwnershipId = typeof marker?.ownershipId === "string"
    && /^[0-9a-f-]{36}$/iu.test(marker.ownershipId);
  const validCurrent = marker?.schema === expected.schema
    && marker.builder === expected.builder
    && marker.repositoryId === expected.repositoryId
    && marker.artifactsRelativeOutput === expected.artifactsRelativeOutput
    && validOwnershipId;
  if (validCurrent) return marker;

  const legacyValid = marker?.schema === LEGACY_OWNER_SCHEMA
    && marker.builder === expected.builder
    && marker.repositoryRoot === normalizeFilesystemPath(await realpath(ROOT))
    && marker.output === normalizeFilesystemPath(output)
    && validOwnershipId;
  if (legacyValid) return { ...marker, legacy: true };
  throw new Error(`Portable Skill ownership marker does not match this repository and output: ${markerPath}`);
}

async function inspectOutputOwnership(output) {
  const entry = await existingEntry(output);
  if (!entry) return { exists: false };
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Portable Skill output must be a real directory, not a link or file: ${output}`);
  }
  if ((await readdir(output)).length === 0) return { exists: true };
  const marker = await readOwner(output);
  if (marker) return { exists: true, marker };
  throw new Error(`Refusing to replace an unowned non-empty Portable Skill output: ${output}`);
}

async function writeOwner(directory, output) {
  const marker = await ownerRecord(output);
  await writeFile(
    join(directory, OWNER_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

async function replaceOutput(output, builtDirectory, previous) {
  if (!previous.exists) {
    await rename(builtDirectory, output);
    return;
  }
  const parent = dirname(output);
  const backup = await mkdtemp(join(parent, ".npc-moneyhand-portable-previous-"));
  await rm(backup, { recursive: true, force: true });
  await rename(output, backup);
  try {
    await rename(builtDirectory, output);
  } catch (error) {
    await rename(backup, output);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_INVALID_SEGMENT = /[<>:"\\|?*\u0000-\u001f\u007f]/u;

function foldedPortableSegment(segment) {
  return segment.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

export function assertPortableArchivePaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError("Portable archive paths must be an array");
  const foldedFiles = new Map();
  const foldedPrefixes = new Map();
  for (const path of paths) {
    if (typeof path !== "string"
      || !path
      || path.startsWith("/")
      || path.endsWith("/")
      || path.includes("\\")) {
      throw new Error(`Unsafe Portable Skill archive path: ${JSON.stringify(path)}`);
    }
    const segments = path.split("/");
    const foldedSegments = [];
    const rawSegments = [];
    for (const segment of segments) {
      if (!segment
        || segment === "."
        || segment === ".."
        || WINDOWS_INVALID_SEGMENT.test(segment)
        || /[ .]$/u.test(segment)
        || WINDOWS_RESERVED_NAME.test(segment)) {
        throw new Error(`Portable Skill path segment is not cross-platform safe: ${JSON.stringify(segment)}`);
      }
      foldedSegments.push(foldedPortableSegment(segment));
      rawSegments.push(segment);
      const foldedPrefix = foldedSegments.join("/");
      const rawPrefix = rawSegments.join("/");
      const existingPrefix = foldedPrefixes.get(foldedPrefix);
      if (existingPrefix !== undefined && existingPrefix !== rawPrefix) {
        throw new Error(
          `Portable Skill archive path normalization collision: '${existingPrefix}' and '${rawPrefix}'`,
        );
      }
      foldedPrefixes.set(foldedPrefix, rawPrefix);
    }
    const foldedPath = foldedSegments.join("/");
    const existingFile = foldedFiles.get(foldedPath);
    if (existingFile !== undefined) {
      throw new Error(`Portable Skill archive path collision: '${existingFile}' and '${path}'`);
    }
    foldedFiles.set(foldedPath, path);
  }
  for (const [foldedPath, original] of foldedFiles) {
    const segments = foldedPath.split("/");
    for (let count = 1; count < segments.length; count += 1) {
      const prefix = segments.slice(0, count).join("/");
      const prefixFile = foldedFiles.get(prefix);
      if (prefixFile !== undefined) {
        throw new Error(
          `Portable Skill archive file/directory collision: '${prefixFile}' and '${original}'`,
        );
      }
    }
  }
  return true;
}

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Portable Skill sources cannot contain symlinks: ${absolute}`);
    }
    if (stats.isDirectory()) files.push(...await filesBelow(absolute, path));
    else if (stats.isFile()) files.push({ absolute, path });
    else throw new Error(`Unsupported Portable Skill source entry: ${absolute}`);
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeDependencies(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
}

async function readProductIdentity() {
  const [rootPackage, skillPackage, extensionManifest] = await Promise.all([
    readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(join(SKILL_SOURCE, "package.json"), "utf8").then(JSON.parse),
    readFile(join(EXTENSION_SOURCE, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  if (rootPackage.name !== "npc-moneyhand"
    || skillPackage.name !== rootPackage.name
    || skillPackage.version !== rootPackage.version
    || extensionManifest.name !== rootPackage.name
    || extensionManifest.version !== rootPackage.version
    || extensionManifest.version_name !== rootPackage.version) {
    throw new Error("Portable Skill package and extension identity must match the repository");
  }
  const dependencies = runtimeDependencies(skillPackage);
  if (dependencies.length > 0) {
    throw new Error(`Portable Skill must have zero package dependencies: ${dependencies.join(", ")}`);
  }
  return { rootPackage, skillPackage, extensionManifest };
}

async function loadSourceFiles(directory) {
  const files = await filesBelow(directory);
  return await Promise.all(files.map(async (file) => {
    const data = await readFile(file.absolute);
    return {
      ...file,
      data,
      bytes: data.length,
      sha256: sha256Buffer(data),
    };
  }));
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function assertExtensionIntegrity(integrity, extensionFiles, identity) {
  if (!exactKeys(integrity, ["schema", "product", "version", "algorithm", "coverage", "files"])
    || integrity.schema !== EXTENSION_INTEGRITY_SCHEMA
    || integrity.product !== identity.rootPackage.name
    || integrity.version !== identity.rootPackage.version
    || integrity.algorithm !== "sha256") {
    throw new Error("Extension integrity manifest identity or shape is invalid");
  }
  if (!exactKeys(integrity.coverage, ["mode", "fileCount", "excluded", "generated"])
    || integrity.coverage.mode !== "complete-extension-tree"
    || !Number.isSafeInteger(integrity.coverage.fileCount)
    || integrity.coverage.fileCount < 0
    || !Array.isArray(integrity.coverage.excluded)
    || integrity.coverage.excluded.length !== 0
    || !Array.isArray(integrity.coverage.generated)
    || integrity.coverage.generated.length !== 0
    || !Array.isArray(integrity.files)
    || integrity.coverage.fileCount !== integrity.files.length) {
    throw new Error(
      "Extension integrity coverage must be the complete tree with empty excluded/generated arrays",
    );
  }

  const declared = new Map();
  let previousPath = null;
  for (const file of integrity.files) {
    if (!exactKeys(file, ["path", "bytes", "sha256"])
      || typeof file.path !== "string"
      || !file.path
      || file.path.startsWith("/")
      || file.path.startsWith("./")
      || file.path.endsWith("/")
      || file.path.includes("\\")
      || file.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error("Extension integrity file entry is invalid");
    }
    if (previousPath !== null && file.path <= previousPath) {
      throw new Error("Extension integrity files must be uniquely sorted by path");
    }
    previousPath = file.path;
    declared.set(file.path, file);
  }

  const actual = new Map(extensionFiles.map((file) => [file.path, file]));
  if (actual.size !== extensionFiles.length) {
    throw new Error("Extension source tree contains duplicate paths");
  }
  for (const [path, expected] of declared) {
    const observed = actual.get(path);
    if (!observed) throw new Error(`Extension integrity missing file: ${path}`);
    if (observed.bytes !== expected.bytes) {
      throw new Error(`Extension integrity byte length mismatch: ${path}`);
    }
    if (observed.sha256 !== expected.sha256) {
      throw new Error(`Extension integrity SHA-256 mismatch: ${path}`);
    }
  }
  for (const path of actual.keys()) {
    if (!declared.has(path)) throw new Error(`Extension integrity unlisted file: ${path}`);
  }
  if (actual.size !== integrity.coverage.fileCount) {
    throw new Error("Extension integrity file count does not cover the complete extension tree");
  }
  return integrity;
}

async function preparePayload(identity) {
  const [skillFiles, extensionFiles] = await Promise.all([
    loadSourceFiles(SKILL_SOURCE),
    loadSourceFiles(EXTENSION_SOURCE),
  ]);
  if (skillFiles.some((file) => file.path === "assets/extension"
    || file.path.startsWith("assets/extension/"))) {
    throw new Error("Portable Skill source must not contain extension source or installation files");
  }
  const integrityFile = skillFiles.find((file) => file.path === EXTENSION_INTEGRITY_PATH);
  if (!integrityFile) {
    throw new Error(`Portable Skill is missing ${EXTENSION_INTEGRITY_PATH}`);
  }
  let integrity;
  try {
    integrity = JSON.parse(integrityFile.data.toString("utf8"));
  } catch {
    throw new Error("Extension integrity manifest is invalid JSON");
  }
  assertExtensionIntegrity(integrity, extensionFiles, identity);
  const payloadFiles = skillFiles
    .map((file) => ({ ...file, path: file.path }))
    .sort(comparePaths);
  assertPortableArchivePaths(payloadFiles.map((file) => `${ARCHIVE_ROOT}/${file.path}`));
  return { payloadFiles, integrity, integrityFile };
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

async function writeDeterministicZip(path, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of [...files].sort(comparePaths)) {
    const data = file.data;
    const archivePath = `${ARCHIVE_ROOT}/${file.path}`;
    const name = Buffer.from(archivePath, "utf8");
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
  const centralDirectory = Buffer.concat(centralParts);
  if (files.length > 0xffff
    || offset > 0xffffffff
    || centralDirectory.length > 0xffffffff) {
    throw new Error("ZIP32 archive limit exceeded");
  }
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

function fileEvidence(files) {
  return [...files].sort(comparePaths).map((file) => ({
    path: `${ARCHIVE_ROOT}/${file.path}`,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
}

async function writeManifestAndChecksums(
  output,
  identity,
  payloadFiles,
  archiveName,
  extensionIntegrity,
  extensionIntegrityFile,
) {
  const archivePath = join(output, archiveName);
  const archive = {
    path: archiveName,
    root: ARCHIVE_ROOT,
    bytes: (await lstat(archivePath)).size,
    sha256: await sha256(archivePath),
  };
  const manifest = {
    schema: MANIFEST_SCHEMA,
    name: identity.rootPackage.name,
    version: identity.rootPackage.version,
    reproducible: true,
    runtime: {
      node: identity.skillPackage.engines?.node ?? ">=20",
      externalPackages: 0,
    },
    archive,
    skill: {
      path: ARCHIVE_ROOT,
      package: identity.skillPackage.name,
      version: identity.skillPackage.version,
    },
    extension: {
      bundled: false,
      sourceFilesIncluded: false,
      distribution: "github-release-asset",
      repositoryUrl: REPOSITORY_URL,
      releasesUrl: RELEASES_URL,
      assetName: `npc-moneyhand-extension-${identity.extensionManifest.version_name}.zip`,
      manualInstallRequired: true,
      version: identity.extensionManifest.version,
      versionName: identity.extensionManifest.version_name,
      manifestVersion: identity.extensionManifest.manifest_version,
      integrity: {
        schema: extensionIntegrity.schema,
        algorithm: extensionIntegrity.algorithm,
        fileCount: extensionIntegrity.coverage.fileCount,
        manifestPath: `${ARCHIVE_ROOT}/${EXTENSION_INTEGRITY_PATH}`,
        manifestSha256: extensionIntegrityFile.sha256,
      },
    },
    files: fileEvidence(payloadFiles),
  };
  const manifestPath = join(output, "portable-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const checksums = [
    { path: archiveName, sha256: archive.sha256 },
    { path: "portable-manifest.json", sha256: await sha256(manifestPath) },
  ].sort(comparePaths);
  await writeFile(
    join(output, "SHA256SUMS.txt"),
    `${checksums.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
    "utf8",
  );
  return manifest;
}

export async function buildPortableSkill({ output = DEFAULT_OUTPUT } = {}) {
  const confined = confinedOutput(output);
  const identity = await readProductIdentity();
  const prepared = await preparePayload(identity);
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  await assertSafeOutputPath(confined);
  await mkdir(dirname(confined), { recursive: true });
  await assertSafeOutputPath(confined);
  const previous = await inspectOutputOwnership(confined);
  const builtDirectory = await mkdtemp(join(dirname(confined), ".npc-moneyhand-portable-stage-"));
  try {
    const archiveName = `npc-moneyhand-portable-skill-${identity.rootPackage.version}.zip`;
    await writeDeterministicZip(join(builtDirectory, archiveName), prepared.payloadFiles);
    const manifest = await writeManifestAndChecksums(
      builtDirectory,
      identity,
      prepared.payloadFiles,
      archiveName,
      prepared.integrity,
      prepared.integrityFile,
    );
    await writeOwner(builtDirectory, confined);
    await replaceOutput(confined, builtDirectory, previous);
    return {
      schema: "npc-moneyhand-portable-skill-build/2",
      output: confined,
      archive: join(confined, archiveName),
      manifest,
      checksums: join(confined, "SHA256SUMS.txt"),
    };
  } catch (error) {
    await rm(builtDirectory, { recursive: true, force: true });
    throw error;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  const result = await buildPortableSkill(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
