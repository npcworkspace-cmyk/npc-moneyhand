import { existsSync, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "npc-moneyhand";
const SKILL_SOURCE = resolve(fileURLToPath(new URL("../skills/npc-moneyhand", import.meta.url)));
const LEGACY_SKILL_NAME = "npc-moneyoperator";
const LEGACY_SKILL_SOURCE = resolve(fileURLToPath(
  new URL("../skills/npc-moneyoperator", import.meta.url),
));
const INSTALL_MARKER = ".npc-skill-install.json";
const INSTALL_MARKER_SCHEMA = "npc-agent-skill-install/1";

function usage() {
  return [
    "Manage npc-moneyhand in an Agent skills directory.",
    "",
    "Usage:",
    "  node scripts/install-skill.mjs [--action install|status|update|remove|rollback|migrate]",
    "    [--mode link|copy] [--target <skills-directory>]",
    "    [--backup <recoverable-path>]",
    "",
    "Defaults:",
    "  --action install",
    "  --mode link (install); preserve current mode (update)",
    "  --target $NPC_AGENT_SKILLS_DIR",
    "           or $CODEX_HOME/skills",
    "           or ~/.codex/skills",
    "",
    "Use --target for any Agent that supports Agent Skills. Install never",
    "overwrites an existing path. Update stages the new copy and keeps the old",
    "installation as a backup. Remove renames the installation instead of",
    "deleting it. Rollback requires the exact backup path returned earlier.",
    "Migrate replaces only a recognized legacy npc-moneyoperator link and",
    "keeps that link at the recoverable path returned in the result.",
    "Link mode uses a directory symlink on POSIX and a junction on Windows;",
    "copy mode creates a standalone Skill directory.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { action: "install" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!["--action", "--backup", "--mode", "--target"].includes(flag)) {
      throw new Error(`Unknown option '${flag}'`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected a value after '${flag}'`);
    }
    index += 1;
    if (flag === "--action") options.action = value;
    else if (flag === "--backup") options.backup = value;
    else if (flag === "--mode") options.mode = value;
    else options.target = value;
  }
  if (!["install", "status", "update", "remove", "rollback", "migrate"].includes(options.action)) {
    throw new Error(
      "--action must be 'install', 'status', 'update', 'remove', 'rollback', or 'migrate'",
    );
  }
  if (options.mode !== undefined && !["link", "copy"].includes(options.mode)) {
    throw new Error("--mode must be 'link' or 'copy'");
  }
  if (["install", "migrate"].includes(options.action) && options.mode === undefined) {
    options.mode = "link";
  }
  if (options.action === "rollback" && !options.backup) {
    throw new Error("--action rollback requires --backup <recoverable-path>");
  }
  if (options.action !== "rollback" && options.backup) {
    throw new Error("--backup is only valid with --action rollback");
  }
  return options;
}

function defaultSkillsDirectory() {
  if (process.env.NPC_AGENT_SKILLS_DIR) {
    return process.env.NPC_AGENT_SKILLS_DIR;
  }
  if (process.env.CODEX_HOME) {
    return join(process.env.CODEX_HOME, "skills");
  }
  return join(homedir(), ".codex", "skills");
}

function sameRealPath(left, right) {
  const normalize = (value) => {
    const resolved = realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function normalizedResolvedPath(path) {
  let value = resolve(path);
  if (process.platform === "win32" && value.startsWith("\\\\?\\")) {
    value = value.slice(4);
  }
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameResolvedPath(left, right) {
  return normalizedResolvedPath(left) === normalizedResolvedPath(right);
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function pathIsInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..")
    && !isAbsolute(relation));
}

function recoverableName(skillName, kind) {
  const timestamp = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/gu, "-");
  return `.${skillName}.${kind}-${timestamp}-${process.pid}`;
}

function recoverablePrefix(skillName) {
  return new RegExp(`^\\.${skillName}\\.(?:backup|removed)-`, "u");
}

async function copiedSkillProvenance(destination, skillName) {
  try {
    const [skill, markerText] = await Promise.all([
      readFile(join(destination, "SKILL.md"), "utf8"),
      readFile(join(destination, INSTALL_MARKER), "utf8"),
    ]);
    const marker = JSON.parse(markerText);
    if (!new RegExp(`^name:\\s*${skillName}\\s*$`, "mu").test(skill)
      || marker?.schema !== INSTALL_MARKER_SCHEMA
      || marker.skill !== skillName
      || marker.mode !== "copy"
      || typeof marker.installId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(marker.installId)) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

async function inspectInstallation(destination, source, skillName) {
  const entry = lstatIfExists(destination);
  if (!entry) {
    return { installed: false, managed: false, mode: null };
  }
  if (entry.isSymbolicLink()) {
    let managed = false;
    try {
      managed = sameRealPath(destination, source);
    } catch {
      // A broken or inaccessible link is installed, but must never be replaced.
    }
    return { installed: true, managed, mode: "link" };
  }
  if (entry.isDirectory()) {
    const provenance = await copiedSkillProvenance(destination, skillName);
    return {
      installed: true,
      managed: provenance !== null,
      mode: "copy",
      installId: provenance?.installId ?? null,
    };
  }
  return { installed: true, managed: false, mode: "other" };
}

async function inspectLegacyInstallation(destination, source) {
  const entry = lstatIfExists(destination);
  if (!entry) {
    return { installed: false, managed: false, mode: null };
  }
  if (!entry.isSymbolicLink()) {
    return {
      installed: true,
      managed: false,
      mode: entry.isDirectory() ? "copy" : "other",
      recognition: null,
    };
  }

  let linkTarget = null;
  let recognition = null;
  try {
    const rawTarget = await readlink(destination);
    linkTarget = resolve(dirname(destination), rawTarget);
    if (sameResolvedPath(linkTarget, source)) {
      recognition = "current-source-link";
    } else if (sameResolvedPath(linkTarget, LEGACY_SKILL_SOURCE)) {
      recognition = "retired-repository-source-link";
    }
  } catch {
    // An unreadable link is visible but never safe to migrate automatically.
  }
  if (!recognition) {
    try {
      if (sameRealPath(destination, source)) recognition = "current-source-link";
    } catch {
      // Dangling links are recognized only by their exact lexical target above.
    }
  }
  return {
    installed: true,
    managed: recognition !== null,
    mode: "link",
    dangling: !existsSync(destination),
    linkTarget,
    recognition,
  };
}

function legacyMigrationError(legacyDestination, legacy) {
  if (!legacy.managed) {
    return new Error(
      `Retired Skill path is unrecognized and will not be changed: ${legacyDestination}`,
    );
  }
  return new Error(
    `Retired Skill path detected at ${legacyDestination}; run --action migrate to rename it recoverably`,
  );
}

async function managementContext(options) {
  const skillName = SKILL_NAME;
  const source = SKILL_SOURCE;
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`Skill source is incomplete: ${source}`);
  }
  const skillsDirectory = resolve(options.target ?? defaultSkillsDirectory());
  const destination = join(skillsDirectory, skillName);
  const legacyDestination = join(skillsDirectory, LEGACY_SKILL_NAME);
  if (pathIsInside(source, destination)) {
    throw new Error("Refusing to install the Skill inside its own source directory");
  }
  if (options.action !== "status" && options.action !== "rollback") {
    await mkdir(skillsDirectory, { recursive: true });
  }
  if (!existsSync(skillsDirectory)) {
    return { skillName, source, skillsDirectory, destination, legacyDestination };
  }
  if (pathIsInside(source, join(realpathSync.native(skillsDirectory), skillName))) {
    throw new Error("Refusing to install the Skill through a link into its own source directory");
  }
  return { skillName, source, skillsDirectory, destination, legacyDestination };
}

async function createInstallation(source, destination, mode, options = {}) {
  if (mode === "link") {
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  } else {
    const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const installId = options.installId ?? randomUUID();
    let destinationOwned = false;
    try {
      await mkdir(destination);
      destinationOwned = true;
      for (const entry of await readdir(source)) {
        await cp(join(source, entry), join(destination, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      await writeFile(join(destination, INSTALL_MARKER), `${JSON.stringify({
        schema: INSTALL_MARKER_SCHEMA,
        skill: options.skillName,
        mode: "copy",
        installId,
        sourcePackage: packageJson.name,
        sourceVersion: packageJson.version,
      }, null, 2)}\n`, "utf8");
    } catch (error) {
      if (destinationOwned) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

async function install(options) {
  const {
    skillName,
    source,
    skillsDirectory,
    destination,
    legacyDestination,
  } = await managementContext(options);

  const legacy = await inspectLegacyInstallation(legacyDestination, source);
  if (legacy.installed) throw legacyMigrationError(legacyDestination, legacy);

  const existing = lstatIfExists(destination);
  if (existing) {
    const entry = existing;
    if (options.mode === "link" && entry.isSymbolicLink() && sameRealPath(destination, source)) {
      return {
        ok: true,
        changed: false,
        skill: skillName,
        mode: "link",
        source,
        destination,
      };
    }
    throw new Error(`Refusing to overwrite existing path: ${destination}`);
  }

  const installId = options.mode === "copy" ? randomUUID() : null;
  await createInstallation(source, destination, options.mode, { skillName, installId });
  return {
    ok: true,
    changed: true,
    skill: skillName,
    mode: options.mode,
    source,
    destination,
    installId,
  };
}

async function status(options) {
  const {
    skillName,
    source,
    skillsDirectory,
    destination,
    legacyDestination,
  } = await managementContext(options);
  const [installation, legacyInstallation] = await Promise.all([
    inspectInstallation(destination, source, skillName),
    inspectLegacyInstallation(legacyDestination, source),
  ]);
  const recoverable = existsSync(skillsDirectory)
    ? (await readdir(skillsDirectory))
      .filter((name) => recoverablePrefix(skillName).test(name))
      .sort()
      .map((name) => join(skillsDirectory, name))
    : [];
  return {
    ok: true,
    changed: false,
    skill: skillName,
    source,
    destination,
    ...installation,
    recoverable,
    legacy: {
      name: LEGACY_SKILL_NAME,
      destination: legacyDestination,
      ...legacyInstallation,
      migrationAction: legacyInstallation.installed && legacyInstallation.managed
        ? "migrate"
        : null,
    },
  };
}

async function update(options) {
  const {
    skillName,
    source,
    skillsDirectory,
    destination,
    legacyDestination,
  } = await managementContext(options);
  const current = await inspectInstallation(destination, source, skillName);
  if (!current.installed) {
    const legacy = await inspectLegacyInstallation(legacyDestination, source);
    if (legacy.installed) throw legacyMigrationError(legacyDestination, legacy);
    throw new Error(`Nothing to update at ${destination}; run --action install first`);
  }
  if (!current.managed) {
    throw new Error(`Refusing to update an unrecognized existing path: ${destination}`);
  }
  const mode = options.mode ?? current.mode;
  if (mode === "link" && current.mode === "link") {
    return {
      ok: true,
      changed: false,
      skill: skillName,
      mode,
      source,
      destination,
      backup: null,
    };
  }

  const stagingRoot = await mkdtemp(join(skillsDirectory, `.${skillName}.staging-`));
  const staging = join(stagingRoot, skillName);
  const backup = join(skillsDirectory, recoverableName(skillName, "backup"));
  const nextInstallId = mode === "copy" ? (current.installId ?? randomUUID()) : null;
  try {
    await createInstallation(source, staging, mode, { skillName, installId: nextInstallId });
    await rename(destination, backup);
    try {
      await rename(staging, destination);
    } catch (error) {
      await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return {
    ok: true,
    changed: true,
    skill: skillName,
    mode,
    source,
    destination,
    backup,
    installId: nextInstallId,
  };
}

async function remove(options) {
  const {
    skillName,
    source,
    skillsDirectory,
    destination,
    legacyDestination,
  } = await managementContext(options);
  const current = await inspectInstallation(destination, source, skillName);
  if (!current.installed) {
    const legacy = await inspectLegacyInstallation(legacyDestination, source);
    if (legacy.installed) throw legacyMigrationError(legacyDestination, legacy);
    return {
      ok: true,
      changed: false,
      skill: skillName,
      source,
      destination,
      recoverablePath: null,
    };
  }
  if (!current.managed) {
    throw new Error(`Refusing to remove an unrecognized existing path: ${destination}`);
  }
  const recoverablePath = join(skillsDirectory, recoverableName(skillName, "removed"));
  await rename(destination, recoverablePath);
  return {
    ok: true,
    changed: true,
    skill: skillName,
    source,
    destination,
    recoverablePath,
    installId: current.installId ?? null,
  };
}

async function migrate(options) {
  const {
    skillName,
    source,
    skillsDirectory,
    destination,
    legacyDestination,
  } = await managementContext(options);
  if (lstatIfExists(destination)) {
    throw new Error(
      `Refusing to migrate while the unified Skill path already exists: ${destination}`,
    );
  }

  const legacy = await inspectLegacyInstallation(legacyDestination, source);
  if (!legacy.installed) {
    throw new Error(`No retired ${LEGACY_SKILL_NAME} path exists at ${legacyDestination}`);
  }
  if (!legacy.managed) throw legacyMigrationError(legacyDestination, legacy);

  const recoverablePath = join(
    skillsDirectory,
    recoverableName(LEGACY_SKILL_NAME, "removed"),
  );
  const installId = options.mode === "copy" ? randomUUID() : null;
  await rename(legacyDestination, recoverablePath);
  try {
    await createInstallation(source, destination, options.mode, { skillName, installId });
  } catch (error) {
    await rename(recoverablePath, legacyDestination);
    throw error;
  }

  return {
    ok: true,
    changed: true,
    skill: skillName,
    mode: options.mode,
    source,
    destination,
    installId,
    migratedLegacy: {
      name: LEGACY_SKILL_NAME,
      from: legacyDestination,
      recoverablePath,
      recognition: legacy.recognition,
      dangling: legacy.dangling === true,
      restoreAfterRemovingUnifiedSkill: {
        from: recoverablePath,
        to: legacyDestination,
      },
    },
  };
}

async function rollback(options) {
  const { skillName, source, skillsDirectory, destination } = await managementContext(options);
  if (lstatIfExists(destination)) {
    throw new Error(`Refusing to overwrite existing path: ${destination}`);
  }
  const backup = resolve(options.backup);
  if (dirname(backup) !== skillsDirectory || !recoverablePrefix(skillName).test(basename(backup))) {
    throw new Error(`Backup must be a ${skillName} recoverable path directly inside ${skillsDirectory}`);
  }
  const backupState = await inspectInstallation(backup, source, skillName);
  if (!backupState.installed || !backupState.managed) {
    throw new Error(`Backup is missing or is not a recognized ${skillName} Skill: ${backup}`);
  }
  await rename(backup, destination);
  return {
    ok: true,
    changed: true,
    skill: skillName,
    source,
    destination,
    restoredFrom: backup,
    installId: backupState.installId ?? null,
  };
}

async function run(options) {
  if (options.action === "status") return await status(options);
  if (options.action === "update") return await update(options);
  if (options.action === "remove") return await remove(options);
  if (options.action === "rollback") return await rollback(options);
  if (options.action === "migrate") return await migrate(options);
  return await install(options);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`Agent Skill install failed: ${error?.message ?? error}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
