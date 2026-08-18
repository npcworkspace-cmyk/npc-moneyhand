import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BROWSER_DISCOVERY_SCHEMA,
  discoverMoneyHand,
  discoveryLimits,
  EXTENSION_INTEGRITY_SCHEMA,
  knownChromiumBrowserRoots,
  validateBrowserRootPath,
} from "../skills/npc-moneyhand/scripts/lib/browser-discovery.mjs";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const PRIVATE_PROFILE_NAME = "do-not-return-profile-name";
const PRIVATE_EMAIL = "do-not-return@example.invalid";
const PRIVATE_BROWSING_SENTINEL = "do-not-read-browser-data";
const EXTENSION_SOURCE = resolve("extension");
const INTEGRITY_SOURCE = resolve(
  "skills/npc-moneyhand/references/extension-integrity.json",
);

async function createExtension(directory, { complete = true, version = "1.0.0" } = {}) {
  if (complete) {
    await cp(EXTENSION_SOURCE, directory, { recursive: true });
    return;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "npc-moneyhand",
    version,
    version_name: version,
    permissions: ["alarms", "debugger", "downloads", "storage", "tabs", "windows"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_popup: "popup.html" },
  }), "utf8");
}

async function copyIntegrityReference(skillRoot) {
  const destination = join(skillRoot, "references", "extension-integrity.json");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await cp(INTEGRITY_SOURCE, destination);
}

