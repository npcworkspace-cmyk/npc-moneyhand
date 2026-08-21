import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { discoverMoneyHand, EXTENSION_RELEASES_URL } from "./browser-discovery.mjs";

const DEFAULT_GRACE_MS = 1_000;

export class MoneyHandBrowserLaunchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MoneyHandBrowserLaunchError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function normalizedEnvironmentValue(environment, name) {
  const match = Object.entries(environment ?? {})
    .find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === "string" && match[1] ? match[1] : undefined;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function windowsExecutableNames(browserId) {
  if (browserId === "edge") return ["msedge.exe"];
  if (browserId === "brave") return ["brave.exe"];
  if (browserId === "vivaldi") return ["vivaldi.exe"];
  if (browserId.startsWith("opera")) return ["launcher.exe", "opera.exe"];
  if (browserId.startsWith("360")) return ["360chrome.exe", "360se.exe"];
  if (browserId.startsWith("qq-browser")) return ["QQBrowser.exe"];
  if (browserId === "chromium") return ["chromium.exe", "chrome.exe"];
  return ["chrome.exe"];
}

function windowsExecutableCandidates(installation, environment) {
  const names = windowsExecutableNames(installation.browserId);
  const browserParent = dirname(installation.browserRoot);
  const candidates = [];
  for (const name of names) {
    candidates.push(
      join(browserParent, "Application", name),
      join(browserParent, name),
      join(dirname(browserParent), name),
    );
  }
  const local = normalizedEnvironmentValue(environment, "LOCALAPPDATA");
  const programFiles = normalizedEnvironmentValue(environment, "PROGRAMFILES");
  const programFilesX86 = normalizedEnvironmentValue(environment, "PROGRAMFILES(X86)");
  const standard = {
    chrome: ["Google", "Chrome", "Application", "chrome.exe"],
    edge: ["Microsoft", "Edge", "Application", "msedge.exe"],
    brave: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    vivaldi: ["Vivaldi", "Application", "vivaldi.exe"],
  }[installation.browserId];
  if (standard) {
    for (const base of [local, programFiles, programFilesX86]) {
      if (base) candidates.push(join(base, ...standard));
    }
  }
  if (local && installation.browserId.startsWith("opera")) {
    candidates.push(join(local, "Programs", "Opera", "launcher.exe"));
    candidates.push(join(local, "Programs", "Opera GX", "launcher.exe"));
  }
  return unique(candidates);
}

function macExecutableCandidates(browserId) {
  const bundle = {
    chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
    edge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    chromium: "Chromium.app/Contents/MacOS/Chromium",
    brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
    vivaldi: "Vivaldi.app/Contents/MacOS/Vivaldi",
    opera: "Opera.app/Contents/MacOS/Opera",
    "opera-gx": "Opera GX.app/Contents/MacOS/Opera GX",
    "qq-browser": "QQBrowser.app/Contents/MacOS/QQBrowser",
  }[browserId];
  return bundle ? [join("/Applications", ...bundle.split("/"))] : [];
}

function linuxExecutableNames(browserId) {
  return {
    chrome: ["google-chrome", "google-chrome-stable"],
    edge: ["microsoft-edge", "microsoft-edge-stable"],
    chromium: ["chromium", "chromium-browser"],
    brave: ["brave-browser", "brave"],
    vivaldi: ["vivaldi", "vivaldi-stable"],
    opera: ["opera"],
    "opera-gx": ["opera-gx"],
    "360-browser": ["360browser"],
    "qq-browser": ["qqbrowser"],
  }[browserId] ?? [];
}

export function browserExecutableCandidates(installation, {
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  if (!installation || typeof installation !== "object") return [];
  if (platform === "win32") return windowsExecutableCandidates(installation, env);
  if (platform === "darwin") return macExecutableCandidates(installation.browserId);
  if (platform !== "linux") return [];
  const pathDirectories = String(normalizedEnvironmentValue(env, "PATH") ?? "")
    .split(delimiter)
    .filter(Boolean);
  return unique(linuxExecutableNames(installation.browserId)
    .flatMap((name) => [
      ...pathDirectories.map((directory) => join(directory, name)),
      join("/usr/bin", name),
      join("/usr/local/bin", name),
      join(homeDir, ".local", "bin", name),
    ]));
}

async function executableExists(path) {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBrowserExecutable(installation, {
  executable,
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  exists = executableExists,
} = {}) {
  if (typeof executable === "string" && executable) {
    if (!isAbsolute(executable) && platform !== "linux") {
      throw new MoneyHandBrowserLaunchError(
        "INVALID_BROWSER_EXECUTABLE",
        "browser executable must be an absolute path on Windows and macOS",
      );
    }
    if (isAbsolute(executable) && !(await exists(executable))) {
      throw new MoneyHandBrowserLaunchError(
        "BROWSER_EXECUTABLE_NOT_FOUND",
        `Browser executable does not exist: ${executable}`,
      );
    }
    return executable;
  }
  for (const candidate of browserExecutableCandidates(installation, { platform, env, homeDir })) {
    if (await exists(candidate)) return candidate;
  }
  throw new MoneyHandBrowserLaunchError(
    "BROWSER_EXECUTABLE_NOT_FOUND",
    `Could not locate an executable for ${installation.browserId ?? "Chromium"}`,
    { browserRoot: installation.browserRoot },
  );
}

export function selectLaunchInstallation(report, { browserRoot, profileDirectory } = {}) {
  const candidates = [
    ...(Array.isArray(report?.installations) ? report.installations : []),
    ...(Array.isArray(report?.unverifiedCandidates) ? report.unverifiedCandidates : []),
  ].filter((candidate) => candidate?.configurationState !== "disabled")
    .filter((candidate) => browserRoot === undefined || candidate.browserRoot === browserRoot)
    .filter((candidate) => profileDirectory === undefined
      || candidate.profileDirectory === profileDirectory)
    .sort((left, right) => (
      Number(right.configurationState === "enabled") - Number(left.configurationState === "enabled")
      || Number(right.verified === true) - Number(left.verified === true)
      || String(left.browserId).localeCompare(String(right.browserId), "en")
      || String(left.profileDirectory).localeCompare(String(right.profileDirectory), "en")
    ));
  return candidates[0];
}

export function launchChromiumProfile({
  executable,
  browserRoot,
  profileDirectory,
  url = "about:blank",
  spawnProcess = spawn,
} = {}) {
  const child = spawnProcess(executable, [
    `--user-data-dir=${browserRoot}`,
    `--profile-directory=${profileDirectory}`,
    "--new-window",
    url,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  // A browser can disappear between the executable check and spawn. Keep that
  // asynchronous error from crashing the Agent; the bounded handshake wait
  // will report the connection failure on the normal command path.
  child.once?.("error", () => {});
  child.unref?.();
  return { pid: Number.isInteger(child.pid) ? child.pid : null };
}

export async function ensureMoneyHandConnection({
  moneyhand,
  timeoutMs = 60_000,
  graceMs = DEFAULT_GRACE_MS,
  signal,
  browserRoot,
  profileDirectory,
  browserExecutable,
  discovery = discoverMoneyHand,
  launch = launchChromiumProfile,
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  if (!moneyhand || typeof moneyhand.wait !== "function") {
    throw new MoneyHandBrowserLaunchError(
      "INVALID_CONTROLLER",
      "ensureMoneyHandConnection requires a started MoneyHand controller",
    );
  }
  const startedAt = Date.now();
  const initialWait = Math.max(0, Math.min(timeoutMs, graceMs));
  if (initialWait > 0) {
    try {
      const session = await moneyhand.wait({ timeoutMs: initialWait, signal });
      return { session, launched: false, browser: null };
    } catch (error) {
      if (error?.code !== "TIMEOUT") throw error;
    }
  }

  const report = await discovery({
    ...(browserRoot === undefined ? {} : { browserRoots: [browserRoot] }),
  });
  const installation = selectLaunchInstallation(report, { browserRoot, profileDirectory });
  if (!installation) {
    throw new MoneyHandBrowserLaunchError(
      "MONEYHAND_EXTENSION_NOT_FOUND",
      `MoneyHand is not installed in an enabled Chromium Profile. Download the extension ZIP from ${EXTENSION_RELEASES_URL}`,
      { releasesUrl: EXTENSION_RELEASES_URL },
    );
  }
  const resolvedExecutable = await resolveBrowserExecutable(installation, {
    executable: browserExecutable,
    platform,
    env,
    homeDir,
  });
  const bootstrapMarker = `about:blank#npc-moneyhand-bootstrap=${randomUUID()}`;
  const processResult = launch({
    executable: resolvedExecutable,
    browserRoot: installation.browserRoot,
    profileDirectory: installation.profileDirectory,
    url: bootstrapMarker,
  });
  const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const session = await moneyhand.wait({ timeoutMs: remaining, signal });
  return {
    session,
    launched: true,
    browser: {
      browserId: installation.browserId,
      browserRoot: installation.browserRoot,
      profileDirectory: installation.profileDirectory,
      executable: resolvedExecutable,
      pid: processResult?.pid ?? null,
      bootstrapMarker,
    },
  };
}
