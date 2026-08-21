import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  AdaptiveRateController,
  RateControlError,
  createRateController,
} from "../skills/npc-moneyhand/scripts/lib/rate-control.mjs";

const WORK = Object.freeze({
  origin: "https://example.test",
  profile: "工作配置",
  account: "account-a",
});

function clock(start = 1_000_000) {
  let now = start;
  const sleeps = [];
  return {
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    sleeps,
  };
}

function hasCode(code) {
  return (error) => error instanceof RateControlError && error.code === code;
}

test("pilot-first plans are scoped by origin, Profile and account", () => {
  const timer = clock();
  const controller = createRateController({ now: timer.now, random: () => 0.5 });

  const raw = controller.plan({ scope: WORK, mode: "raw" });
  const human = controller.plan({ scope: WORK, mode: "human" });
  assert.deepEqual(raw, {
    allowed: true,
    stop: false,
    reason: "pilot",
    behaviorMode: "raw",
    humanBypassesRateControl: false,
    concurrency: 1,
    intervalMs: 0,
    waitMs: 0,
    retryAtMs: null,
    checkpointRequired: false,
    phase: "pilot",
  });
  assert.equal(human.behaviorMode, "human");
  assert.equal(human.humanBypassesRateControl, false);
  assert.equal(human.concurrency, raw.concurrency);

  controller.observe({ scope: WORK, status: 200, latencyMs: 100 });
  const completed = controller.observe({ scope: WORK, status: 204, latencyMs: 110 });
  assert.deepEqual(completed.actions, ["pilot-complete", "increase-concurrency"]);
  assert.equal(completed.state.phase, "steady");
  assert.equal(completed.state.concurrency, 2);

  const anotherAccount = { ...WORK, account: "account-b" };
  const anotherOrigin = { ...WORK, origin: "https://api.example.test" };
  assert.equal(controller.plan({ scope: anotherAccount }).concurrency, 1);
  assert.equal(controller.plan({ scope: anotherOrigin }).concurrency, 1);
  const all = controller.snapshot();
  assert.equal(all.scopes.length, 3);
  assert.deepEqual(
    new Set(all.scopes.map((state) => `${state.scope.origin}|${state.scope.account}`)),
    new Set([
      "https://example.test|account-a",
      "https://example.test|account-b",
      "https://api.example.test|account-a",
    ]),
  );
});

test("429 honors Retry-After after reducing concurrency and applies deterministic exponential jitter", () => {
  const timer = clock();
  let sleepCalls = 0;
  const controller = new AdaptiveRateController({
    now: timer.now,
    random: () => 0.75,
    sleep: async () => { sleepCalls += 1; },
    minConcurrency: 1,
    maxConcurrency: 8,
    pilotConcurrency: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.5,
  });

  const first = controller.observe({
    scope: WORK,
    status: 429,
    headers: { "Retry-After": "5" },
  });
  assert.deepEqual(first.signals, ["http-429", "retry-after"]);
  assert.deepEqual(first.actions, ["reduce-concurrency", "checkpoint-required", "cooldown"]);
  assert.equal(first.state.concurrency, 2);
  assert.equal(first.state.intervalMs, 1_250);
  assert.equal(first.decision.waitMs, 5_000);
  assert.equal(first.state.checkpointRequired, true);
  assert.equal(sleepCalls, 0, "observe must never sleep or send work");

  const checkpointed = controller.checkpoint({ scope: WORK, token: "cursor:100" });
  assert.equal(checkpointed.checkpointRequired, false);
  assert.deepEqual(checkpointed.checkpoint, { token: "cursor:100", savedAtMs: 1_000_000 });

  timer.advance(5_000);
  const second = controller.observe({ scope: WORK, status: 503, checkpoint: "cursor:100" });
  assert.deepEqual(second.signals, ["http-503"]);
  assert.equal(second.state.concurrency, 1);
  assert.equal(second.state.backoffLevel, 2);
  assert.equal(second.state.intervalMs, 2_500);
  assert.equal(second.decision.waitMs, 2_500);
  assert.equal(second.state.checkpointRequired, false);
  assert.equal(sleepCalls, 0);
});