async function extensionFiles(directory, prefix = "") {
  const files = [];
  for (const candidate of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${candidate.name}` : candidate.name;
    if (candidate.isDirectory()) {
      files.push(...await extensionFiles(join(directory, candidate.name), relativePath));
    } else if (candidate.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function extensionIdFromIndex(index) {
  return index.toString(16).padStart(32, "0").replace(/[0-9a-f]/gu, (digit) => (
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))
  ));
}

function syntheticCatalog(root, overrides = {}) {
  return [{
    id: "synthetic",
    name: "Synthetic Chromium",
    family: "chromium",
    root,
    source: "known",
    ...overrides,
  }];
}

test("known root catalog covers requested Chromium families on Windows, macOS, and Linux", () => {
  const windows = knownChromiumBrowserRoots({
    platform: "win32",
    homeDir: "C:\\Users\\person",
    env: { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming" },
  });
  const mac = knownChromiumBrowserRoots({
    platform: "darwin",
    homeDir: "/Users/person",
    env: {},
  });
  const linux = knownChromiumBrowserRoots({
    platform: "linux",
    homeDir: "/home/person",
    env: { XDG_CONFIG_HOME: "/cfg" },
  });

  for (const catalog of [windows, mac, linux]) {
    const families = new Set(catalog.map((browser) => browser.family));
    for (const family of ["chrome", "edge", "chromium", "brave", "vivaldi", "opera"]) {
      assert.ok(families.has(family), `${family} missing from injected catalog`);
    }
    assert.ok(catalog.every((browser) => typeof browser.root === "string" && browser.root));
  }
  assert.ok(windows.some((browser) => browser.family === "360"));
  assert.ok(windows.some((browser) => browser.family === "qq-browser"));
  assert.ok(mac.some((browser) => browser.root.includes("Library/Application Support")));
  assert.ok(linux.some((browser) => browser.root.startsWith("/cfg/")));
});

test("fixed integrity reference covers the complete 24-file extension tree", async () => {
  const reference = JSON.parse(await readFile(INTEGRITY_SOURCE, "utf8"));
  assert.equal(reference.schema, EXTENSION_INTEGRITY_SCHEMA);
  assert.equal(reference.product, "npc-moneyhand");
  assert.equal(reference.version, "1.0.0");
  assert.equal(reference.algorithm, "sha256");
  assert.deepEqual(reference.coverage, {
    mode: "complete-extension-tree",
    fileCount: 24,
    excluded: [],
    generated: [],
  });
  const actualPaths = await extensionFiles(EXTENSION_SOURCE);
  assert.deepEqual(reference.files.map((file) => file.path), actualPaths);
  for (const expected of reference.files) {
    const contents = await readFile(join(EXTENSION_SOURCE, ...expected.path.split("/")));
    assert.equal(contents.length, expected.bytes, expected.path);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expected.sha256,
      expected.path,
    );
  }
});

test("Windows UNC, device, drive-relative, and POSIX network roots fail before discovery", async () => {
  const overlongRoot = `C:\\${"a".repeat(discoveryLimits.maximumBrowserRootChars)}`;
  assert.throws(
    () => validateBrowserRootPath(overlongRoot, "win32", "test root"),
    /at most 4096 characters/u,
  );
  for (const unsafe of [
    "\\\\server\\share\\User Data",
    "//server/share/User Data",
    "\\\\?\\C:\\User Data",
    "\\\\.\\C:\\User Data",
    "\\??\\C:\\User Data",
    "C:drive-relative",
  ]) {
    assert.throws(
      () => validateBrowserRootPath(unsafe, "win32", "test root"),
      /rejected Windows/u,
      unsafe,
    );
    await assert.rejects(
      discoverMoneyHand({
        platform: "win32",
        catalog: syntheticCatalog(unsafe),
        browserRoots: [],
      }),
      /rejected Windows/u,
      unsafe,
    );
  }
  for (const unsafe of [
    "C:\\safe\\NUL\\User Data",
    "C:\\safe\\CON.txt\\User Data",
    "C:\\safe\\COM1\\User Data",
    "C:\\safe\\LPT1\\User Data",
    "C:\\safe\\trailing.\\User Data",
    "C:\\safe\\trailing \\User Data",
  ]) {
    assert.throws(
      () => validateBrowserRootPath(unsafe, "win32", "test root"),
      /reserved Windows|trailing dot or space/u,
      unsafe,
    );
    await assert.rejects(
      discoverMoneyHand({
        platform: "win32",
        catalog: syntheticCatalog(unsafe),
        browserRoots: [],
      }),
      /reserved Windows|trailing dot or space/u,
      unsafe,
    );
  }
  assert.throws(
    () => knownChromiumBrowserRoots({
      platform: "win32",
      homeDir: "C:\\Users\\person",
      env: { LOCALAPPDATA: "\\\\server\\share", APPDATA: "C:\\Roaming" },
    }),
    /LOCALAPPDATA.*rejected Windows network/u,
  );
  assert.throws(
    () => knownChromiumBrowserRoots({
      platform: "win32",
      homeDir: "C:\\Users\\person",
      env: { LOCALAPPDATA: "C:\\Users\\NUL", APPDATA: "C:\\Roaming" },
    }),
    /LOCALAPPDATA.*reserved Windows/u,
  );
  assert.throws(
    () => validateBrowserRootPath("//server/share/User Data", "linux", "test root"),
    /rejected POSIX network path/u,
  );
  assert.throws(
    () => knownChromiumBrowserRoots({ platform: "darwin", homeDir: "//server/home", env: {} }),
    /rejected POSIX network path/u,
  );
  assert.throws(
    () => knownChromiumBrowserRoots({
      platform: "linux",
      homeDir: "/home/person",
      env: { XDG_CONFIG_HOME: "//server/config" },
    }),
    /rejected POSIX network path/u,
  );
});

test("packed scan uses only Local State directory keys and returns no account identity or browsing data", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand scan packed 空格 "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(profile, "Extensions", EXTENSION_ID, "1.0.0_0");
  await createExtension(extension);
  await mkdir(profile, { recursive: true });
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: PRIVATE_PROFILE_NAME,
          user_name: PRIVATE_EMAIL,
          avatar_icon: "private-avatar",
        },
        "Profile 2": { name: "must-not-escape" },
      },
    },
  }), "utf8");
  await writeFile(join(profile, "Preferences"), JSON.stringify({
    account_info: [{ email: PRIVATE_EMAIL }],
    extensions: { settings: { [EXTENSION_ID]: { state: 1 } } },
  }), "utf8");
  await Promise.all([
    writeFile(join(profile, "History"), PRIVATE_BROWSING_SENTINEL, "utf8"),
    writeFile(join(profile, "Cookies"), PRIVATE_BROWSING_SENTINEL, "utf8"),
  ]);

  const report = await discoverMoneyHand({
    platform: process.platform,
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.schema, BROWSER_DISCOVERY_SCHEMA);
  assert.equal(report.policy.readOnly, true);
  assert.equal(report.policy.startsBrowser, false);
  assert.equal(report.policy.startsListener, false);
  assert.equal(report.policy.writesFilesystem, false);
  assert.deepEqual(report.policy.excludedProfileData, [
    "cookies",
    "passwords",
    "history",
    "local-storage",
    "page-data",
  ]);
  assert.equal(report.installations.length, 1);
  assert.equal(report.installations[0].extensionId, EXTENSION_ID);
  assert.equal(report.installations[0].installType, "packed");
  assert.equal(report.installations[0].profileDirectory, "Default");
  assert.equal(report.installations[0].profilePath, profile);
  assert.equal(report.installations[0].verified, true);
  assert.equal(report.installations[0].configurationState, "enabled");
  assert.equal(report.installations[0].evidence.integrity.matched, true);
  assert.equal(report.installations[0].evidence.integrity.checkedFiles, 24);
  assert.deepEqual(report.summary.configurationStates, {
    enabled: 1,
    disabled: 0,
    unknown: 0,
  });
  assert.equal(report.summary.controllerStartEligible, true);
  assert.equal(report.summary.liveHandshakeRequired, true);
  assert.equal(report.summary.browserReady, "unknown-until-npc-moneyhand-2-handshake");
  assert.deepEqual(Object.keys(report.browsers[0].profiles[0]).sort(), [
    "configurationFiles",
    "directory",
    "path",
  ]);
  const serialized = JSON.stringify(report);
  for (const secret of [
    PRIVATE_PROFILE_NAME,
    PRIVATE_EMAIL,
    "private-avatar",
    "must-not-escape",
    PRIVATE_BROWSING_SENTINEL,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("Local State safely discovers custom Chromium profile directory basenames", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-custom-profile-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const workProfile = join(browserRoot, "Work");
  const personProfile = join(browserRoot, "Person 1");
  const extension = join(workProfile, "Extensions", EXTENSION_ID, "1.0.0_0");
  await Promise.all([
    createExtension(extension),
    mkdir(personProfile, { recursive: true }),
  ]);
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Work: {}, "Person 1": {} } },
  }), "utf8");
  await writeFile(join(workProfile, "Preferences"), JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { state: 1 } } },
  }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.scan.complete, true);
  assert.deepEqual(
    report.browsers[0].profiles.map((profile) => profile.directory),
    ["Person 1", "Work"],
  );
  assert.equal(report.installations.length, 1);
  assert.equal(report.installations[0].profileDirectory, "Work");
  assert.equal(report.installations[0].verified, true);
  assert.equal(report.summary.controllerStartEligible, true);
});

test("Preferences and Secure Preferences locate one verified unpacked extension without duplication", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-unpacked-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "Browser", "User Data");
  const profile = join(browserRoot, "Profile 1");
  const extension = join(temporary, "portable skill", "extension");
  await createExtension(extension);
  await mkdir(profile, { recursive: true });
  const settings = {
    extensions: {
      settings: {
        [EXTENSION_ID]: { path: extension, state: 1 },
      },
    },
  };
  await Promise.all([
    writeFile(join(profile, "Preferences"), JSON.stringify(settings), "utf8"),
    writeFile(join(profile, "Secure Preferences"), JSON.stringify(settings), "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 1);
  assert.equal(report.installations[0].installType, "unpacked");
  assert.deepEqual(report.installations[0].sources, ["Preferences", "Secure Preferences"]);
  assert.equal(report.installations[0].extensionPath, extension);
  assert.equal(report.installations[0].configurationState, "enabled");
});

test("Windows Preferences paths reject UNC and device namespaces without filesystem access", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-unsafe-path-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "Preferences"), JSON.stringify({
    extensions: {
      settings: {
        [EXTENSION_ID]: { path: "\\\\server.invalid\\share\\extension" },
        [extensionIdFromIndex(2)]: { path: "\\\\?\\C:\\outside\\extension" },
        [extensionIdFromIndex(3)]: { path: "C:\\outside\\NUL\\extension" },
        [extensionIdFromIndex(4)]: { path: "C:\\outside\\trailing.\\extension" },
        [extensionIdFromIndex(5)]: { path: "NUL\\extension" },
      },
    },
  }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 0);
  assert.equal(report.unverifiedCandidates.length, 0);
  assert.ok(report.warnings.some((warning) => (
    warning.code === "UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED"
  )));
  assert.ok(report.scan.incompleteReasons.includes("UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED"));
  assert.equal(report.scan.complete, false);
});

test("Windows Local State profile keys reject device aliases before profile filesystem access", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-unsafe-profile-key-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        Default: {},
        NUL: {},
        "CON.txt": {},
        "Profile 1.": {},
        "C:": {},
      },
    },
  }), "utf8");

  const report = await discoverMoneyHand({
    platform: "win32",
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  const code = "SCAN_INCOMPLETE_UNSAFE_PROFILE_DIRECTORY_SKIPPED";
  assert.ok(report.scan.incompleteReasons.includes(code));
  assert.equal(report.scan.complete, false);
  assert.deepEqual(report.browsers[0].profiles.map((candidate) => candidate.directory), ["Default"]);
});

test("a matching extension name without exact release integrity is not installed", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-unverified-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const extension = join(
    browserRoot,
    "Default",
    "Extensions",
    EXTENSION_ID,
    "1.0.0_0",
  );
  await createExtension(extension, { complete: false });

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 0);
  assert.equal(report.unverifiedCandidates.length, 1);
  assert.equal(report.unverifiedCandidates[0].verified, false);
  assert.equal(report.summary.extensionFound, false);
  assert.equal(report.summary.controllerStartEligible, false);
});

test("one modified byte fails the fixed release hash", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-tamper-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(profile, "Extensions", EXTENSION_ID, "1.0.0_0");
  await createExtension(extension);
  const popup = join(extension, "popup.js");
  await writeFile(popup, `${await readFile(popup, "utf8")} `, "utf8");
  await writeFile(join(profile, "Preferences"), JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { state: 1 } } },
  }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 0);
  assert.equal(report.unverifiedCandidates.length, 1);
  assert.equal(report.unverifiedCandidates[0].evidence.integrity.matched, false);
  assert.ok(report.unverifiedCandidates[0].evidence.integrity.mismatches.includes("popup.js"));
});

test("extra files, directories, and symlinks fail complete-tree integrity", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-extra-tree-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(profile, "Extensions", EXTENSION_ID, "1.0.0_0");
  const linkTarget = join(temporary, "link-target");
  await createExtension(extension);
  await mkdir(join(extension, "extra-dir"));
  await writeFile(join(extension, "extra.txt"), "extra", "utf8");
  await mkdir(linkTarget);
  await symlink(
    linkTarget,
    join(extension, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 0);
  const mismatches = report.unverifiedCandidates[0].evidence.integrity.mismatches;
  assert.ok(mismatches.includes("extra.txt:extra-file"));
  assert.ok(mismatches.includes("extra-dir:extra-directory"));
  assert.ok(mismatches.includes("linked:symlink"));
});

test("a missing Skill integrity reference fails every otherwise exact extension closed", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-no-integrity-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const extension = join(
    browserRoot,
    "Default",
    "Extensions",
    EXTENSION_ID,
    "1.0.0_0",
  );
  const emptySkill = join(temporary, "empty-skill");
  await createExtension(extension);
  await mkdir(emptySkill);

  const report = await discoverMoneyHand({
    skillRoot: emptySkill,
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.skill.extensionIntegrity.valid, false);
  assert.equal(report.installations.length, 0);
  assert.equal(report.unverifiedCandidates.length, 1);
  assert.ok(report.warnings.some((warning) => warning.code === "INTEGRITY_REFERENCE_INVALID"));
});

test("oversized profile metadata is skipped while bounded directory discovery still works", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-bounded-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(browserRoot, "Local State"),
    Buffer.alloc(discoveryLimits.maximumLocalStateBytes + 1, 32),
  );
  await writeFile(join(profile, "Preferences"), JSON.stringify({ extensions: { settings: {} } }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.scan.profilesScanned, 1);
  assert.ok(report.warnings.some((warning) => warning.code === "LOCAL_STATE_TOO_LARGE"));
  assert.ok(report.scan.incompleteReasons.includes("LOCAL_STATE_TOO_LARGE"));
  assert.equal(report.scan.complete, false);
});

test("oversized valid Preferences cannot hide an unpacked exact extension behind a complete scan", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-oversized-preferences-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(temporary, "exact-extension");
  await Promise.all([
    mkdir(profile, { recursive: true }),
    createExtension(extension),
  ]);
  const prefix = JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { path: extension, state: 1 } } },
    padding: "",
  });
  const preferences = `${prefix.slice(0, -2)}${"x".repeat(
    discoveryLimits.maximumPreferencesBytes,
  )}"}`;
  JSON.parse(preferences);
  await writeFile(join(profile, "Preferences"), preferences, "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.installations.length, 0);
  assert.ok(report.warnings.some((warning) => warning.code === "PREFERENCES_TOO_LARGE"));
  assert.ok(report.scan.incompleteReasons.includes("PREFERENCES_TOO_LARGE"));
  assert.equal(report.scan.complete, false);
  assert.equal(report.summary.controllerStartEligible, false);
});

test("invalid Secure Preferences makes enabled Preferences ineligible fail-closed", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-invalid-secure-preferences-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(temporary, "exact-extension");
  await Promise.all([
    mkdir(profile, { recursive: true }),
    createExtension(extension),
  ]);
  await Promise.all([
    writeFile(join(profile, "Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: extension, state: 1 } } },
    }), "utf8"),
    writeFile(join(profile, "Secure Preferences"), "invalid-json", "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.summary.enabledInstallations, 1);
  assert.equal(report.installations[0].verified, true);
  assert.ok(report.scan.incompleteReasons.includes("PREFERENCES_INVALID_JSON"));
  assert.equal(report.scan.complete, false);
  assert.equal(report.summary.controllerStartEligible, false);
  assert.equal(report.summary.controllerStartEligible, false);
  assert.equal(
    report.summary.eligibilityScope,
    "complete-scan-with-enabled-declared-integrity-match",
  );
});

test("oversized valid Secure Preferences makes an observed enabled install ineligible", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-oversized-secure-preferences-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(temporary, "exact-extension");
  await Promise.all([
    mkdir(profile, { recursive: true }),
    createExtension(extension),
  ]);
  await Promise.all([
    writeFile(join(profile, "Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: extension, state: 1 } } },
    }), "utf8"),
    writeFile(
      join(profile, "Secure Preferences"),
      `{"padding":"${"x".repeat(discoveryLimits.maximumPreferencesBytes)}"}`,
      "utf8",
    ),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.summary.enabledInstallations, 1);
  assert.equal(report.installations[0].verified, true);
  assert.ok(report.scan.incompleteReasons.includes("PREFERENCES_TOO_LARGE"));
  assert.equal(report.scan.complete, false);
  assert.equal(report.summary.controllerStartEligible, false);
});

test("profile-directory and configured-extension path lengths are bounded without echoing input", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-path-lengths-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const longProfile = "p".repeat(discoveryLimits.maximumProfileDirectoryChars + 1);
  const longExtensionPath = "e".repeat(discoveryLimits.maximumExtensionSettingPathChars + 1);
  await mkdir(profile, { recursive: true });
  await Promise.all([
    writeFile(join(browserRoot, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: {}, [longProfile]: {} } },
    }), "utf8"),
    writeFile(join(profile, "Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: longExtensionPath, state: 1 } } },
    }), "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.ok(report.scan.incompleteReasons.includes("PROFILE_DIRECTORY_TOO_LARGE"));
  assert.ok(report.scan.incompleteReasons.includes("EXTENSION_PATH_TOO_LARGE"));
  assert.equal(report.scan.complete, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(longProfile), false);
  assert.equal(serialized.includes(longExtensionPath), false);
});

