/**
 * Local AI Translator — popup
 *
 * popup 只负责「发起操作」和「显示状态」，不拥有任务生命周期。
 * 真正的翻译任务运行在 content script 中（由 background 中转 Ollama 请求），
 * 因此用户关闭 popup 不会中断翻译。
 *
 * 消息：
 * - CHECK_CONNECTION       → Ollama 在线 / 模型可用
 * - ENSURE_CONTENT_SCRIPT  → 按需注入 content script
 * - TRANSLATE_PAGE         → 触发页面翻译（不等整页完成）
 * - GET_STATUS             → 读取当前页面真实状态（popup 重开时恢复显示）
 * - RESTORE_PAGE           → 恢复原文
 */
(function () {
  const UNSUPPORTED_SCHEMES = [
    "chrome://", "chrome-extension://", "edge://", "about:",
    "devtools://", "view-source:", "chrome-search:", "chrome-untrusted://",
    "https://chromewebstore.google.com"
  ];

  const el = {
    modelName: document.getElementById("modelName"),
    ollamaDot: document.getElementById("ollamaDot"),
    ollamaStatus: document.getElementById("ollamaStatus"),
    modelDot: document.getElementById("modelDot"),
    modelStatus: document.getElementById("modelStatus"),
    btnTest: document.getElementById("btnTest"),
    btnTranslate: document.getElementById("btnTranslate"),
    btnRestore: document.getElementById("btnRestore"),
    statusText: document.getElementById("statusText")
  };

  let currentTabId = null;
  let supported = false;
  let translating = false;
  // 优先使用 popup 上下文加载的 config.js；稍后由 GET_CONFIG 补全
  let modelName = (window.LOCAL_AI_CONFIG && window.LOCAL_AI_CONFIG.model) || "—";

  /* -------------------- 状态展示 -------------------- */

  function setStatus(text, level) {
    el.statusText.textContent = text;
    el.statusText.className = "status-text" + (level ? " " + level : "");
  }

  function setDot(dotEl, level) {
    dotEl.className = "dot" + (level ? " " + level : "");
  }

  function setOllama(state, text) {
    setDot(el.ollamaDot, state);
    el.ollamaStatus.textContent = text;
  }

  function setModel(state, text) {
    setDot(el.modelDot, state);
    el.modelStatus.textContent = text;
  }

  function refreshButtons() {
    el.btnTest.disabled = !supported;
    el.btnRestore.disabled = !supported;
    // 翻译进行中禁止重复点击，其余情况仅在页面不支持时禁用
    el.btnTranslate.disabled = !supported || translating;
  }

  /* -------------------- 通信 -------------------- */

  async function sendToBackground(message) {
    const resp = await chrome.runtime.sendMessage(message);
    if (!resp) throw new Error("background 未响应。");
    return resp;
  }

  async function sendToTab(tabId, message) {
    const resp = await chrome.tabs.sendMessage(tabId, message);
    if (!resp) throw new Error("页面未响应。");
    return resp;
  }

  /* -------------------- Ollama 检测（由 background 执行） -------------------- */

  async function testConnection(silent) {
    setOllama("", "检测中...");
    setModel("", "检测中...");
    if (!silent) setStatus("正在检测连接...", "warn");

    let r;
    try {
      r = await sendToBackground({ type: "CHECK_CONNECTION" });
    } catch (e) {
      console.error("[LAT] CHECK_CONNECTION 失败:", e);
      setOllama("err", "离线");
      setModel("", "不可用");
      if (!silent) setStatus("无法与扩展后台通信，请重试。", "err");
      return { online: false, available: false };
    }

    if (!r.ok || !r.online) {
      setOllama("err", "离线");
      setModel("", "不可用");
      if (!silent) setStatus(r.reason || r.error || "Ollama 未运行。", "err");
      return { online: false, available: false };
    }

    setOllama("ok", "在线" + (r.version ? " v" + r.version : ""));

    if (r.available) {
      setModel("ok", "可用");
      if (!silent) setStatus("准备就绪", "ok");
    } else {
      setModel("err", "不可用");
      if (!silent) setStatus(r.reason || ("模型 " + modelName + " 不可用。"), "err");
    }
    return { online: true, available: !!r.available };
  }

  /** 预热模型（加载进显存并保持），让首次翻译不必等待加载。失败不影响后续。 */
  function warmUp() {
    sendToBackground({ type: "WARMUP" }).catch(() => {});
  }

  /* -------------------- 页面辅助 -------------------- */

  function isUnsupported(url) {
    if (!url) return true;
    return UNSUPPORTED_SCHEMES.some((s) => url.startsWith(s));
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function ensureContentScript(tabId) {
    return sendToBackground({ type: "ENSURE_CONTENT_SCRIPT", tabId });
  }

  /* -------------------- 按钮行为 -------------------- */

  async function onTest() {
    el.btnTest.disabled = true;
    try {
      await testConnection(false);
    } catch (e) {
      console.error("[LAT] 检测连接错误:", e);
      setStatus("检测出错，请重试。", "err");
    } finally {
      refreshButtons();
    }
  }

  /** 发起翻译后立即返回，不等待整页完成（任务在 content script 中继续）。 */
  async function onTranslate() {
    if (!currentTabId) {
      setStatus("无法获取当前标签页。", "err");
      return;
    }
    translating = true;
    refreshButtons();
    setStatus("正在收集正文...", "warn");

    try {
      const inject = await ensureContentScript(currentTabId);
      if (!inject || !inject.ok) {
        setStatus("当前页面不支持翻译。", "err");
        console.error("[LAT] 注入失败:", inject && inject.reason);
        return;
      }

      const conn = await testConnection(true);
      if (!conn.online) {
        setStatus("Ollama 未运行，无法翻译。请启动 Ollama 后重试。", "err");
        return;
      }
      if (!conn.available) {
        setStatus("模型 " + modelName + " 不可用。请先运行：ollama pull " + modelName, "err");
        return;
      }

      setStatus("正在翻译...", "warn");
      // 开始新任务前清掉旧译文与旧会话，保证状态干净且不产生重复
      try {
        await sendToTab(currentTabId, { type: "LAT_RESET" });
      } catch (e) {
        console.warn("[LAT] 重置旧译文失败（可忽略）:", e && e.message);
      }

      const resp = await sendToTab(currentTabId, { type: "TRANSLATE_PAGE" });

      if (!resp.ok && !resp.translated) {
        if (resp.alreadyTranslated) {
          setStatus(resp.watching ? "翻译完成 · 正在监听新内容" : "当前页面已翻译。", "ok");
        } else {
          setStatus(resp.error || "翻译失败。", "err");
        }
        return;
      }
      if (resp.failed > 0) {
        setStatus("部分内容翻译失败，可重试。已翻译 " + resp.translated + " / " + resp.total + " 段。", "warn");
      } else if (resp.watching) {
        setStatus("翻译完成 · 正在监听新内容", "ok");
      } else {
        setStatus("翻译完成，共 " + resp.translated + " 段。", "ok");
      }
    } catch (e) {
      console.error("[LAT] 翻译流程错误:", e);
      setStatus("翻译出错，请重试。", "err");
    } finally {
      translating = false;
      refreshButtons();
    }
  }

  async function onRestore() {
    if (!currentTabId) {
      setStatus("无法获取当前标签页。", "err");
      return;
    }
    el.btnRestore.disabled = true;
    try {
      const inject = await ensureContentScript(currentTabId);
      if (!inject || !inject.ok) {
        // 页面本就没有 content script，说明已是原始状态
        setStatus("已恢复原文。", "ok");
        return;
      }
      const resp = await sendToTab(currentTabId, { type: "RESTORE_PAGE" });
      if (resp.ok) {
        setStatus(resp.removed > 0 ? "已恢复原文，移除译文 " + resp.removed + " 段。" : "页面当前没有译文。", "ok");
      } else {
        setStatus("恢复失败。", "err");
      }
    } catch (e) {
      console.error("[LAT] 恢复错误:", e);
      setStatus("恢复出错，请重试。", "err");
    } finally {
      refreshButtons();
    }
  }

  /* -------------------- 进度接收 -------------------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "TRANSLATION_PROGRESS") return;
    const p = msg.progress || {};
    if (p.status === "dynamic-translating") {
      // 首次翻译完成后，页面新增内容被自动增量翻译
      setStatus("发现新内容，正在翻译... 已完成 " + (p.done || 0) + " / " + (p.total || 0) + " 段", "warn");
    } else if (p.status === "watching") {
      setStatus("翻译完成 · 正在监听新内容", "ok");
      translating = false;
      refreshButtons();
    } else if (translating && p.status === "translating") {
      const batch = p.batches ? "，第 " + (p.batch || 0) + " / " + p.batches + " 批" : "";
      setStatus("正在翻译" + batch + "... 已完成 " + (p.done || 0) + " / " + (p.total || 0) + " 段", "warn");
    } else if (translating && p.status === "translated") {
      setStatus("翻译完成，共 " + p.total + " 段。", "ok");
      translating = false;
      refreshButtons();
    } else if (p.status === "restored") {
      setStatus("已恢复原文。", "ok");
    }
  });

  /* -------------------- 初始化 -------------------- */

  /** 读取当前页面真实状态，恢复 popup 显示。 */
  async function restorePageState() {
    try {
      const inject = await ensureContentScript(currentTabId);
      if (!inject || !inject.ok) return;
      const st = await sendToTab(currentTabId, { type: "GET_STATUS" });
      if (!st || !st.ok) return;

      if (st.status === "translating" || st.status === "dynamic-translating") {
        translating = true;
        refreshButtons();
        setStatus(st.status === "dynamic-translating" ? "发现新内容，正在翻译..." : "正在翻译...", "warn");
      } else if (st.status === "watching") {
        setStatus("翻译完成 · 正在监听新内容", "ok");
      } else if (st.status === "translated") {
        setStatus("页面已翻译。", "ok");
      } else if (st.status === "partial") {
        setStatus("部分翻译完成。", "warn");
      }
    } catch (e) {
      // 页面无 content script 属正常情况（未翻译过）
      console.warn("[LAT] 读取页面状态失败:", e && e.message);
    }
  }

  async function init() {
    el.modelName.textContent = modelName;

    const tab = await getActiveTab();
    currentTabId = tab ? tab.id : null;
    supported = !!(tab && !isUnsupported(tab.url));
    refreshButtons();

    if (!supported) {
      setOllama("warn", "—");
      setModel("warn", "—");
      setStatus("当前页面不支持翻译。", "warn");
      return;
    }

    // 先恢复页面状态（是否有已有译文），再静默检测连接并预热模型
    await restorePageState();
    const conn = await testConnection(true);
    if (conn.online && conn.available) warmUp();
  }

  el.btnTest.addEventListener("click", onTest);
  el.btnTranslate.addEventListener("click", onTranslate);
  el.btnRestore.addEventListener("click", onRestore);

  async function boot() {
    try {
      const r = await sendToBackground({ type: "GET_CONFIG" });
      if (r && r.ok && r.model) modelName = r.model;
    } catch (e) {
      console.warn("[LAT] 获取配置失败，使用默认值:", e && e.message);
    }
    el.modelName.textContent = modelName;
    try {
      await init();
    } catch (e) {
      console.error("[LAT] 初始化失败:", e);
      setStatus("初始化失败，请重新打开扩展。", "err");
      refreshButtons();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
