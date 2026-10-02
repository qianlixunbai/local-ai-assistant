const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const EXT = path.resolve(__dirname, "..", "browser-extension");
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "chrome-extension://" + EXTENSION_ID;
const CLIENT_ID = crypto.randomUUID();
const PROOF = crypto.randomBytes(32).toString("base64url");
const CREDENTIAL = "br1." + CLIENT_ID + "." + crypto.randomBytes(32).toString("base64url");
const TASK_ID = "00000000-0000-4000-8000-000000000001";
const identity = { profile: { id: "translate.fast", version: "m0-1", locality: "LOCAL" }, promptVersion: "translate-batch-v1" };
function task(status = "QUEUED", overrides = {}) {
  return { taskId: TASK_ID, capability: "translate", status, ...identity,
    createdAt: "2026-10-02T10:00:00Z", finishedAt: ["QUEUED", "RUNNING"].includes(status) ? null : "2026-10-02T10:00:01Z",
    result: status === "SUCCEEDED" ? { items: [{ id: 1, translation: "翻译结果" }] } : null,
    error: ["FAILED", "CANCELLED", "TIMED_OUT"].includes(status) ? { code: "INTERNAL_ERROR" } : null, ...overrides };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function makeBackground(options = {}) {
  let listener, installedListener, menuClickListener;
  let selectedText = "Senior Software Engineer", activeInput = null, documentIdAvailable = true;
  const menus = [], tabMessages = [], scriptCalls = [], cssCalls = [], logs = [], calls = [], storageEvents = [];
  const frameDocuments = new Map([[0, "doc-top"], [2, "doc-frame"]]), injectedDocuments = new Set();
  const store = options.store || (options.unpaired ? {} : { runtimePairing: { credential: CREDENTIAL, clientId: CLIENT_ID, origin: ORIGIN } });
  let responder = options.fetch || (async (url, init) => {
    if (url.endsWith("/exchange")) return json({ client: { clientId: CLIENT_ID, clientType: "browser-extension", origin: ORIGIN, allowedCapabilities: ["translate"] }, credential: CREDENTIAL });
    if (url.endsWith("/readiness")) return json({ available: true });
    if (init.method === "POST") return json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID });
    return json(task("SUCCEEDED"));
  });
  const sandbox = {
    self: {}, URL, AbortController, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    window: { getSelection: () => ({ isCollapsed: !selectedText, toString: () => selectedText }) },
    document: { get activeElement() { return activeInput; } },
    console: Object.fromEntries(["log", "warn", "error"].map(method => [method, (...args) => logs.push(args.join(" "))])),
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init, calls.length); },
    chrome: {
      runtime: { id: EXTENSION_ID,
        onMessage: { addListener: fn => { listener = fn; } },
        onInstalled: { addListener: fn => { installedListener = fn; } }, onStartup: { addListener() {} } },
      storage: { local: {
        async setAccessLevel(value) { storageEvents.push({ type: "access", value }); if (options.boundaryFail) throw new Error("PRIVATE"); },
        async get(key) { storageEvents.push({ type: "get" }); return { [key]: store[key] }; },
        async set(value) { storageEvents.push({ type: "set" }); if (options.writeFail) throw new Error("PRIVATE"); Object.assign(store, value); },
        async remove(key) { storageEvents.push({ type: "remove" }); if (options.removeFail) throw new Error("PRIVATE"); delete store[key]; }
      } },
      contextMenus: { create(properties, callback) { menus.push(properties); callback?.(); }, remove(_id, callback) { callback(); }, onClicked: { addListener: fn => { menuClickListener = fn; } } },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
        async sendMessage(tabId, message, options) {
          tabMessages.push({ tabId, message, options });
          if (message.type === "PING" && !injectedDocuments.has(options?.documentId)) throw new Error("No receiver");
          return {};
        } },
      scripting: { async insertCSS(details) { cssCalls.push(details); }, async executeScript(details) {
        scriptCalls.push(details);
        const frameId = details.target.frameIds ? details.target.frameIds[0] : [...frameDocuments].find(entry => details.target.documentIds.includes(entry[1]))[0];
        const documentId = documentIdAvailable ? frameDocuments.get(frameId) : undefined;
        if (details.files && documentId) injectedDocuments.add(documentId);
        return [{ frameId, ...(documentId ? { documentId } : {}), ...(details.func ? { result: details.func(...details.args) } : {}) }];
      } }
    }
  };
  if (options.boundaryMissing) delete sandbox.chrome.storage.local.setAccessLevel;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), context, { filename: file }));
  sandbox.importScripts("background.js");
  Object.assign(sandbox.self.LOCAL_AI_CONFIG, { runtimePollIntervalMs: 1, runtimeRequestTimeoutMs: 50, runtimeTaskDeadlineMs: 500 }, options.config);
  const popup = { id: EXTENSION_ID, url: ORIGIN + "/popup.html" };
  const content = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0, url: "https://example.com" };
  return { calls, logs, menus, tabMessages, scriptCalls, cssCalls, store, storageEvents,
    config: sandbox.self.LOCAL_AI_CONFIG,
    setFetch(fn) { responder = fn; },
    send(msg, sender = popup) { return new Promise(resolve => { if (listener(msg, sender, resolve) === false) resolve(undefined); }); },
    translateBatch(items) { return this.send({ type: "TRANSLATE_BATCH", items }, content); },
    checkConnection() { return this.send({ type: "CHECK_CONNECTION" }); },
    install() { installedListener(); }, clickMenu(info, tab) { return menuClickListener(info, tab); },
    setSelectedText(value) { selectedText = value; }, setActiveInput(value) { activeInput = value; },
    setDocumentIdAvailable(value) { documentIdAvailable = value; }, popup, content };
}
module.exports = { makeBackground, task, json, identity, TASK_ID, PROOF, CREDENTIAL, CLIENT_ID, ORIGIN };