test("relative configured paths that escape every allowed root are explicit incomplete diagnostics", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-relative-path-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "nested", "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "Preferences"), JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { path: "../../../../outside", state: 1 } } },
  }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  const code = process.platform === "win32"
    ? "UNSAFE_WINDOWS_EXTENSION_PATH_SKIPPED"
    : "UNSAFE_POSIX_EXTENSION_PATH_SKIPPED";
  assert.ok(report.scan.incompleteReasons.includes(code));
  assert.equal(report.scan.complete, false);
  assert.equal(report.installations.length, 0);
});

test("directory visitation is bounded across rejected Dirents and reports an incomplete scan", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-dirent-budget-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: {} } },
  }), "utf8");
  await Promise.all(Array.from(
    { length: discoveryLimits.maximumProfileDirectories },
    (_, index) => mkdir(join(browserRoot, `unrelated-${String(index).padStart(4, "0")}`)),
  ));

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  const code = "SCAN_INCOMPLETE_PROFILE_DIRECTORIES_VISIT_LIMIT_REACHED";
  assert.ok(report.warnings.some((warning) => warning.code === code));
  assert.equal(report.scan.complete, false);
  assert.ok(report.scan.incompleteReasons.includes(code));
  assert.equal(report.scan.profilesScanned, 1);
});

