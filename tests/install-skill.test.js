import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installer = join(root, "scripts", "install-skill.mjs");
const source = join(root, "skills", "npc-moneyhand");
const npmInvocation = process.platform === "win32"
  ? { executable: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm.cmd"] }
  : { executable: "npm", prefix: [] };

async function invoke(...args) {
  return await run(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function invokeWithInput(script, args, input) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input, "utf8");
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

test("copy install is standalone in a path with spaces, Unicode, #, and %", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc skill #百分比 %-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "Agent Skills #50% 空格");

  const { stdout } = await invoke("--mode", "copy", "--target", skillsDirectory);
  const result = JSON.parse(stdout);
  const destination = join(skillsDirectory, "npc-moneyhand");
  assert.equal(result.changed, true);
  assert.equal(result.destination, destination);
  assert.match(await readFile(join(destination, "SKILL.md"), "utf8"), /npc-moneyhand/u);
  assert.match(await readFile(join(destination, "LICENSE"), "utf8"), /MIT License/u);
  assert.match(
    await readFile(join(destination, "assets", "disposable-task.mjs"), "utf8"),
    /export async function run/u,
  );

  const module = await import(pathToFileURL(
    join(destination, "scripts", "moneyhand.mjs"),
  ).href);
  const moneyhand = module.createMoneyHand({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 5_000,
    handshakeTimeoutMs: 500,
  });
  await moneyhand.start();
  assert.match(moneyhand.peer.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/extension$/u);
  await moneyhand.stop({ graceMs: 0 });
  assert.equal(moneyhand.peer.state, "STOPPED");

  const cli = await invokeWithInput(
    join(destination, "scripts", "moneyhand.mjs"),
    ["--once", "--internal-test-port", "0"],
    `${JSON.stringify({ id: "unicode-op", op: "状态" })}\n`,
  );
  assert.equal(cli.code, 0, cli.stderr);
  const messages = cli.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.match(
    messages.find((message) => message.id === "unicode-op").error.message,
    /状态/u,
  );
  assert.equal(messages.at(-1).event, "moneyhand.stopped");

  await assert.rejects(
    invoke("--mode", "copy", "--target", skillsDirectory),
    (error) => /Refusing to overwrite existing path/u.test(error.stderr),
  );
});

test("link install is idempotent and never replaces another path", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-link-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "skills");

  const first = JSON.parse((await invoke(
    "--mode",
    "link",
    "--target",
    skillsDirectory,
  )).stdout);
  const second = JSON.parse((await invoke(
    "--mode",
    "link",
    "--target",
    skillsDirectory,
  )).stdout);
  const destination = join(skillsDirectory, "npc-moneyhand");
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.equal(await realpath(destination), await realpath(source));

  const occupiedRoot = join(temporary, "occupied");
  const occupied = join(occupiedRoot, "npc-moneyhand");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "sentinel.txt"), "keep", "utf8");
  await assert.rejects(
    invoke("--mode", "link", "--target", occupiedRoot),
    (error) => /Refusing to overwrite existing path/u.test(error.stderr),
  );
  assert.equal(await readFile(join(occupied, "sentinel.txt"), "utf8"), "keep");
  await assert.rejects(
    invoke("--mode", "link", "--target", join(source, "nested-skills")),
    (error) => /inside its own source directory/u.test(error.stderr),
  );
});

