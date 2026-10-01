/* Regression tests for exact Ollama model-name detection in the real background script. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, pass: !!condition });
  console.log((condition ? "PASS  " : "FAIL  ") + name + (detail ? "  -> " + detail : ""));
}

function makeBackground() {
  let tags = [];
  let messageListener;
  let installedListener;
  let menuClickListener;
  let chatResponse = null;
  let selectedText = "Senior Software Engineer";
  let activeInput = null;
  let documentIdAvailable = true;
  const menus = [];
  const tabMessages = [];
  const scriptCalls = [];
  const cssCalls = [];
  const logs = [];
  const frameDocuments = new Map([[0, "doc-top"], [2, "doc-frame"]]);
  const injectedDocuments = new Set();
  const sandbox = {
    self: {},
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    window: {
      getSelection: () => ({
        isCollapsed: !selectedText,
        toString: () => selectedText
      })
    },
    document: { get activeElement() { return activeInput; } },
    console: {
      log(...args) { logs.push(args.join(" ")); },
      warn(...args) { logs.push(args.join(" ")); },
      error(...args) { logs.push(args.join(" ")); }
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/api/version")) {
        return { ok: true, status: 200, json: async () => ({ version: "test" }) };
      }
      if (url.endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: tags }) };
      }
      if (url.endsWith("/api/chat") && chatResponse) return chatResponse(options);
      throw new Error("Unexpected fetch URL: " + url);
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onInstalled: { addListener: (listener) => { installedListener = listener; } },
        onStartup: { addListener() {} }
      },
      contextMenus: {
        create: (properties, callback) => { menus.push(properties); if (callback) callback(); },
        remove: (_id, callback) => callback(),
        onClicked: { addListener: (listener) => { menuClickListener = listener; } }
      },
      tabs: {
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
        sendMessage: async (tabId, message, options) => {
          tabMessages.push({ tabId, message, options });
          const documentId = options && options.documentId;
          if (message.type === "PING" && !injectedDocuments.has(documentId)) {
            throw new Error("No receiver");
          }
          return {};
        }
      },
      scripting: {
        insertCSS: async (details) => { cssCalls.push(details); },
        executeScript: async (details) => {
          scriptCalls.push(details);
          const target = details.target;
          const frameId = target.frameIds ? target.frameIds[0] :
            Array.from(frameDocuments.entries()).find((entry) => target.documentIds.includes(entry[1]))[0];
          const documentId = documentIdAvailable ? frameDocuments.get(frameId) : undefined;
          if (details.func) {
            const result = { frameId, result: details.func(...(details.args || [])) };
            if (documentId) result.documentId = documentId;
            return [result];
          }
          if (details.files && documentId) injectedDocuments.add(documentId);
          return [documentId ? { frameId, documentId } : { frameId }];
        }
      }
    }
  };

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (file) => {
    const source = fs.readFileSync(path.join(EXT, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), context, {
    filename: "background.js"
  });

  return {
    config: sandbox.self.LOCAL_AI_CONFIG,
    menus,
    tabMessages,
    scriptCalls,
    cssCalls,
    logs,
    install() { installedListener(); },
    clickMenu(info, tab) { return menuClickListener(info, tab); },
    setTags(value) { tags = value; },
    setSelectedText(value) { selectedText = value; },
    setActiveInput(value) { activeInput = value; },
    setDocumentIdAvailable(value) { documentIdAvailable = value; },
    setChatResponse(value) { chatResponse = value; },
    async checkConnection() {
      return new Promise((resolve) => {
        messageListener({ type: "CHECK_CONNECTION" }, {}, resolve);
      });
    },
    async translateBatch(items) {
      return new Promise((resolve) => {
        messageListener({ type: "TRANSLATE_BATCH", items }, {}, resolve);
      });
    }
  };
}

(async () => {
  const bg = makeBackground();

  bg.setTags([{ name: "qwen3.5:4b" }]);
  const exactName = await bg.checkConnection();
  check("Configured model matches the exact Ollama name field", exactName.available);

  bg.setTags([{ name: "qwen3.5:9b" }]);
  const siblingTag = await bg.checkConnection();
  check("A different size tag does not satisfy the configured model", !siblingTag.available,
    siblingTag.reason);

  bg.config.model = "llama3.1:8b";
  bg.setTags([{ model: "llama3.1:8b" }]);
  const alternateExact = await bg.checkConnection();
  check("Configured model matches the exact Ollama model field", alternateExact.available);

  bg.install();
  const menu = bg.menus[0];
  const targetTab = { id: 7, url: "https://example.com/article" };
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Senior Software Engineer",
    frameId: 2,
    documentId: "doc-frame"
  }, targetTab);
  const sent = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  const messagesBeforeMissingFrame = bg.tabMessages.length;
  await bg.clickMenu({ menuItemId: menu.id, selectionText: "No frame id" }, targetTab);
  check("A context-menu selection without a frame id fails closed",
    bg.tabMessages.length === messagesBeforeMissingFrame);
  const messagesBeforeMissingDocumentId = bg.tabMessages.length;
  bg.setDocumentIdAvailable(false);
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Senior Software Engineer",
    frameId: 2
  }, targetTab);
  bg.setDocumentIdAvailable(true);
  check("A selection fails closed when the probe cannot pin a document ID",
    bg.tabMessages.length === messagesBeforeMissingDocumentId);
  const callsBeforeMismatch = bg.scriptCalls.length;
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Old document selection",
    frameId: 2,
    documentId: "doc-frame"
  }, targetTab);
  check("A selection that no longer matches the target frame is dropped",
    bg.scriptCalls.length === callsBeforeMismatch + 1 &&
    !bg.tabMessages.some((entry) => entry.message.type === "TRANSLATE_SELECTION" &&
      entry.message.selectionText === "Old document selection"));
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "restricted",
    frameId: 0
  }, { id: 8, url: "chrome://settings" });
  await bg.clickMenu({ menuItemId: "different-menu", selectionText: "ignored" }, targetTab);
  const selectionMessages = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  check("One selection context menu routes only the selected text to an injectable tab",
    bg.menus.length === 1 && menu.title === "使用 Local AI 翻译选中文本" &&
    menu.contexts.length === 1 && menu.contexts[0] === "selection" &&
    sent.length === 1 && sent[0].tabId === 7 &&
    sent[0].message.selectionText === "Senior Software Engineer" &&
    sent[0].options.documentId === "doc-frame" &&
    sent[0].message.selectionTarget.frameId === 2 &&
    sent[0].message.selectionTarget.documentId === "doc-frame" &&
    selectionMessages.length === 1);

  const selectionProbe = bg.scriptCalls.find((call) => call.func);
  check("Selection probe and script target stay bound to the clicked frame/document",
    selectionProbe.target.frameIds[0] === 2 &&
    bg.scriptCalls.filter((call) => call.files).every((call) =>
      call.target.documentIds && call.target.documentIds[0] === "doc-frame"));

  const inputValue = "before Input selected text after";
  const inputStart = inputValue.indexOf("Input selected text");
  bg.setActiveInput({
    tagName: "INPUT",
    type: "text",
    value: inputValue,
    selectionStart: inputStart,
    selectionEnd: inputStart + "Input selected text".length
  });
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Input selected text",
    frameId: 0
  }, targetTab);
  bg.setActiveInput(null);
  const inputSelectionMessage = bg.tabMessages.find((entry) =>
    entry.message.type === "TRANSLATE_SELECTION" && entry.message.selectionText === "Input selected text");
  check("Selection probing supports selected text in ordinary text inputs",
    !!inputSelectionMessage && inputSelectionMessage.options.documentId === "doc-top");

  bg.setChatResponse(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      message: {
        content: JSON.stringify([
          { id: 1, translation: "  valid one  " },
          { id: "2", translation: "string id must be ignored" },
          { id: 3, translation: "duplicate first" },
          { id: 3, translation: "duplicate second" },
          { id: 99, translation: "unsolicited" },
          { id: 4.5, translation: "fractional" },
          { id: 5, translation: "   " }
        ])
      }
    })
  }));
  const strictIds = await bg.translateBatch([
    { id: 1, text: "one" },
    { id: 2, text: "two" },
    { id: 3, text: "three" },
    { id: 4, text: "four" },
    { id: 5, text: "five" }
  ]);
  check("Response IDs must be requested safe integers and duplicates stay missing",
    strictIds.ok && strictIds.results.length === 1 &&
    strictIds.results[0].id === 1 && strictIds.results[0].translation === "valid one");

  const duplicateRequestIds = await bg.translateBatch([
    { id: 8, text: "first" },
    { id: 8, text: "second" }
  ]);
  check("Duplicate request IDs are rejected before reaching Ollama",
    !duplicateRequestIds.ok && duplicateRequestIds.kind === "unsupported" &&
    duplicateRequestIds.error === "翻译请求无效。");

  const privateResponse = "PRIVATE_RESPONSE_BODY_DO_NOT_EXPOSE";
  let privateBodyRead = false;
  bg.setChatResponse(async () => ({
    ok: false,
    status: 500,
    text: async () => { privateBodyRead = true; return privateResponse; }
  }));
  const privateHttpError = await bg.translateBatch([{ id: 1, text: "private input" }]);
  check("HTTP error bodies stay unread and are not returned or logged",
    !privateBodyRead && privateHttpError.status === 500 &&
    !JSON.stringify(privateHttpError).includes(privateResponse) &&
    !bg.logs.join(" ").includes(privateResponse));

  bg.setChatResponse(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: privateResponse })
  }));
  const privateModelError = await bg.translateBatch([{ id: 1, text: "private input" }]);
  check("Raw Ollama JSON errors never reach the response or background logs",
    !JSON.stringify(privateModelError).includes(privateResponse) &&
    !bg.logs.join(" ").includes(privateResponse));

  bg.config.requestTimeoutMs = 5;
  bg.setChatResponse(async (options) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error(privateResponse);
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  }));
  const bodyTimeout = await bg.translateBatch([{ id: 1, text: "private input" }]);
  check("Translation deadline remains active while reading the response body",
    !bodyTimeout.ok && bodyTimeout.kind === "timeout" &&
    bodyTimeout.error.includes("超时") && !JSON.stringify(bodyTimeout).includes(privateResponse) &&
    !bg.logs.join(" ").includes(privateResponse));

  const failed = checks.filter((result) => !result.pass);
  console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " background model checks passed.");
  if (failed.length) process.exitCode = 1;
})();
