export const SEMANTIC_REF_ACTIONS = Object.freeze([
  "click",
  "download",
  "hover",
  "scroll",
  "drag",
  "upload",
  "select",
  "check",
  "uncheck",
  "type",
  "key",
]);
export const SEMANTIC_VERIFICATION_KINDS = Object.freeze([
  "observe",
  "download-complete",
  "target-text-inserted",
  "target-value-equals",
  "target-value-includes",
  "target-checked",
  "target-focused",
  "target-detached",
  "target-files-set",
  "target-options-selected",
  "url-equals",
  "url-includes",
  "url-changed",
  "loader-changed",
]);

const ACTION_SET = new Set(SEMANTIC_REF_ACTIONS);
const VERIFICATION_SET = new Set(SEMANTIC_VERIFICATION_KINDS);
const BUTTON_SET = new Set(["left", "middle", "right"]);
const MAX_TEXT_CHARS = 12_000;
const MAX_EXPECTED_CHARS = 4_096;
const MAX_SCROLL_DELTA = 100_000;
const MAX_SELECT_OPTIONS = 16;
const MAX_OPTION_CHARS = 1_024;
const MAX_OPTION_INDEX = 4_095;
const MAX_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_DOWNLOAD_FILENAME_CHARS = 1_024;
const MAX_DOWNLOAD_URL_CHARS = 4_096;
const MAX_DOWNLOAD_MIME_CHARS = 256;

export class SemanticActionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SemanticActionError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticActionError("INVALID_SEMANTIC_ACTION", `${label} must be an object`);
  }
  return value;
}

function boundedString(value, label, maximum = MAX_EXPECTED_CHARS) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `${label} must be a 1-${maximum} character string`,
    );
  }
  return value;
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function portableBasename(value) {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function normalizeDownload(value) {
  const input = object(value, "download");
  const unsupported = Object.keys(input).filter(
    (key) => !["timeoutMs", "pollIntervalMs", "match"].includes(key),
  );
  if (unsupported.length > 0) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `download contains unsupported field(s): ${unsupported.join(", ")}`,
    );
  }
  const matchInput = input.match === undefined ? {} : object(input.match, "download.match");
  const unsupportedMatch = Object.keys(matchInput).filter(
    (key) => !["filename", "url", "finalUrl", "mime"].includes(key),
  );
  if (unsupportedMatch.length > 0) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `download.match contains unsupported field(s): ${unsupportedMatch.join(", ")}`,
    );
  }
  const match = {};
  if (matchInput.filename !== undefined) {
    const filename = boundedString(
      matchInput.filename,
      "download.match.filename",
      MAX_DOWNLOAD_FILENAME_CHARS,
    );
    if (portableBasename(filename) !== filename || filename === "." || filename === "..") {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        "download.match.filename must be an exact basename without path separators",
      );
    }
    match.filename = filename;
  }
  for (const key of ["url", "finalUrl"]) {
    if (matchInput[key] !== undefined) {
      match[key] = boundedString(
        matchInput[key],
        `download.match.${key}`,
        MAX_DOWNLOAD_URL_CHARS,
      );
    }
  }
  if (matchInput.mime !== undefined) {
    match.mime = boundedString(
      matchInput.mime,
      "download.match.mime",
      MAX_DOWNLOAD_MIME_CHARS,
    );
  }
  return {
    timeoutMs: boundedInteger(
      input.timeoutMs,
      0,
      MAX_DOWNLOAD_TIMEOUT_MS,
      30_000,
      "download.timeoutMs",
    ),
    pollIntervalMs: boundedInteger(
      input.pollIntervalMs,
      20,
      2_000,
      250,
      "download.pollIntervalMs",
    ),
    match,
  };
}

