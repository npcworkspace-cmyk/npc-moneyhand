export const SEMANTIC_LOCATOR_KINDS = Object.freeze(["role", "css"]);
export const SEMANTIC_LOCATOR_STATES = Object.freeze(["attached", "actionable"]);

const KIND_SET = new Set(SEMANTIC_LOCATOR_KINDS);
const STATE_SET = new Set(SEMANTIC_LOCATOR_STATES);
const LOCATOR_KEYS = new Set(["kind", "role", "name", "value", "confidence", "frameId"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

export function normalizeSemanticLocator(value) {
  const input = object(value, "semantic locator");
  const unknown = Object.keys(input).filter((key) => !LOCATOR_KEYS.has(key));
  if (unknown.length) {
    throw new TypeError(`semantic locator has unsupported field(s): ${unknown.join(", ")}`);
  }
  if (typeof input.kind !== "string" || !KIND_SET.has(input.kind)) {
    throw new TypeError(`semantic locator kind must be one of: ${SEMANTIC_LOCATOR_KINDS.join(", ")}`);
  }
  const frame = input.frameId === undefined
    ? {}
    : { frameId: text(input.frameId, "semantic locator frameId", 256) };
  if (input.kind === "css") {
    if (input.role !== undefined || input.name !== undefined) {
      throw new TypeError("css semantic locator accepts value only");
    }
    return {
      kind: "css",
      value: text(input.value, "semantic locator value", 2_048),
      ...frame,
    };
  }
  if (input.value !== undefined) {
    throw new TypeError("role semantic locator accepts role and name only");
  }
  return {
    kind: "role",
    role: text(input.role, "semantic locator role", 100),
    name: text(input.name, "semantic locator name", 500),
    ...frame,
  };
}

export function normalizeSemanticLocatorState(value) {
  const state = value === undefined ? "actionable" : value;
  if (typeof state !== "string" || !STATE_SET.has(state)) {
    throw new TypeError(`semantic locator state must be one of: ${SEMANTIC_LOCATOR_STATES.join(", ")}`);
  }
  return state;
}

function sameLocator(node, locator) {
  if (locator.frameId !== undefined && node?.frame?.frameId !== locator.frameId) return false;
  if (locator.kind === "role") {
    return node?.role === locator.role && node?.name === locator.name;
  }
  return node?.locator?.kind === "css" && node.locator.value === locator.value;
}

export function matchSemanticLocator(nodesValue, locatorValue, stateValue) {
  const locator = normalizeSemanticLocator(locatorValue);
  const state = normalizeSemanticLocatorState(stateValue);
  const nodes = Array.isArray(nodesValue) ? nodesValue : [];
  const matches = nodes.filter((node) => sameLocator(node, locator));
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      count: matches.length,
      refs: matches.slice(0, 16).map((node) => node.ref),
    };
  }
  if (matches.length === 0) return { status: "missing", count: 0 };
  const node = matches[0];
  if (state === "actionable") {
    if (node.actionable !== true) {
      return { status: "not-ready", count: 1, reason: "not-actionable", node };
    }
    if (!Number.isInteger(node.backendNodeId) || node.backendNodeId < 1) {
      return { status: "not-ready", count: 1, reason: "backend-node-unavailable", node };
    }
    if (node.properties?.disabled === true) {
      return { status: "not-ready", count: 1, reason: "disabled", node };
    }
  }
  return { status: "matched", count: 1, node };
}

export function semanticLocatorStabilityKey(snapshot, node, locatorValue, stateValue) {
  const locator = normalizeSemanticLocator(locatorValue);
  const state = normalizeSemanticLocatorState(stateValue);
  return JSON.stringify({
    sessionSelector: snapshot?.sessionSelector,
    guard: snapshot?.guard,
    locator,
    state,
    semanticTarget: {
      frameId: node?.frame?.frameId,
      sessionId: node?.frame?.sessionId,
      targetId: node?.frame?.targetId,
      parentFrameId: node?.frame?.parentFrameId,
      loaderId: node?.frame?.loaderId,
      url: node?.frame?.url,
      role: node?.role,
      name: node?.name,
      tag: node?.tag,
      actionable: node?.actionable === true,
      disabled: node?.properties?.disabled === true,
    },
  });
}
