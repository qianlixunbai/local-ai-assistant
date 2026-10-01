/**
 * Local AI Translator — background service worker
 *
 * 职责（本轮重构后）：
 * 1. Ollama 在线检测（GET /api/version）
 * 2. 模型检测（GET /api/tags）
 * 3. 翻译请求（POST /api/chat，stream:false，think:false）
 * 4. 网络 / HTTP / JSON 错误处理
 * 5. 向当前 tab 注入 content script（config.js / content.js / content.css）
 *
 * 架构：popup → chrome.runtime messaging → background → Ollama API
 * content.js 不直接访问 Ollama，只负责 DOM（提取 / 插入译文 / 恢复）。
 * service worker 生命周期可能被回收，因此不保存任何跨请求状态，
 * 每次请求都在监听器内完成并异步 sendResponse。
 */

importScripts("config.js");

const CFG = self.LOCAL_AI_CONFIG;

const CONTENT_SCRIPTS = ["config.js", "content.js"];
const CONTENT_STYLES = ["content.css"];
const SELECTION_MENU_ID = "local-ai-translate-selection";
const CONNECTION_TIMEOUT_MS = 5000;
let selectionMenuSetupInProgress = false;
let selectionMenuSetupComplete = false;

/** 已注入过顶层 content script 的 tab，用于页面导航后重新注入 */
const injectedTabs = new Set();

function ollamaUrl(path) {
  return CFG.ollamaBaseUrl.replace(/\/$/, "") + path;
}

/* ------------------------------------------------------------------ */
/* Ollama 访问                                                         */
/* ------------------------------------------------------------------ */

/**
 * 检测 Ollama 在线状态与目标模型可用性。
 * 返回 { online, available, reason }
 */
async function checkConnection() {
  let versionResult;
  try {
    versionResult = await withRequestDeadline(
      CONNECTION_TIMEOUT_MS,
      "连接 Ollama 超时。",
      async (signal) => {
        const resp = await fetch(ollamaUrl("/api/version"), { method: "GET", signal });
        if (!resp.ok) return { resp };
        let data;
        try {
          data = await resp.json();
        } catch (e) {
          if (signal.aborted) throw e;
          throw latError("parse", "Ollama 版本响应无法解析。");
        }
        return { resp, data };
      }
    );
  } catch (e) {
    if (e && e.kind === "parse") {
      return { online: true, available: false, reason: "Ollama 在线，但版本响应无法解析。" };
    }
    return {
      online: false,
      available: false,
      reason: e && e.kind === "timeout" ? e.message : "无法连接本机 Ollama，请确认 Ollama 已启动。"
    };
  }

  const versionResp = versionResult.resp;
  if (!versionResp.ok) {
    return {
      online: false,
      available: false,
      status: versionResp.status,
      reason: "Ollama 响应异常：HTTP " + versionResp.status
    };
  }

  const versionData = versionResult.data;
  const rawVersion = versionData && versionData.version;
  const version = typeof rawVersion === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(rawVersion)
    ? rawVersion
    : "";

  let tagsResult;
  try {
    tagsResult = await withRequestDeadline(
      CONNECTION_TIMEOUT_MS,
      "读取 Ollama 模型列表超时。",
      async (signal) => {
        const resp = await fetch(ollamaUrl("/api/tags"), { method: "GET", signal });
        if (!resp.ok) return { resp };
        let data;
        try {
          data = await resp.json();
        } catch (e) {
          if (signal.aborted) throw e;
          throw latError("parse", "Ollama 模型列表无法解析。");
        }
        return { resp, data };
      }
    );
  } catch (e) {
    return {
      online: true,
      available: false,
      version,
      reason: e && e.kind === "timeout"
        ? e.message
        : e && e.kind === "parse"
          ? "Ollama 在线，但模型列表无法解析。"
          : "Ollama 在线，但读取模型列表失败。"
    };
  }

  const tagsResp = tagsResult.resp;
  if (!tagsResp.ok) {
    return {
      online: true,
      available: false,
      version,
      status: tagsResp.status,
      reason: "Ollama 在线，但模型列表返回 HTTP " + tagsResp.status
    };
  }

  const tagsData = tagsResult.data;
  const models = tagsData && Array.isArray(tagsData.models) ? tagsData.models : [];
  // Ollama tags may expose the full model name as either `name` or `model`.
  // Keep the configured tag intact so another size/tag cannot satisfy the check.
  const found = models.some(
    (model) => model && (model.name === CFG.model || model.model === CFG.model)
  );

  if (found) {
    return { online: true, available: true, version, reason: "" };
  }
  return {
    online: true,
    available: false,
    version,
    reason: "Ollama 在线，但未找到模型 " + CFG.model + "。请运行：ollama pull " + CFG.model
  };
}