test("candidate budget stops before any later Profile configuration is read", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-candidate-budget-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const firstProfile = join(browserRoot, "Default");
  const laterProfile = join(browserRoot, "Profile 2");
  await mkdir(firstProfile, { recursive: true });
  await mkdir(laterProfile, { recursive: true });
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: {}, "Profile 2": {} } },
  }), "utf8");
  const settings = Object.fromEntries(Array.from(
    { length: discoveryLimits.maximumExtensionSettings },
    (_, index) => [extensionIdFromIndex(index), { path: "missing-extension" }],
  ));
  const configuration = JSON.stringify({ extensions: { settings } });
  await Promise.all([
    writeFile(join(firstProfile, "Preferences"), configuration, "utf8"),
    writeFile(join(firstProfile, "Secure Preferences"), configuration, "utf8"),
    writeFile(join(laterProfile, "Preferences"), "not-json-and-must-not-be-read", "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  const code = "SCAN_INCOMPLETE_EXTENSION_CANDIDATE_BUDGET";
  assert.ok(report.warnings.some((warning) => warning.code === code));
  assert.equal(report.scan.complete, false);
  assert.deepEqual(report.browsers[0].profiles.map((profile) => profile.directory), ["Default"]);
  assert.equal(
    report.warnings.some((warning) => (
      warning.code === "PREFERENCES_INVALID_JSON" && warning.path.includes("Profile 2")
    )),
    false,
  );
});

test("warning saturation cannot hide a later candidate-budget incomplete state", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-warning-saturation-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const invalidProfiles = Array.from({ length: 128 }, (_, index) => `Profile ${index + 1}`);
  const candidateProfile = "System Profile";
  await Promise.all([
    ...invalidProfiles.map((profile) => mkdir(join(browserRoot, profile), { recursive: true })),
    mkdir(join(browserRoot, candidateProfile), { recursive: true }),
  ]);
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: Object.fromEntries([
        ...invalidProfiles.map((profile) => [profile, {}]),
        [candidateProfile, {}],
      ]),
    },
  }), "utf8");
  await Promise.all(invalidProfiles.flatMap((profile) => [
    writeFile(join(browserRoot, profile, "Preferences"), "invalid-json", "utf8"),
    writeFile(join(browserRoot, profile, "Secure Preferences"), "invalid-json", "utf8"),
  ]));
  const settings = Object.fromEntries(Array.from(
    { length: discoveryLimits.maximumExtensionSettings },
    (_, index) => [extensionIdFromIndex(index), { path: "missing-extension" }],
  ));
  const configuration = JSON.stringify({ extensions: { settings } });
  await Promise.all([
    writeFile(join(browserRoot, candidateProfile, "Preferences"), configuration, "utf8"),
    writeFile(join(browserRoot, candidateProfile, "Secure Preferences"), configuration, "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  const code = "SCAN_INCOMPLETE_EXTENSION_CANDIDATE_BUDGET";
  assert.equal(report.warnings.length, 256);
  assert.equal(report.warnings.some((warning) => warning.code === code), false);
  assert.ok(report.scan.incompleteReasons.includes(code));
  assert.equal(report.scan.complete, false);
});

test("global byte budget refuses the next file and never parses its sentinel contents", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-read-budget-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  await mkdir(profile, { recursive: true });
  const preferences = JSON.stringify({ extensions: { settings: {} } });
  await writeFile(join(profile, "Preferences"), preferences, "utf8");
  await writeFile(
    join(profile, "Secure Preferences"),
    "sentinel-invalid-json-that-must-not-be-read",
    "utf8",
  );
  const readBudgetBytes = (await stat(INTEGRITY_SOURCE)).size
    + Buffer.byteLength(preferences);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
    readBudgetBytes,
  });
  const code = "SCAN_INCOMPLETE_TOTAL_READ_BUDGET";
  assert.ok(report.warnings.some((warning) => warning.code === code));
  assert.equal(report.scan.complete, false);
  assert.equal(report.scan.readBudget.remainingBytes, 0);
  assert.equal(report.scan.readBudget.consumedBytes, readBudgetBytes);
  assert.equal(
    report.warnings.some((warning) => warning.code === "PREFERENCES_INVALID_JSON"),
    false,
  );
  await assert.rejects(
    discoverMoneyHand({ catalog: [], readBudgetBytes: discoveryLimits.maximumTotalReadBytes + 1 }),
    /readBudgetBytes/u,
  );
});

