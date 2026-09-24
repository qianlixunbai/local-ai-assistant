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
  const sandbox = {
    self: {},
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
      runtime: { onMessage: { addListener: (listener) => { messageListener = listener; } } },
      tabs: {
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
        sendMessage: async () => ({})
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

  bg.setTags([{ model: "qwen3.5:4b" }]);
  const exactModel = await bg.checkConnection();
  check("Configured model matches the exact Ollama model field", exactModel.available);

  bg.config.model = "llama3.1:8b";
  bg.setTags([{ name: "llama3.1:8b" }]);
  const alternateExact = await bg.checkConnection();
  check("Exact matching follows a changed configured model", alternateExact.available);

  const failed = checks.filter((result) => !result.pass);
  console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " background model checks passed.");
  if (failed.length) process.exitCode = 1;
})();
