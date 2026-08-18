import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserExecutableCandidates,
  ensureMoneyHandConnection,
  selectLaunchInstallation,
} from "../skills/npc-moneyhand/scripts/lib/browser-launch.mjs";

test("connection reuses a live extension without scanning or launching a browser", async () => {
  let discoveryCalls = 0;
  let launchCalls = 0;
  const session = { instanceId: "live", bootId: "boot" };
  const result = await ensureMoneyHandConnection({
    moneyhand: { wait: async () => session },
    timeoutMs: 1_000,
    discovery: async () => {
      discoveryCalls += 1;
      return {};
    },
    launch: () => {
      launchCalls += 1;
    },
  });

  assert.deepEqual(result, { session, launched: false, browser: null });
  assert.equal(discoveryCalls, 0);
  assert.equal(launchCalls, 0);
});

test("connection accepts a compatible non-disabled installation and auto-opens its Profile", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "npc-moneyhand-browser-launch-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const executable = join(temporary, process.platform === "win32" ? "browser.exe" : "browser");
  await writeFile(executable, "fixture", "utf8");
  await chmod(executable, 0o755);
  const waits = [
    Object.assign(new Error("not connected"), { code: "TIMEOUT" }),
    { instanceId: "connected", bootId: "boot-2" },
  ];
  const launched = [];
  const result = await ensureMoneyHandConnection({
    moneyhand: {
      wait: async () => {
        const next = waits.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    timeoutMs: 3_000,
    graceMs: 1,
    browserExecutable: executable,
    discovery: async () => ({
      installations: [],
      unverifiedCandidates: [{
        browserId: "chrome",
        browserRoot: join(temporary, "User Data"),
        profileDirectory: "Profile 2",
        configurationState: "enabled",
        verified: false,
      }],
    }),
    launch: (options) => {
      launched.push(options);
      return { pid: 77 };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(result.session.instanceId, "connected");
  assert.equal(result.browser.profileDirectory, "Profile 2");
  assert.equal(result.browser.pid, 77);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].executable, executable);
  assert.equal(launched[0].profileDirectory, "Profile 2");
});

test("launch selection ignores disabled Profiles and supports explicit Profile choice", () => {
  const report = {
    installations: [
      { browserId: "chrome", browserRoot: "root", profileDirectory: "Default", configurationState: "disabled", verified: true },
      { browserId: "chrome", browserRoot: "root", profileDirectory: "Profile 2", configurationState: "enabled", verified: true },
    ],
    unverifiedCandidates: [
      { browserId: "edge", browserRoot: "edge-root", profileDirectory: "Work", configurationState: "enabled", verified: false },
    ],
  };
  assert.equal(selectLaunchInstallation(report).profileDirectory, "Profile 2");
  assert.equal(selectLaunchInstallation(report, { profileDirectory: "Work" }).browserId, "edge");
  assert.equal(selectLaunchInstallation(report, { profileDirectory: "Default" }), undefined);
});

test("executable discovery covers Windows Chrome, Edge, 360, and QQ Browser families", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\agent\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  };
  const cases = [
    ["chrome", "chrome.exe"],
    ["edge", "msedge.exe"],
    ["360-chrome", "360chrome.exe"],
    ["qq-browser", "QQBrowser.exe"],
  ];
  for (const [browserId, filename] of cases) {
    const candidates = browserExecutableCandidates({
      browserId,
      browserRoot: `C:\\Browser\\${browserId}\\User Data`,
    }, { platform: "win32", env });
    assert.ok(candidates.some((candidate) => candidate.endsWith(filename)), browserId);
  }
});
