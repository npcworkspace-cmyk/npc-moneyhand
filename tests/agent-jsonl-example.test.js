import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function pythonCommand() {
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  return candidates.find(([command, args]) => spawnSync(command, [...args, "--version"], {
    encoding: "utf8",
  }).status === 0);
}

test("minimal Python adapter completes descriptor-driven Hand lifecycle", (t) => {
  const python = pythonCommand();
  if (!python) {
    t.skip("Python 3 is unavailable");
    return;
  }
  const [command, prefix] = python;
  const completed = spawnSync(command, [
    ...prefix,
    "scripts/agent-jsonl-example.py",
    "--timeout",
    "15",
    "--",
    process.execPath,
    "skills/npc-moneyhand/scripts/moneyhand.mjs",
    "--port",
    "0",
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(completed.status, 0, completed.stderr);
  const messages = completed.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(messages[0].event, "moneyhand.listening");
  assert.equal(messages.some((message) => message.id === "example-probe" && message.ok === true), true);
  assert.equal(messages.some((message) => message.id === "example-drain" && message.ok === true), true);
  assert.equal(messages.some((message) => message.id === "example-shutdown" && message.ok === true), true);
  assert.equal(messages.at(-1).event, "moneyhand.stopped");
});

test("minimal Python adapter gracefully stops after a failed product command", (t) => {
  const python = pythonCommand();
  if (!python) {
    t.skip("Python 3 is unavailable");
    return;
  }
  const [command, prefix] = python;
  const completed = spawnSync(command, [
    ...prefix,
    "scripts/agent-jsonl-example.py",
    "--timeout",
    "15",
    "--send",
    JSON.stringify({ id: "bad-op", op: "doesNotExist", args: {} }),
    "--",
    process.execPath,
    "skills/npc-moneyhand/scripts/moneyhand.mjs",
    "--port",
    "0",
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(completed.status, 2, completed.stderr);
  const messages = completed.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  const failedAt = messages.findIndex((message) => message.id === "bad-op" && message.ok === false);
  const drainAt = messages.findIndex((message) => message.id === "example-drain" && message.ok === true);
  const shutdownAt = messages.findIndex((message) => message.id === "example-shutdown" && message.ok === true);
  const stoppedAt = messages.findIndex((message) => message.event === "moneyhand.stopped");

  assert.notEqual(failedAt, -1);
  assert.notEqual(drainAt, -1);
  assert.notEqual(shutdownAt, -1);
  assert.notEqual(stoppedAt, -1);
  assert.equal(failedAt < drainAt, true);
  assert.equal(drainAt < shutdownAt, true);
  assert.equal(shutdownAt < stoppedAt, true);
  assert.equal(stoppedAt, messages.length - 1);
});