test("human mode cannot bypass cooldown and wait uses only the injected sleeper", async () => {
  const timer = clock(50_000);
  const controller = createRateController({
    now: timer.now,
    random: () => 0.5,
    sleep: timer.sleep,
    jitterRatio: 0,
    baseDelayMs: 750,
  });
  controller.observe({ scope: WORK, throttle: true });

  const human = controller.plan({ scope: WORK, mode: "human" });
  assert.equal(human.allowed, false);
  assert.equal(human.reason, "cooldown");
  assert.equal(human.waitMs, 750);
  assert.equal(human.humanBypassesRateControl, false);

  const after = await controller.wait({ scope: WORK, mode: "human" });
  assert.deepEqual(timer.sleeps, [750]);
  assert.equal(after.allowed, true);
  assert.equal(after.phase, "recovery");
  assert.equal(after.behaviorMode, "human");
});

test("rate-control wait aborts promptly even when an injected sleeper does not", async () => {
  let sleepCalls = 0;
  const controller = createRateController({
    now: () => 50_000,
    random: () => 0.5,
    sleep: async () => {
      sleepCalls += 1;
      await new Promise(() => {});
    },
    jitterRatio: 0,
    baseDelayMs: 750,
  });
  controller.observe({ scope: WORK, throttle: true });
  const abortController = new AbortController();
  const waiting = controller.wait(
    { scope: WORK, mode: "raw" },
    { signal: abortController.signal },
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  abortController.abort(new Error("task budget expired"));
  await assert.rejects(
    waiting,
    (error) => error.code === "ABORTED"
      && error.details.actionDispatched === false
      && error.details.retry === "safe-to-recheck",
  );
  assert.equal(sleepCalls, 1);
});

test("rate-control wait rejects an already-aborted signal before planning or sleeping", async () => {
  let sleepCalls = 0;
  const controller = createRateController({
    sleep: async () => { sleepCalls += 1; },
  });
  const abortController = new AbortController();
  abortController.abort(new Error("task was already cancelled"));
  await assert.rejects(
    controller.wait(
      { scope: WORK, mode: "raw" },
      { signal: abortController.signal },
    ),
    hasCode("ABORTED"),
  );
  assert.equal(sleepCalls, 0);
  assert.equal(controller.snapshot().scopes.length, 0);
});

test("the default rate-control sleeper clears its timer after abort", async () => {
  const moduleUrl = new URL(
    "../skills/npc-moneyhand/scripts/lib/rate-control.mjs",
    import.meta.url,
  ).href;
  const script = [
    `import { createRateController } from ${JSON.stringify(moduleUrl)};`,
    `const scope = ${JSON.stringify(WORK)};`,
    "const controller = createRateController({ baseDelayMs: 10_000, jitterRatio: 0 });",
    "controller.observe({ scope, throttle: true });",
    "const abortController = new AbortController();",
    "const waiting = controller.wait({ scope }, { signal: abortController.signal });",
    "setImmediate(() => abortController.abort());",
    "try { await waiting; process.exitCode = 2; } catch (error) {",
    "  if (error.code !== 'ABORTED') process.exitCode = 3;",
    "}",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("rate-control child retained the aborted cooldown timer"));
    }, 1_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
});

test("explicit throttle, 503 and latency regression are independent observable signals", () => {
  const timer = clock();
  const options = {
    now: timer.now,
    random: () => 0.5,
    jitterRatio: 0,
    latencyFloorMs: 500,
    latencyRegressionFactor: 3,
    minConcurrencyThrottleThreshold: 10,
  };
  const controller = createRateController(options);
  const throttleScope = { ...WORK, account: "payload" };
  const statusScope = { ...WORK, account: "status" };
  const latencyScope = { ...WORK, account: "latency" };

  assert.deepEqual(
    controller.observe({ scope: throttleScope, throttle: true }).signals,
    ["throttle"],
  );
  assert.deepEqual(
    controller.observe({ scope: statusScope, status: 503 }).signals,
    ["http-503"],
  );
  controller.observe({ scope: latencyScope, clean: true, latencyMs: 100 });
  const regressed = controller.observe({ scope: latencyScope, status: 200, latencyMs: 1_000 });
  assert.deepEqual(regressed.signals, ["latency-regression"]);
  assert.equal(regressed.state.latencyBaselineMs, 100, "a regression must not poison the baseline");
  assert.equal(regressed.decision.allowed, false);
});