test("copy Skill lifecycle is inspectable, recoverable, and refuses unknown paths", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-lifecycle-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "Agent Skills 生命周期");
  const destination = join(skillsDirectory, "npc-moneyhand");

  await invoke("--mode", "copy", "--target", skillsDirectory);
  const initial = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(initial.installed, true);
  assert.equal(initial.managed, true);
  assert.equal(initial.mode, "copy");
  assert.match(initial.installId, /^[0-9a-f-]{36}$/iu);
  assert.deepEqual(initial.recoverable, []);
  const marker = JSON.parse(await readFile(
    join(destination, ".npc-skill-install.json"),
    "utf8",
  ));
  assert.equal(marker.schema, "npc-agent-skill-install/1");
  assert.equal(marker.skill, "npc-moneyhand");
  assert.equal(marker.installId, initial.installId);

  const installedSkill = await readFile(join(destination, "SKILL.md"), "utf8");
  await writeFile(join(destination, "SKILL.md"), `${installedSkill}\nlocal-update-marker\n`, "utf8");
  const foreignStaging = join(skillsDirectory, ".npc-moneyhand.staging-collision");
  await mkdir(foreignStaging);
  await writeFile(join(foreignStaging, "sentinel.txt"), "keep", "utf8");
  const updated = JSON.parse((await invoke(
    "--action",
    "update",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(updated.changed, true);
  assert.equal(updated.mode, "copy");
  assert.equal(updated.installId, initial.installId);
  assert.doesNotMatch(await readFile(join(destination, "SKILL.md"), "utf8"), /local-update-marker/u);
  assert.match(await readFile(join(updated.backup, "SKILL.md"), "utf8"), /local-update-marker/u);
  assert.equal(await readFile(join(foreignStaging, "sentinel.txt"), "utf8"), "keep");

  const removed = JSON.parse((await invoke(
    "--action",
    "remove",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(removed.changed, true);
  assert.equal(removed.installId, initial.installId);
  await assert.rejects(lstat(destination), /ENOENT/u);
  assert.match(await readFile(join(removed.recoverablePath, "SKILL.md"), "utf8"), /npc-moneyhand/u);

  const afterRemove = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(afterRemove.installed, false);
  assert.deepEqual(new Set(afterRemove.recoverable), new Set([
    updated.backup,
    removed.recoverablePath,
  ]));

  const restored = JSON.parse((await invoke(
    "--action",
    "rollback",
    "--backup",
    removed.recoverablePath,
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(restored.changed, true);
  assert.equal(restored.restoredFrom, removed.recoverablePath);
  assert.equal(restored.installId, initial.installId);
  assert.match(await readFile(join(destination, "SKILL.md"), "utf8"), /npc-moneyhand/u);
  await assert.rejects(
    invoke(
      "--action",
      "rollback",
      "--backup",
      updated.backup,
      "--target",
      skillsDirectory,
    ),
    (error) => /Refusing to overwrite existing path/u.test(error.stderr),
  );

  const occupiedRoot = join(temporary, "unknown");
  const occupied = join(occupiedRoot, "npc-moneyhand");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "SKILL.md"), "---\nname: npc-moneyhand\n---\n", "utf8");
  await writeFile(join(occupied, "sentinel.txt"), "keep", "utf8");
  await assert.rejects(
    invoke("--action", "remove", "--target", occupiedRoot),
    (error) => /unrecognized existing path/u.test(error.stderr),
  );
  assert.equal(await readFile(join(occupied, "sentinel.txt"), "utf8"), "keep");
});

test("dangling Skill links stay visible and fail closed for every lifecycle action", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-dangling-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "skills");
  const destination = join(skillsDirectory, "npc-moneyhand");
  const formerTarget = join(temporary, "former-source");
  await mkdir(skillsDirectory, { recursive: true });
  await mkdir(formerTarget, { recursive: true });
  await symlink(
    formerTarget,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
  await rm(formerTarget, { recursive: true, force: true });

  const status = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(status.installed, true);
  assert.equal(status.managed, false);
  assert.equal(status.mode, "link");

  for (const args of [
    ["--action", "install", "--target", skillsDirectory],
    ["--action", "remove", "--target", skillsDirectory],
    ["--action", "update", "--target", skillsDirectory],
    [
      "--action",
      "rollback",
      "--backup",
      join(skillsDirectory, ".npc-moneyhand.removed-test"),
      "--target",
      skillsDirectory,
    ],
  ]) {
    await assert.rejects(
      invoke(...args),
      (error) => /existing path|unrecognized existing path/u.test(error.stderr),
    );
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
  }
});

test("recognized legacy same-source links require explicit recoverable migration", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-legacy-link-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "skills");
  const legacyDestination = join(skillsDirectory, "npc-moneyoperator");
  const destination = join(skillsDirectory, "npc-moneyhand");
  await mkdir(skillsDirectory, { recursive: true });
  await symlink(
    source,
    legacyDestination,
    process.platform === "win32" ? "junction" : "dir",
  );

  const before = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(before.installed, false);
  assert.equal(before.legacy.installed, true);
  assert.equal(before.legacy.managed, true);
  assert.equal(before.legacy.recognition, "current-source-link");
  assert.equal(before.legacy.migrationAction, "migrate");

  await assert.rejects(
    invoke("--target", skillsDirectory),
    (error) => /run --action migrate/u.test(error.stderr),
  );
  const migrated = JSON.parse((await invoke(
    "--action",
    "migrate",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.migratedLegacy.from, legacyDestination);
  assert.equal(migrated.migratedLegacy.recognition, "current-source-link");
  assert.equal(migrated.migratedLegacy.dangling, false);
  assert.equal(await realpath(destination), await realpath(source));
  assert.equal((await lstat(migrated.migratedLegacy.recoverablePath)).isSymbolicLink(), true);
  assert.equal(
    await realpath(migrated.migratedLegacy.recoverablePath),
    await realpath(source),
  );
  await assert.rejects(lstat(legacyDestination), /ENOENT/u);
});

test("dangling retired-repository links migrate without losing the recoverable link", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-legacy-dangling-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "skills");
  const legacyDestination = join(skillsDirectory, "npc-moneyoperator");
  const retiredSource = join(root, "skills", "npc-moneyoperator");
  await mkdir(skillsDirectory, { recursive: true });
  await assert.rejects(lstat(retiredSource), /ENOENT/u);
  await symlink(
    retiredSource,
    legacyDestination,
    process.platform === "win32" ? "junction" : "dir",
  );

  const before = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(before.legacy.installed, true);
  assert.equal(before.legacy.managed, true);
  assert.equal(before.legacy.dangling, true);
  assert.equal(before.legacy.recognition, "retired-repository-source-link");

  const migrated = JSON.parse((await invoke(
    "--action",
    "migrate",
    "--mode",
    "copy",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(migrated.mode, "copy");
  assert.equal(migrated.migratedLegacy.dangling, true);
  assert.equal((await lstat(migrated.destination)).isDirectory(), true);
  assert.equal((await lstat(migrated.migratedLegacy.recoverablePath)).isSymbolicLink(), true);
  await assert.rejects(lstat(legacyDestination), /ENOENT/u);
});

test("unrecognized legacy directories are reported and never changed", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-skill-legacy-unknown-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const skillsDirectory = join(temporary, "skills");
  const legacyDestination = join(skillsDirectory, "npc-moneyoperator");
  const destination = join(skillsDirectory, "npc-moneyhand");
  await mkdir(legacyDestination, { recursive: true });
  await writeFile(join(legacyDestination, "sentinel.txt"), "keep", "utf8");

  const before = JSON.parse((await invoke(
    "--action",
    "status",
    "--target",
    skillsDirectory,
  )).stdout);
  assert.equal(before.legacy.installed, true);
  assert.equal(before.legacy.managed, false);
  assert.equal(before.legacy.mode, "copy");
  assert.equal(before.legacy.migrationAction, null);

  for (const args of [
    ["--action", "install", "--target", skillsDirectory],
    ["--action", "migrate", "--target", skillsDirectory],
  ]) {
    await assert.rejects(
      invoke(...args),
      (error) => /Retired Skill path is unrecognized/u.test(error.stderr),
    );
  }
  assert.equal(await readFile(join(legacyDestination, "sentinel.txt"), "utf8"), "keep");
  await assert.rejects(lstat(destination), /ENOENT/u);
});

test("installer exposes only the unified MoneyHand Skill", async () => {
  await assert.rejects(
    invoke("--skill", "unknown-skill"),
    (error) => /Unknown option '--skill'/u.test(error.stderr),
  );
});

test("MoneyHand packs as one standalone zero-dependency Skill package", async () => {
  const { stdout } = await run(npmInvocation.executable, [
    ...npmInvocation.prefix,
    "pack",
    "--dry-run",
    "--json",
  ], {
    cwd: source,
    encoding: "utf8",
    windowsHide: true,
  });
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.name, "npc-moneyhand");
  assert.deepEqual(packed.bundled, []);
  const paths = new Set(packed.files.map((file) => file.path.replaceAll("\\\\", "/")));
  for (const path of [
    "SKILL.md",
    "scripts/moneyhand.mjs",
    "scripts/lib/rate-control.mjs",
    "references/agent-operations.json",
    "references/moneyhand-contract.json",
  ]) {
    assert.ok(paths.has(path), `npc-moneyhand missing ${path}`);
  }
  assert.equal(paths.has("scripts/operator.mjs"), false);
});

test("fresh npm project imports and runs the packaged MoneyHand Skill", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-moneyhand-package-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(join(temporary, "package.json"), JSON.stringify({
    name: "npc-moneyhand-package-test",
    private: true,
    type: "module",
  }), "utf8");

  const { stdout } = await run(npmInvocation.executable, [
    ...npmInvocation.prefix,
    "pack",
    "--json",
    "--pack-destination",
    temporary,
  ], {
    cwd: source,
    encoding: "utf8",
    windowsHide: true,
  });
  const [packed] = JSON.parse(stdout);
  const tarball = join(temporary, packed.filename);
  await run(npmInvocation.executable, [
    ...npmInvocation.prefix,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], {
    cwd: temporary,
    encoding: "utf8",
    windowsHide: true,
  });

  const bin = join(
    temporary,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "moneyhand.cmd" : "moneyhand",
  );
  const binEntry = await lstat(bin);
  assert.equal(binEntry.isFile() || binEntry.isSymbolicLink(), true);
  const version = await run(bin, ["--version"], {
    cwd: temporary,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  assert.equal(version.stdout.trim(), "npc-moneyhand-control/1");

  const imported = await run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'const hand = await import("npc-moneyhand");',
      "const controller = hand.createMoneyHand({ host: '127.0.0.1', port: 0 });",
      "process.stdout.write(controller.capabilities().protocol);",
    ].join("\n"),
  ], {
    cwd: temporary,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(imported.stdout, "npc-moneyhand-control/1");
});

test("packaged Agent conformance is a cleanup-bound Python black-box gate", async () => {
  const acceptance = await readFile("scripts/packaged-agent-conformance.mjs", "utf8");
  assert.match(acceptance, /npc-packaged-agent-conformance/u);
  assert.match(acceptance, /"--ignore-scripts"/u);
  assert.match(acceptance, /agent-jsonl-conformance\.py/u);
  assert.match(acceptance, /join\(installedRoot, product\.script\)/u);
  assert.match(acceptance, /runtimeDependencies\(packageJson\)/u);
  assert.match(acceptance, /await rm\(temporary, \{ recursive: true, force: true \}\)/u);
  assert.doesNotMatch(acceptance, /shell:\s*true/u);
});
