import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertPortableArchivePaths,
  buildPortableSkill,
} from "../scripts/build-portable-skill.mjs";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = join(root, "artifacts");

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function filesBelow(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(join(directory, entry.name), path));
    else files.push(path);
  }
  return files.sort();
}

function storedZipFiles(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 6), 0x0800, "ZIP entries must use UTF-8 paths");
    assert.equal(buffer.readUInt16LE(offset + 8), 0, "ZIP entries must use deterministic store mode");
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(compressedSize, size);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    files.push({ name, data: buffer.subarray(dataStart, dataStart + size) });
    offset = dataStart + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "ZIP central directory is missing");
  return files;
}

function safeArchivePath(base, value) {
  assert.match(value, /^npc-moneyhand\//u);
  assert.equal(value.includes("\\"), false);
  assert.equal(isAbsolute(value), false);
  assert.equal(value.split("/").includes(".."), false);
  const destination = resolve(base, ...value.split("/"));
  const relation = relative(base, destination);
  assert.ok(relation && relation !== ".." && !relation.startsWith(`..${sep}`));
  return destination;
}

async function extractStoredZip(path, destination) {
  const files = storedZipFiles(await readFile(path));
  const seen = new Set();
  for (const file of files) {
    assert.equal(seen.has(file.name), false, `duplicate ZIP path: ${file.name}`);
    seen.add(file.name);
    const output = safeArchivePath(destination, file.name);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, file.data);
  }
  return files.map((file) => file.name).sort();
}

async function createPortableBuilderFixture(base, name) {
  const fixture = join(base, name);
  await mkdir(join(fixture, "scripts"), { recursive: true });
  await mkdir(join(fixture, "skills"), { recursive: true });
  await cp(join(root, "scripts", "build-portable-skill.mjs"), join(
    fixture,
    "scripts",
    "build-portable-skill.mjs",
  ));
  await cp(join(root, "package.json"), join(fixture, "package.json"));
  await cp(join(root, "skills", "npc-moneyhand"), join(fixture, "skills", "npc-moneyhand"), {
    recursive: true,
  });
  await cp(join(root, "extension"), join(fixture, "extension"), { recursive: true });
  return fixture;
}

async function assertFixtureBuildRejects(fixture, pattern) {
  try {
    await run(process.execPath, [join(fixture, "scripts", "build-portable-skill.mjs")], {
      cwd: fixture,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.fail("tampered Portable Skill fixture unexpectedly built");
  } catch (error) {
    assert.match(`${error?.message ?? ""}\n${error?.stderr ?? ""}`, pattern);
  }
  await assert.rejects(access(join(fixture, "artifacts")), { code: "ENOENT" });
}

test("portable archive paths reject cross-platform aliases and Windows-invalid segments", () => {
  assert.equal(assertPortableArchivePaths([
    "npc-moneyhand/SKILL.md",
    "npc-moneyhand/assets/safe # 文件.txt",
  ]), true);
  for (const paths of [
    ["npc-moneyhand/Foo.txt", "npc-moneyhand/foo.txt"],
    ["npc-moneyhand/stra\u00dfe.txt", "npc-moneyhand/STRASSE.txt"],
    ["npc-moneyhand/caf\u00e9.txt", "npc-moneyhand/cafe\u0301.txt"],
    ["npc-moneyhand/Foo/a.txt", "npc-moneyhand/foo/b.txt"],
    ["npc-moneyhand/file", "npc-moneyhand/file/child.txt"],
  ]) {
    assert.throws(
      () => assertPortableArchivePaths(paths),
      /normalization collision|path collision|file\/directory collision/u,
    );
  }
  for (const path of [
    "npc-moneyhand/CON.txt",
    "npc-moneyhand/LPT1/output.txt",
    "npc-moneyhand/trailing./file.txt",
    "npc-moneyhand/trailing /file.txt",
    "npc-moneyhand/alternate:data.txt",
    "npc-moneyhand/question?.txt",
  ]) {
    assert.throws(
      () => assertPortableArchivePaths([path]),
      /not cross-platform safe/u,
      path,
    );
  }
});

test("portable Skill output is confined and never replaces unowned or linked content", async (t) => {
  await assert.rejects(
    buildPortableSkill({ output: root }),
    /must be a child directory of repository artifacts/u,
  );
  await assert.rejects(
    buildPortableSkill({ output: artifacts }),
    /must be a child directory of repository artifacts/u,
  );
  await assert.rejects(
    buildPortableSkill({ output: join(artifacts, "..", "portable-escape") }),
    /must be a child directory of repository artifacts/u,
  );

  await mkdir(artifacts, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const unowned = join(artifacts, `portable-unowned-${nonce}`);
  await mkdir(unowned);
  await writeFile(join(unowned, "sentinel.txt"), "keep", "utf8");
  t.after(() => rm(unowned, { recursive: true, force: true }));
  await assert.rejects(
    buildPortableSkill({ output: unowned }),
    /Refusing to replace an unowned non-empty Portable Skill output/u,
  );
  assert.equal(await readFile(join(unowned, "sentinel.txt"), "utf8"), "keep");

  const external = await mkdtemp(join(tmpdir(), "npc-portable-link-boundary-"));
  const victim = join(external, "victim");
  const link = join(artifacts, `portable-link-${nonce}`);
  await mkdir(victim);
  await writeFile(join(victim, "sentinel.txt"), "keep", "utf8");
  await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  await assert.rejects(
    buildPortableSkill({ output: join(link, "victim") }),
    /cannot contain a symbolic link or junction|resolves outside/u,
  );
  assert.equal(await readFile(join(victim, "sentinel.txt"), "utf8"), "keep");
});

test("portable builder rejects extension drift or embedded source before creating artifacts", {
  timeout: 60_000,
}, async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "npc-portable-integrity-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const [tampered, missing, extra, embedded] = await Promise.all([
    createPortableBuilderFixture(fixtureRoot, "tampered"),
    createPortableBuilderFixture(fixtureRoot, "missing"),
    createPortableBuilderFixture(fixtureRoot, "extra"),
    createPortableBuilderFixture(fixtureRoot, "embedded"),
  ]);

  const tamperedCss = join(tampered, "extension", "popup.css");
  const tamperedBytes = await readFile(tamperedCss);
  tamperedBytes[0] ^= 1;
  await writeFile(tamperedCss, tamperedBytes);
  await rm(join(missing, "extension", "popup.css"));
  await writeFile(join(extra, "extension", "unexpected.js"), "export {};\n", "utf8");
  const embeddedPath = join(embedded, "skills", "npc-moneyhand", "assets", "extension");
  await mkdir(embeddedPath, { recursive: true });
  await writeFile(join(embeddedPath, "manifest.json"), "{}\n", "utf8");

  await assertFixtureBuildRejects(tampered, /integrity SHA-256 mismatch: popup\.css/u);
  await assertFixtureBuildRejects(missing, /integrity missing file: popup\.css/u);
  await assertFixtureBuildRejects(extra, /integrity unlisted file: unexpected\.js/u);
  await assertFixtureBuildRejects(
    embedded,
    /must not contain extension source or installation files/u,
  );
});