/** 解析模型返回的 JSON（容忍 ```json 包裹 / 前后多余文字） */
function parseTranslationJSON(rawText) {
  let text = (rawText || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    /* 继续尝试提取数组片段 */
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      /* 落到下面抛错 */
    }
  }
  throw new Error("无法解析模型返回的 JSON");
}

const SYSTEM_PROMPT =
  "你是网页翻译引擎。\n" +
  "将英文准确、自然地翻译成简体中文。\n" +
  "只返回指定 JSON，不解释、不总结、不添加内容。\n" +
  "保留产品名、专有名词、URL、代码和必要技术术语。\n\n" +
  "输入：[{\"id\":1,\"text\":\"...\"}]\n" +
  "输出：[{\"id\":1,\"translation\":\"...\"}]";

/**
 * 带有分类的错误，便于上层判断是否可重试。
 * kind: "network" | "timeout" | "http4xx" | "http5xx" | "parse" | "model" | "unsupported"
 */
function latError(kind, message, status) {
  const e = new Error(message);
  e.kind = kind;
  e.isLatError = true;
  if (Number.isInteger(status) && status >= 100 && status <= 599) e.status = status;
  return e;
}

/** Keep the deadline active through response-body reads, not just until headers arrive. */
async function withRequestDeadline(timeoutMs, timeoutMessage, operation) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (e) {
    if (e && e.kind) throw e;
    if (timedOut || (e && e.name === "AbortError")) {
      throw latError("timeout", timeoutMessage);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function validateRequestedIds(items) {
  if (!Array.isArray(items)) throw latError("unsupported", "翻译请求无效。");
  const ids = new Set();
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 0 || typeof item.text !== "string" || ids.has(item.id)) {
      throw latError("unsupported", "翻译请求无效。");
    }
    ids.add(item.id);
  }
  return ids;
}

/** Return only unique, numeric IDs requested in this batch. Invalid or duplicate IDs stay missing. */
function collectRequestedResults(results, requestedIds) {
  const byId = new Map();
  const seen = new Set();
  const invalid = new Set();

  results.forEach((result) => {
    if (!result || !Number.isSafeInteger(result.id) || result.id < 0 || !requestedIds.has(result.id)) return;
    if (seen.has(result.id)) {
      byId.delete(result.id);
      invalid.add(result.id);
      return;
    }
    seen.add(result.id);
    if (typeof result.translation !== "string" || !result.translation.trim()) return;
    byId.set(result.id, result.translation.trim());
  });

  invalid.forEach((id) => byId.delete(id));
  return byId;
}

/**
 * 翻译一批文本块。stream:false，think:false。
 * 带超时（AbortController）。首次请求可能触发模型加载，故超时较长。
 * @param {Array<{id:number,text:string}>} items
 * @returns {Promise<Map<number,string>>} id → 译文
 */
async function translateBatch(items) {
  const requestedIds = validateRequestedIds(items);
  const body = {
    model: CFG.model,
    stream: false,
    think: CFG.think,
    keep_alive: CFG.keepAlive,
    options: {
      temperature: CFG.temperature,
      top_p: CFG.top_p,
      num_predict: CFG.num_predict,
      num_ctx: CFG.num_ctx
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(items) }
    ]
  };

  try {
    return await withRequestDeadline(
      CFG.requestTimeoutMs,
      "Ollama 请求超时（超过 " + Math.round(CFG.requestTimeoutMs / 1000) + " 秒）。",
      async (signal) => {
        const resp = await fetch(ollamaUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal
        });

        if (!resp.ok) {
          if (resp.status === 404) throw latError("model", "模型 " + CFG.model + " 不存在。", resp.status);
          if (resp.status >= 400 && resp.status < 500) {
            throw latError("http4xx", "Ollama 请求失败（HTTP " + resp.status + "）。", resp.status);
          }
          throw latError("http5xx", "Ollama 服务异常（HTTP " + resp.status + "）。", resp.status);
        }

        let data;
        try {
          data = await resp.json();
        } catch (e) {
          if (signal.aborted) throw e;
          throw latError("parse", "Ollama 响应无法解析为 JSON。");
        }

        if (data && data.error) {
          const err = String(data.error);
          if (/not found|no such model|does not exist/i.test(err)) {
            throw latError("model", "模型 " + CFG.model + " 不可用。");
          }
          throw latError("http5xx", "Ollama 返回错误。");
        }

        const content = data && data.message && typeof data.message.content === "string"
          ? data.message.content
          : "";
        if (!content) throw latError("parse", "Ollama 未返回翻译内容。");

        let results;
        try {
          results = parseTranslationJSON(content);
        } catch (e) {
          throw latError("parse", "Ollama 响应无法解析为翻译结果。");
        }
        return collectRequestedResults(results, requestedIds);
      }
    );
  } catch (e) {
    if (e && e.isLatError) throw e;
    if (e && e.name === "AbortError") {
      throw latError("timeout", "Ollama 请求超时（超过 " + Math.round(CFG.requestTimeoutMs / 1000) + " 秒）。");
    }
    throw latError("network", "无法连接本机 Ollama。");
  }
}