function normalizeSelectOptions(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1 || values.length > MAX_SELECT_OPTIONS) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `select options must contain 1-${MAX_SELECT_OPTIONS} descriptors`,
    );
  }
  const normalized = values.map((candidate, index) => {
    if (typeof candidate === "string") {
      return { value: boundedString(candidate, `options[${index}]`, MAX_OPTION_CHARS) };
    }
    if (Number.isInteger(candidate)) {
      if (candidate < 0 || candidate > MAX_OPTION_INDEX) {
        throw new SemanticActionError(
          "INVALID_SEMANTIC_ACTION",
          `options[${index}] index must be between 0 and ${MAX_OPTION_INDEX}`,
        );
      }
      return { index: candidate };
    }
    const descriptor = object(candidate, `options[${index}]`);
    const keys = Object.keys(descriptor);
    const selectors = keys.filter((key) => ["value", "label", "index"].includes(key));
    if (keys.length !== 1 || selectors.length !== 1) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        `options[${index}] must contain exactly one of value, label, or index`,
      );
    }
    if (selectors[0] === "index") {
      if (!Number.isInteger(descriptor.index)
        || descriptor.index < 0
        || descriptor.index > MAX_OPTION_INDEX) {
        throw new SemanticActionError(
          "INVALID_SEMANTIC_ACTION",
          `options[${index}].index must be between 0 and ${MAX_OPTION_INDEX}`,
        );
      }
      return { index: descriptor.index };
    }
    return {
      [selectors[0]]: boundedString(
        descriptor[selectors[0]],
        `options[${index}].${selectors[0]}`,
        MAX_OPTION_CHARS,
      ),
    };
  });
  const fingerprints = normalized.map((descriptor) => JSON.stringify(descriptor));
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      "select options must not repeat the same descriptor",
    );
  }
  return normalized;
}

function normalizeVerification(value, action) {
  const input = value === undefined
    ? (action.action === "type"
      ? { kind: "target-text-inserted" }
      : action.action === "download"
        ? { kind: "download-complete" }
      : action.action === "upload"
        ? { kind: "target-files-set" }
        : action.action === "select"
          ? { kind: "target-options-selected" }
          : action.action === "check"
            ? { kind: "target-checked", value: true }
            : action.action === "uncheck"
              ? { kind: "target-checked", value: false }
        : { kind: "observe" })
    : object(value, "verification");
  if (typeof input.kind !== "string" || !VERIFICATION_SET.has(input.kind)) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_VERIFICATION",
      `verification.kind must be one of: ${SEMANTIC_VERIFICATION_KINDS.join(", ")}`,
    );
  }
  if ((action.action === "check" || action.action === "uncheck")
    && input.kind !== "target-checked") {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_VERIFICATION",
      `${action.action} requires target-checked verification`,
    );
  }
  if (action.action === "download" && input.kind !== "download-complete") {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_VERIFICATION",
      "download requires download-complete verification",
    );
  }
  if (action.action !== "download" && input.kind === "download-complete") {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_VERIFICATION",
      "download-complete verification is valid only for download actions",
    );
  }
  if (input.kind === "download-complete") {
    const unsupported = Object.keys(input).filter((key) => key !== "kind");
    if (unsupported.length > 0) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        "download-complete timing and matching belong in the download object",
      );
    }
    return {
      kind: input.kind,
      timeoutMs: action.download.timeoutMs,
      pollIntervalMs: action.download.pollIntervalMs,
    };
  }
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    0,
    10_000,
    input.kind === "observe" ? 0 : 2_000,
    "verification.timeoutMs",
  );
  const pollIntervalMs = boundedInteger(
    input.pollIntervalMs,
    20,
    1_000,
    100,
    "verification.pollIntervalMs",
  );
  const output = { kind: input.kind, timeoutMs, pollIntervalMs };
  if ([
    "target-value-equals",
    "target-value-includes",
    "url-equals",
    "url-includes",
  ].includes(input.kind)) {
    output.value = boundedString(input.value, "verification.value");
  } else if (input.kind === "target-checked") {
    const actionChecked = action.action === "check"
      ? true
      : action.action === "uncheck"
        ? false
        : undefined;
    if (actionChecked !== undefined
      && input.value !== undefined
      && input.value !== actionChecked) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        `${action.action} cannot verify the opposite checked state`,
      );
    }
    const expected = actionChecked ?? input.value;
    if (typeof expected !== "boolean") {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        "target-checked verification requires boolean value",
      );
    }
    output.value = expected;
  }
  if (input.kind === "target-text-inserted") {
    if (action.action !== "type") {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        "target-text-inserted verification is valid only for type actions",
      );
    }
    output.value = action.text;
    output.replace = action.replace;
  } else if (input.kind === "target-files-set") {
    if (action.action !== "upload") {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        "target-files-set verification is valid only for upload actions",
      );
    }
    output.value = action.files.map(portableBasename);
  } else if (input.kind === "target-options-selected") {
    if (action.action !== "select") {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_VERIFICATION",
        "target-options-selected verification is valid only for select actions",
      );
    }
    output.value = action.options.map((descriptor) => ({ ...descriptor }));
  }
  return output;
}

