const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const OWNERS = new Set(["agent", "user"]);

export class TaskSpaceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TaskSpaceError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function validId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) {
    throw new TaskSpaceError(
      "INVALID_TASK_SPACE",
      "taskSpace id must use 1-128 letters, numbers, '.', '_', ':' or '-'",
    );
  }
  return value;
}

function selector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.instanceId !== "string" || typeof value.bootId !== "string") {
    throw new TaskSpaceError(
      "INVALID_TASK_SPACE",
      "taskSpace selector requires instanceId and bootId",
    );
  }
  return {
    ...(typeof value.profile === "string" ? { profile: value.profile } : {}),
    instanceId: value.instanceId,
    bootId: value.bootId,
  };
}

function tabIds(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 256
    || values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new TaskSpaceError("INVALID_TASK_SPACE", "taskSpace tabIds must be positive integers");
  }
  return [...new Set(values)];
}

function publicSpace(space) {
  return {
    id: space.id,
    name: space.name,
    ownership: space.ownership,
    state: space.state,
    selector: { ...space.selector },
    tabIds: [...space.tabIds],
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    handedOffAt: space.handedOffAt,
    completedAt: space.completedAt,
    keep: space.keep,
  };
}

function confirmedByUser(value) {
  return Boolean(value
    && typeof value === "object"
    && value.approved === true
    && value.source === "user"
    && typeof value.confirmedAt === "string"
    && !Number.isNaN(Date.parse(value.confirmedAt)));
}

export class TaskSpaceRegistry {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.maximum = Number.isInteger(options.maximum) ? options.maximum : 64;
    this.spaces = new Map();
  }

  create(input = {}) {
    const id = validId(input.id);
    if (this.spaces.has(id)) {
      throw new TaskSpaceError("TASK_SPACE_EXISTS", `taskSpace '${id}' already exists`);
    }
    if (this.spaces.size >= this.maximum) {
      throw new TaskSpaceError("TASK_SPACE_LIMIT", `taskSpace limit ${this.maximum} reached`);
    }
    const timestamp = new Date(this.now()).toISOString();
    const space = {
      id,
      name: typeof input.name === "string" ? input.name.slice(0, 200) : id,
      ownership: "agent",
      state: "active",
      selector: selector(input.selector),
      tabIds: tabIds(input.tabIds),
      createdAt: timestamp,
      updatedAt: timestamp,
      handedOffAt: null,
      completedAt: null,
      keep: null,
    };
    this.spaces.set(id, space);
    return publicSpace(space);
  }

  list() {
    return [...this.spaces.values()].map(publicSpace);
  }

  get(id) {
    const space = this.spaces.get(validId(id));
    if (!space) throw new TaskSpaceError("TASK_SPACE_NOT_FOUND", `taskSpace '${id}' not found`);
    return space;
  }

  assertAgentControl(id) {
    const space = this.get(id);
    if (space.state !== "active") {
      throw new TaskSpaceError("TASK_SPACE_COMPLETE", `taskSpace '${id}' is complete`);
    }
    if (space.ownership !== "agent") {
      throw new TaskSpaceError(
        "USER_CONTROL_ACTIVE",
        `taskSpace '${id}' is controlled by the user`,
      );
    }
    return publicSpace(space);
  }

  handOff(id) {
    const space = this.get(id);
    if (space.state !== "active") {
      throw new TaskSpaceError("TASK_SPACE_COMPLETE", `taskSpace '${id}' is complete`);
    }
    if (space.ownership === "user") return publicSpace(space);
    const timestamp = new Date(this.now()).toISOString();
    space.ownership = "user";
    space.handedOffAt = timestamp;
    space.updatedAt = timestamp;
    return publicSpace(space);
  }

  takeOver(id, confirmation) {
    const space = this.get(id);
    if (space.state !== "active") {
      throw new TaskSpaceError("TASK_SPACE_COMPLETE", `taskSpace '${id}' is complete`);
    }
    if (space.ownership === "agent") return publicSpace(space);
    if (!confirmedByUser(confirmation)) {
      throw new TaskSpaceError(
        "CONTROL_CONFIRMATION_REQUIRED",
        "takeOverTaskSpace requires an explicit user confirmation record",
      );
    }
    space.ownership = "agent";
    space.updatedAt = new Date(this.now()).toISOString();
    return publicSpace(space);
  }

  complete(id, options = {}) {
    const space = this.get(id);
    if (typeof options.keep !== "boolean") {
      throw new TaskSpaceError("INVALID_TASK_SPACE", "completeTaskSpace requires keep:boolean");
    }
    if (space.ownership === "user" && !confirmedByUser(options.confirmation)) {
      throw new TaskSpaceError(
        "USER_CONTROL_ACTIVE",
        "Completing a user-controlled taskSpace requires explicit user confirmation",
      );
    }
    if (space.state === "complete") return publicSpace(space);
    const timestamp = new Date(this.now()).toISOString();
    space.state = "complete";
    space.keep = options.keep;
    space.completedAt = timestamp;
    space.updatedAt = timestamp;
    const completed = publicSpace(space);
    if (!space.keep) this.spaces.delete(space.id);
    return completed;
  }
}

export function taskSpaceRequestTabIds(request = {}) {
  const ids = new Set();
  const collect = (method, params) => {
    if (!params || typeof params !== "object") return;
    if (Number.isInteger(params.tabId)) ids.add(params.tabId);
    if (Number.isInteger(params.target?.tabId)) ids.add(params.target.tabId);
    if (method === "chrome.call" && typeof params.method === "string") {
      const first = params.args?.[0];
      if (params.method === "tabs.remove") {
        for (const value of Array.isArray(first) ? first : [first]) {
          if (Number.isInteger(value)) ids.add(value);
        }
      } else if ([
        "tabs.get",
        "tabs.update",
        "tabs.reload",
        "tabs.goBack",
        "tabs.goForward",
        "tabs.duplicate",
      ].includes(params.method) && Number.isInteger(first)) {
        ids.add(first);
      }
    }
  };
  collect(request.method, request.params);
  if (request.method === "batch.run") {
    for (const step of request.params?.steps ?? []) collect(step?.method, step?.params);
  }
  return [...ids];
}

export function taskSpaceHasUnscopedMutation(request = {}) {
  const readOnlyChromeCalls = new Set([
    "tabs.query",
    "tabs.get",
    "windows.get",
    "windows.getAll",
    "windows.getCurrent",
    "windows.getLastFocused",
    "downloads.search",
  ]);
  const scopedTabMutations = new Set([
    "tabs.update",
    "tabs.remove",
    "tabs.reload",
    "tabs.goBack",
    "tabs.goForward",
    "tabs.duplicate",
  ]);
  const check = (method, params) => method === "chrome.call"
    && typeof params?.method === "string"
    && !readOnlyChromeCalls.has(params.method)
    && !scopedTabMutations.has(params.method);
  if (check(request.method, request.params)) return true;
  return request.method === "batch.run"
    && (request.params?.steps ?? []).some((step) => check(step?.method, step?.params));
}