/** 判断某个错误是否值得重试（网络瞬时失败 / 5xx / JSON 解析失败） */
function isRetryable(kind) {
  return kind === "network" || kind === "timeout" || kind === "http5xx" || kind === "parse";
}

/**
 * 带重试地翻译一批。最多额外重试 CFG.maxRetries 次。
 */
async function translateBatchWithRetry(items) {
  let lastErr;
  for (let attempt = 0; attempt <= CFG.maxRetries; attempt++) {
    try {
      return await translateBatch(items);
    } catch (e) {
      lastErr = e;
      const kind = e && e.kind ? e.kind : "network";
      if (!isRetryable(kind) || attempt === CFG.maxRetries) break;
      console.warn("[LAT] 批次翻译失败（" + kind + "），重试 " + (attempt + 1) + "/" + CFG.maxRetries);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* content script 注入                                                 */
/* ------------------------------------------------------------------ */

function normalizeSelectedText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function failedInjection() {
  return { ok: false, reason: "无法在目标页面安全注入扩展脚本。" };
}

/** Inject and message only the requested frame/document. A missing frame never means frame 0. */
async function ensureContentScript(tabId, frameId, expectedDocumentId, expectedSelectionText) {
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !injectedTabs.has(tabId)) return;
  injectedTabs.delete(tabId);
  chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: CONTENT_STYLES }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_SCRIPTS }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

const handlers = {
  async ENSURE_CONTENT_SCRIPT(msg) {
    const ready = await ensureContentScript(msg.tabId, 0);
    return { ok: ready.ok, reason: ready.reason };
  },

  async CHECK_CONNECTION() {
    return checkConnection();
  },

  async GET_CONFIG() {
    return {
      model: CFG.model,
      ollamaBaseUrl: CFG.ollamaBaseUrl,
      minTextLength: CFG.minTextLength
    };
  },

  /** 预热模型（加载进显存并保持 keep_alive），下一次翻译不必等待加载。 */
  async WARMUP() {
    try {
      const resp = await withRequestDeadline(CFG.requestTimeoutMs, "Ollama 预热超时。", async (signal) => {
        const response = await fetch(ollamaUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: CFG.model,
            stream: false,
            think: CFG.think,
            keep_alive: CFG.keepAlive,
            options: { num_ctx: CFG.num_ctx, num_predict: 1 },
            messages: [{ role: "user", content: "hi" }]
          }),
          signal
        });
        if (response.ok) await response.arrayBuffer();
        return response;
      });
      return { warm: resp.ok };
    } catch (e) {
      return { warm: false };
    }
  },

  async TRANSLATE_BATCH(msg) {
    const byId = await translateBatchWithRetry(msg.items);
    // Map 不能跨消息传递，转成可序列化的数组
    const results = [];
    byId.forEach((translation, id) => results.push({ id, translation }));
    return { ok: true, results };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !handlers[msg.type]) return false;

  handlers[msg.type](msg, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((e) => {
      const allowedKinds = ["network", "timeout", "http4xx", "http5xx", "parse", "model", "unsupported"];
      const kind = e && allowedKinds.includes(e.kind) ? e.kind : "unknown";
      const message = e && e.isLatError && typeof e.message === "string"
        ? e.message
        : "本地翻译请求失败，请重试。";
      console.error("[LAT] 后台请求失败:", kind);
      const response = {
        ok: false,
        error: message,
        kind
      };
      if (e && e.isLatError && Number.isInteger(e.status)) response.status = e.status;
      sendResponse(response);
    });

  return true; // 异步响应，保持消息通道打开
});
