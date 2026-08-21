const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const CONTENT_ROLES = new Set([
  "alert",
  "cell",
  "columnheader",
  "dialog",
  "heading",
  "img",
  "listitem",
  "main",
  "navigation",
  "row",
  "rowheader",
  "status",
  "StaticText",
]);

const LOCATOR_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "id", "name"];
const AX_PROPERTIES = [
  "checked",
  "disabled",
  "expanded",
  "focused",
  "haspopup",
  "invalid",
  "level",
  "pressed",
  "readonly",
  "required",
  "selected",
  "url",
];

function valueOf(value) {
  return value && Object.hasOwn(value, "value") ? value.value : undefined;
}

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 && index < strings.length
    ? strings[index]
    : "";
}

function attributesAt(nodes, index, strings) {
  const encoded = nodes?.attributes?.[index];
  if (!Array.isArray(encoded)) return {};
  const attributes = {};
  for (let offset = 0; offset + 1 < encoded.length; offset += 2) {
    const name = stringAt(strings, encoded[offset]);
    if (!name) continue;
    attributes[name] = stringAt(strings, encoded[offset + 1]);
  }
  return attributes;
}

function layoutBounds(document, nodeIndex) {
  const layoutIndex = document?.layout?.nodeIndex?.indexOf(nodeIndex) ?? -1;
  if (layoutIndex < 0) return undefined;
  const bounds = document.layout.bounds?.[layoutIndex];
  if (!Array.isArray(bounds) || bounds.length < 4 || bounds.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  return {
    x: bounds[0],
    y: bounds[1],
    width: bounds[2],
    height: bounds[3],
    coordinateSpace: "document-css-v1",
  };
}

function domRecords(domSnapshot, frameFilter) {
  const strings = Array.isArray(domSnapshot?.strings) ? domSnapshot.strings : [];
  const records = new Map();
  for (const [documentIndex, document] of (domSnapshot?.documents ?? []).entries()) {
    const nodes = document?.nodes;
    if (!nodes || !Array.isArray(nodes.backendNodeId)) continue;
    const frameId = stringAt(strings, document?.frameId);
    if (typeof frameFilter === "string" && frameId !== frameFilter) continue;
    for (let nodeIndex = 0; nodeIndex < nodes.backendNodeId.length; nodeIndex += 1) {
      const backendNodeId = nodes.backendNodeId[nodeIndex];
      if (!Number.isInteger(backendNodeId) || backendNodeId < 1) continue;
      records.set(backendNodeId, {
        backendNodeId,
        documentIndex,
        frameId,
        nodeIndex,
        tag: stringAt(strings, nodes.nodeName?.[nodeIndex]).toLowerCase(),
        attributes: attributesAt(nodes, nodeIndex, strings),
        bounds: layoutBounds(document, nodeIndex),
      });
    }
  }
  return records;
}

function locatorCounts(records) {
  const counts = new Map();
  for (const record of records.values()) {
    for (const attribute of LOCATOR_ATTRIBUTES) {
      const value = record.attributes[attribute];
      if (!value) continue;
      const key = `${attribute}\n${value}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function cssIdentifier(value) {
  return Array.from(value).map((character, index) => {
    const code = character.codePointAt(0);
    const safe = /[A-Za-z0-9_-]/u.test(character)
      && !(index === 0 && /[0-9]/u.test(character));
    return safe ? character : `\\${code.toString(16)} `;
  }).join("");
}

function cssAttribute(value) {
  return JSON.stringify(String(value)).replaceAll("\\u2028", "\\2028 ").replaceAll("\\u2029", "\\2029 ");
}

function stableLocator(record, role, name, counts) {
  if (record) {
    const id = record.attributes.id;
    if (id && counts.get(`id\n${id}`) === 1) {
      return { kind: "css", value: `#${cssIdentifier(id)}`, confidence: "unique-snapshot" };
    }
    for (const attribute of ["data-testid", "data-test", "data-qa"]) {
      const value = record.attributes[attribute];
      if (value && counts.get(`${attribute}\n${value}`) === 1) {
        return {
          kind: "css",
          value: `[${attribute}=${cssAttribute(value)}]`,
          confidence: "unique-snapshot",
        };
      }
    }
    const controlName = record.attributes.name;
    if (controlName && counts.get(`name\n${controlName}`) === 1 && record.tag) {
      return {
        kind: "css",
        value: `${record.tag}[name=${cssAttribute(controlName)}]`,
        confidence: "unique-snapshot",
      };
    }
  }
  if (role && name) {
    return { kind: "role", role, name, confidence: "semantic" };
  }
  return undefined;
}

function axProperties(node) {
  const source = new Map((node?.properties ?? []).map((property) => [property.name, valueOf(property.value)]));
  const output = {};
  for (const name of AX_PROPERTIES) {
    if (source.has(name)) output[name] = source.get(name);
  }
  return output;
}

function compactText(value, maximum = 500) {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function compactHref(value) {
  return typeof value === "string" ? value.trim().slice(0, 16_384) : "";
}

function shouldInclude(node, role, name, value, includeIgnored) {
  if (node?.ignored === true && !includeIgnored) return false;
  if (ACTIONABLE_ROLES.has(role) || CONTENT_ROLES.has(role)) return true;
  return Boolean(name || value) && role !== "generic" && role !== "none";
}

function contentLine(node) {
  const parts = [node.ref, node.role || "node"];
  if (node.frame?.topLevel === false) parts.push(`frame=${JSON.stringify(node.frame.frameId)}`);
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.href) parts.push(`href=${JSON.stringify(node.href)}`);
  for (const [name, value] of Object.entries(node.properties)) {
    parts.push(`${name}=${JSON.stringify(value)}`);
  }
  if (node.locator?.kind === "css") parts.push(`locator=${JSON.stringify(node.locator.value)}`);
  if (node.locator?.kind === "role") {
    parts.push(`locator=role:${node.locator.role}[name=${JSON.stringify(node.locator.name)}]`);
  }
  return parts.join(" ");
}

function nodeFrame(frame) {
  if (!frame) return undefined;
  return {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    url: frame.url,
    depth: frame.depth,
    topLevel: frame.topLevel === true,
    ...(typeof frame.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
    ...(typeof frame.targetId === "string" ? { targetId: frame.targetId } : {}),
    ...(typeof frame.parentFrameId === "string" ? { parentFrameId: frame.parentFrameId } : {}),
  };
}

function semanticCandidates(options = {}) {
  const domSnapshot = options.domSnapshot ?? {};
  const axTree = options.axTree ?? {};
  const includeIgnored = options.includeIgnored === true;
  const frame = options.frame;
  const frameKey = frame?.frameId ?? "main";
  const records = domRecords(domSnapshot, frame?.frameId);
  const counts = locatorCounts(records);
  const candidates = [];

  for (const node of axTree?.nodes ?? []) {
    if (frame?.frameId
      && typeof node?.frameId === "string"
      && node.frameId !== frame.frameId) continue;
    const role = compactText(valueOf(node.role), 100);
    const name = compactText(valueOf(node.name));
    const value = compactText(valueOf(node.value));
    if (!shouldInclude(node, role, name, value, includeIgnored)) continue;
    const backendNodeId = Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : undefined;
    const record = backendNodeId === undefined ? undefined : records.get(backendNodeId);
    const locator = stableLocator(record, role, name, counts);
    if (locator && frame?.frameId) locator.frameId = frame.frameId;
    const properties = axProperties(node);
    const href = compactHref(record?.attributes.href || properties.url);
    const axNodeId = String(node.nodeId ?? "");
    const parentAxNodeId = node.parentId === undefined ? undefined : String(node.parentId);
    candidates.push({
      axNodeId,
      axNodeKey: `${frameKey}\n${axNodeId}`,
      backendNodeId,
      role,
      name,
      value,
      description: compactText(valueOf(node.description)),
      properties,
      ...(href ? { href } : {}),
      actionable: ACTIONABLE_ROLES.has(role),
      locator,
      bounds: record?.bounds,
      tag: record?.tag || undefined,
      frame: nodeFrame(frame),
      parentAxNodeKey: parentAxNodeId === undefined
        ? undefined
        : `${frameKey}\n${parentAxNodeId}`,
    });
  }
  return candidates;
}

function finalizeSemanticCandidates(candidates, maxNodesValue) {
  const maxNodes = Number.isInteger(maxNodesValue)
    ? Math.max(1, Math.min(2_000, maxNodesValue))
    : 400;

  const truncated = candidates.length > maxNodes;
  const selected = candidates.slice(0, maxNodes);
  const refsByAxNode = new Map();
  for (const [index, node] of selected.entries()) {
    node.ref = `@${index + 1}`;
    refsByAxNode.set(node.axNodeKey, node.ref);
  }
  for (const node of selected) {
    node.parentRef = refsByAxNode.get(node.parentAxNodeKey);
    delete node.axNodeKey;
    delete node.parentAxNodeKey;
    if (node.frame === undefined) delete node.frame;
  }
  return {
    nodes: selected,
    content: selected.map(contentLine).join("\n"),
    totalCandidates: candidates.length,
    truncated,
  };
}

export function buildSemanticSnapshot(options = {}) {
  return finalizeSemanticCandidates(semanticCandidates(options), options.maxNodes);
}

export function buildFrameSemanticSnapshot(options = {}) {
  const frames = Array.isArray(options.frames) ? options.frames : [];
  const candidates = frames.flatMap((frame) => semanticCandidates({
    domSnapshot: frame.domSnapshot,
    axTree: frame.axTree,
    includeIgnored: options.includeIgnored,
    frame,
  }));
  return finalizeSemanticCandidates(candidates, options.maxNodes);
}