export function normalizeSemanticRefAction(value) {
  const input = object(value, "semantic action");
  if (typeof input.action !== "string" || !ACTION_SET.has(input.action)) {
    throw new SemanticActionError(
      "INVALID_SEMANTIC_ACTION",
      `top-level action must be a string and one of: ${SEMANTIC_REF_ACTIONS.join(", ")}`,
    );
  }
  const output = { action: input.action };
  if (input.action === "click") {
    const button = input.button ?? "left";
    if (typeof button !== "string" || !BUTTON_SET.has(button)) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        "click button must be left, middle or right",
      );
    }
    output.button = button;
    output.clickCount = boundedInteger(input.clickCount, 1, 3, 1, "clickCount");
  } else if (input.action === "download") {
    output.download = normalizeDownload(input.download);
  } else if (input.action === "hover") {
    // The live hit-tested ref point is the complete hover intent.
  } else if (input.action === "scroll") {
    output.deltaX = boundedInteger(
      input.deltaX,
      -MAX_SCROLL_DELTA,
      MAX_SCROLL_DELTA,
      0,
      "deltaX",
    );
    output.deltaY = boundedInteger(
      input.deltaY,
      -MAX_SCROLL_DELTA,
      MAX_SCROLL_DELTA,
      0,
      "deltaY",
    );
    if (output.deltaX === 0 && output.deltaY === 0) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        "scroll requires a non-zero deltaX or deltaY",
      );
    }
  } else if (input.action === "drag") {
    output.toRef = boundedString(input.toRef, "toRef", 128);
  } else if (input.action === "upload") {
    output.fileRoot = boundedString(input.fileRoot, "fileRoot", 4_096);
    const files = typeof input.files === "string" ? [input.files] : input.files;
    if (!Array.isArray(files) || files.length < 1 || files.length > 16) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        "upload files must contain 1-16 paths",
      );
    }
    output.files = files.map((file, index) => boundedString(
      file,
      `files[${index}]`,
      4_096,
    ));
  } else if (input.action === "select") {
    output.options = normalizeSelectOptions(input.options);
  } else if (input.action === "check" || input.action === "uncheck") {
    // The action name is the complete desired binary checked-state intent.
    if (Object.hasOwn(input, "checked")) {
      throw new SemanticActionError(
        "INVALID_SEMANTIC_ACTION",
        "check/uncheck must express the desired state in the action name, not a checked field",
      );
    }
  } else if (input.action === "type") {
    output.text = boundedString(input.text, "text", MAX_TEXT_CHARS);
    if (input.replace !== undefined && typeof input.replace !== "boolean") {
      throw new SemanticActionError("INVALID_SEMANTIC_ACTION", "replace must be boolean");
    }
    output.replace = input.replace === true;
  } else if (input.action === "key") {
    output.key = boundedString(input.key, "key", 128);
    if (input.code !== undefined) output.code = boundedString(input.code, "code", 128);
    output.modifiers = boundedInteger(input.modifiers, 0, 15, 0, "modifiers");
    if (input.text !== undefined) {
      if (typeof input.text !== "string" || input.text.length > 128) {
        throw new SemanticActionError(
          "INVALID_SEMANTIC_ACTION",
          "key text must be a string no longer than 128 characters",
        );
      }
      output.text = input.text;
    }
  }
  output.verification = normalizeVerification(input.verification, output);
  return output;
}

export function semanticActionApprovalRequest({ snapshot, node, action, destination }) {
  return {
    method: "moneyhand.actSemanticRef",
    params: {
      tabId: snapshot.tabId,
      snapshotId: snapshot.id,
      ref: node.ref,
      sessionSelector: { ...snapshot.sessionSelector },
      guard: {
        frameId: snapshot.guard.frameId,
        loaderId: snapshot.guard.loaderId,
        url: snapshot.guard.url,
      },
      backendNodeId: node.backendNodeId,
      ...(node.frame === undefined ? {} : { frame: { ...node.frame } }),
      ...(destination === undefined ? {} : {
        destination: {
          ref: destination.ref,
          guard: { ...destination.guard },
          backendNodeId: destination.node.backendNodeId,
          ...(destination.node.frame === undefined
            ? {}
            : { frame: { ...destination.node.frame } }),
        },
      }),
      action: { ...action, verification: { ...action.verification } },
    },
  };
}