test("portable Skill ZIP is deterministic, complete and runnable from special paths", {
  timeout: 120_000,
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const first = join(artifacts, `portable path # 空格 ${nonce}`);
  const second = join(artifacts, `portable repeat ${nonce}`);
  const extraction = await mkdtemp(join(tmpdir(), "npc portable # 中文 "));
  t.after(async () => {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
      rm(extraction, { recursive: true, force: true }),
    ]);
  });

  const built = await buildPortableSkill({ output: first });
  const repeated = await buildPortableSkill({ output: second });
  assert.equal(built.schema, "npc-moneyhand-portable-skill-build/2");
  assert.equal(built.manifest.schema, "npc-moneyhand-portable-skill-manifest/2");
  assert.equal(built.manifest.name, "npc-moneyhand");
  assert.equal(built.manifest.version, "1.0.0");
  assert.equal(built.manifest.runtime.externalPackages, 0);
  assert.equal(built.manifest.reproducible, true);
  assert.equal(built.manifest.extension.bundled, false);
  assert.equal(built.manifest.extension.sourceFilesIncluded, false);
  assert.equal(built.manifest.extension.distribution, "github-release-asset");
  assert.equal(
    built.manifest.extension.repositoryUrl,
    "https://github.com/npcworkspace-cmyk/npc-moneyhand",
  );
  assert.equal(
    built.manifest.extension.releasesUrl,
    "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
  );
  assert.equal(built.manifest.extension.assetName, "npc-moneyhand-extension-1.0.0.zip");
  assert.equal(built.manifest.extension.manualInstallRequired, true);
  assert.equal(built.manifest.extension.version, "1.0.0");
  assert.equal(built.manifest.extension.versionName, "1.0.0");
  assert.equal(built.manifest.extension.manifestVersion, 3);
  assert.equal(
    built.manifest.extension.integrity.schema,
    "npc-moneyhand-extension-integrity/1",
  );
  assert.equal(built.manifest.extension.integrity.algorithm, "sha256");
  assert.equal(built.manifest.extension.integrity.fileCount, 24);
  assert.equal(await hash(built.archive), await hash(repeated.archive));
  assert.equal(
    await readFile(join(first, "portable-manifest.json"), "utf8"),
    await readFile(join(second, "portable-manifest.json"), "utf8"),
  );
  assert.equal(
    await readFile(join(first, "SHA256SUMS.txt"), "utf8"),
    await readFile(join(second, "SHA256SUMS.txt"), "utf8"),
  );
  const owner = JSON.parse(await readFile(
    join(first, ".npc-moneyhand-portable-skill-owner.json"),
    "utf8",
  ));
  assert.equal(owner.schema, "npc-moneyhand-portable-skill-output/2");
  assert.equal(owner.builder, "scripts/build-portable-skill.mjs");
  assert.match(owner.repositoryId, /^[a-f0-9]{64}$/u);
  assert.equal(owner.artifactsRelativeOutput, `portable path # 空格 ${nonce}`);
  assert.equal(Object.hasOwn(owner, "repositoryRoot"), false);
  assert.equal(Object.hasOwn(owner, "output"), false);
  for (const value of Object.values(owner).filter((entry) => typeof entry === "string")) {
    assert.equal(isAbsolute(value), false, `owner marker leaked an absolute path: ${value}`);
    assert.doesNotMatch(value, /^[a-z]:[\\/]/iu);
  }

  await writeFile(join(first, "owned-sentinel.txt"), "replace", "utf8");
  const firstHash = await hash(built.archive);
  const rebuilt = await buildPortableSkill({ output: first });
  assert.equal(await hash(rebuilt.archive), firstHash);
  await assert.rejects(access(join(first, "owned-sentinel.txt")));
  assert.deepEqual(
    (await readdir(first)).sort(),
    [
      ".npc-moneyhand-portable-skill-owner.json",
      "npc-moneyhand-portable-skill-1.0.0.zip",
      "portable-manifest.json",
      "SHA256SUMS.txt",
    ].sort(),
  );

  for (const line of (await readFile(join(first, "SHA256SUMS.txt"), "utf8")).trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    assert.equal(await hash(join(first, match[2])), match[1]);
  }

  const skillFiles = await filesBelow(join(root, "skills", "npc-moneyhand"));
  const extensionFiles = await filesBelow(join(root, "extension"));
  const expectedArchiveFiles = skillFiles
    .map((path) => `npc-moneyhand/${path}`)
    .sort();
  const archiveFiles = await extractStoredZip(rebuilt.archive, extraction);
  assert.deepEqual(archiveFiles, expectedArchiveFiles);
  assert.equal(
    archiveFiles.some((path) => path.startsWith("npc-moneyhand/assets/extension/")),
    false,
  );
  assert.deepEqual(
    built.manifest.files.map((entry) => entry.path).sort(),
    expectedArchiveFiles,
  );

  const unpacked = join(extraction, "npc-moneyhand");
  const packageJson = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));
  assert.equal(packageJson.name, "npc-moneyhand");
  assert.equal(packageJson.version, "1.0.0");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    assert.deepEqual(packageJson[field] ?? {}, {}, `${field} must stay empty`);
  }
  await assert.rejects(access(join(unpacked, "assets", "extension")), { code: "ENOENT" });
  const integrity = JSON.parse(await readFile(
    join(unpacked, "references", "extension-integrity.json"),
    "utf8",
  ));
  assert.equal(integrity.schema, "npc-moneyhand-extension-integrity/1");
  assert.equal(integrity.coverage.fileCount, extensionFiles.length);
  assert.deepEqual(integrity.coverage.excluded, []);
  assert.deepEqual(integrity.coverage.generated, []);
  assert.equal(
    built.manifest.extension.integrity.manifestSha256,
    await hash(join(unpacked, "references", "extension-integrity.json")),
  );
  assert.equal(
    built.manifest.files.some((file) => file.path.startsWith("npc-moneyhand/assets/extension/")),
    false,
  );

  const { stdout: descriptorOutput } = await run(process.execPath, [
    join(unpacked, "scripts", "moneyhand.mjs"),
    "--describe",
  ], {
    cwd: unpacked,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const descriptor = JSON.parse(descriptorOutput.trim());
  assert.equal(descriptor.schema, "npc-agent-cli-descriptor/1");
  assert.equal(descriptor.product?.package, "npc-moneyhand");

  const preflight = join(unpacked, "scripts", "preflight.mjs");
  try {
    await access(preflight);
    const { stdout: preflightOutput } = await run(process.execPath, [preflight, "--json"], {
      cwd: unpacked,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(preflightOutput);
    assert.equal(report.schema, "npc-moneyhand-preflight/1");
    assert.deepEqual(report.skill?.extensionAcquisition, {
      bundled: false,
      automaticDownload: false,
      manualInstallRequired: true,
      repositoryUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand",
      releasesUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
      assetName: "npc-moneyhand-extension-1.0.0.zip",
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  for (const file of built.manifest.files) {
    assert.equal(await hash(safeArchivePath(extraction, file.path)), file.sha256, file.path);
    assert.equal((await lstat(safeArchivePath(extraction, file.path))).size, file.bytes, file.path);
  }
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(rootPackage.scripts?.["skill:pack:portable"], "node scripts/build-portable-skill.mjs");
});
