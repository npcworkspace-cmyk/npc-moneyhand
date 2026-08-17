import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PAGE_WAIT_OBSERVATIONS,
  PageTransitionError,
  normalizeTaskPageNavigation,
  normalizeTaskPageState,
  normalizeTaskPageWait,
  pageUrlMatches,
  taskPageStateMatches,
  taskPageStateStabilityKey,
} from "../skills/npc-moneyhand/scripts/lib/page-transitions.mjs";

test("task page navigation normalizes one bounded HTTP transaction", () => {
  assert.deepEqual(normalizeTaskPageNavigation({
    tabId: 42,
    url: "https://example.test/path",
    waitUntil: "domcontentloaded",
    timeoutMs: 10_000,
    pollIntervalMs: 100,
    stablePolls: 3,
    expectedUrl: "https://example.test/path",
    urlMatch: "origin+path",
  }), {
    tabId: 42,
    url: "https://example.test/path",
    waitUntil: "domcontentloaded",
    timeoutMs: 10_000,
    pollIntervalMs: 100,
    stablePolls: 3,
    maximumObservations: 101,
    expectedUrl: "https://example.test/path",
    urlMatch: "origin+path",
  });
  assert.equal(normalizeTaskPageNavigation({
    tabId: 7,
    url: "https://example.test",
    waitUntil: "commit",
  }).url, "https://example.test/");
  assert.equal(normalizeTaskPageNavigation({
    tabId: 7,
    url: "about:blank",
    waitUntil: "commit",
  }).url, "about:blank");
});

test("task page navigation rejects executable, credentialed and unbounded intents", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///private.txt",
    "https://user:secret@example.test/",
  ]) {
    assert.throws(
      () => normalizeTaskPageNavigation({ tabId: 42, url }),
      (error) => error instanceof PageTransitionError
        && error.code === "INVALID_PAGE_TRANSITION",
    );
  }
  assert.throws(
    () => normalizeTaskPageNavigation({
      tabId: 42,
      url: "https://example.test/",
      timeoutMs: 300_000,
      pollIntervalMs: 20,
    }),
    (error) => error instanceof PageTransitionError
      && error.details?.maximumObservations === MAX_PAGE_WAIT_OBSERVATIONS,
  );
  assert.throws(
    () => normalizeTaskPageNavigation({
      tabId: 42,
      url: "https://example.test/",
      waitUntil: "commit",
      expectedUrl: "https://example.test/",
    }),
    /cannot prove expectedUrl/u,
  );
  assert.throws(() => normalizeTaskPageWait({}), /tabId is required/u);
});

test("fixed URL match modes cover redirects without accepting an arbitrary predicate", () => {
  assert.equal(pageUrlMatches(
    "https://example.test/path/?token=redacted#done",
    "https://example.test/path",
    "origin+path",
  ), true);
  assert.equal(pageUrlMatches("https://example.test/path", "https://example.test", "origin"), true);
  assert.equal(pageUrlMatches("https://example.test/path", "https://example.test/pa", "prefix"), true);
  assert.equal(pageUrlMatches("https://example.test/path", "example.test", "includes"), true);
  assert.equal(pageUrlMatches("https://other.test/path", "https://example.test", "origin"), false);
  assert.equal(pageUrlMatches("https://example.test/path", "https://example.test/path", "regex"), false);
});

test("page readiness requires a real transition and stable browser-owned frame identity", () => {
  const wait = normalizeTaskPageNavigation({
    tabId: 42,
    url: "https://example.test/next",
    expectedUrl: "https://example.test/next",
  });
  const transition = {
    frameId: "root",
    requestedUrl: wait.url,
    before: {
      frameId: "root",
      loaderId: "loader-before",
      url: "https://example.test/start",
      readyState: "complete",
    },
  };
  assert.equal(taskPageStateMatches({
    frameId: "root",
    loaderId: "loader-before",
    url: "https://example.test/start",
    readyState: "complete",
  }, wait, transition), false);
  assert.equal(taskPageStateMatches({
    frameId: "root",
    loaderId: "loader-next",
    url: "https://example.test/next",
    readyState: "interactive",
  }, wait, transition), false);
  const complete = normalizeTaskPageState({
    frameId: "root",
    loaderId: "loader-next",
    url: "https://example.test/next",
    readyState: "complete",
  });
  assert.equal(taskPageStateMatches(complete, wait, transition), true);
  assert.equal(taskPageStateStabilityKey(complete), JSON.stringify(complete));
  assert.equal(taskPageStateMatches({ ...complete, frameId: "replacement" }, wait, transition), false);
});

test("same-document navigation requires URL movement while same-URL reload requires a new loader", () => {
  const fragmentWait = normalizeTaskPageNavigation({
    tabId: 42,
    url: "https://example.test/page#section",
  });
  const before = {
    frameId: "root",
    loaderId: "loader-one",
    url: "https://example.test/page",
    readyState: "complete",
  };
  assert.equal(taskPageStateMatches({
    ...before,
    url: "https://example.test/page#section",
  }, fragmentWait, {
    frameId: "root",
    requestedUrl: fragmentWait.url,
    before,
  }), true);

  const reloadWait = normalizeTaskPageNavigation({ tabId: 42, url: before.url });
  assert.equal(taskPageStateMatches(before, reloadWait, {
    frameId: "root",
    requestedUrl: reloadWait.url,
    before,
  }), false);
  assert.equal(taskPageStateMatches({ ...before, loaderId: "loader-two" }, reloadWait, {
    frameId: "root",
    requestedUrl: reloadWait.url,
    before,
  }), true);
});