export const PREPARE_SEMANTIC_TARGET_FUNCTION = String.raw`function(options) {
  const element = this;
  const clip = (value) => typeof value === "string" ? value.slice(0, 12000) : null;
  const url = typeof globalThis.location?.href === "string"
    ? globalThis.location.href.slice(0, 4096)
    : null;
  if (!element || element.nodeType !== 1 || element.isConnected !== true) {
    return { ok: false, reason: "detached", connected: false, url };
  }
  if (options?.scroll !== false) {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  }
  const rect = element.getBoundingClientRect();
  const composedParent = (node) => {
    if (node.parentElement) return node.parentElement;
    const nodeRoot = node.getRootNode?.();
    return nodeRoot && nodeRoot.nodeType === 11 ? nodeRoot.host : null;
  };
  let current = element;
  let hidden = rect.width <= 0 || rect.height <= 0;
  let disabled = false;
  for (let depth = 0; current && depth < 64; depth += 1) {
    const style = getComputedStyle(current);
    hidden ||= style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || Number(style.opacity) <= 0.01
      || style.pointerEvents === "none";
    disabled ||= current.disabled === true
      || current.getAttribute("aria-disabled") === "true"
      || current.hasAttribute("inert");
    current = composedParent(current);
  }
  if (hidden) {
    return { ok: false, reason: "hidden", connected: true, url };
  }
  if (disabled) {
    return { ok: false, reason: "disabled", connected: true, url };
  }
  const viewportWidth = Math.max(0, globalThis.innerWidth || 0);
  const viewportHeight = Math.max(0, globalThis.innerHeight || 0);
  const candidates = [
    [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]
  ];
  const root = element.getRootNode?.();
  const composedAncestorOfTarget = (candidate) => {
    let ancestor = element;
    for (let depth = 0; ancestor && depth < 64; depth += 1) {
      if (ancestor === candidate) return true;
      ancestor = composedParent(ancestor);
    }
    return false;
  };
  let point = null;
  let lastHit = null;
  for (const [rx, ry] of candidates) {
    const x = rect.left + rect.width * rx;
    const y = rect.top + rect.height * ry;
    if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
    const topHit = document.elementFromPoint(x, y);
    const hit = root && root.nodeType === 11 && typeof root.elementFromPoint === "function"
      ? root.elementFromPoint(x, y)
      : topHit;
    lastHit = topHit || hit;
    const topAllows = root?.nodeType !== 11
      || topHit === element
      || element.contains(topHit)
      || composedAncestorOfTarget(topHit);
    if (topAllows && (hit === element || element.contains(hit))) {
      point = { x, y };
      break;
    }
  }
  if (!point) {
    return {
      ok: false,
      reason: lastHit ? "occluded" : "outside-viewport",
      connected: true,
      url,
      hitTag: clip(lastHit?.tagName?.toLowerCase?.())
    };
  }
  const tag = element.tagName.toLowerCase();
  const inputType = tag === "input" ? (element.type || "text").toLowerCase() : "";
  const role = clip(element.getAttribute("role"));
  const ariaCheckedValue = clip(element.getAttribute("aria-checked"));
  const ariaChecked = typeof ariaCheckedValue === "string"
    ? ariaCheckedValue.trim().toLowerCase()
    : null;
  const textInput = tag === "textarea" || (tag === "input" && ![
    "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"
  ].includes(inputType));
  const editable = (textInput && element.readOnly !== true) || element.isContentEditable === true;
  const value = typeof element.value === "string"
    ? element.value
    : (element.isContentEditable ? element.textContent : null);
  const nativeCheckable = tag === "input"
    && (inputType === "checkbox" || inputType === "radio");
  const checked = nativeCheckable
    ? element.checked === true
    : ariaChecked === "true"
      ? true
      : ariaChecked === "false"
        ? false
        : null;
  return {
    ok: true,
    reason: null,
    connected: true,
    url,
    x: point.x,
    y: point.y,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: viewportWidth, height: viewportHeight },
    tag,
    inputType,
    role,
    multiple: tag === "select" ? element.multiple === true : null,
    editable,
    readOnly: element.readOnly === true,
    focused: document.activeElement === element,
    value: clip(value),
    checked,
    ariaChecked,
    indeterminate: nativeCheckable && inputType === "checkbox"
      ? element.indeterminate === true
      : null
  };
}`;