test("preflight directs a missing extension to the separate GitHub Release asset", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-extension-acquisition-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await copyIntegrityReference(temporary);

  const report = await discoverMoneyHand({
    skillRoot: temporary,
    catalog: [],
    browserRoots: [],
  });
  assert.deepEqual(report.skill.extensionAcquisition, {
    bundled: false,
    automaticDownload: false,
    manualInstallRequired: true,
    repositoryUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand",
    releasesUrl: "https://github.com/npcworkspace-cmyk/npc-moneyhand/releases",
    assetName: "npc-moneyhand-extension-1.0.0.zip",
  });
  assert.equal(report.summary.extensionFound, false);
  assert.equal(report.summary.extensionAction, "download-from-github-release");
  assert.equal(report.summary.extensionDownloadRequired, true);
  assert.equal(report.skill.extensionIntegrity.valid, true);
});

test("enabled, disabled, and unknown extension states are counted separately", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-states-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const enabledId = extensionIdFromIndex(11);
  const disabledId = extensionIdFromIndex(12);
  const unknownId = extensionIdFromIndex(13);
  const enabledExtension = join(temporary, "enabled-extension");
  const disabledExtension = join(temporary, "disabled-extension");
  const unknownExtension = join(
    browserRoot,
    "Default",
    "Extensions",
    unknownId,
    "1.0.0_0",
  );
  await Promise.all([
    createExtension(enabledExtension),
    createExtension(disabledExtension),
    createExtension(unknownExtension),
  ]);
  await mkdir(join(browserRoot, "Profile 1"), { recursive: true });
  await mkdir(join(browserRoot, "Profile 2"), { recursive: true });
  await Promise.all([
    writeFile(join(browserRoot, "Profile 1", "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [enabledId]: { path: enabledExtension, location: 4 } } },
    }), "utf8"),
    writeFile(join(browserRoot, "Profile 2", "Secure Preferences"), JSON.stringify({
      extensions: {
        settings: {
          [disabledId]: { path: disabledExtension, location: 4, disable_reasons: [1] },
        },
      },
    }), "utf8"),
  ]);

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.deepEqual(report.summary.configurationStates, {
    enabled: 1,
    disabled: 1,
    unknown: 1,
  });
  assert.equal(report.summary.enabledInstallations, 1);
  assert.equal(report.summary.disabledInstallations, 1);
  assert.equal(report.summary.unknownInstallations, 1);
  assert.equal(report.summary.controllerStartEligible, true);
  assert.equal(report.summary.controllerStartEligible, true);
});

