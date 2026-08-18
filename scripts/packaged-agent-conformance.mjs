import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PYTHON_CONSUMER = join(ROOT, "scripts", "agent-jsonl-conformance.py");
const NPM = process.platform === "win32"
  ? { executable: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm.cmd"] }
  : { executable: "npm", prefix: [] };

const PRODUCTS = [
  {
    name: "MoneyHand",
    packageName: "npc-moneyhand",
    packageRoot: join(ROOT, "skills", "npc-moneyhand"),
    script: join("scripts", "moneyhand.mjs"),
    args: ["--internal-test-port", "0"],
    productProtocol: "npc-moneyhand-control/1",
    supported: true,
  },
];

function parseArgs(args) {
  let python = process.env.NPC_AGENT_CONFORMANCE_PYTHON || "python";
  let releaseDir = null;
  let requireAll = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--python") {
      python = args[index + 1];
      if (!python) throw new Error("--python requires an executable path");
      index += 1;
      continue;
    }
    if (value === "--release-dir") {
      releaseDir = args[index + 1];
      if (!releaseDir) throw new Error("--release-dir requires a path");
      index += 1;
      continue;
    }
    if (value === "--require-all") {
      requireAll = true;
      continue;
    }
    if (value === "--help") {
      process.stdout.write([
        "Usage: node scripts/packaged-agent-conformance.mjs [options]",
        "",
        "Options:",
        "  --python <executable>  Python consumer executable",
        "  --release-dir <path>   Test prebuilt release tarballs and checksums",
        "  --require-all          Fail if the MoneyHand Skill is skipped",
        "",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument '${value}'`);
  }
  return { python, releaseDir: releaseDir ? resolve(releaseDir) : null, requireAll };
}

function runtimeDependencies(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ];
}

async function npm(args, options = {}) {
  return await run(NPM.executable, [...NPM.prefix, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

function storedZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const checksum = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if ((flags & 0x0008) !== 0
      || method !== 0
      || compressedSize !== uncompressedSize
      || dataEnd > buffer.length) {
      throw new Error("Release extension ZIP is not a bounded stored archive");
    }
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (!name || name.includes("\\") || name.startsWith("/")
      || name.split("/").includes("..") || entries.has(name)) {
      throw new Error(`Release extension ZIP has an invalid entry: ${name}`);
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(data) !== checksum) {
      throw new Error(`Release extension ZIP CRC mismatch: ${name}`);
    }
    entries.set(name, data);
    offset = dataEnd;
  }
  if (entries.size < 1 || offset + 4 > buffer.length
    || ![0x02014b50, 0x06054b50].includes(buffer.readUInt32LE(offset))) {
    throw new Error("Release extension ZIP central directory is missing");
  }
  return entries;
}

function releasePath(releaseDir, path) {
  if (typeof path !== "string" || !path || path.includes("\\")) {
    throw new Error(`Invalid portable release path '${path}'`);
  }
  const absolute = resolve(releaseDir, ...path.split("/"));
  const fromRoot = relative(releaseDir, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Release path escapes its root: ${path}`);
  }
  return absolute;
}

export async function validateReleaseDirectory(releaseDir) {
  const manifestPath = join(releaseDir, "release-manifest.json");
  const checksumsPath = join(releaseDir, "SHA256SUMS.txt");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema !== "npc-agent-release-manifest/1"
    || manifest.lifecycleScriptsExecuted !== false
    || manifest.runtimeExternalPackages !== 0
    || manifest.packages?.length !== PRODUCTS.length) {
    throw new Error("Release manifest is invalid");
  }
  const checksumLines = (await readFile(checksumsPath, "utf8")).trim().split(/\r?\n/u);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match || checksums.has(match[2])) throw new Error(`Invalid checksum line: ${line}`);
    checksums.set(match[2], match[1]);
  }
  for (const [path, expected] of checksums) {
    const actual = await sha256(releasePath(releaseDir, path));
    if (actual !== expected) throw new Error(`Release checksum mismatch: ${path}`);
  }
  if (checksums.get("release-manifest.json") !== await sha256(manifestPath)) {
    throw new Error("Release manifest checksum is missing or invalid");
  }
  if (!manifest.extension?.archive
    || checksums.get(manifest.extension.archive.path) !== manifest.extension.archive.sha256) {
    throw new Error("Release extension archive metadata is invalid");
  }
  const archivePath = releasePath(releaseDir, manifest.extension.archive.path);
  const zipEntries = storedZipEntries(await readFile(archivePath));
  const expectedZipEntries = new Set();
  const unpackedRoot = releasePath(releaseDir, manifest.extension.path);
  let unpackedPresent = false;
  try {
    const entry = await lstat(unpackedRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Release unpacked extension path is not a real directory");
    }
    unpackedPresent = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const file of manifest.extension.files ?? []) {
    if (typeof file.path !== "string" || !file.path.startsWith("extension/")) {
      throw new Error(`Release extension file path is invalid: ${file.path}`);
    }
    const entryName = file.path.slice("extension/".length);
    const data = zipEntries.get(entryName);
    if (!data
      || data.length !== file.bytes
      || createHash("sha256").update(data).digest("hex") !== file.sha256) {
      throw new Error(`Release extension archive entry mismatch: ${entryName}`);
    }
    expectedZipEntries.add(entryName);
    if (unpackedPresent) {
      if (await sha256(releasePath(releaseDir, file.path)) !== file.sha256) {
        throw new Error(`Release unpacked extension file mismatch: ${file.path}`);
      }
    }
  }
  if (expectedZipEntries.size !== zipEntries.size) {
    throw new Error("Release extension ZIP entries do not match the manifest");
  }

  const tarballs = [];
  const packageEvidence = new Map();
  for (const product of PRODUCTS) {
    const artifact = manifest.packages.find((entry) => entry.package === product.packageName);
    if (!artifact
      || artifact.kind !== "npm-tarball"
      || artifact.runtimeDependencies !== 0
      || artifact.bundledPackages !== 0
      || artifact.lifecycleScriptsExecuted !== false
      || checksums.get(artifact.path) !== artifact.sha256) {
      throw new Error(`${product.name} release artifact metadata is invalid`);
    }
    tarballs.push(releasePath(releaseDir, artifact.path));
    packageEvidence.set(product.packageName, {
      name: artifact.package,
      version: artifact.version,
      packedBytes: artifact.bytes,
      unpackedBytes: null,
      bundledPackages: artifact.bundledPackages,
    });
  }
  return { tarballs, packageEvidence };
}