export const INSPECT_SEMANTIC_FILE_INPUT_FUNCTION = String.raw`function() {
  const element = this;
  const clip = (value, maximum = 4096) => typeof value === "string"
    ? value.slice(0, maximum)
    : null;
  const url = typeof globalThis.location?.href === "string"
    ? globalThis.location.href.slice(0, 4096)
    : null;
  if (!element || element.nodeType !== 1 || element.isConnected !== true) {
    return { ok: false, reason: "detached", connected: false, url };
  }
  const tag = element.tagName?.toLowerCase?.() || "";
  const inputType = tag === "input" ? String(element.type || "").toLowerCase() : "";
  if (tag !== "input" || inputType !== "file") {
    return {
      ok: false,
      reason: "not-file-input",
      connected: true,
      url,
      tag,
      inputType
    };
  }
  const composedParent = (node) => {
    if (node.parentElement) return node.parentElement;
    const nodeRoot = node.getRootNode?.();
    return nodeRoot && nodeRoot.nodeType === 11 ? nodeRoot.host : null;
  };
  let current = element;
  let disabled = false;
  for (let depth = 0; current && depth < 64; depth += 1) {
    disabled ||= current.disabled === true
      || current.getAttribute("aria-disabled") === "true"
      || current.hasAttribute("inert");
    current = composedParent(current);
  }
  if (disabled) {
    return { ok: false, reason: "disabled", connected: true, url, tag, inputType };
  }
  const names = element.files
    ? Array.from(element.files, (file) => clip(file?.name, 1024)).filter(Boolean).slice(0, 16)
    : [];
  return {
    ok: true,
    reason: null,
    connected: true,
    url,
    tag,
    inputType,
    multiple: element.multiple === true,
    accept: clip(element.accept, 2048),
    files: { count: names.length, names }
  };
}`;

export const SET_SEMANTIC_SELECT_OPTIONS_FUNCTION = String.raw`function(request) {
  const element = this;
  const clip = (value, maximum = 1024) => typeof value === "string"
    ? value.slice(0, maximum)
    : null;
  const url = typeof globalThis.location?.href === "string"
    ? globalThis.location.href.slice(0, 4096)
    : null;
  if (!element || element.nodeType !== 1 || element.isConnected !== true) {
    return { ok: false, reason: "detached", connected: false, url };
  }
  const tag = element.tagName?.toLowerCase?.() || "";
  if (tag !== "select") {
    return { ok: false, reason: "not-select", connected: true, url, tag };
  }
  const composedParent = (node) => {
    if (node.parentElement) return node.parentElement;
    const nodeRoot = node.getRootNode?.();
    return nodeRoot && nodeRoot.nodeType === 11 ? nodeRoot.host : null;
  };
  let current = element;
  let disabled = false;
  for (let depth = 0; current && depth < 64; depth += 1) {
    disabled ||= current.disabled === true
      || current.getAttribute("aria-disabled") === "true"
      || current.hasAttribute("inert");
    current = composedParent(current);
  }
  if (disabled) {
    return { ok: false, reason: "disabled", connected: true, url, tag };
  }
  const descriptors = request?.descriptors;
  const commit = request?.commit === true;
  if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 16) {
    return { ok: false, reason: "invalid-options", connected: true, url, tag };
  }
  if (descriptors.length > 1 && element.multiple !== true) {
    return { ok: false, reason: "multiple-required", connected: true, url, tag };
  }
  const options = Array.from(element.options || []);
  if (options.length > 4096) {
    return { ok: false, reason: "too-many-options", connected: true, url, tag };
  }
  const selected = [];
  const selectedIndexes = new Set();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      return { ok: false, reason: "invalid-option", connected: true, url, tag };
    }
    const keys = Object.keys(descriptor);
    if (keys.length !== 1 || !["value", "label", "index"].includes(keys[0])) {
      return { ok: false, reason: "invalid-option", connected: true, url, tag };
    }
    let matches;
    if (keys[0] === "index") {
      matches = Number.isInteger(descriptor.index)
        && descriptor.index >= 0
        && descriptor.index < options.length
        ? [options[descriptor.index]]
        : [];
    } else if (keys[0] === "value") {
      matches = options.filter((option) => option.value === descriptor.value);
    } else {
      matches = options.filter((option) => option.label === descriptor.label);
    }
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: matches.length === 0 ? "option-not-found" : "option-ambiguous",
        connected: true,
        url,
        tag
      };
    }
    const option = matches[0];
    const optionIndex = options.indexOf(option);
    if (selectedIndexes.has(optionIndex)) {
      return { ok: false, reason: "duplicate-option", connected: true, url, tag };
    }
    if (option.disabled === true || option.parentElement?.disabled === true) {
      return { ok: false, reason: "option-disabled", connected: true, url, tag };
    }
    selectedIndexes.add(optionIndex);
    selected.push(option);
  }
  const before = options.filter((option) => option.selected === true);
  const changed = before.length !== selected.length
    || before.some((option) => !selected.includes(option));
  if (changed && commit) {
    for (const option of options) option.selected = selected.includes(option);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  const actual = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => commit ? option.selected === true : selected.includes(option))
    .slice(0, 16)
    .map(({ option, index }) => ({
      index,
      value: clip(option.value),
      label: clip(option.label)
    }));
  return {
    ok: true,
    reason: null,
    connected: true,
    url,
    tag,
    changed,
    applied: commit,
    multiple: element.multiple === true,
    selection: { count: actual.length, options: actual }
  };
}`;

