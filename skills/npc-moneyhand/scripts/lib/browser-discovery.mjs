import { createHash } from "node:crypto";
import {
  lstat,
  open,
  opendir,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  posix,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_DISCOVERY_SCHEMA = "npc-moneyhand-browser-discovery/1";
export const MINIMUM_NODE_MAJOR = 20;
export const EXTENSION_INTEGRITY_SCHEMA = "npc-moneyhand-extension-integrity/1";
export const EXTENSION_REPOSITORY_URL = "https://github.com/npcworkspace-cmyk/npc-moneyhand";
export const EXTENSION_RELEASES_URL = `${EXTENSION_REPOSITORY_URL}/releases`;

const MAX_ROOTS = 64;
const MAX_PROFILE_DIRECTORIES = 256;
const MAX_EXTENSION_IDS = 1_024;
const MAX_EXTENSION_VERSIONS = 32;
const MAX_EXTENSION_SETTINGS = 1_024;
const MAX_TOTAL_PROFILES = 512;
const MAX_TOTAL_EXTENSION_CANDIDATES = 4_096;
const MAX_WARNINGS = 256;
const MAX_BROWSER_ROOT_CHARS = 4_096;
const MAX_PROFILE_DIRECTORY_CHARS = 255;
const MAX_EXTENSION_SETTING_PATH_CHARS = 4_096;
const MAX_REPORTED_INSTALLATIONS = 128;
const MAX_REPORTED_UNVERIFIED_CANDIDATES = 128;
const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PREFERENCES_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INTEGRITY_REFERENCE_BYTES = 128 * 1024;
const MAX_INTEGRITY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INTEGRITY_TREE_ENTRIES = 64;
const MAX_TOTAL_READ_BYTES = 256 * 1024 * 1024;
const EXPECTED_INTEGRITY_FILES = 24;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const PROFILE_DIRECTORY_PATTERN = /^(?:Default|Profile [0-9]{1,5}|Guest Profile|System Profile)$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_INVALID_SEGMENT = /[<>:"\\|?*\u0000-\u001f\u007f]/u;
const REQUIRED_PERMISSIONS = ["debugger", "storage", "tabs", "windows"];
const EXCLUDED_PROFILE_DATA = [
  "cookies",
  "passwords",
  "history",
  "local-storage",
  "page-data",
];
const DEFAULT_SKILL_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function windowsPathKind(value) {
  if (typeof value !== "string" || !value) return "invalid";
  const normalized = value.replaceAll("/", "\\");
  if (["\\\\?\\", "\\\\.\\", "\\??\\", "\\\\??\\"]
    .some((prefix) => normalized.startsWith(prefix))) return "device";
  if (normalized.startsWith("\\\\")) return "network";
  if (!/^[A-Za-z]:\\/u.test(normalized)) return "not-local-absolute";
  if (normalized.slice(3).includes(":")) return "alternate-data-stream";
  return "local-absolute";
}

function assertSafeWindowsPathSegments(value, label) {
  const normalized = value.replaceAll("/", "\\");
  const root = win32.parse(normalized).root;
  for (const segment of normalized.slice(root.length).split("\\").filter(Boolean)) {
    if (segment === "." || segment === ".." || WINDOWS_INVALID_SEGMENT.test(segment)) {
      throw new TypeError(`${label} contains an invalid Windows path segment`);
    }
    if (/[ .]$/u.test(segment)) {
      throw new TypeError(`${label} contains a Windows path segment with a trailing dot or space`);
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw new TypeError(`${label} contains a reserved Windows device-name segment`);
    }
  }
}

/** Reject Windows network and device namespaces before any filesystem call. */
export function validateBrowserRootPath(root, platform = process.platform, label = "browser root") {
  if (typeof root !== "string" || !root) throw new TypeError(`${label} must be a non-empty path`);
  if (root.length > MAX_BROWSER_ROOT_CHARS) {
    throw new TypeError(`${label} must be at most ${MAX_BROWSER_ROOT_CHARS} characters`);
  }
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    const kind = windowsPathKind(root);
    if (kind !== "local-absolute") {
      throw new TypeError(`${label} must be a local drive path; rejected Windows ${kind}: ${root}`);
    }
    assertSafeWindowsPathSegments(root, label);
  } else {
    if (root.startsWith("//")) {
      throw new TypeError(`${label} must be a local path; rejected POSIX network path: ${root}`);
    }
    if (!path.isAbsolute(root)) throw new TypeError(`${label} must be absolute: ${root}`);
  }
  const absolute = path.resolve(root);
  if (path.parse(absolute).root === absolute) {
    throw new TypeError(`${label} cannot be a filesystem root: ${root}`);
  }
  return absolute;
}

function environmentValue(environment, key) {
  const exact = environment?.[key];
  if (typeof exact === "string" && exact) return exact;
  const entry = Object.entries(environment ?? {})
    .find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
  return typeof entry?.[1] === "string" && entry[1] ? entry[1] : undefined;
}

function entry(id, name, family, root) {
  return { id, name, family, root, source: "known" };
}

/**
 * Return a bounded catalog of Chromium user-data roots. The platform, home and
 * environment inputs are injectable so callers can test every OS without
 * reading that OS or launching a browser.
 */
export function knownChromiumBrowserRoots({
  platform = process.platform,
  homeDir = homedir(),
  env = process.env,
} = {}) {
  if (platform === "win32") {
    const path = win32;
    const local = validateBrowserRootPath(
      environmentValue(env, "LOCALAPPDATA") ?? path.join(homeDir, "AppData", "Local"),
      platform,
      "LOCALAPPDATA",
    );
    const roaming = validateBrowserRootPath(
      environmentValue(env, "APPDATA") ?? path.join(homeDir, "AppData", "Roaming"),
      platform,
      "APPDATA",
    );
    return [
      entry("chrome", "Google Chrome", "chrome", path.join(local, "Google", "Chrome", "User Data")),
      entry("edge", "Microsoft Edge", "edge", path.join(local, "Microsoft", "Edge", "User Data")),
      entry("chromium", "Chromium", "chromium", path.join(local, "Chromium", "User Data")),
      entry("brave", "Brave", "brave", path.join(local, "BraveSoftware", "Brave-Browser", "User Data")),
      entry("vivaldi", "Vivaldi", "vivaldi", path.join(local, "Vivaldi", "User Data")),
      entry("opera", "Opera", "opera", path.join(roaming, "Opera Software", "Opera Stable")),
      entry("opera-gx", "Opera GX", "opera", path.join(roaming, "Opera Software", "Opera GX Stable")),
      entry("360-chrome", "360 Chromium", "360", path.join(local, "360Chrome", "Chrome", "User Data")),
      entry("360-chrome-x", "360 Chromium X", "360", path.join(local, "360ChromeX", "Chrome", "User Data")),
      entry("360-safe", "360 Safe Browser", "360", path.join(roaming, "360se6", "User Data")),
      entry("qq-browser", "QQ Browser", "qq-browser", path.join(local, "Tencent", "QQBrowser", "User Data")),
      entry("qq-browser-roaming", "QQ Browser", "qq-browser", path.join(roaming, "Tencent", "QQBrowser", "User Data")),
    ];
  }

  if (platform === "darwin") {
    const path = posix;
    if (homeDir.startsWith("//")) {
      throw new TypeError("homeDir rejected POSIX network path");
    }
    const support = path.join(homeDir, "Library", "Application Support");
    return [
      entry("chrome", "Google Chrome", "chrome", path.join(support, "Google", "Chrome")),
      entry("edge", "Microsoft Edge", "edge", path.join(support, "Microsoft Edge")),
      entry("chromium", "Chromium", "chromium", path.join(support, "Chromium")),
      entry("brave", "Brave", "brave", path.join(support, "BraveSoftware", "Brave-Browser")),
      entry("vivaldi", "Vivaldi", "vivaldi", path.join(support, "Vivaldi")),
      entry("opera", "Opera", "opera", path.join(support, "com.operasoftware.Opera")),
      entry("opera-gx", "Opera GX", "opera", path.join(support, "com.operasoftware.OperaGX")),
      entry("360-browser", "360 Browser", "360", path.join(support, "360Browser")),
      entry("qq-browser", "QQ Browser", "qq-browser", path.join(support, "Tencent", "QQBrowser")),
    ];
  }

  if (platform === "linux") {
    const path = posix;
    const configured = environmentValue(env, "XDG_CONFIG_HOME");
    if ((configured ?? homeDir).startsWith("//")) {
      throw new TypeError("XDG_CONFIG_HOME rejected POSIX network path");
    }
    const config = configured ?? path.join(homeDir, ".config");
    return [
      entry("chrome", "Google Chrome", "chrome", path.join(config, "google-chrome")),
      entry("edge", "Microsoft Edge", "edge", path.join(config, "microsoft-edge")),
      entry("chromium", "Chromium", "chromium", path.join(config, "chromium")),
      entry("brave", "Brave", "brave", path.join(config, "BraveSoftware", "Brave-Browser")),
      entry("vivaldi", "Vivaldi", "vivaldi", path.join(config, "vivaldi")),
      entry("opera", "Opera", "opera", path.join(config, "opera")),
      entry("360-browser", "360 Browser", "360", path.join(config, "360browser")),
      entry("qq-browser", "QQ Browser", "qq-browser", path.join(config, "qqbrowser")),
    ];
  }

  return [];
}

function createWarningCollector() {
  return { items: [], incompleteReasons: new Set() };
}

function warningMakesScanIncomplete(code) {
  return code === "PATH_UNREADABLE"
    || code === "SYMLINK_SKIPPED"
    || code === "INTEGRITY_REFERENCE_INVALID"
    || code === "UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED"
    || code === "UNSAFE_POSIX_EXTENSION_PATH_SKIPPED"
    || code.startsWith("SCAN_INCOMPLETE_")
    || code.endsWith("_UNREADABLE")
    || code.endsWith("_INVALID_JSON")
    || code.endsWith("_TOO_LARGE")
    || code.endsWith("_CHANGED_DURING_READ");
}

function addWarning(warnings, code, path, detail) {
  if (warningMakesScanIncomplete(code)) warnings.incompleteReasons.add(code);
  if (warnings.items.length >= MAX_WARNINGS) return;
  const warning = { code };
  if (path) warning.path = path;
  if (detail) warning.detail = detail;
  if (warnings.items.some((candidate) => candidate.code === warning.code
    && candidate.path === warning.path
    && candidate.detail === warning.detail)) return;
  warnings.items.push(warning);
}

function markIncomplete(warnings, code, path, detail) {
  warnings.incompleteReasons.add(code);
  addWarning(warnings, code, path, detail);
}

async function pathKind(path, warnings, { warn = true } = {}) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      addWarning(warnings, "SYMLINK_SKIPPED", path);
      return "symlink";
    }
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code !== "ENOENT" && warn) {
      addWarning(warnings, "PATH_UNREADABLE", path, error?.code ?? "UNKNOWN");
    }
    return "missing";
  }
}

