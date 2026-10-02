/* High-value lifecycle and tab-isolation checks for the real popup script. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const POPUP_JS = fs.readFileSync(
  path.resolve(__dirname, "..", "browser-extension", "popup.js"),
  "utf8"
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makePopup(options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.resolve(__dirname, "..", "browser-extension", "popup.html"), "utf8"),
    { url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html", runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window.document, "readyState", { configurable: true, value: "complete" });

  const backgroundMessages = [];
  const tabMessages = [];
  const runtimeListeners = [];
  let ensureCount = 0;
  let holdNextCheck = false;
  let pendingCheck = null;
  let getStatusResult = options.getStatusResult || {
    ok: true, status: "idle", operationId: null, sessionGeneration: 0
  };

  window.console = { log() {}, warn() {}, error() {} };
  window.chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      sendMessage(message) {
        backgroundMessages.push(message);
        if (message.type === "GET_PAIRING") return Promise.resolve({ ok: true, paired: options.paired !== false, pairing: options.paired === false ? "unpaired" : "paired" });
        if (message.type === "PAIR") return options.pairResponse ? options.pairResponse(message) : Promise.resolve({ ok: true, paired: true, pairing: "paired" });
        if (message.type === "FORGET_PAIRING") return Promise.resolve({ ok: true, paired: false, pairing: "unpaired" });
        if (message.type === "ENSURE_CONTENT_SCRIPT") {
          ensureCount += 1;
          const initializedContentPresent = options.ensureOnInit === true;
          return Promise.resolve({ ok: ensureCount > 1 || (ensureCount === 1 && initializedContentPresent) });
        }
        if (message.type === "CHECK_CONNECTION") {
          if (holdNextCheck) {
            holdNextCheck = false;
            pendingCheck = deferred();
            return pendingCheck.promise;
          }
          return Promise.resolve(options.readiness || { ok: true, paired: options.paired !== false, pairing: options.paired === false ? "unpaired" : "paired", online: true, available: options.paired !== false });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) }
    },
    tabs: {
      query: async () => [{ id: 22, url: "https://example.com/article" }],
      sendMessage: async (tabId, message, options) => {
        tabMessages.push({ tabId, message, options });
        if (message.type === "GET_STATUS") return getStatusResult;
        if (message.type === "RESTORE_PAGE") return { ok: true, removed: 1 };
        if (message.type === "TRANSLATE_PAGE") {
          return { ok: true, translated: 1, failed: 0, total: 1, watching: false };
        }
        return { ok: true };
      }
    }
  };

  window.eval(POPUP_JS);
  const byId = (id) => window.document.getElementById(id);
  async function waitFor(predicate, message) {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await wait(2);
    }
    throw new Error("Timed out waiting for " + message);
  }
  function emitProgress(progress, tabId = 22, frameId) {
    runtimeListeners.forEach((listener) => listener(
      { type: "TRANSLATION_PROGRESS", progress },
      { tab: { id: tabId }, frameId }
    ));
  }

  return {
    backgroundMessages,
    tabMessages,
    waitFor,
    emitProgress,
    holdConnectionCheck() { holdNextCheck = true; },
    get pendingCheck() { return pendingCheck; },
    byId,
    window,
    setStatusResult(value) { getStatusResult = value; }
  };
}

async function testRestoreCancelsTranslatePreflightAndBProgressIsScoped() {
  const popup = makePopup();
  await popup.waitFor(() => popup.byId("btnTranslate").disabled === false &&
    popup.backgroundMessages.some((m) => m.type === "CHECK_CONNECTION"), "popup initialization");

  popup.holdConnectionCheck();
  popup.byId("btnTranslate").click();
  await popup.waitFor(() => !!popup.pendingCheck, "Translate connection preflight");

  popup.byId("btnRestore").click();
  await popup.waitFor(() => popup.tabMessages.some((entry) => entry.message.type === "RESTORE_PAGE") &&
    popup.byId("statusText").textContent.startsWith("已恢复原文"), "Restore completion");

  popup.byId("btnTranslate").click();
  await popup.waitFor(() => popup.tabMessages.some((entry) => entry.message.type === "TRANSLATE_PAGE"),
    "the replacement Translate operation");
  const pageMessagesAfterReplacement = popup.tabMessages.slice();
  const finalStatus = popup.byId("statusText").textContent;
  const restore = popup.tabMessages.find((entry) => entry.message.type === "RESTORE_PAGE").message;
  const reset = popup.tabMessages.find((entry) => entry.message.type === "LAT_RESET").message;
  const translate = popup.tabMessages.find((entry) => entry.message.type === "TRANSLATE_PAGE").message;
  assert.ok(restore.operationId, "Restore carries its popup operation identity");
  assert.ok(reset.operationId, "LAT_RESET carries its popup operation identity");
  assert.strictEqual(reset.operationId, translate.operationId,
    "LAT_RESET and TRANSLATE_PAGE belong to the same Translate operation");
  assert.notStrictEqual(restore.operationId, translate.operationId,
    "Restore and the later Translate operation have distinct identities");
  assert(popup.tabMessages.every((entry) => entry.options && entry.options.frameId === 0),
    "popup page operations target only the top frame");

  popup.pendingCheck.resolve({ ok: true, paired: true, pairing: "paired", online: true, available: true });
  await wait(0);
  assert.deepStrictEqual(popup.tabMessages, pageMessagesAfterReplacement,
    "a stale preflight must not continue to GET_STATUS, LAT_RESET, or TRANSLATE_PAGE");
  assert.strictEqual(popup.byId("statusText").textContent, finalStatus,
    "the old Translate finally must not replace the newer operation's UI");

  const sessionGeneration = 9;
  popup.emitProgress({
    status: "dynamic-translating", done: 1, total: 2,
    operationId: translate.operationId, sessionGeneration
  }, 11);
  assert.strictEqual(popup.byId("statusText").textContent, finalStatus,
    "progress from another tab is ignored");

  popup.emitProgress({
    status: "partial", done: 1, total: 2,
    operationId: restore.operationId, sessionGeneration
  });
  assert.strictEqual(popup.byId("statusText").textContent, finalStatus,
    "progress from a superseded page operation is ignored");

  popup.emitProgress({
    status: "partial", done: 1, total: 2,
    operationId: translate.operationId, sessionGeneration
  }, 22, 5);
  assert.strictEqual(popup.byId("statusText").textContent, finalStatus,
    "progress from a non-top frame is ignored");

  popup.emitProgress({
    status: "dynamic-translating", done: 1, total: 2,
    operationId: translate.operationId, sessionGeneration
  });
  assert.match(popup.byId("statusText").textContent, /发现新内容/,
    "progress from the current operation in the active tab is shown");

  popup.emitProgress({
    status: "partial", done: 1, total: 2,
    operationId: translate.operationId, sessionGeneration: sessionGeneration - 1
  });
  assert.match(popup.byId("statusText").textContent, /发现新内容/,
    "progress from an older content session is ignored");
}

async function testReopenedPopupTracksExistingPageOperation() {
  const popup = makePopup({ getStatusResult: {
    ok: true, status: "translating", operationId: "existing-popup:17", sessionGeneration: 31
  }, ensureOnInit: true });
  await popup.waitFor(() => popup.byId("statusText").textContent === "正在翻译..." &&
    popup.backgroundMessages.some((m) => m.type === "CHECK_CONNECTION"), "reopened page status");

  popup.emitProgress({
    status: "translating", done: 3, total: 8,
    operationId: "existing-popup:17", sessionGeneration: 31
  });
  assert.match(popup.byId("statusText").textContent, /3 \/ 8 段/,
    "GET_STATUS metadata lets a reopened popup follow the existing page task");
  popup.emitProgress({
    status: "translated", done: 8, total: 8,
    operationId: "other-popup:4", sessionGeneration: 31
  });
  assert.match(popup.byId("statusText").textContent, /3 \/ 8 段/,
    "unknown task metadata does not replace the tracked task's status");
}

(async () => {
  await testRestoreCancelsTranslatePreflightAndBProgressIsScoped();
  console.log("PASS  Restore invalidates stale Translate preflight and progress is scoped to tab/operation/session");
  await testReopenedPopupTracksExistingPageOperation();
  console.log("PASS  a reopened popup follows only the operation reported by GET_STATUS");
  const pairing = makePopup({ paired: false, pairResponse: async () => ({ ok: false, kind: "pairingUnknown", error: "配对状态未知，请查看 Paired Browsers。" }) });
  await pairing.waitFor(() => pairing.backgroundMessages.some(m => m.type === "CHECK_CONNECTION"), "unpaired initialization");
  assert(pairing.byId("btnTranslate").disabled);
  assert.strictEqual(pairing.byId("extensionOrigin").value, "chrome-extension://" + pairing.window.chrome.runtime.id);
  pairing.byId("pairingId").value = "temporary pairing id";
  pairing.byId("pairingSecret").value = "temporary proof";
  pairing.byId("pairingForm").dispatchEvent(new pairing.window.Event("submit", { cancelable: true }));
  assert.strictEqual(pairing.byId("pairingSecret").value, "", "proof cleared before waiting for exchange");
  await pairing.waitFor(() => pairing.byId("statusText").textContent.includes("状态未知"), "ambiguous exchange UX");
  assert.strictEqual(pairing.byId("pairingId").value, "");
  assert.strictEqual(pairing.backgroundMessages.filter(m => m.type === "PAIR").length, 1);
  assert(!pairing.backgroundMessages.some(m => m.type === "WARMUP"));
  console.log("PASS  exact Origin, unpaired button, proof clearing and ambiguous exchange UX");
  const storage = makePopup({ paired: false, pairResponse: async () => ({ ok: false, kind: "storage", error: "Browser credential 未安全保存，请撤销。" }) });
  await storage.waitFor(() => storage.backgroundMessages.some(m => m.type === "CHECK_CONNECTION"), "storage popup initialization");
  storage.byId("pairingForm").dispatchEvent(new storage.window.Event("submit", { cancelable: true }));
  await storage.waitFor(() => storage.byId("statusText").textContent.includes("未安全保存"), "storage failure guidance");
  assert(storage.byId("btnTranslate").disabled);
  assert.strictEqual(storage.byId("pairingSecret").value, "");
  const forget = makePopup();
  await forget.waitFor(() => !forget.byId("btnForget").hidden, "paired popup");
  forget.byId("btnForget").click();
  await forget.waitFor(() => forget.byId("statusText").textContent.includes("不等于 server revoke"), "local Forget UX");
  assert(forget.byId("btnTranslate").disabled);
  assert(!forget.backgroundMessages.some(m => m.type === "REVOKE"));
  console.log("PASS  storage failure fails closed and Forget states server revoke boundary");
  const invalid = makePopup({ readiness: { ok: true, paired: false, pairing: "invalid", online: true, available: false, reason: "配对凭据已失效，请重新配对。" } });
  await invalid.waitFor(() => invalid.byId("pairingStatus").textContent.includes("凭据失效"), "revoked UX");
  assert(invalid.byId("btnTranslate").disabled);
  assert.strictEqual(invalid.byId("runtimeStatus").textContent, "在线");
  console.log("PASS  revoked credential disables translation while Runtime stays online");
  console.log("\n5 popup lifecycle/pairing scenarios passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