async function main() {
  const { python, releaseDir, requireAll } = parseArgs(process.argv.slice(2));
  const temporary = await mkdtemp(join(tmpdir(), "npc-packaged-agent-conformance-"));
  try {
    await writeFile(join(temporary, "package.json"), JSON.stringify({
      name: "npc-packaged-agent-conformance",
      private: true,
      type: "module",
    }), "utf8");

    let tarballs;
    let packageEvidence;
    if (releaseDir) {
      ({ tarballs, packageEvidence } = await validateReleaseDirectory(releaseDir));
    } else {
      tarballs = [];
      packageEvidence = new Map();
      for (const product of PRODUCTS) {
        const { stdout } = await npm([
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temporary,
        ], { cwd: product.packageRoot });
        const [packed] = JSON.parse(stdout);
        if (packed.name !== product.packageName || packed.bundled?.length !== 0) {
          throw new Error(`${product.name} tarball identity or bundle boundary is invalid`);
        }
        tarballs.push(join(temporary, packed.filename));
        packageEvidence.set(product.packageName, {
          name: product.packageName,
          version: packed.version,
          packedBytes: packed.size,
          unpackedBytes: packed.unpackedSize,
          bundledPackages: packed.bundled.length,
        });
      }
    }

    await npm([
      "install",
      "--ignore-scripts",
      "--offline",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ], { cwd: temporary });

    const results = [];
    for (const product of PRODUCTS) {
      const installedRoot = join(temporary, "node_modules", product.packageName);
      const packageJson = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
      const dependencies = runtimeDependencies(packageJson);
      if (dependencies.length) {
        throw new Error(`${product.name} installed package has runtime dependencies: ${dependencies}`);
      }
      const evidence = packageEvidence.get(product.packageName);
      const installedScript = join(installedRoot, product.script);
      const discoverySecret = `packaged-discovery-secret-${product.packageName}`;
      const { stdout: descriptorOutput } = await run(process.execPath, [
        installedScript,
        "--describe",
      ], {
        cwd: temporary,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NPC_MONEYHAND_PAIRING_TOKEN: discoverySecret },
      });
      const descriptorLines = descriptorOutput.trim().split(/\r?\n/u).filter(Boolean);
      if (descriptorLines.length !== 1 || descriptorOutput.includes(discoverySecret)) {
        throw new Error(`${product.name} installed CLI returned an unsafe discovery stream`);
      }
      const descriptor = JSON.parse(descriptorLines[0]);
      const operationNames = descriptor.operationCatalog?.operations?.map((entry) => entry.op);
      if (descriptor.schema !== "npc-agent-cli-descriptor/1"
        || descriptor.product?.package !== product.packageName
        || descriptor.product?.version !== packageJson.version
        || descriptor.protocols?.agent !== "npc-agent-jsonl/1"
        || descriptor.protocols?.product !== product.productProtocol
        || descriptor.discovery?.startsListener !== false
        || descriptor.discovery?.startsPlatformWorker !== false
        || descriptor.discovery?.consumesStdin !== false
        || descriptor.discovery?.inputSideEffect !== false
        || descriptor.contract?.package !== product.packageName
        || descriptor.contract?.version !== packageJson.version
        || descriptor.operationCatalog?.schema !== "npc-agent-operation-catalog/1"
        || JSON.stringify(operationNames)
          !== JSON.stringify(descriptor.capabilities?.operations?.jsonl)
        || !operationNames?.includes(descriptor.operationCatalog?.safeProbe?.op)) {
        throw new Error(`${product.name} installed CLI returned an invalid offline descriptor`);
      }
      const offlineDiscovery = {
        schema: descriptor.schema,
        agentProtocol: descriptor.protocols.agent,
        productProtocol: descriptor.protocols.product,
        modes: descriptor.modes,
        runtime: descriptor.runtime,
        operationCatalog: {
          schema: descriptor.operationCatalog.schema,
          operations: operationNames.length,
          safeProbe: descriptor.operationCatalog.safeProbe.op,
        },
        productStarted: false,
      };
      if (!product.supported) {
        results.push({
          ...evidence,
          runtimeDependencies: 0,
          offlineDiscovery,
          skipped: true,
          reason: "platform-not-supported",
        });
        continue;
      }
      const { stdout } = await run(python, [
        PYTHON_CONSUMER,
        "--",
        process.execPath,
        installedScript,
        ...product.args,
      ], {
        cwd: temporary,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const conformance = JSON.parse(stdout.trim());
      if (conformance.schema !== "npc-agent-jsonl-conformance/1"
        || conformance.name !== product.name
        || conformance.identitySource !== "offline-descriptor"
        || conformance.protocol !== "npc-agent-jsonl/1"
        || conformance.startup !== descriptor.capabilities.agentInterop.startupEvent
        || conformance.stopped !== descriptor.capabilities.agentInterop.stoppedEvent
        || conformance.catalog !== "npc-agent-operation-catalog/1"
        || conformance.operationCount !== operationNames.length
        || conformance.safeProbe !== descriptor.operationCatalog.safeProbe.op
        || conformance.exitCode !== 0) {
        throw new Error(`${product.name} installed CLI returned invalid conformance evidence`);
      }
      results.push({
        ...evidence,
        runtimeDependencies: 0,
        offlineDiscovery,
        skipped: false,
        conformance,
      });
    }

    if (requireAll && results.some((product) => product.skipped === true)) {
      throw new Error("Packaged Agent conformance requires the MoneyHand Skill lifecycle");
    }
    return {
      schema: "npc-packaged-agent-conformance/1",
      source: releaseDir ? "release-directory" : "source-pack",
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      consumer: "python-standard-library",
      consumerIdentitySource: "offline-descriptor",
      packScriptsExecuted: false,
      installScriptsExecuted: false,
      products: results,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = await main();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
