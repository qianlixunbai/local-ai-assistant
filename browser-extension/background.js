/** Trusted worker: Runtime execution and exact frame/document injection. */
importScripts("config.js");
const CFG = self.LOCAL_AI_CONFIG;
importScripts("runtime-client.js", "runtime-storage.js");
const CONTENT_SCRIPTS = ["config.js", "content.js"];
const CONTENT_STYLES = ["content.css"];
const SELECTION_MENU_ID = "local-ai-translate-selection";
let selectionMenuSetupInProgress = false;
let selectionMenuSetupComplete = false;
const injectedTabs = new Set();

function normalizeSelectedText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function failedInjection() {
  return { ok: false, reason: "无法在目标页面安全注入扩展脚本。" };
}

/** Inject and message only the requested frame/document. A missing frame never means frame 0. */
async function ensureContentScript(tabId, frameId, expectedDocumentId, expectedSelectionText) {
  try { await RuntimeStorage.secure(); } catch (_) { return failedInjection(); }
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId < 0) return failedInjection();

  const expectedSelection = typeof expectedSelectionText === "string"
    ? normalizeSelectedText(expectedSelectionText)
    : null;
  let probe;
  try {
    const probes = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (expected) => {
        if (expected === null) return true;
        const active = document.activeElement;
        let selected = "";
        if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
          if (active.tagName === "INPUT" && String(active.type).toLowerCase() === "password") return false;
          if (Number.isInteger(active.selectionStart) && Number.isInteger(active.selectionEnd) &&
              active.selectionEnd > active.selectionStart) {
            selected = active.value.slice(active.selectionStart, active.selectionEnd);
          }
        }
        if (!selected) {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) return false;
          selected = selection.toString();
        }
        return selected.replace(/\s+/g, " ").trim() === expected;
      },
      args: [expectedSelection]
    });
    probe = Array.isArray(probes) ? probes.find((entry) => entry && entry.frameId === frameId) : null;
  } catch (e) {
    return failedInjection();
  }
  if (!probe || (expectedSelection !== null && probe.result !== true)) return failedInjection();
  if (expectedSelection !== null && (typeof probe.documentId !== "string" || !probe.documentId)) {
    return failedInjection();
  }

  if (typeof expectedDocumentId !== "undefined" && expectedDocumentId !== null) {
    if (typeof expectedDocumentId !== "string" || !expectedDocumentId || probe.documentId !== expectedDocumentId) {
      return failedInjection();
    }
  }

  const documentId = typeof probe.documentId === "string" && probe.documentId ? probe.documentId : null;
  const injectionTarget = documentId
    ? { tabId, documentIds: [documentId] }
    : { tabId, frameIds: [frameId] };
  const messageOptions = documentId ? { documentId } : { frameId };

  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, messageOptions);
    if (frameId === 0) injectedTabs.add(tabId);
    return { ok: true, frameId, documentId, messageOptions };
  } catch (e) {
    /* Not injected in this exact document; inject below. */
  }

  try {
    await chrome.scripting.insertCSS({ target: injectionTarget, files: CONTENT_STYLES });
  } catch (e) {
    // A stylesheet failure must not expose browser or page details in logs.
  }

  try {
    const injected = await chrome.scripting.executeScript({ target: injectionTarget, files: CONTENT_SCRIPTS });
    const exactTargetWasInjected = Array.isArray(injected) && injected.some((entry) =>
      entry && entry.frameId === frameId && (!documentId || entry.documentId === documentId)
    );
    if (!exactTargetWasInjected) return failedInjection();
    if (frameId === 0) injectedTabs.add(tabId);
  } catch (e) {
    return failedInjection();
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, messageOptions);
    return { ok: true, frameId, documentId, messageOptions };
  } catch (e) {
    return failedInjection();
  }
}

/** Create the selection menu idempotently across install and browser startup. */
function createSelectionContextMenu() {
  if (!chrome.contextMenus || typeof chrome.contextMenus.create !== "function") return;
  if (selectionMenuSetupInProgress || selectionMenuSetupComplete) return;
  selectionMenuSetupInProgress = true;

  const create = () => {
    try {
      chrome.contextMenus.create({
        id: SELECTION_MENU_ID,
        title: "使用 Local AI 翻译选中文本",
        contexts: ["selection"]
      }, () => {
        const error = chrome.runtime.lastError;
        selectionMenuSetupInProgress = false;
        if (error) {
          console.warn("[LAT] 无法创建选中文本菜单");
        } else {
          selectionMenuSetupComplete = true;
        }
      });
    } catch (e) {
      selectionMenuSetupInProgress = false;
      console.warn("[LAT] 无法创建选中文本菜单");
    }
  };

  // A stable id may already exist after a service worker restart or extension
  // update. Remove only this item before recreating it.
  if (typeof chrome.contextMenus.remove === "function") {
    try {
      chrome.contextMenus.remove(SELECTION_MENU_ID, () => {
        const error = chrome.runtime.lastError;
        create();
      });
      return;
    } catch (e) {
      // Fall through and try creating the item.
    }
  }
  create();
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(createSelectionContextMenu);
}
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(createSelectionContextMenu);
}

function isInjectableTab(tab) {
  if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (e) {
    return false;
  }
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!info || info.menuItemId !== SELECTION_MENU_ID) return;
    if (typeof info.selectionText !== "string" || !info.selectionText.trim()) return;
    if (!Number.isInteger(info.frameId) || info.frameId < 0) return;
    if (typeof info.documentId !== "undefined" && info.documentId !== null &&
        (typeof info.documentId !== "string" || !info.documentId)) return;
    if (!isInjectableTab(tab)) return;

    const ready = await ensureContentScript(tab.id, info.frameId, info.documentId, info.selectionText);
    if (!ready || !ready.ok) return;

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "TRANSLATE_SELECTION",
        selectionText: info.selectionText,
        selectionTarget: { frameId: ready.frameId, documentId: ready.documentId }
      }, ready.messageOptions);
    } catch (e) {
      // Restricted or navigated pages can reject the message after injection.
      // Keep this path quiet and never include selected text in diagnostics.
    }
  });
}

// 页面导航后 content script 会丢失，若该 tab 之前注入过则重新注入
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  try { await RuntimeStorage.secure(); } catch (_) { return; }
  if (changeInfo.status !== "loading" || !injectedTabs.has(tabId)) return;
  injectedTabs.delete(tabId);
  chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: CONTENT_STYLES }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_SCRIPTS }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

importScripts("runtime-router.js");
