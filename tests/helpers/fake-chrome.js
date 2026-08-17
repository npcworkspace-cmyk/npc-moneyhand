export class ChromeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(...args) {
    for (const listener of this.listeners) listener(...args);
  }
}

export function createFakeChrome() {
  const calls = [];
  const attached = new Set();
  const handlers = new Map();
  const tabs = new Map([
    [1, { id: 1, windowId: 1, active: true, status: "complete", url: "https://example.com/", title: "Example" }],
    [2, { id: 2, windowId: 1, active: false, status: "complete", url: "https://example.org/", title: "Example Two" }],
  ]);
  const storage = {};
  const sessionStorage = {};
  let nextTabId = 3;

  const events = {
    debuggerEvent: new ChromeEvent(),
    debuggerDetach: new ChromeEvent(),
    tabRemoved: new ChromeEvent(),
    tabCreated: new ChromeEvent(),
    tabActivated: new ChromeEvent(),
    runtimeMessage: new ChromeEvent(),
    runtimeStartup: new ChromeEvent(),
    runtimeInstalled: new ChromeEvent(),
    alarm: new ChromeEvent(),
    windowFocus: new ChromeEvent(),
  };

  const chrome = {
    action: {
      async setIcon(details) {
        calls.push({ api: "action.setIcon", details });
      },
    },
    alarms: {
      onAlarm: events.alarm,
      async create(name, alarmInfo) {
        calls.push({ api: "alarms.create", name, alarmInfo });
      },
      async clear(name) {
        calls.push({ api: "alarms.clear", name });
        return true;
      },
    },
    debugger: {
      onEvent: events.debuggerEvent,
      onDetach: events.debuggerDetach,
      async attach(target, version) {
        calls.push({ api: "debugger.attach", target: { ...target }, version });
        if (attached.has(target.tabId)) throw new Error("Another debugger is already attached");
        attached.add(target.tabId);
      },
      async detach(target) {
        calls.push({ api: "debugger.detach", target: { ...target } });
        attached.delete(target.tabId);
      },
      async getTargets() {
        return [...tabs.values()].map((tab) => ({
          id: String(tab.id),
          tabId: tab.id,
          type: "page",
          attached: attached.has(tab.id),
          title: tab.title,
          url: tab.url,
        }));
      },
      async sendCommand(target, method, params = {}) {
        calls.push({ api: "debugger.sendCommand", target: { ...target }, method, params });
        const handler = handlers.get(method);
        if (handler instanceof Error) throw handler;
        if (typeof handler === "function") return await handler(target, params);
        if (handler !== undefined) return structuredClone(handler);
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                url: tabs.get(target.tabId)?.url || "",
                title: tabs.get(target.tabId)?.title || "",
                readyState: "complete",
                text: "Example page text",
                textTruncated: false,
                controls: [],
              },
            },
          };
        }
        if (method === "Page.captureScreenshot") return { data: "cG5n" };
        return { method, params };
      },
    },
    tabs: {
      onRemoved: events.tabRemoved,
      onCreated: events.tabCreated,
      onActivated: events.tabActivated,
      async query(query = {}) {
        const values = [...tabs.values()];
        if (query.active) return values.filter((tab) => tab.active);
        return values;
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      async create(properties = {}) {
        const tab = {
          id: nextTabId++,
          windowId: 1,
          active: Boolean(properties.active),
          status: "loading",
          url: properties.url || "about:blank",
          title: "",
        };
        tabs.set(tab.id, tab);
        events.tabCreated.emit({ ...tab });
        return { ...tab };
      },
      async update(tabId, properties) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        Object.assign(tab, properties);
        return { ...tab };
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          tabs.delete(tabId);
          events.tabRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
        }
      },
      async reload() {},
      async goBack() {},
      async goForward() {},
      async duplicate(tabId) {
        return await chrome.tabs.create({ url: tabs.get(tabId)?.url });
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.windowFocus,
      async get(windowId) {
        return { id: windowId, focused: true, type: "normal" };
      },
      async getAll() {
        return [{ id: 1, focused: true, type: "normal" }];
      },
      async getCurrent() {
        return { id: 1, focused: true, type: "normal" };
      },
      async getLastFocused() {
        return { id: 1, focused: true, type: "normal" };
      },
      async create(properties) {
        return { id: 2, focused: Boolean(properties?.focused), type: "normal" };
      },
      async update(windowId, properties) {
        return { id: windowId, ...properties };
      },
      async remove() {},
    },
    downloads: {
      async download() {
        return 1;
      },
      async search() {
        return [];
      },
      async pause() {},
      async resume() {},
      async cancel() {},
      async erase() {
        return [];
      },
      async removeFile() {},
      async open() {},
      async show() {
        return true;
      },
    },
    storage: {
      local: {
        async get(defaults = {}) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
      session: {
        async get(defaults = {}) {
          return { ...defaults, ...sessionStorage };
        },
        async set(values) {
          Object.assign(sessionStorage, values);
        },
      },
    },
    runtime: {
      onMessage: events.runtimeMessage,
      onStartup: events.runtimeStartup,
      onInstalled: events.runtimeInstalled,
      getManifest() {
        return { name: "npc-moneyhand", version: "2.0.0", version_name: "2.0.0-alpha.6" };
      },
      async getPlatformInfo() {
        return { os: "win", arch: "x86-64" };
      },
    },
  };

  return {
    chrome,
    calls,
    attached,
    events,
    handlers,
    storage,
    sessionStorage,
    tabs,
  };
}