test("clean batches progressively recover without exceeding the post-throttle safe ceiling", () => {
  const timer = clock();
  const controller = createRateController({
    now: timer.now,
    random: () => 0.5,
    jitterRatio: 0,
    maxConcurrency: 4,
    pilotCleanBatches: 1,
    cleanBatchesToIncrease: 2,
    baseDelayMs: 100,
  });

  assert.equal(controller.observe({ scope: WORK, status: 200 }).state.concurrency, 2);
  controller.observe({ scope: WORK, status: 200 });
  assert.equal(controller.observe({ scope: WORK, status: 200 }).state.concurrency, 3);

  const throttled = controller.observe({ scope: WORK, status: 429 });
  assert.equal(throttled.state.concurrency, 1);
  assert.equal(throttled.state.recoveryCeiling, 2);
  timer.advance(throttled.decision.waitMs);

  controller.observe({ scope: WORK, status: 200 });
  const recovered = controller.observe({ scope: WORK, status: 200 });
  assert.equal(recovered.state.concurrency, 2);
  assert.equal(recovered.state.backoffLevel, 0);
  assert.equal(recovered.state.phase, "steady");

  for (let index = 0; index < 6; index += 1) {
    controller.observe({ scope: WORK, status: 200 });
  }
  assert.equal(controller.snapshot({ scope: WORK }).concurrency, 2);
});

test("challenge and account change open a circuit that only an explicit reset closes", async () => {
  const timer = clock();
  const controller = createRateController({ now: timer.now, random: () => 0.5 });

  const challenge = controller.observe({ scope: WORK, challenge: true });
  assert.deepEqual(challenge.signals, ["challenge"]);
  assert.equal(challenge.decision.stop, true);
  assert.equal(challenge.decision.reason, "challenge");
  assert.deepEqual(challenge.actions, ["checkpoint-required", "open-circuit"]);
  const ignoredClean = controller.observe({ scope: WORK, status: 200 });
  assert.equal(ignoredClean.decision.stop, true);
  assert.deepEqual(ignoredClean.actions, ["circuit-remains-open"]);
  await assert.rejects(
    controller.wait({ scope: WORK }),
    hasCode("RATE_CONTROL_CIRCUIT_OPEN"),
  );

  assert.equal(controller.reset({ scope: WORK }).reset, true);
  assert.equal(controller.plan({ scope: WORK }).phase, "pilot");
  const account = controller.observe({ scope: WORK, accountChanged: true, checkpoint: "cursor:1" });
  assert.equal(account.decision.reason, "account-change");
  assert.equal(account.state.checkpointRequired, false);
});

test("persistent 403 and repeated throttling at minimum concurrency stop the scope", () => {
  const timer = clock();
  const forbidden = createRateController({
    now: timer.now,
    random: () => 0.5,
    jitterRatio: 0,
    persistent403Threshold: 2,
    minConcurrencyThrottleThreshold: 10,
    baseDelayMs: 10,
  });
  let result = forbidden.observe({ scope: WORK, status: 403 });
  timer.advance(result.decision.waitMs);
  result = forbidden.observe({ scope: WORK, status: 403 });
  assert.equal(result.decision.stop, true);
  assert.equal(result.decision.reason, "persistent-403");
  assert.equal(result.state.consecutive403, 2);

  const repeatedScope = { ...WORK, account: "minimum" };
  const repeated = createRateController({
    now: timer.now,
    random: () => 0.5,
    jitterRatio: 0,
    minConcurrencyThrottleThreshold: 2,
    persistent403Threshold: 10,
    baseDelayMs: 10,
  });
  result = repeated.observe({ scope: repeatedScope, status: 429 });
  timer.advance(result.decision.waitMs);
  result = repeated.observe({ scope: repeatedScope, status: 429 });
  assert.equal(result.decision.stop, true);
  assert.equal(result.decision.reason, "repeated-throttle-at-minimum-concurrency");
  assert.equal(result.state.minConcurrencyThrottles, 2);
});

