#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  discoverMoneyHand,
  validateBrowserRootPath,
} from "./lib/browser-discovery.mjs";

const USAGE = [
  "Usage: moneyhand-preflight --json [--browser-root <absolute-user-data-root>]...",
  "",
  "Runs a bounded, read-only scan for verified npc-moneyhand Chromium extensions.",
  "It does not launch a browser, start a listener, inspect browsing data, or write files.",
].join("\n");

export function parsePreflightArgs(argv) {
  const options = { json: false, browserRoots: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    let root;
    if (argument === "--browser-root") {
      root = argv[index + 1];
      index += 1;
      if (!root) throw new TypeError("--browser-root requires an absolute path");
    } else if (argument.startsWith("--browser-root=")) {
      root = argument.slice("--browser-root=".length);
      if (!root) throw new TypeError("--browser-root requires an absolute path");
    } else {
      throw new TypeError(`Unknown option '${argument}'`);
    }
    const absolute = validateBrowserRootPath(root, process.platform, "--browser-root");
    options.browserRoots.push(absolute);
  }
  if (!options.help && !options.json) throw new TypeError("--json is required");
  return options;
}

export async function runPreflightCli(argv = process.argv.slice(2), io = process) {
  const options = parsePreflightArgs(argv);
  if (options.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = await discoverMoneyHand({ browserRoots: options.browserRoots });
  io.stdout.write(`${JSON.stringify(report)}\n`);
  return report.runtime.supported ? 0 : 3;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = await runPreflightCli();
  } catch (error) {
    process.stderr.write(`moneyhand-preflight: ${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}