export const READ_SEMANTIC_TARGET_FUNCTION = String.raw`function() {
  const element = this;
  const clip = (value) => typeof value === "string" ? value.slice(0, 12000) : null;
  if (!element || element.nodeType !== 1 || element.isConnected !== true) {
    return {
      connected: false,
      focused: false,
      value: null,
      checked: null,
      ariaChecked: null,
      indeterminate: null,
      files: null,
      selection: null
    };
  }
  const tag = element.tagName?.toLowerCase?.() || "";
  const inputType = tag === "input" ? String(element.type || "").toLowerCase() : "";
  const ariaCheckedValue = clip(element.getAttribute?.("aria-checked"));
  const ariaChecked = typeof ariaCheckedValue === "string"
    ? ariaCheckedValue.trim().toLowerCase()
    : null;
  const nativeCheckable = tag === "input"
    && (inputType === "checkbox" || inputType === "radio");
  const checked = nativeCheckable
    ? element.checked === true
    : ariaChecked === "true"
      ? true
      : ariaChecked === "false"
        ? false
        : null;
  const value = typeof element.value === "string"
    ? element.value
    : (element.isContentEditable ? element.textContent : null);
  const names = element.files
    ? Array.from(element.files, (file) => typeof file?.name === "string"
      ? file.name.slice(0, 1024)
      : null).filter(Boolean).slice(0, 16)
    : null;
  const selectedOptions = element.tagName?.toLowerCase?.() === "select"
    ? Array.from(element.options || [])
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => option.selected === true)
    : null;
  const selection = selectedOptions === null
    ? null
    : selectedOptions.slice(0, 16).map(({ option, index }) => ({
        index,
        value: typeof option.value === "string" ? option.value.slice(0, 1024) : null,
        label: typeof option.label === "string" ? option.label.slice(0, 1024) : null
      }));
  return {
    connected: true,
    focused: document.activeElement === element,
    value: clip(value),
    checked,
    ariaChecked,
    indeterminate: nativeCheckable && inputType === "checkbox"
      ? element.indeterminate === true
      : null,
    files: names === null ? null : { count: names.length, names },
    selection: selection === null
      ? null
      : { multiple: element.multiple === true, count: selectedOptions.length, options: selection }
  };
}`;

function publicFrame(frame) {
  return frame ? { loaderId: frame.loaderId, url: frame.url } : null;
}

