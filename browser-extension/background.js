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

/** 已注入过 content script 的 tab，用于页面导航后重新注入 */
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
  let versionResp;
  try {
    versionResp = await fetch(ollamaUrl("/api/version"), { method: "GET" });
  } catch (e) {
    console.error("[LAT] /api/version 请求失败:", e);
    return { online: false, available: false, reason: "无法连接 " + CFG.ollamaBaseUrl + "，请确认 Ollama 已启动。" };
  }

  if (!versionResp.ok) {
    return { online: false, available: false, reason: "Ollama 响应异常：HTTP " + versionResp.status };
  }

  let versionData;
  try {
    versionData = await versionResp.json();
  } catch (e) {
    console.error("[LAT] /api/version JSON 解析失败:", e);
    return { online: true, available: false, reason: "Ollama 在线，但返回内容无法解析。" };
  }
  const version = versionData && versionData.version ? versionData.version : "";

  let tagsResp;
  try {
    tagsResp = await fetch(ollamaUrl("/api/tags"), { method: "GET" });
  } catch (e) {
    console.error("[LAT] /api/tags 请求失败:", e);
    return { online: true, available: false, version, reason: "Ollama 在线，但读取模型列表失败。" };
  }

  if (!tagsResp.ok) {
    return { online: true, available: false, version, reason: "Ollama 在线，但模型列表返回 HTTP " + tagsResp.status };
  }

  let tagsData;
  try {
    tagsData = await tagsResp.json();
  } catch (e) {
    console.error("[LAT] /api/tags JSON 解析失败:", e);
    return { online: true, available: false, version, reason: "Ollama 在线，但模型列表无法解析。" };
  }

  const models = Array.isArray(tagsData.models) ? tagsData.models : [];
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
function latError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/**
 * 翻译一批文本块。stream:false，think:false。
 * 带超时（AbortController）。首次请求可能触发模型加载，故超时较长。
 * @param {Array<{id:number,text:string}>} items
 * @returns {Promise<Map<number,string>>} id → 译文
 */
async function translateBatch(items) {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.requestTimeoutMs);

  let resp;
  try {
    resp = await fetch(ollamaUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    console.error("[LAT] /api/chat 请求失败:", e);
    if (e && e.name === "AbortError") {
      throw latError("timeout", "Ollama 请求超时（超过 " + Math.round(CFG.requestTimeoutMs / 1000) + " 秒）。");
    }
    throw latError("network", "无法连接 Ollama（" + CFG.ollamaBaseUrl + "）。");
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch (e) {
      /* ignore */
    }
    const msg = "Ollama 返回 HTTP " + resp.status + (detail ? "：" + detail.slice(0, 200) : "");
    if (resp.status === 404) throw latError("model", "模型 " + CFG.model + " 不存在。");
    if (resp.status >= 400 && resp.status < 500) throw latError("http4xx", msg);
    throw latError("http5xx", msg);
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw latError("parse", "Ollama 响应无法解析为 JSON。");
  }

  if (data.error) {
    const err = String(data.error);
    // 模型未加载 / 不存在属于不可重试
    if (/not found|no such model|does not exist/i.test(err)) {
      throw latError("model", "模型 " + CFG.model + " 不可用：" + err);
    }
    throw latError("http5xx", "Ollama 错误：" + err);
  }

  const content = data && data.message && typeof data.message.content === "string"
    ? data.message.content
    : "";
  if (!content) throw latError("parse", "Ollama 未返回翻译内容。");

  let results;
  try {
    results = parseTranslationJSON(content);
  } catch (e) {
    console.error("[LAT] JSON 解析失败，模型原始输出：\n" + content.slice(0, 1000));
    throw latError("parse", e.message);
  }

  const byId = new Map();
  results.forEach((r) => {
    if (r && typeof r.id !== "undefined" && typeof r.translation === "string") {
      byId.set(Number(r.id), r.translation.trim());
    }
  });
  return byId;
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

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return { ok: true };
  } catch (e) {
    /* 未注入，继续注入 */
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_STYLES });
  } catch (e) {
    console.warn("[LAT] insertCSS 失败:", e && e.message);
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    injectedTabs.add(tabId);
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

// 页面导航后 content script 会丢失，若该 tab 之前注入过则重新注入
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !injectedTabs.has(tabId)) return;
  injectedTabs.delete(tabId);
  chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_STYLES }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

const handlers = {
  async ENSURE_CONTENT_SCRIPT(msg) {
    return ensureContentScript(msg.tabId);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.requestTimeoutMs);
    try {
      const resp = await fetch(ollamaUrl("/api/chat"), {
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
        signal: controller.signal
      });
      return { warm: resp.ok };
    } catch (e) {
      return { warm: false };
    } finally {
      clearTimeout(timer);
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
      console.error("[LAT] 处理 " + msg.type + " 失败:", e);
      sendResponse({
        ok: false,
        error: e && e.message ? e.message : String(e),
        kind: e && e.kind ? e.kind : "unknown"
      });
    });

  return true; // 异步响应，保持消息通道打开
});