function claimReadBudget(budget, bytes, warnings, path) {
  if (!budget) return true;
  if (budget.stop) return false;
  if (bytes > budget.readBytesRemaining) {
    budget.stop = true;
    markIncomplete(
      warnings,
      "SCAN_INCOMPLETE_TOTAL_READ_BUDGET",
      path,
      String(budget.readBytesMaximum),
    );
    return false;
  }
  budget.readBytesRemaining -= bytes;
  return true;
}

async function readBufferBounded(path, maximumBytes, warnings, purpose, budget) {
  if (budget?.stop) return undefined;
  let handle;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      addWarning(warnings, "SYMLINK_SKIPPED", path);
      return undefined;
    }
    if (!stats.isFile()) {
      addWarning(warnings, `${purpose}_UNREADABLE`, path, "not-a-file");
      return undefined;
    }
    handle = await open(path, "r");
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size > maximumBytes) {
      addWarning(warnings, `${purpose}_TOO_LARGE`, path);
      return undefined;
    }
    if (!claimReadBudget(budget, openedStats.size, warnings, path)) return undefined;
    const contents = Buffer.alloc(openedStats.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== contents.length || after.size !== openedStats.size) {
      addWarning(warnings, `${purpose}_CHANGED_DURING_READ`, path);
      return undefined;
    }
    return contents;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    addWarning(warnings, `${purpose}_UNREADABLE`, path, error?.code ?? "UNKNOWN");
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonBounded(path, maximumBytes, warnings, purpose, budget) {
  const contents = await readBufferBounded(path, maximumBytes, warnings, purpose, budget);
  if (!contents) return undefined;
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    addWarning(warnings, `${purpose}_INVALID_JSON`, path);
    return undefined;
  }
}