function publicTarget(target, targetError) {
  if (target) {
    return {
      connected: target.connected === true,
      focused: target.focused === true,
      value: typeof target.value === "string" ? target.value : null,
      checked: typeof target.checked === "boolean" ? target.checked : null,
      ariaChecked: ["true", "false", "mixed"].includes(target.ariaChecked)
        ? target.ariaChecked
        : null,
      indeterminate: typeof target.indeterminate === "boolean"
        ? target.indeterminate
        : null,
      files: target.files && Array.isArray(target.files.names)
        ? {
            count: Number.isInteger(target.files.count) ? target.files.count : null,
            names: target.files.names.slice(0, 16)
          }
        : null,
      selection: target.selection && Array.isArray(target.selection.options)
        ? {
            multiple: target.selection.multiple === true,
            count: Number.isInteger(target.selection.count) ? target.selection.count : null,
            options: target.selection.options.slice(0, 16).map((option) => ({
              index: Number.isInteger(option?.index) ? option.index : null,
              value: typeof option?.value === "string" ? option.value : null,
              label: typeof option?.label === "string" ? option.label : null,
            })),
          }
        : null,
    };
  }
  return {
    connected: null,
    focused: null,
    value: null,
    checked: null,
    ariaChecked: null,
    indeterminate: null,
    files: null,
    selection: null,
    unreadable: true,
    ...(targetError ? { error: targetError } : {}),
  };
}

export function evaluateSemanticVerification({
  verification,
  frameBefore,
  frameAfter,
  targetBefore,
  targetAfter,
  targetError,
  downloadReceipt,
}) {
  const observed = {
    frameBefore: publicFrame(frameBefore),
    frameAfter: publicFrame(frameAfter),
    targetBefore: publicTarget(targetBefore),
    targetAfter: publicTarget(targetAfter, targetError),
    ...(downloadReceipt === undefined ? {} : { download: { ...downloadReceipt } }),
  };
  let matched;
  switch (verification.kind) {
    case "observe":
      matched = null;
      break;
    case "download-complete":
      matched = downloadReceipt?.state === "complete"
        && downloadReceipt?.localPathReturned === false
        && downloadReceipt?.fileExistenceVerified === false;
      break;
    case "target-text-inserted": {
      const before = typeof targetBefore?.value === "string" ? targetBefore.value : "";
      const after = targetAfter?.value;
      matched = typeof after === "string" && (verification.replace
        ? after === verification.value
        : after !== before && after.includes(verification.value));
      break;
    }
    case "target-value-equals":
      matched = targetAfter?.value === verification.value;
      break;
    case "target-value-includes":
      matched = typeof targetAfter?.value === "string"
        && targetAfter.value.includes(verification.value);
      break;
    case "target-checked":
      matched = targetAfter?.checked === verification.value
        && targetAfter?.indeterminate !== true
        && targetAfter?.ariaChecked !== "mixed";
      break;
    case "target-focused":
      matched = targetAfter?.focused === true;
      break;
    case "target-detached":
      matched = targetAfter?.connected === false
        || frameAfter?.loaderId !== frameBefore?.loaderId;
      break;
    case "target-files-set": {
      const expected = verification.value;
      const observed = targetAfter?.files;
      matched = Array.isArray(expected)
        && observed?.count === expected.length
        && Array.isArray(observed.names)
        && observed.names.length === expected.length
        && expected.every((name, index) => observed.names[index] === name);
      break;
    }
    case "target-options-selected": {
      const expected = verification.value;
      const selected = targetAfter?.selection?.options;
      if (!Array.isArray(expected)
        || !Array.isArray(selected)
        || targetAfter?.selection?.count !== expected.length
        || selected.length !== expected.length) {
        matched = false;
        break;
      }
      const remaining = new Set(selected.map((_, index) => index));
      matched = expected.every((descriptor) => {
        const matches = [...remaining].filter((index) => {
          const option = selected[index];
          if (Object.hasOwn(descriptor, "index")) return option?.index === descriptor.index;
          if (Object.hasOwn(descriptor, "value")) return option?.value === descriptor.value;
          return option?.label === descriptor.label;
        });
        if (matches.length !== 1) return false;
        remaining.delete(matches[0]);
        return true;
      }) && remaining.size === 0;
      break;
    }
    case "url-equals":
      matched = frameAfter?.url === verification.value;
      break;
    case "url-includes":
      matched = typeof frameAfter?.url === "string" && frameAfter.url.includes(verification.value);
      break;
    case "url-changed":
      matched = frameAfter?.url !== frameBefore?.url;
      break;
    case "loader-changed":
      matched = frameAfter?.loaderId !== frameBefore?.loaderId;
      break;
    default:
      matched = false;
  }
  return {
    kind: verification.kind,
    matched,
    claim: matched === null ? "observation-only" : "declarative-postcondition",
    observed,
  };
}
