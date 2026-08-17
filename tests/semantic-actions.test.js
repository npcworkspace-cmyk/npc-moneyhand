import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  INSPECT_SEMANTIC_FILE_INPUT_FUNCTION,
  PREPARE_SEMANTIC_TARGET_FUNCTION,
  SET_SEMANTIC_SELECT_OPTIONS_FUNCTION,
  evaluateSemanticVerification,
  normalizeSemanticRefAction,
  semanticActionApprovalRequest,
} from "../skills/npc-moneyhand/scripts/lib/semantic-actions.mjs";

function style() {
  return {
    display: "block",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "auto",
  };
}

function mockElement(options = {}) {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  const element = {
    nodeType: 1,
    isConnected: true,
    parentElement: options.parentElement ?? null,
    tagName: options.tagName ?? "BUTTON",
    disabled: options.disabled === true,
    readOnly: options.readOnly === true,
    isContentEditable: options.isContentEditable === true,
    type: options.type,
    multiple: options.multiple === true,
    accept: options.accept ?? "",
    files: options.files,
    value: options.value,
    checked: options.checked,
    indeterminate: options.indeterminate === true,
    style: options.style ?? style(),
    scrollIntoView() {
      options.onScroll?.();
    },
    getBoundingClientRect() {
      return options.rect ?? { x: 10, y: 10, left: 10, top: 10, width: 80, height: 40 };
    },
    getRootNode() {
      return options.root;
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    contains(candidate) {
      return candidate === element || options.children?.includes(candidate) === true;
    },
  };
  return element;
}

function executeFileInputInspect(options = {}) {
  const document = { nodeType: 9 };
  const target = mockElement({
    root: document,
    tagName: options.tagName ?? "INPUT",
    type: options.type ?? "file",
    multiple: options.multiple,
    accept: options.accept,
    files: options.files ?? [],
    attributes: options.attributes,
    disabled: options.disabled,
  });
  const inspect = vm.runInNewContext(`(${INSPECT_SEMANTIC_FILE_INPUT_FUNCTION})`, {
    location: { href: "https://example.test/upload" },
  });
  return inspect.call(target);
}

function executePreflight(options = {}) {
  const document = {
    nodeType: 9,
    activeElement: null,
    elementFromPoint() {
      return options.topHit;
    },
  };
  const host = mockElement({
    root: document,
    tagName: "DIV",
    attributes: options.hostAttributes,
  });
  const shadow = {
    nodeType: 11,
    host,
    elementFromPoint() {
      return options.shadowHit;
    },
  };
  const target = mockElement({
    root: options.shadow ? shadow : document,
    tagName: options.tagName,
    type: options.type,
    checked: options.checked,
    indeterminate: options.indeterminate,
    multiple: options.multiple,
    value: options.value,
    attributes: options.attributes,
    isContentEditable: options.isContentEditable,
    rect: options.rect,
    onScroll: options.onScroll,
  });
  const overlay = mockElement({ root: document, tagName: "DIALOG" });
  options.topHit = options.topHit === "target"
    ? target
    : options.topHit === "host"
      ? host
      : options.topHit === "overlay"
        ? overlay
        : options.topHit;
  options.shadowHit = options.shadowHit === "target" ? target : options.shadowHit;
  const context = {
    document,
    innerWidth: 200,
    innerHeight: 100,
    location: { href: "https://example.test/app" },
    getComputedStyle(node) {
      return node.style ?? style();
    },
  };
  const prepare = vm.runInNewContext(`(${PREPARE_SEMANTIC_TARGET_FUNCTION})`, context);
  return prepare.call(target, options.preflightOptions);
}

function executeSelectDispatch(descriptors, options = {}) {
  const events = [];
  const target = mockElement({
    tagName: options.tagName ?? "SELECT",
    multiple: options.multiple,
    disabled: options.disabled,
    attributes: options.attributes,
  });
  const selectOptions = (options.options ?? []).map((option) => ({
    value: option.value ?? "",
    label: option.label ?? option.value ?? "",
    selected: option.selected === true,
    disabled: option.disabled === true,
    parentElement: option.parentDisabled ? { disabled: true } : null,
  }));
  target.options = selectOptions;
  target.dispatchEvent = (event) => {
    events.push(event.type);
    return true;
  };
  class Event {
    constructor(type, init) {
      this.type = type;
      this.init = init;
    }
  }
  const select = vm.runInNewContext(`(${SET_SEMANTIC_SELECT_OPTIONS_FUNCTION})`, {
    location: { href: "https://example.test/form" },
    Event,
  });
  return {
    result: select.call(target, {
      descriptors,
      commit: options.commit !== false,
    }),
    events,
    options: selectOptions,
  };
}

test("semantic preflight returns a fresh hit-tested viewport point and bounded page state", () => {
  const result = executePreflight({
    topHit: "target",
    tagName: "INPUT",
    type: "text",
    value: "before",
  });
  assert.equal(result.ok, true);
  assert.deepEqual({ x: result.x, y: result.y }, { x: 50, y: 30 });
  assert.equal(result.url, "https://example.test/app");
  assert.equal(result.editable, true);
  assert.equal(result.value, "before");
});

test("semantic hover and scroll normalize to bounded pointer intents", () => {
  assert.deepEqual(normalizeSemanticRefAction({ action: "hover" }), {
    action: "hover",
    verification: { kind: "observe", timeoutMs: 0, pollIntervalMs: 100 },
  });
  assert.deepEqual(normalizeSemanticRefAction({ action: "scroll", deltaY: 640 }), {
    action: "scroll",
    deltaX: 0,
    deltaY: 640,
    verification: { kind: "observe", timeoutMs: 0, pollIntervalMs: 100 },
  });
  for (const input of [
    { action: "scroll" },
    { action: "scroll", deltaX: 0, deltaY: 0 },
    { action: "scroll", deltaY: 0.5 },
    { action: "scroll", deltaY: 100_001 },
  ]) {
    assert.throws(
      () => normalizeSemanticRefAction(input),
      (error) => error.code === "INVALID_SEMANTIC_ACTION",
    );
  }

  const approvalRequest = semanticActionApprovalRequest({
    snapshot: {
      tabId: 42,
      id: "snapshot-scroll",
      sessionSelector: { profileId: "Profile 2", tabId: 42 },
      guard: {
        frameId: "root",
        loaderId: "loader-1",
        url: "https://example.test/app",
      },
    },
    node: { ref: "@2", backendNodeId: 86 },
    action: normalizeSemanticRefAction({ action: "scroll", deltaX: -80, deltaY: 640 }),
  });
  assert.deepEqual(
    {
      action: approvalRequest.params.action.action,
      deltaX: approvalRequest.params.action.deltaX,
      deltaY: approvalRequest.params.action.deltaY,
    },
    { action: "scroll", deltaX: -80, deltaY: 640 },
  );
});

test("semantic download binds an exact bounded receipt without accepting a local path", () => {
  const action = normalizeSemanticRefAction({
    action: "download",
    download: {
      timeoutMs: 12_000,
      pollIntervalMs: 50,
      match: {
        filename: "report.csv",
        finalUrl: "https://files.example.test/report.csv?token=secret",
        mime: "text/csv",
      },
    },
  });
  assert.deepEqual(action, {
    action: "download",
    download: {
      timeoutMs: 12_000,
      pollIntervalMs: 50,
      match: {
        filename: "report.csv",
        finalUrl: "https://files.example.test/report.csv?token=secret",
        mime: "text/csv",
      },
    },
    verification: {
      kind: "download-complete",
      timeoutMs: 12_000,
      pollIntervalMs: 50,
    },
  });
  for (const input of [
    { action: "download" },
    { action: "download", download: { timeoutMs: 300_001 } },
    { action: "download", download: { match: { filename: "folder/report.csv" } } },
    { action: "download", download: { match: { path: "/tmp/report.csv" } } },
    { action: "download", download: {}, verification: { kind: "observe" } },
    { action: "download", download: {}, verification: { kind: "download-complete", timeoutMs: 1 } },
    { action: "click", verification: { kind: "download-complete" } },
  ]) {
    assert.throws(
      () => normalizeSemanticRefAction(input),
      (error) => ["INVALID_SEMANTIC_ACTION", "INVALID_SEMANTIC_VERIFICATION"].includes(error.code),
    );
  }

  const receipt = {
    id: 17,
    state: "complete",
    filename: "report.csv",
    localPathReturned: false,
    fileExistenceVerified: false,
  };
  const verification = evaluateSemanticVerification({
    verification: action.verification,
    downloadReceipt: receipt,
  });
  assert.equal(verification.matched, true);
  assert.equal(verification.claim, "declarative-postcondition");
  assert.deepEqual(verification.observed.download, receipt);
});

test("semantic drag binds one exact destination ref without scrolling during final recheck", () => {
  const action = normalizeSemanticRefAction({ action: "drag", toRef: "@2" });
  assert.deepEqual(action, {
    action: "drag",
    toRef: "@2",
    verification: { kind: "observe", timeoutMs: 0, pollIntervalMs: 100 },
  });
  for (const input of [
    { action: "drag" },
    { action: "drag", toRef: "" },
    { action: "drag", toRef: "x".repeat(129) },
  ]) {
    assert.throws(
      () => normalizeSemanticRefAction(input),
      (error) => error.code === "INVALID_SEMANTIC_ACTION",
    );
  }

  const approvalRequest = semanticActionApprovalRequest({
    snapshot: {
      tabId: 42,
      id: "snapshot-drag",
      sessionSelector: { instanceId: "instance-1", bootId: "boot-1" },
      guard: {
        frameId: "root",
        loaderId: "loader-1",
        url: "https://example.test/app",
      },
    },
    node: { ref: "@1", backendNodeId: 84 },
    destination: {
      ref: "@2",
      guard: {
        frameId: "child",
        loaderId: "loader-child",
        url: "https://frame.example.test/drop",
      },
      node: {
        ref: "@2",
        backendNodeId: 86,
        frame: { frameId: "child", sessionId: "child-session" },
      },
    },
    action,
  });
  assert.deepEqual(approvalRequest.params.destination, {
    ref: "@2",
    guard: {
      frameId: "child",
      loaderId: "loader-child",
      url: "https://frame.example.test/drop",
    },
    backendNodeId: 86,
    frame: { frameId: "child", sessionId: "child-session" },
  });
  assert.equal(approvalRequest.params.action.toRef, "@2");

  let scrolls = 0;
  const result = executePreflight({
    topHit: "target",
    onScroll() {
      scrolls += 1;
    },
    preflightOptions: { scroll: false },
  });
  assert.equal(result.ok, true);
  assert.equal(scrolls, 0);
});

test("semantic upload normalizes confined paths and verifies the resulting FileList", () => {
  const action = normalizeSemanticRefAction({
    action: "upload",
    fileRoot: "C:\\task-files",
    files: ["C:\\task-files\\brief.pdf", "/task/photo.png"],
  });
  assert.deepEqual(action, {
    action: "upload",
    fileRoot: "C:\\task-files",
    files: ["C:\\task-files\\brief.pdf", "/task/photo.png"],
    verification: {
      kind: "target-files-set",
      timeoutMs: 2_000,
      pollIntervalMs: 100,
      value: ["brief.pdf", "photo.png"],
    },
  });
  for (const input of [
    { action: "upload", fileRoot: "/task", files: [] },
    { action: "upload", fileRoot: "/task", files: Array.from({ length: 17 }, (_, i) => `/task/${i}`) },
    { action: "upload", fileRoot: "/task" },
    { action: "upload", fileRoot: "", files: ["/task/a"] },
  ]) {
    assert.throws(
      () => normalizeSemanticRefAction(input),
      (error) => error.code === "INVALID_SEMANTIC_ACTION",
    );
  }
  assert.throws(
    () => normalizeSemanticRefAction({
      action: "click",
      verification: { kind: "target-files-set" },
    }),
    (error) => error.code === "INVALID_SEMANTIC_VERIFICATION",
  );

  const verification = evaluateSemanticVerification({
    verification: action.verification,
    frameBefore: { loaderId: "loader-1", url: "https://example.test/upload" },
    frameAfter: { loaderId: "loader-1", url: "https://example.test/upload" },
    targetBefore: { connected: true, files: { count: 0, names: [] } },
    targetAfter: {
      connected: true,
      files: { count: 2, names: ["brief.pdf", "photo.png"] },
    },
  });
  assert.equal(verification.matched, true);
  assert.equal(verification.claim, "declarative-postcondition");

  const hiddenInput = executeFileInputInspect({
    multiple: true,
    accept: ".pdf,image/png",
    files: [{ name: "old.txt" }],
  });
  assert.equal(hiddenInput.ok, true);
  assert.equal(hiddenInput.multiple, true);
  assert.equal(hiddenInput.files.count, 1);
  assert.deepEqual(Array.from(hiddenInput.files.names), ["old.txt"]);
  assert.equal(executeFileInputInspect({ type: "text" }).reason, "not-file-input");
  assert.equal(executeFileInputInspect({ disabled: true }).reason, "disabled");
});

test("semantic select resolves exact value, label, or index descriptors and verifies selection", () => {
  const action = normalizeSemanticRefAction({
    action: "select",
    options: ["paid", { label: "Pending" }, 2],
  });
  assert.deepEqual(action, {
    action: "select",
    options: [{ value: "paid" }, { label: "Pending" }, { index: 2 }],
    verification: {
      kind: "target-options-selected",
      timeoutMs: 2_000,
      pollIntervalMs: 100,
      value: [{ value: "paid" }, { label: "Pending" }, { index: 2 }],
    },
  });
  for (const input of [
    { action: "select" },
    { action: "select", options: [] },
    { action: "select", options: Array.from({ length: 17 }, (_, index) => index) },
    { action: "select", options: [{ value: "a", label: "A" }] },
    { action: "select", options: [{ index: -1 }] },
    { action: "select", options: ["a", { value: "a" }] },
  ]) {
    assert.throws(
      () => normalizeSemanticRefAction(input),
      (error) => error.code === "INVALID_SEMANTIC_ACTION",
    );
  }
  assert.throws(
    () => normalizeSemanticRefAction({
      action: "click",
      verification: { kind: "target-options-selected" },
    }),
    (error) => error.code === "INVALID_SEMANTIC_VERIFICATION",
  );

  const verification = evaluateSemanticVerification({
    verification: action.verification,
    frameBefore: { loaderId: "loader-1", url: "https://example.test/form" },
    frameAfter: { loaderId: "loader-1", url: "https://example.test/form" },
    targetBefore: { connected: true, selection: { count: 0, options: [] } },
    targetAfter: {
      connected: true,
      selection: {
        multiple: true,
        count: 3,
        options: [
          { index: 2, value: "other", label: "Other" },
          { index: 4, value: "paid", label: "Paid" },
          { index: 7, value: "pending", label: "Pending" },
        ],
      },
    },
  });
  assert.equal(verification.matched, true);

  const preflight = executePreflight({
    topHit: "target",
    tagName: "SELECT",
    multiple: true,
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.tag, "select");
  assert.equal(preflight.multiple, true);

  const selected = executeSelectDispatch([{ label: "Paid" }], {
    options: [
      { value: "draft", label: "Draft", selected: true },
      { value: "paid", label: "Paid" },
    ],
  });
  assert.equal(selected.result.ok, true);
  assert.equal(selected.result.changed, true);
  assert.deepEqual(selected.events, ["input", "change"]);
  assert.deepEqual(selected.options.map((option) => option.selected), [false, true]);
  assert.equal(selected.result.selection.count, 1);
  assert.equal(selected.result.selection.options[0].value, "paid");

  const inspected = executeSelectDispatch([{ label: "Paid" }], {
    commit: false,
    options: [
      { value: "draft", label: "Draft", selected: true },
      { value: "paid", label: "Paid" },
    ],
  });
  assert.equal(inspected.result.ok, true);
  assert.equal(inspected.result.applied, false);
  assert.deepEqual(inspected.events, []);
  assert.deepEqual(inspected.options.map((option) => option.selected), [true, false]);
  assert.equal(inspected.result.selection.options[0].value, "paid");

  const ambiguous = executeSelectDispatch([{ value: "same" }], {
    options: [
      { value: "same", label: "First", selected: true },
      { value: "same", label: "Second" },
    ],
  });
  assert.equal(ambiguous.result.reason, "option-ambiguous");
  assert.deepEqual(ambiguous.events, []);
  assert.deepEqual(ambiguous.options.map((option) => option.selected), [true, false]);

  assert.equal(executeSelectDispatch([{ label: "Blocked" }], {
    options: [{ value: "blocked", label: "Blocked", disabled: true }],
  }).result.reason, "option-disabled");
  assert.equal(executeSelectDispatch([{ index: 0 }, { index: 1 }], {
    options: [{ value: "a" }, { value: "b" }],
  }).result.reason, "multiple-required");
});

test("semantic check and uncheck normalize to binary idempotent postconditions", () => {
  const check = normalizeSemanticRefAction({ action: "check" });
  const uncheck = normalizeSemanticRefAction({
    action: "uncheck",
    verification: { kind: "target-checked" },
  });
  assert.deepEqual(check, {
    action: "check",
    verification: {
      kind: "target-checked",
      timeoutMs: 2_000,
      pollIntervalMs: 100,
      value: true,
    },
  });
  assert.deepEqual(uncheck, {
    action: "uncheck",
    verification: {
      kind: "target-checked",
      timeoutMs: 2_000,
      pollIntervalMs: 100,
      value: false,
    },
  });
  assert.throws(
    () => normalizeSemanticRefAction({
      action: "check",
      verification: { kind: "target-checked", value: false },
    }),
    (error) => error.code === "INVALID_SEMANTIC_VERIFICATION",
  );
  assert.throws(
    () => normalizeSemanticRefAction({
      action: "uncheck",
      verification: { kind: "observe" },
    }),
    (error) => error.code === "INVALID_SEMANTIC_VERIFICATION",
  );
  assert.throws(
    () => normalizeSemanticRefAction({ action: "check", checked: false }),
    (error) => error.code === "INVALID_SEMANTIC_ACTION",
  );

  const native = executePreflight({
    topHit: "target",
    tagName: "INPUT",
    type: "checkbox",
    checked: false,
  });
  assert.equal(native.ok, true);
  assert.equal(native.inputType, "checkbox");
  assert.equal(native.checked, false);
  assert.equal(native.indeterminate, false);

  const aria = executePreflight({
    topHit: "target",
    tagName: "DIV",
    attributes: { role: "checkbox", "aria-checked": "TRUE" },
  });
  assert.equal(aria.role, "checkbox");
  assert.equal(aria.ariaChecked, "true");
  assert.equal(aria.checked, true);

  const mixed = executePreflight({
    topHit: "target",
    tagName: "DIV",
    attributes: { role: "switch", "aria-checked": "mixed" },
  });
  assert.equal(mixed.ariaChecked, "mixed");
  assert.equal(mixed.checked, null);

  const matched = evaluateSemanticVerification({
    verification: check.verification,
    frameBefore: { loaderId: "loader-1", url: "https://example.test/form" },
    frameAfter: { loaderId: "loader-1", url: "https://example.test/form" },
    targetBefore: { connected: true, checked: false, indeterminate: false },
    targetAfter: { connected: true, checked: true, indeterminate: false },
  });
  assert.equal(matched.matched, true);
  const stillMixed = evaluateSemanticVerification({
    verification: uncheck.verification,
    frameBefore: { loaderId: "loader-1", url: "https://example.test/form" },
    frameAfter: { loaderId: "loader-1", url: "https://example.test/form" },
    targetBefore: { connected: true, checked: false, indeterminate: true },
    targetAfter: { connected: true, checked: false, indeterminate: true },
  });
  assert.equal(stillMixed.matched, false);
});

test("semantic preflight cannot use a shadow-root hit to bypass a top-level overlay", () => {
  const result = executePreflight({
    shadow: true,
    topHit: "overlay",
    shadowHit: "target",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "occluded");
  assert.equal(result.hitTag, "dialog");
});

test("semantic preflight follows composed parents and rejects a disabled shadow host", () => {
  const result = executePreflight({
    shadow: true,
    topHit: "host",
    shadowHit: "target",
    hostAttributes: { "aria-disabled": "true" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disabled");
});

test("target-detached verification does not turn an arbitrary read error into success", () => {
  const frame = { frameId: "root", loaderId: "loader-1", url: "https://example.test/app" };
  const inconclusive = evaluateSemanticVerification({
    verification: { kind: "target-detached" },
    frameBefore: frame,
    frameAfter: frame,
    targetBefore: { connected: true },
    targetError: { code: "DEBUGGER_CONFLICT", message: "unrelated read failure" },
  });
  assert.equal(inconclusive.matched, false);

  const detached = evaluateSemanticVerification({
    verification: { kind: "target-detached" },
    frameBefore: frame,
    frameAfter: frame,
    targetBefore: { connected: true },
    targetAfter: { connected: false },
  });
  assert.equal(detached.matched, true);
});
