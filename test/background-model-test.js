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
  const menus = [];
  const tabMessages = [];
  const sandbox = {
    self: {},
    URL,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => {
      if (url.endsWith("/api/version")) {
        return { ok: true, status: 200, json: async () => ({ version: "test" }) };
      }
      if (url.endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: tags }) };
      }
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
        sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message }); return {}; }
      },
      scripting: { insertCSS: async () => {}, executeScript: async () => {} }
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
    install() { installedListener(); },
    clickMenu(info, tab) { return menuClickListener(info, tab); },
    setTags(value) { tags = value; },
    async checkConnection() {
      return new Promise((resolve) => {
        messageListener({ type: "CHECK_CONNECTION" }, {}, resolve);
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
  await bg.clickMenu({ menuItemId: menu.id, selectionText: "Senior Software Engineer" }, targetTab);
  const sent = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  await bg.clickMenu({ menuItemId: menu.id, selectionText: "restricted" }, { id: 8, url: "chrome://settings" });
  await bg.clickMenu({ menuItemId: "different-menu", selectionText: "ignored" }, targetTab);
  const selectionMessages = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  check("One selection context menu routes only the selected text to an injectable tab",
    bg.menus.length === 1 && menu.title === "使用 Local AI 翻译选中文本" &&
    menu.contexts.length === 1 && menu.contexts[0] === "selection" &&
    sent.length === 1 && sent[0].tabId === 7 &&
    sent[0].message.selectionText === "Senior Software Engineer" &&
    selectionMessages.length === 1);

  const failed = checks.filter((result) => !result.pass);
  console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " background model checks passed.");
  if (failed.length) process.exitCode = 1;
})();