function validIntegrityPath(path) {
  return typeof path === "string"
    && !path.includes("\\")
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..")
    && !posix.isAbsolute(path);
}

async function loadIntegrityReference(skillRoot, warnings, budget) {
  const path = resolve(skillRoot, "references", "extension-integrity.json");
  const reference = await readJsonBounded(
    path,
    MAX_INTEGRITY_REFERENCE_BYTES,
    warnings,
    "INTEGRITY_REFERENCE",
    budget,
  );
  const invalid = (detail) => {
    markIncomplete(warnings, "INTEGRITY_REFERENCE_INVALID", path, detail);
    return { valid: false, path, schema: null, version: null, files: [] };
  };
  if (!reference) return invalid("missing-or-unreadable");
  if (reference.schema !== EXTENSION_INTEGRITY_SCHEMA
    || reference.product !== "npc-moneyhand"
    || reference.version !== "1.0.0"
    || reference.algorithm !== "sha256") return invalid("identity");
  if (reference.coverage?.mode !== "complete-extension-tree"
    || reference.coverage?.fileCount !== EXPECTED_INTEGRITY_FILES
    || !Array.isArray(reference.coverage?.excluded)
    || reference.coverage.excluded.length !== 0
    || !Array.isArray(reference.coverage?.generated)
    || reference.coverage.generated.length !== 0) return invalid("coverage");
  if (!Array.isArray(reference.files)
    || reference.files.length !== EXPECTED_INTEGRITY_FILES) return invalid("file-count");

  const seen = new Set();
  for (const file of reference.files) {
    if (!file || typeof file !== "object"
      || !validIntegrityPath(file.path)
      || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || file.bytes > MAX_INTEGRITY_FILE_BYTES
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) return invalid("file-entry");
    seen.add(file.path);
  }
  if (!seen.has("manifest.json")) return invalid("manifest-missing");
  const sorted = [...seen].sort((left, right) => left.localeCompare(right, "en"));
  if (reference.files.some((file, index) => file.path !== sorted[index])) {
    return invalid("file-order");
  }
  return {
    valid: true,
    path,
    schema: reference.schema,
    version: reference.version,
    files: reference.files,
  };
}

function expectedIntegrityDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    let directory = "";
    for (const segment of segments) {
      directory = directory ? `${directory}/${segment}` : segment;
      directories.add(directory);
    }
  }
  return directories;
}

async function enumerateExtensionTree(extensionPath, integrityReference, warnings) {
  const expectedDirectories = expectedIntegrityDirectories(integrityReference.files);
  const actualFiles = new Set();
  const mismatches = [];
  const pending = [{ absolute: extensionPath, relative: "" }];
  let visited = 0;

  while (pending.length > 0) {
    const directoryPath = pending.shift();
    let directory;
    let reachedEnd = false;
    try {
      directory = await opendir(directoryPath.absolute);
      while (visited < MAX_INTEGRITY_TREE_ENTRIES) {
        const candidate = await directory.read();
        if (candidate === null) {
          reachedEnd = true;
          break;
        }
        visited += 1;
        const relativePath = directoryPath.relative
          ? `${directoryPath.relative}/${candidate.name}`
          : candidate.name;
        const candidatePath = join(directoryPath.absolute, candidate.name);
        const candidateStats = await lstat(candidatePath);
        if (candidateStats.isSymbolicLink()) {
          addWarning(
            warnings,
            "SYMLINK_SKIPPED",
            candidatePath,
          );
          mismatches.push(`${relativePath}:symlink`);
        } else if (candidateStats.isDirectory()) {
          if (expectedDirectories.has(relativePath)) {
            pending.push({
              absolute: candidatePath,
              relative: relativePath,
            });
          } else {
            mismatches.push(`${relativePath}:extra-directory`);
          }
        } else if (candidateStats.isFile()) {
          actualFiles.add(relativePath);
        } else {
          mismatches.push(`${relativePath}:unsupported-entry`);
        }
      }
      if (!reachedEnd) {
        markIncomplete(
          warnings,
          "SCAN_INCOMPLETE_EXTENSION_INTEGRITY_TREE_VISIT_LIMIT_REACHED",
          extensionPath,
          String(MAX_INTEGRITY_TREE_ENTRIES),
        );
        mismatches.push("tree-visit-budget");
      }
    } catch (error) {
      addWarning(
        warnings,
        "EXTENSION_TREE_UNREADABLE",
        directoryPath.absolute,
        error?.code ?? "UNKNOWN",
      );
      mismatches.push(`${directoryPath.relative || "."}:unreadable-directory`);
    } finally {
      try {
        await directory?.close();
      } catch (error) {
        addWarning(
          warnings,
          "EXTENSION_TREE_UNREADABLE",
          directoryPath.absolute,
          error?.code ?? "UNKNOWN",
        );
        mismatches.push(`${directoryPath.relative || "."}:close-failed`);
      }
    }
    if (!reachedEnd || visited >= MAX_INTEGRITY_TREE_ENTRIES) break;
  }

  const expectedFiles = new Set(integrityReference.files.map((file) => file.path));
  for (const path of actualFiles) {
    if (!expectedFiles.has(path)) mismatches.push(`${path}:extra-file`);
  }
  for (const path of expectedFiles) {
    if (!actualFiles.has(path)) mismatches.push(`${path}:missing-file`);
  }
  return {
    matched: mismatches.length === 0,
    actualFiles,
    mismatches: [...new Set(mismatches)].sort(),
    visited,
  };
}

