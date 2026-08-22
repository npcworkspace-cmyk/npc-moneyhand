import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertReleaseIdentity,
  buildAgentRelease,
} from "../scripts/build-agent-release.mjs";
import { validateReleaseDirectory } from "../scripts/packaged-agent-conformance.mjs";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = join(root, "artifacts");
const npmInvocation = process.platform === "win32"
  ? { executable: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm.cmd"] }
  : { executable: "npm", prefix: [] };

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function fromPortable(base, path) {
  return join(base, ...path.split("/"));
}

async function extensionSourceFiles(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await extensionSourceFiles(join(directory, entry.name), path));
    else files.push(path);
  }
  return files.sort();
}

function storedZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, "release ZIP must use deterministic store mode");
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    entries.push(buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    offset = nameStart + nameLength + extraLength + size;
  }
  return entries;
}

async function npm(args, cwd) {
  return await run(npmInvocation.executable, [...npmInvocation.prefix, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
}

function v1ReleaseIdentity(overrides = {}) {
  return {
    rootPackage: { version: "1.0.0" },
    skillPackage: { version: "1.0.0" },
    contract: { version: "1.0.0" },
    extensionManifest: { version: "1.0.0", version_name: "1.0.0" },
    ...overrides,
  };
}

test("release identity requires one version across every shipped surface", () => {
  assert.deepEqual(assertReleaseIdentity(v1ReleaseIdentity()), {
    version: "1.0.0",
    chromeVersion: "1.0.0",
  });
  assert.throws(
    () => assertReleaseIdentity(v1ReleaseIdentity({
      skillPackage: { version: "1.0.1" },
    })),
    /Skill package version '1\.0\.1' must match root package version '1\.0\.0'/u,
  );
  assert.throws(
    () => assertReleaseIdentity(v1ReleaseIdentity({
      contract: { version: "1.0.1" },
    })),
    /Skill contract version '1\.0\.1' must match root package version '1\.0\.0'/u,
  );
  assert.throws(
    () => assertReleaseIdentity(v1ReleaseIdentity({
      extensionManifest: { version: "1.0.0", version_name: "1.0.1" },
    })),
    /Extension version_name version '1\.0\.1' must match root package version '1\.0\.0'/u,
  );
  assert.throws(
    () => assertReleaseIdentity(v1ReleaseIdentity({
      extensionManifest: { version: "1.0.0.1", version_name: "1.0.0" },
    })),
    /Extension numeric version '1\.0\.0\.1' must map '1\.0\.0' to '1\.0\.0'/u,
  );
});

test("release output cannot target or escape the ignored artifacts directory", async (t) => {
  await assert.rejects(
    buildAgentRelease({ output: root, conformance: false }),
    /must be a child directory of repository artifacts/u,
  );
  await assert.rejects(
    buildAgentRelease({ output: artifacts, conformance: false }),
    /must be a child directory of repository artifacts/u,
  );
  await assert.rejects(
    buildAgentRelease({
      output: join(artifacts, "..", "release-escape"),
      conformance: false,
    }),
    /must be a child directory of repository artifacts/u,
  );

  await mkdir(artifacts, { recursive: true });
  const external = await mkdtemp(join(tmpdir(), "npc-release-link-boundary-"));
  const victim = join(external, "victim");
  const link = join(artifacts, `release-link-${process.pid}-${Date.now()}`);
  await mkdir(victim, { recursive: true });
  await writeFile(join(victim, "sentinel.txt"), "keep", "utf8");
  await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  await assert.rejects(
    buildAgentRelease({ output: join(link, "victim"), conformance: false }),
    /cannot contain a symbolic link or junction|resolves outside/u,
  );
  assert.equal(await readFile(join(victim, "sentinel.txt"), "utf8"), "keep");

  const directLink = join(artifacts, `release-direct-link-${process.pid}-${Date.now()}`);
  await symlink(victim, directLink, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(directLink, { recursive: true, force: true }));
  await assert.rejects(
    buildAgentRelease({ output: directLink, conformance: false }),
    /cannot contain a symbolic link or junction|must be a real directory/u,
  );
  assert.equal(await readFile(join(victim, "sentinel.txt"), "utf8"), "keep");
});

test("release build preserves unowned non-empty custom output", async (t) => {
  await mkdir(artifacts, { recursive: true });
  const output = join(artifacts, `release-unowned-${process.pid}-${Date.now()}`);
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(output);
  await writeFile(join(output, "sentinel.txt"), "keep", "utf8");

  await assert.rejects(
    buildAgentRelease({ output, conformance: false }),
    /Refusing to replace an unowned non-empty release output/u,
  );
  assert.equal(await readFile(join(output, "sentinel.txt"), "utf8"), "keep");

  await writeFile(join(output, ".npc-moneyhand-release-owner.json"), JSON.stringify({
    schema: "npc-moneyhand-release-output/1",
    builder: "scripts/build-agent-release.mjs",
    repositoryRoot: "wrong-repository",
    output: resolve(output),
    ownershipId: "00000000-0000-4000-8000-000000000000",
  }), "utf8");
  await assert.rejects(
    buildAgentRelease({ output, conformance: false }),
    /ownership marker does not match this repository and output/u,
  );
  assert.equal(await readFile(join(output, "sentinel.txt"), "utf8"), "keep");
});

test("release build is reproducible, confined, installable and includes an npm README", {
  timeout: 120_000,
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const first = join(artifacts, `release path # 空格 ${nonce}`);
  const second = join(artifacts, `release repeat ${nonce}`);
  const publicAssets = join(artifacts, `release public assets ${nonce}`);
  const installRoot = await mkdtemp(join(tmpdir(), "npc-release-install-"));
  t.after(async () => {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
      rm(publicAssets, { recursive: true, force: true }),
      rm(installRoot, { recursive: true, force: true }),
    ]);
  });

  await mkdir(first, { recursive: true });
  const built = await buildAgentRelease({ output: first, conformance: false });
  const repeated = await buildAgentRelease({ output: second, conformance: false });
  assert.equal(built.manifest.schema, "npc-agent-release-manifest/1");
  assert.deepEqual(built.manifest.suite, { name: "npc-moneyhand", version: "1.2.0" });
  assert.equal(built.manifest.packages.length, 1);
  assert.equal(built.manifest.packages[0].package, "npc-moneyhand");
  assert.equal(built.manifest.packages[0].version, "1.2.0");
  assert.equal(built.manifest.extension.version, "1.2.0");
  assert.equal(built.manifest.extension.versionName, "1.2.0");
  assert.equal(
    built.manifest.extension.archive.path,
    "npc-moneyhand-extension.zip",
  );
  assert.equal(built.manifest.runtimeExternalPackages, 0);
  assert.equal(built.manifest.lifecycleScriptsExecuted, false);
  assert.equal(
    await readFile(join(first, "SHA256SUMS.txt"), "utf8"),
    await readFile(join(second, "SHA256SUMS.txt"), "utf8"),
  );
  const owner = JSON.parse(await readFile(
    join(first, ".npc-moneyhand-release-owner.json"),
    "utf8",
  ));
  assert.equal(owner.schema, "npc-moneyhand-release-output/1");
  assert.equal(owner.output.toLowerCase(), resolve(first).toLowerCase());

  await writeFile(join(first, "owned-sentinel.txt"), "replace", "utf8");
  const rebuilt = await buildAgentRelease({ output: first, conformance: false });
  assert.equal(rebuilt.manifest.schema, "npc-agent-release-manifest/1");
  await assert.rejects(access(join(first, "owned-sentinel.txt")));
  assert.equal(
    await readFile(join(first, "SHA256SUMS.txt"), "utf8"),
    await readFile(join(second, "SHA256SUMS.txt"), "utf8"),
  );

  const checksumLines = (await readFile(join(first, "SHA256SUMS.txt"), "utf8"))
    .trim().split(/\r?\n/u);
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    assert.equal(await hash(fromPortable(first, match[2])), match[1], match[2]);
    assert.equal(match[2].includes("/"), false, "public checksum targets must be flat assets");
  }
  assert.ok(built.manifest.packages.every((entry) => !entry.path.includes("/")));
  assert.ok(!built.manifest.extension.archive.path.includes("/"));
  assert.deepEqual(
    (await readdir(first)).sort(),
    [
      "extension",
      ".npc-moneyhand-release-owner.json",
      ...built.manifest.packages.map((entry) => entry.path),
      built.manifest.extension.archive.path,
      "release-manifest.json",
      "SHA256SUMS.txt",
    ].sort(),
  );

  const expectedExtensionFiles = await extensionSourceFiles(join(root, "extension"));
  assert.deepEqual(
    built.manifest.extension.files.map((entry) => entry.path
      .replace(/^extension\/npc-moneyhand\//u, "")).sort(),
    expectedExtensionFiles,
  );
  const zip = await readFile(fromPortable(first, built.manifest.extension.archive.path));
  assert.deepEqual(
    storedZipEntries(zip).sort(),
    expectedExtensionFiles.map((path) => `npc-moneyhand/${path}`).sort(),
  );

  await mkdir(publicAssets, { recursive: true });
  for (const entry of await readdir(first, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(join(first, entry.name), join(publicAssets, entry.name));
  }
  const publicValidation = await validateReleaseDirectory(publicAssets);
  assert.equal(publicValidation.tarballs.length, 1);

  await writeFile(join(installRoot, "package.json"), JSON.stringify({
    name: "npc-release-install-test",
    private: true,
  }), "utf8");
  // npm 10 treats # in an absolute local tarball spec as a fragment.
  for (const entry of built.manifest.packages) {
    await copyFile(fromPortable(first, entry.path), join(installRoot, entry.path));
  }
  await npm([
    "install",
    "--ignore-scripts",
    "--offline",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    ...built.manifest.packages.map((entry) => `./${entry.path}`),
  ], installRoot);
  for (const entry of built.manifest.packages) {
    const packageRoot = join(installRoot, "node_modules", entry.package);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(packageJson.name, entry.package);
    assert.deepEqual(packageJson.dependencies ?? {}, {});
    assert.deepEqual(packageJson.optionalDependencies ?? {}, {});
    assert.deepEqual(packageJson.peerDependencies ?? {}, {});
    for (const lifecycle of ["preinstall", "install", "postinstall", "prepack", "postpack"]) {
      assert.equal(packageJson.scripts?.[lifecycle], undefined);
    }
    await assert.rejects(access(join(packageRoot, "scripts", "operator.mjs")));
  }
  assert.match(
    await readFile(join(installRoot, "node_modules", "npc-moneyhand", "README.md"), "utf8"),
    /MoneyHand Agent Skill/u,
  );
  await assert.rejects(access(join(root, "skills", "npc-moneyhand", "README.md")));
});