test("Retry-After HTTP dates use the injected clock", () => {
  const timer = clock(Date.parse("2030-01-01T00:00:00.000Z"));
  const controller = createRateController({
    now: timer.now,
    random: () => 0.5,
    jitterRatio: 0,
    baseDelayMs: 100,
  });
  const result = controller.observe({
    scope: WORK,
    status: 429,
    headers: { "retry-after": "Tue, 01 Jan 2030 00:00:03 GMT" },
  });
  assert.equal(result.decision.waitMs, 3_000);
});

test("validation is strict and snapshots cannot mutate internal state", () => {
  assert.throws(
    () => createRateController({ request: () => {} }),
    hasCode("INVALID_RATE_CONTROL_INPUT"),
  );
  assert.throws(
    () => createRateController({ minConcurrency: 4, maxConcurrency: 2 }),
    hasCode("INVALID_RATE_CONTROL_INPUT"),
  );
  const highMinimum = createRateController({ minConcurrency: 12 });
  assert.equal(highMinimum.plan({ scope: WORK }).concurrency, 12);
  assert.equal(highMinimum.snapshot().config.maxConcurrency, 12);
  const timer = clock();
  const controller = createRateController({ now: timer.now, random: () => 0.5 });
  assert.throws(
    () => controller.plan({ scope: { ...WORK, origin: "https://example.test/path" } }),
    hasCode("INVALID_RATE_CONTROL_SCOPE"),
  );
  assert.throws(
    () => controller.plan({ scope: WORK, mode: "stealth" }),
    hasCode("INVALID_RATE_CONTROL_INPUT"),
  );
  assert.throws(
    () => controller.observe({ scope: WORK, status: 429, clean: true }),
    hasCode("CONFLICTING_RATE_CONTROL_SIGNAL"),
  );
  assert.throws(
    () => controller.observe({ scope: WORK, status: 429, headers: { "retry-after": "later" } }),
    hasCode("INVALID_RETRY_AFTER"),
  );
  assert.throws(
    () => controller.observe({ scope: WORK, status: 429, headers: { "retry-after": Infinity } }),
    hasCode("INVALID_RATE_CONTROL_INPUT"),
  );
  assert.throws(
    () => controller.observe({ scope: WORK, surprise: true }),
    hasCode("INVALID_RATE_CONTROL_INPUT"),
  );
  assert.equal(controller.snapshot().scopes.length, 0, "invalid observations must not create state");

  controller.observe({ scope: WORK, status: 200 });
  const snapshot = controller.snapshot({ scope: WORK });
  snapshot.scope.profile = "mutated";
  snapshot.concurrency = 99;
  assert.equal(controller.snapshot({ scope: WORK }).scope.profile, WORK.profile);
  assert.notEqual(controller.snapshot({ scope: WORK }).concurrency, 99);

  const brokenRandom = createRateController({ now: timer.now, random: () => 1 });
  assert.throws(
    () => brokenRandom.observe({ scope: WORK, status: 403, checkpoint: "cursor:bad-random" }),
    hasCode("INVALID_RATE_CONTROL_RANDOM"),
  );
  assert.equal(brokenRandom.snapshot({ scope: WORK }).throttleCount, 0);
  assert.equal(brokenRandom.snapshot({ scope: WORK }).consecutive403, 0);
  assert.equal(brokenRandom.snapshot({ scope: WORK }).checkpoint, null);
});

test("an explicitly clean successful operation is not reclassified by latency heuristics", () => {
  const controller = createRateController({
    random: () => 0.5,
    latencyFloorMs: 100,
    latencyRegressionFactor: 2,
  });
  controller.observe({ scope: WORK, clean: true, latencyMs: 100 });
  const slowSuccess = controller.observe({
    scope: WORK,
    clean: true,
    latencyMs: 1_000,
  });
  assert.deepEqual(slowSuccess.signals, []);
  assert.equal(slowSuccess.decision.stop, false);
  assert.notEqual(slowSuccess.decision.phase, "cooldown");
});