test("installation diagnostics are capped while observed counts and enabled priority stay exact", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-diagnostic-cap-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const verifiedExtension = join(temporary, "verified-extension");
  const unverifiedExtension = join(temporary, "unverified-extension");
  const profileCount = discoveryLimits.maximumReportedInstallations + 1;
  const profileDirectories = Array.from(
    { length: profileCount },
    (_, index) => `Profile ${index + 1}`,
  );
  await Promise.all([
    createExtension(verifiedExtension),
    createExtension(unverifiedExtension, { complete: false }),
    ...profileDirectories.map((profile) => mkdir(join(browserRoot, profile), { recursive: true })),
  ]);
  await writeFile(join(browserRoot, "Local State"), JSON.stringify({
    profile: {
      info_cache: Object.fromEntries(profileDirectories.map((profile) => [profile, {}])),
    },
  }), "utf8");
  await Promise.all(profileDirectories.map((profile, index) => writeFile(
    join(browserRoot, profile, "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          [EXTENSION_ID]: {
            path: verifiedExtension,
            state: index === 0 ? 0 : 1,
          },
          [extensionIdFromIndex(27)]: { path: unverifiedExtension, state: 1 },
        },
      },
    }),
    "utf8",
  )));

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.scan.complete, true);
  assert.equal(report.summary.observedInstallations, profileCount);
  assert.equal(report.summary.observedUnverifiedCandidates, profileCount);
  assert.equal(report.summary.verifiedInstallations, profileCount);
  assert.equal(report.summary.unverifiedCandidates, profileCount);
  assert.equal(report.installations.length, discoveryLimits.maximumReportedInstallations);
  assert.equal(
    report.unverifiedCandidates.length,
    discoveryLimits.maximumReportedUnverifiedCandidates,
  );
  assert.ok(report.installations.every((installation) => (
    installation.configurationState === "enabled"
  )));
  assert.equal(report.summary.enabledInstallations, profileCount - 1);
  assert.equal(report.summary.disabledInstallations, 1);
  assert.equal(report.summary.controllerStartEligible, true);
  assert.equal(report.summary.diagnosticsTruncated, true);
  assert.deepEqual(report.summary.diagnosticsTruncatedByType, {
    installations: true,
    unverifiedCandidates: true,
  });
});