async function verifyExtensionIntegrity(extensionPath, integrityReference, warnings, budget) {
  if (!integrityReference.valid) {
    return {
      matched: false,
      expectedFiles: 0,
      checkedFiles: 0,
      mismatches: ["integrity-reference"],
    };
  }
  const tree = await enumerateExtensionTree(extensionPath, integrityReference, warnings);
  const mismatches = [...tree.mismatches];
  if (!tree.matched) {
    return {
      matched: false,
      expectedFiles: integrityReference.files.length,
      checkedFiles: 0,
      visitedEntries: tree.visited,
      mismatches,
    };
  }
  let checkedFiles = 0;
  for (const expected of integrityReference.files) {
    const filePath = join(extensionPath, ...expected.path.split("/"));
    if (budget?.stop) {
      mismatches.push("total-read-budget");
      break;
    }
    const contents = await readBufferBounded(
      filePath,
      expected.bytes,
      warnings,
      "EXTENSION_INTEGRITY_FILE",
      budget,
    );
    if (!contents
      || contents.length !== expected.bytes
      || createHash("sha256").update(contents).digest("hex") !== expected.sha256) {
      mismatches.push(expected.path);
      if (budget?.stop) {
        mismatches.push("total-read-budget");
        break;
      }
      continue;
    }
    checkedFiles += 1;
  }
  return {
    matched: mismatches.length === 0 && checkedFiles === integrityReference.files.length,
    expectedFiles: integrityReference.files.length,
    checkedFiles,
    visitedEntries: tree.visited,
    mismatches,
  };
}

async function boundedDirectoryNames(path, limit, warnings, purpose, accept = () => true) {
  const names = [];
  let directory;
  let reachedEnd = false;
  try {
    directory = await opendir(path);
    for (let visited = 0; visited < limit; visited += 1) {
      const candidate = await directory.read();
      if (candidate === null) {
        reachedEnd = true;
        break;
      }
      if (!candidate.isDirectory() || !accept(candidate.name)) continue;
      names.push(candidate.name);
    }
    if (!reachedEnd) {
      markIncomplete(
        warnings,
        `SCAN_INCOMPLETE_${purpose}_VISIT_LIMIT_REACHED`,
        path,
        String(limit),
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      addWarning(warnings, `${purpose}_UNREADABLE`, path, error?.code ?? "UNKNOWN");
    }
  } finally {
    try {
      await directory?.close();
    } catch (error) {
      if (error?.code !== "ERR_DIR_CLOSED") {
        addWarning(warnings, `${purpose}_UNREADABLE`, path, error?.code ?? "UNKNOWN");
      }
    }
  }
  return names.sort((left, right) => left.localeCompare(right, "en"));
}

function isSafeProfileDirectory(value, platform) {
  if (!(typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0"))) return false;
  if (platform === "win32") {
    try {
      assertSafeWindowsPathSegments(value, "profile directory");
    } catch {
      return false;
    }
  }
  return true;
}

function normalizedKey(path, platform) {
  const absolute = (platform === "win32" ? win32 : posix).resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isPathInside(parent, candidate, platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  const pathFromParent = path.relative(path.resolve(parent), path.resolve(candidate));
  return pathFromParent === ""
    || (!pathFromParent.startsWith("..") && !path.isAbsolute(pathFromParent));
}

async function inspectMoneyHandExtension(extensionPath, warnings, integrityReference, budget) {
  if (budget?.stop) return undefined;
  if (await pathKind(extensionPath, warnings) !== "directory") return undefined;
  const manifestPath = join(extensionPath, "manifest.json");
  const manifest = await readJsonBounded(
    manifestPath,
    MAX_MANIFEST_BYTES,
    warnings,
    "EXTENSION_MANIFEST",
    budget,
  );
  if (!manifest || manifest.name !== "npc-moneyhand") return undefined;

  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const manifestChecks = {
    manifestVersion: manifest.manifest_version === 3,
    serviceWorker: manifest.background?.service_worker === "background.js"
      && manifest.background?.type === "module",
    popup: manifest.action?.default_popup === "popup.html",
    permissions: REQUIRED_PERMISSIONS.every((permission) => permissions.has(permission)),
    version: manifest.version === integrityReference.version
      && (manifest.version_name === undefined || manifest.version_name === integrityReference.version),
  };
  const integrity = await verifyExtensionIntegrity(
    extensionPath,
    integrityReference,
    warnings,
    budget,
  );
  const verified = Object.values(manifestChecks).every(Boolean)
    && integrity.matched;
  const versionName = typeof manifest.version_name === "string"
    && manifest.version_name.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(manifest.version_name)
    ? manifest.version_name
    : undefined;

  return {
    verified,
    version: versionName
      ? versionName
      : typeof manifest.version === "string" ? manifest.version : null,
    path: resolve(extensionPath),
    evidence: {
      manifest: manifestChecks,
      integrity,
    },
  };
}

function configurationStateFromSetting(setting) {
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return "unknown";
  const disableReasons = setting.disable_reasons;
  const hasDisableReasons = Array.isArray(disableReasons)
    ? disableReasons.length > 0
    : typeof disableReasons === "number"
      ? disableReasons !== 0
      : disableReasons && typeof disableReasons === "object"
        ? Object.keys(disableReasons).length > 0
        : Boolean(disableReasons);
  if (hasDisableReasons || setting.state === 0) return "disabled";
  if (setting.state === 1) return "enabled";
  if (!Object.hasOwn(setting, "state")) return "enabled";
  return "unknown";
}

function mergeConfigurationStates(states) {
  if (states.includes("disabled")) return "disabled";
  if (states.includes("enabled")) return "enabled";
  return "unknown";
}

function configuredExtensionPaths(
  setting,
  profilePath,
  browserRoot,
  platform,
  warnings,
  configurationPath,
) {
  if (typeof setting?.path !== "string" || !setting.path) return [];
  const warningCode = platform === "win32"
    ? "UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED"
    : "UNSAFE_POSIX_EXTENSION_PATH_SKIPPED";
  if (setting.path.length > MAX_EXTENSION_SETTING_PATH_CHARS) {
    addWarning(
      warnings,
      "EXTENSION_PATH_TOO_LARGE",
      configurationPath,
      String(MAX_EXTENSION_SETTING_PATH_CHARS),
    );
    return [];
  }
  if (setting.path.includes("\0")) {
    addWarning(warnings, warningCode, configurationPath, "null-byte");
    return [];
  }
  const path = platform === "win32" ? win32 : posix;
  if (path.isAbsolute(setting.path) || (platform === "win32" && /^[A-Za-z]:/u.test(setting.path))) {
    try {
      return [validateBrowserRootPath(setting.path, platform, "extension path")];
    } catch (error) {
      addWarning(
        warnings,
        warningCode,
        configurationPath,
        error?.message?.includes("device")
          ? "device"
          : error?.message?.includes("network")
            ? "network"
            : error?.message?.includes("reserved")
              ? "reserved-name"
              : error?.message?.includes("trailing") ? "trailing-dot-or-space" : "nonlocal",
      );
      return [];
    }
  }
  if (platform === "win32" && setting.path.includes(":")) {
    addWarning(
      warnings,
      "UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED",
      configurationPath,
      "alternate-data-stream-or-drive-relative",
    );
    return [];
  }
  const candidates = [...new Set([
    path.resolve(profilePath, setting.path),
    path.resolve(browserRoot, setting.path),
  ])];
  const safe = [];
  for (const candidate of candidates) {
    try {
      const validated = validateBrowserRootPath(candidate, platform, "extension path");
      if (isPathInside(profilePath, validated, platform)
        || isPathInside(browserRoot, validated, platform)) safe.push(validated);
    } catch (error) {
      addWarning(
        warnings,
        warningCode,
        configurationPath,
        error?.message?.includes("reserved")
          ? "reserved-name"
          : error?.message?.includes("trailing") ? "trailing-dot-or-space" : "relative-path-invalid",
      );
    }
  }
  const uniqueSafe = [...new Set(safe)];
  if (uniqueSafe.length === 0) {
    addWarning(warnings, warningCode, configurationPath, "relative-path-outside-browser-root");
  }
  return uniqueSafe;
}

function installTypeForPath(extensionPath, profilePath, platform) {
  return isPathInside(join(profilePath, "Extensions"), extensionPath, platform)
    ? "packed"
    : "unpacked";
}

function candidateKey(extensionId, extensionPath, platform) {
  return `${extensionId ?? "unknown"}\0${normalizedKey(extensionPath, platform)}`;
}

function compareInstallationDiagnostics(left, right) {
  const statePriority = { enabled: 0, disabled: 1, unknown: 2 };
  return (statePriority[left.configurationState] ?? 3)
    - (statePriority[right.configurationState] ?? 3)
    || left.extensionPath.localeCompare(right.extensionPath, "en")
    || left.browserRoot.localeCompare(right.browserRoot, "en")
    || left.profileDirectory.localeCompare(right.profileDirectory, "en")
    || String(left.extensionId ?? "").localeCompare(String(right.extensionId ?? ""), "en");
}

function stopForCandidateBudget(budget, warnings, path) {
  budget.stop = true;
  markIncomplete(
    warnings,
    "SCAN_INCOMPLETE_EXTENSION_CANDIDATE_BUDGET",
    path,
    String(MAX_TOTAL_EXTENSION_CANDIDATES),
  );
}

function stopForProfileBudget(budget, warnings, path) {
  budget.stop = true;
  markIncomplete(
    warnings,
    "SCAN_INCOMPLETE_PROFILE_BUDGET",
    path,
    String(MAX_TOTAL_PROFILES),
  );
}

async function scanProfile({
  browser,
  browserRoot,
  profileDirectory,
  platform,
  warnings,
  budget,
  integrityReference,
  inspectionCache,
}) {
  const profilePath = profileDirectory === "."
    ? browserRoot
    : join(browserRoot, profileDirectory);
  if (await pathKind(profilePath, warnings) !== "directory") return undefined;

  const records = new Map();
  const configuredStates = new Map();
  const configurationFiles = [];
  const inspectCandidate = async ({
    extensionId,
    extensionPath,
    source,
    installType,
    configurationState = "unknown",
  }) => {
    if (budget.extensionCandidates <= 0) {
      stopForCandidateBudget(budget, warnings, browserRoot);
      return;
    }
    budget.extensionCandidates -= 1;
    const exhaustedAfterCandidate = budget.extensionCandidates === 0;
    const inspectionKey = normalizedKey(extensionPath, platform);
    let result = inspectionCache.get(inspectionKey);
    if (result === undefined) {
      result = await inspectMoneyHandExtension(
        extensionPath,
        warnings,
        integrityReference,
        budget,
      ) ?? null;
      inspectionCache.set(inspectionKey, result);
    }
    if (!result) {
      if (exhaustedAfterCandidate) stopForCandidateBudget(budget, warnings, browserRoot);
      return;
    }
    const key = candidateKey(extensionId, result.path, platform);
    const previous = records.get(key);
    const sources = [...new Set([...(previous?.sources ?? []), source])].sort();
    const configurationStates = [
      ...(previous?._configurationStates ?? []),
      configurationState,
    ];
    records.set(key, {
      browserId: browser.id,
      browserFamily: browser.family,
      browserRoot,
      profileDirectory,
      profilePath,
      extensionId,
      version: result.version,
      extensionPath: result.path,
      installType,
      verified: result.verified,
      sources,
      _configurationStates: configurationStates,
      evidence: result.evidence,
    });
    if (exhaustedAfterCandidate) stopForCandidateBudget(budget, warnings, browserRoot);
  };

  for (const configurationFile of ["Preferences", "Secure Preferences"]) {
    const configurationPath = join(profilePath, configurationFile);
    const preferences = await readJsonBounded(
      configurationPath,
      MAX_PREFERENCES_BYTES,
      warnings,
      "PREFERENCES",
      budget,
    );
    if (budget.stop) break;
    if (!preferences) continue;
    configurationFiles.push(configurationFile);
    const settings = preferences?.extensions?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    const entries = Object.entries(settings);
    if (entries.length > MAX_EXTENSION_SETTINGS) {
      markIncomplete(
        warnings,
        "SCAN_INCOMPLETE_EXTENSION_SETTINGS_LIMIT_REACHED",
        configurationPath,
        String(MAX_EXTENSION_SETTINGS),
      );
    }
    for (const [extensionId, setting] of entries.slice(0, MAX_EXTENSION_SETTINGS)) {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) continue;
      const configurationState = configurationStateFromSetting(setting);
      configuredStates.set(extensionId, [
        ...(configuredStates.get(extensionId) ?? []),
        configurationState,
      ]);
      const configuredPaths = configuredExtensionPaths(
        setting,
        profilePath,
        browserRoot,
        platform,
        warnings,
        configurationPath,
      );
      for (const extensionPath of configuredPaths) {
        if (budget.extensionCandidates <= 0) {
          stopForCandidateBudget(budget, warnings, browserRoot);
          break;
        }
        await inspectCandidate({
          extensionId,
          extensionPath,
          source: configurationFile,
          installType: installTypeForPath(extensionPath, profilePath, platform),
          configurationState,
        });
      }
      if (budget.stop) break;
    }
    if (budget.stop) break;
  }

  const extensionsDirectory = join(profilePath, "Extensions");
  if (budget.extensionCandidates <= 0 && !budget.stop) {
    stopForCandidateBudget(budget, warnings, browserRoot);
  }
  if (!budget.stop) {
    const extensionIds = await boundedDirectoryNames(
      extensionsDirectory,
      MAX_EXTENSION_IDS,
      warnings,
      "EXTENSION_IDS",
      (name) => EXTENSION_ID_PATTERN.test(name),
    );
    for (const extensionId of extensionIds) {
      if (budget.extensionCandidates <= 0) {
        stopForCandidateBudget(budget, warnings, browserRoot);
        break;
      }
      const idPath = join(extensionsDirectory, extensionId);
      const versions = await boundedDirectoryNames(
        idPath,
        MAX_EXTENSION_VERSIONS,
        warnings,
        "EXTENSION_VERSIONS",
      );
      for (const version of versions) {
        if (budget.extensionCandidates <= 0) {
          stopForCandidateBudget(budget, warnings, browserRoot);
          break;
        }
        await inspectCandidate({
          extensionId,
          extensionPath: join(idPath, version),
          source: "Extensions",
          installType: "packed",
          configurationState: mergeConfigurationStates(configuredStates.get(extensionId) ?? []),
        });
      }
      if (budget.stop) break;
    }
  }

  const all = [...records.values()]
    .map(({ _configurationStates, ...candidate }) => ({
      ...candidate,
      configurationState: mergeConfigurationStates(_configurationStates),
    }))
    .sort((left, right) => left.extensionPath.localeCompare(right.extensionPath, "en"));
  return {
    directory: profileDirectory,
    path: profilePath,
    configurationFiles,
    verifiedInstallations: all.filter((candidate) => candidate.verified),
    unverifiedCandidates: all.filter((candidate) => !candidate.verified),
  };
}

async function discoverProfileDirectories(browserRoot, platform, warnings, budget) {
  const profiles = new Set();
  const localStatePath = join(browserRoot, "Local State");
  const localState = await readJsonBounded(
    localStatePath,
    MAX_LOCAL_STATE_BYTES,
    warnings,
    "LOCAL_STATE",
    budget,
  );
  if (budget.stop) return [];
  const infoCache = localState?.profile?.info_cache;
  if (infoCache && typeof infoCache === "object" && !Array.isArray(infoCache)) {
    for (const directory of Object.keys(infoCache).slice(0, MAX_PROFILE_DIRECTORIES)) {
      if (directory.length > MAX_PROFILE_DIRECTORY_CHARS) {
        addWarning(
          warnings,
          "PROFILE_DIRECTORY_TOO_LARGE",
          localStatePath,
          String(MAX_PROFILE_DIRECTORY_CHARS),
        );
      } else if (isSafeProfileDirectory(directory, platform)) {
        profiles.add(directory);
      } else {
        markIncomplete(
          warnings,
          "SCAN_INCOMPLETE_UNSAFE_PROFILE_DIRECTORY_SKIPPED",
          localStatePath,
          "invalid-single-segment",
        );
      }
    }
    if (Object.keys(infoCache).length > MAX_PROFILE_DIRECTORIES) {
      markIncomplete(
        warnings,
        "SCAN_INCOMPLETE_PROFILE_INFO_CACHE_LIMIT_REACHED",
        localStatePath,
        String(MAX_PROFILE_DIRECTORIES),
      );
    }
  }

  for (const directory of await boundedDirectoryNames(
    browserRoot,
    MAX_PROFILE_DIRECTORIES,
    warnings,
    "PROFILE_DIRECTORIES",
    (name) => PROFILE_DIRECTORY_PATTERN.test(name),
  )) {
    profiles.add(directory);
  }

  const rootFiles = await Promise.all([
    pathKind(join(browserRoot, "Preferences"), warnings),
    pathKind(join(browserRoot, "Secure Preferences"), warnings),
    pathKind(join(browserRoot, "Extensions"), warnings),
  ]);
  if (rootFiles.some((kind) => kind === "file" || kind === "directory")) profiles.add(".");
  return [...profiles].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeCatalog(catalog, explicitRoots, platform) {
  if (!Array.isArray(catalog)) throw new TypeError("browser catalog must be an array");
  if (!Array.isArray(explicitRoots)) throw new TypeError("browser roots must be an array");
  if (catalog.length + explicitRoots.length > MAX_ROOTS) {
    throw new RangeError(`at most ${MAX_ROOTS} browser roots may be scanned`);
  }
  const roots = [
    ...catalog.map((browser, index) => {
      if (!browser || typeof browser !== "object") {
        throw new TypeError(`browser catalog entry ${index} must be an object`);
      }
      const root = validateBrowserRootPath(browser.root, platform, "browser catalog root");
      return {
        id: typeof browser.id === "string" && browser.id ? browser.id : `browser-${index + 1}`,
        name: typeof browser.name === "string" && browser.name ? browser.name : "Chromium",
        family: typeof browser.family === "string" && browser.family
          ? browser.family
          : "custom-chromium",
        root,
        source: browser.source === "explicit" ? "explicit" : "known",
      };
    }),
    ...explicitRoots.map((root, index) => ({
      id: `custom-${index + 1}`,
      name: "Custom Chromium",
      family: "custom-chromium",
      root: validateBrowserRootPath(root, platform, "explicit browser root"),
      source: "explicit",
    })),
  ];
  const deduplicated = new Map();
  for (const browser of roots) {
    const key = normalizedKey(browser.root, platform);
    if (!deduplicated.has(key)) deduplicated.set(key, browser);
  }
  return [...deduplicated.values()];
}

/**
 * Inspect only known (or explicitly supplied) Chromium profile locations.
 * This function performs no writes, process creation, browser launch, explicit
 * network-client access, listener binding, registry scan or unrestricted
 * filesystem walk. Mapped or mounted remote filesystems are indistinguishable
 * from local paths to portable Node.js code.
 */
export async function discoverMoneyHand({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  homeDir = homedir(),
  env = process.env,
  catalog,
  browserRoots = [],
  skillRoot = DEFAULT_SKILL_ROOT,
  readBudgetBytes = MAX_TOTAL_READ_BYTES,
} = {}) {
  const warnings = createWarningCollector();
  const selectedCatalog = catalog ?? knownChromiumBrowserRoots({ platform, homeDir, env });
  const roots = normalizeCatalog(selectedCatalog, browserRoots, platform);
  if (!Number.isSafeInteger(readBudgetBytes)
    || readBudgetBytes < 1
    || readBudgetBytes > MAX_TOTAL_READ_BYTES) {
    throw new RangeError(`readBudgetBytes must be an integer from 1 to ${MAX_TOTAL_READ_BYTES}`);
  }
  const browsers = [];
  const installations = [];
  const unverifiedCandidates = [];
  const inspectionCache = new Map();
  const budget = {
    profiles: MAX_TOTAL_PROFILES,
    extensionCandidates: MAX_TOTAL_EXTENSION_CANDIDATES,
    readBytesMaximum: readBudgetBytes,
    readBytesRemaining: readBudgetBytes,
    stop: false,
  };
  const integrityReference = await loadIntegrityReference(skillRoot, warnings, budget);

  for (const browser of roots) {
    if (budget.stop) break;
    if (budget.profiles <= 0) {
      stopForProfileBudget(budget, warnings, browser.root);
      break;
    }
    if (await pathKind(browser.root, warnings) !== "directory") continue;
    const profiles = [];
    for (const profileDirectory of await discoverProfileDirectories(
      browser.root,
      platform,
      warnings,
      budget,
    )) {
      if (budget.profiles <= 0) {
        stopForProfileBudget(budget, warnings, browser.root);
        break;
      }
      budget.profiles -= 1;
      const exhaustedAfterProfile = budget.profiles === 0;
      const profile = await scanProfile({
        browser,
        browserRoot: browser.root,
        profileDirectory,
        platform,
        warnings,
        budget,
        integrityReference,
        inspectionCache,
      });
      if (!profile) {
        if (exhaustedAfterProfile && !budget.stop) {
          stopForProfileBudget(budget, warnings, browser.root);
        }
        if (budget.stop) break;
        continue;
      }
      profiles.push({
        directory: profile.directory,
        path: profile.path,
        configurationFiles: profile.configurationFiles,
      });
      installations.push(...profile.verifiedInstallations);
      unverifiedCandidates.push(...profile.unverifiedCandidates);
      if (exhaustedAfterProfile && !budget.stop) {
        stopForProfileBudget(budget, warnings, browser.root);
      }
      if (budget.stop) break;
    }
    browsers.push({ ...browser, profiles });
  }

  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  const runtimeSupported = ["win32", "darwin", "linux"].includes(platform)
    && Number.isInteger(nodeMajor)
    && nodeMajor >= MINIMUM_NODE_MAJOR;
  const configurationStates = { enabled: 0, disabled: 0, unknown: 0 };
  for (const installation of installations) {
    configurationStates[installation.configurationState] += 1;
  }
  const incompleteReasons = [...warnings.incompleteReasons].sort();
  const scanComplete = incompleteReasons.length === 0 && !budget.stop;
  const controllerStartEligible = runtimeSupported
    && scanComplete
    && configurationStates.enabled > 0;
  const extensionAction = configurationStates.enabled > 0
    ? "none"
    : installations.length === 0
      ? "download-from-github-release"
      : configurationStates.disabled > 0 && configurationStates.unknown === 0
        ? "enable-installed-extension"
        : "inspect-browser-configuration";
  const reportedInstallations = [...installations]
    .sort(compareInstallationDiagnostics)
    .slice(0, MAX_REPORTED_INSTALLATIONS);
  const reportedUnverifiedCandidates = [...unverifiedCandidates]
    .sort(compareInstallationDiagnostics)
    .slice(0, MAX_REPORTED_UNVERIFIED_CANDIDATES);
  const installationDiagnosticsTruncated = installations.length > reportedInstallations.length;
  const unverifiedDiagnosticsTruncated = unverifiedCandidates.length
    > reportedUnverifiedCandidates.length;

  return {
    schema: BROWSER_DISCOVERY_SCHEMA,
    product: "npc-moneyhand",
    runtime: {
      platform,
      arch,
      node: String(nodeVersion),
      minimumNodeMajor: MINIMUM_NODE_MAJOR,
      supported: runtimeSupported,
    },
    policy: {
      readOnly: true,
      scanScope: "known-and-explicit-chromium-user-data-roots",
      startsBrowser: false,
      startsListener: false,
      writesFilesystem: false,
      excludedProfileData: EXCLUDED_PROFILE_DATA,
    },
    skill: {
      root: resolve(skillRoot),
      controller: resolve(skillRoot, "scripts", "moneyhand.mjs"),
      extensionIntegrity: {
        path: integrityReference.path,
        schema: integrityReference.schema,
        version: integrityReference.version,
        valid: integrityReference.valid,
        files: integrityReference.files.length,
      },
      extensionAcquisition: {
        bundled: false,
        automaticDownload: false,
        manualInstallRequired: true,
        repositoryUrl: EXTENSION_REPOSITORY_URL,
        releasesUrl: EXTENSION_RELEASES_URL,
        assetName: `npc-moneyhand-extension-${integrityReference.version}.zip`,
      },
    },
    scan: {
      rootsRequested: roots.length,
      rootsFound: browsers.length,
      profilesScanned: browsers.reduce((total, browser) => total + browser.profiles.length, 0),
      readBudget: {
        maximumBytes: budget.readBytesMaximum,
        consumedBytes: budget.readBytesMaximum - budget.readBytesRemaining,
        remainingBytes: budget.readBytesRemaining,
      },
      complete: scanComplete,
      incompleteReasons,
    },
    browsers,
    installations: reportedInstallations,
    unverifiedCandidates: reportedUnverifiedCandidates,
    summary: {
      browserDataFound: browsers.length > 0,
      verifiedInstallations: installations.length,
      observedInstallations: installations.length,
      reportedInstallations: reportedInstallations.length,
      enabledInstallations: configurationStates.enabled,
      disabledInstallations: configurationStates.disabled,
      unknownInstallations: configurationStates.unknown,
      configurationStates,
      unverifiedCandidates: unverifiedCandidates.length,
      observedUnverifiedCandidates: unverifiedCandidates.length,
      reportedUnverifiedCandidates: reportedUnverifiedCandidates.length,
      diagnosticsTruncated: installationDiagnosticsTruncated || unverifiedDiagnosticsTruncated,
      diagnosticsTruncatedByType: {
        installations: installationDiagnosticsTruncated,
        unverifiedCandidates: unverifiedDiagnosticsTruncated,
      },
      extensionFound: installations.length > 0,
      runtimeSupported,
      controllerStartEligible,
      eligibilityScope: "complete-scan-with-enabled-declared-integrity-match",
      liveHandshakeRequired: true,
      browserReady: "unknown-until-npc-moneyhand-2-handshake",
      extensionAction,
      extensionDownloadRequired: installations.length === 0,
    },
    warnings: warnings.items,
  };
}

export const discoveryLimits = Object.freeze({
  maximumRoots: MAX_ROOTS,
  maximumProfileDirectories: MAX_PROFILE_DIRECTORIES,
  maximumExtensionIds: MAX_EXTENSION_IDS,
  maximumExtensionVersions: MAX_EXTENSION_VERSIONS,
  maximumExtensionSettings: MAX_EXTENSION_SETTINGS,
  maximumTotalProfiles: MAX_TOTAL_PROFILES,
  maximumTotalExtensionCandidates: MAX_TOTAL_EXTENSION_CANDIDATES,
  maximumTotalReadBytes: MAX_TOTAL_READ_BYTES,
  maximumBrowserRootChars: MAX_BROWSER_ROOT_CHARS,
  maximumProfileDirectoryChars: MAX_PROFILE_DIRECTORY_CHARS,
  maximumExtensionSettingPathChars: MAX_EXTENSION_SETTING_PATH_CHARS,
  maximumReportedInstallations: MAX_REPORTED_INSTALLATIONS,
  maximumReportedUnverifiedCandidates: MAX_REPORTED_UNVERIFIED_CANDIDATES,
  maximumIntegrityTreeEntries: MAX_INTEGRITY_TREE_ENTRIES,
  maximumLocalStateBytes: MAX_LOCAL_STATE_BYTES,
  maximumPreferencesBytes: MAX_PREFERENCES_BYTES,
  maximumManifestBytes: MAX_MANIFEST_BYTES,
});