test("an all-disabled verified installation is found but cannot start the controller", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "moneyhand-disabled-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const browserRoot = join(temporary, "User Data");
  const profile = join(browserRoot, "Default");
  const extension = join(temporary, "disabled-extension");
  await createExtension(extension);
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
    extensions: { settings: { [EXTENSION_ID]: { path: extension, state: 0 } } },
  }), "utf8");

  const report = await discoverMoneyHand({
    catalog: syntheticCatalog(browserRoot),
    browserRoots: [],
  });
  assert.equal(report.summary.extensionFound, true);
  assert.equal(report.summary.verifiedInstallations, 1);
  assert.equal(report.summary.disabledInstallations, 1);
  assert.equal(report.summary.enabledInstallations, 0);
  assert.equal(report.summary.controllerStartEligible, false);
  assert.equal(report.summary.controllerStartEligible, false);
  assert.equal(report.installations[0].configurationState, "disabled");
  assert.equal(report.summary.browserReady, "unknown-until-npc-moneyhand-2-handshake");
});

test("runtime and catalog injection simulate another OS without changing the host", async () => {
  const report = await discoverMoneyHand({
    platform: "linux",
    arch: "arm64",
    nodeVersion: "19.9.0",
    homeDir: "/home/tester",
    env: { XDG_CONFIG_HOME: "/does-not-exist/npc-moneyhand-test" },
  });
  assert.deepEqual(report.runtime, {
    platform: "linux",
    arch: "arm64",
    node: "19.9.0",
    minimumNodeMajor: 20,
    supported: false,
  });
  assert.equal(report.summary.runtimeSupported, false);
  assert.equal(report.summary.controllerStartEligible, false);
});

test("discovery implementation has no process launch, network, registry, or filesystem write primitive", async () => {
  const source = await readFile(
    "skills/npc-moneyhand/scripts/lib/browser-discovery.mjs",
    "utf8",
  );
  for (const forbidden of [
    "node:child_process",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "writeFile",
    "appendFile",
    "mkdir(",
    "rm(",
    "RegOpenKey",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
