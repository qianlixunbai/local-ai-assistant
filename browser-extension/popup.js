/**
 * Local AI Translator — popup
 *
 * popup 只负责「发起操作」和「显示状态」，不拥有任务生命周期。
 * 真正的翻译任务运行在 content script 中（由 background 中转 Runtime 请求），
 * 因此用户关闭 popup 不会中断翻译。
 *
 * 消息：
 * - CHECK_CONNECTION       → 配对 / Runtime 在线 / Translation 可用
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
    pairingStatus: document.getElementById("pairingStatus"),
    extensionOrigin: document.getElementById("extensionOrigin"),
    pairingId: document.getElementById("pairingId"),
    pairingSecret: document.getElementById("pairingSecret"),
    pairingForm: document.getElementById("pairingForm"),
    btnCopyOrigin: document.getElementById("btnCopyOrigin"),
    btnPair: document.getElementById("btnPair"),
    btnForget: document.getElementById("btnForget"),
    runtimeDot: document.getElementById("runtimeDot"),
    runtimeStatus: document.getElementById("runtimeStatus"),
    translationDot: document.getElementById("translationDot"),
    translationStatus: document.getElementById("translationStatus"),
    btnTest: document.getElementById("btnTest"),
    btnTranslate: document.getElementById("btnTranslate"),
    btnRestore: document.getElementById("btnRestore"),
    statusText: document.getElementById("statusText")
  };

  let currentTabId = null;
  let supported = false;
  let translating = false;
  let operationGeneration = 0;
  let activeOperation = null;
  const popupInstanceId = window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let expectedProgressOperationId = null;
  let expectedProgressSessionGeneration = null;
  let requireProgressMetadata = false;
  let paired = false;
  let ready = false;
  let pairingBusy = false;
  let initialized = false;

  /* -------------------- 状态展示 -------------------- */

  function setStatus(text, level) {
    el.statusText.textContent = text;
    el.statusText.className = "status-text" + (level ? " " + level : "");
  }

  function setDot(dotEl, level) {
    dotEl.className = "dot" + (level ? " " + level : "");
  }

  function setRuntime(state, text) {
    setDot(el.runtimeDot, state);
    el.runtimeStatus.textContent = text;
  }

  function setTranslation(state, text) {
    setDot(el.translationDot, state);
    el.translationStatus.textContent = text;
  }

  function refreshButtons() {
    el.btnTest.disabled = !supported || translating || activeOperation === "translate" ||
      pairingBusy || activeOperation === "restore" || activeOperation === "test";
    el.btnRestore.disabled = !supported || activeOperation === "restore";
    // 翻译进行中禁止重复点击，其余情况仅在页面不支持时禁用
    el.btnTranslate.disabled = !supported || !paired || !ready || pairingBusy || translating || activeOperation === "translate";
    el.btnPair.disabled = !initialized || pairingBusy || paired;
    el.btnForget.disabled = !initialized || pairingBusy;
  }

  function showPairing(r) {
    paired = !!r.paired;
    el.pairingStatus.textContent = r.pairing === "invalid" ? "凭据失效，请重新配对" : paired ? "Paired" : "未配对";
    el.pairingForm.hidden = paired;
    el.btnForget.hidden = !paired && r.pairing !== "invalid" && r.pairing !== "storage";
    refreshButtons();
  }
  function clearProof() { el.pairingId.value = ""; el.pairingSecret.value = ""; }
  async function onPair(event) {
    event.preventDefault();
    if (!initialized || pairingBusy || paired) return;
    const generation = beginOperation("pair");
    pairingBusy = true;
    ready = false;
    refreshButtons();
    setStatus("正在配对...", "warn");
    let message;
    try {
      message = { type: "PAIR", pairingId: el.pairingId.value.trim(), pairingSecret: el.pairingSecret.value.trim() };
      // Clear proof before waiting; popup closure or a failed attempt cannot retain it.
      clearProof();
      const r = await sendToBackground(message);
      message.pairingId = ""; message.pairingSecret = "";
      if (!isCurrentOperation(generation)) return;
      if (!r.ok) {
        if (r.kind === "storage") el.btnForget.hidden = false;
        setStatus(r.error || "配对失败，请创建新配对。", "err");
        return;
      }
      showPairing(r);
      await testConnection(false, generation);
    } catch (_) {
      if (isCurrentOperation(generation)) setStatus("配对状态未知，请在 Windows Assistant 查看 Paired Browsers；必要时撤销后重新创建配对。", "err");
    } finally {
      if (message) { message.pairingId = ""; message.pairingSecret = ""; }
      clearProof();
      pairingBusy = false;
      finishOperation(generation);
    }
  }
  async function onForget() {
    if (pairingBusy) return;
    const generation = beginOperation("forget");
    pairingBusy = true;
    ready = false;
    refreshButtons();
    try {
      const r = await sendToBackground({ type: "FORGET_PAIRING" });
      if (!isCurrentOperation(generation)) return;
      if (!r.ok) { setStatus(r.error || "无法删除本地配对。", "err"); return; }
      clearProof();
      showPairing(r);
      setRuntime("", "未检测"); setTranslation("", "不可用");
      setStatus("已删除本地配对；这不等于 server revoke。请在 Windows Assistant → Paired Browsers 撤销。", "warn");
    } finally { pairingBusy = false; finishOperation(generation); }
  }

  function beginOperation(kind) {
    const generation = ++operationGeneration;
    activeOperation = kind;
    if (kind === "restore" || kind === "translate") {
      expectedProgressOperationId = operationIdFor(generation);
      expectedProgressSessionGeneration = null;
      requireProgressMetadata = true;
    }
    return generation;
  }

  function operationIdFor(generation) {
    return popupInstanceId + ":" + generation;
  }

  function isSessionGeneration(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function trackPageStatus(st) {
    if (!st || !st.ok) return;
    expectedProgressOperationId = typeof st.operationId === "string" && st.operationId
      ? st.operationId
      : null;
    expectedProgressSessionGeneration = isSessionGeneration(st.sessionGeneration)
      ? st.sessionGeneration
      : null;
    // When a popup reopens, a valid GET_STATUS snapshot establishes which
    // existing page task may continue to update this popup.
    requireProgressMetadata = true;
  }

  function isCurrentOperation(generation) {
    return generation === operationGeneration;
  }

  function finishOperation(generation) {
    if (!isCurrentOperation(generation)) return false;
    activeOperation = null;
    refreshButtons();
    return true;
  }

  /* -------------------- 通信 -------------------- */

  async function sendToBackground(message) {
    const resp = await chrome.runtime.sendMessage(message);
    if (!resp) throw new Error("background 未响应。");
    return resp;
  }

  async function sendToTab(tabId, message) {
    // Page-wide popup actions belong to the top document. Other frames can
    // host independent content-script sessions and must not receive them.
    const resp = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (!resp) throw new Error("页面未响应。");
    return resp;
  }

  /* -------------------- Runtime 检测（由 background 执行） -------------------- */

  async function testConnection(silent, generation) {
    if (generation !== undefined && !isCurrentOperation(generation)) {
      return { cancelled: true };
    }
    setRuntime("", "检测中...");
    setTranslation("", "检测中...");
    if (!silent) setStatus("正在检测连接...", "warn");

    let r;
    try {
      r = await sendToBackground({ type: "CHECK_CONNECTION" });
    } catch (e) {
      console.error("[LAT] CHECK_CONNECTION 失败。");
      if (generation !== undefined && !isCurrentOperation(generation)) {
        return { cancelled: true };
      }
      setRuntime("err", "离线");
      setTranslation("", "不可用");
      ready = false;
      refreshButtons();
      if (!silent) setStatus("无法与扩展后台通信，请重试。", "err");
      return { online: false, available: false };
    }

    if (generation !== undefined && !isCurrentOperation(generation)) {
      return { cancelled: true };
    }

    showPairing(r);
    ready = !!(r.ok && r.paired && r.online && r.available);
    refreshButtons();
    if (!r.ok || !r.online || !r.paired) {
      setRuntime(r.online ? "ok" : "err", r.online ? "在线" : "离线");
      setTranslation("", "不可用");
      if (!silent || !translating) setStatus(r.reason || r.error || "Runtime 不可用。", "err");
      return { online: false, available: false, paired: false, reason: r.reason || r.error };
    }

    setRuntime("ok", "在线");

    if (r.available) {
      setTranslation("ok", "可用");
      if (!silent) setStatus("准备就绪", "ok");
    } else {
      setTranslation("err", "不可用");
      if (!silent || !translating) setStatus(r.reason || "Translation 不可用。", "err");
    }
    return { online: true, available: !!r.available };
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
    if (translating || activeOperation === "translate" || activeOperation === "restore") return;
    const generation = beginOperation("test");
    refreshButtons();
    try {
      await testConnection(false, generation);
    } catch (e) {
      console.error("[LAT] 检测连接错误。");
      if (isCurrentOperation(generation)) setStatus("检测出错，请重试。", "err");
    } finally {
      finishOperation(generation);
    }
  }

  /** 发起翻译后立即返回，不等待整页完成（任务在 content script 中继续）。 */
  async function onTranslate() {
    if (!paired || !ready || pairingBusy || translating) return;
    const generation = beginOperation("translate");
    if (!currentTabId) {
      if (isCurrentOperation(generation)) setStatus("无法获取当前标签页。", "err");
      finishOperation(generation);
      return;
    }
    translating = true;
    refreshButtons();
    setStatus("正在收集正文...", "warn");
    const tabId = currentTabId;

    try {
      const inject = await ensureContentScript(tabId);
      if (!isCurrentOperation(generation)) return;
      if (!inject || !inject.ok) {
        setStatus("当前页面不支持翻译。", "err");
        console.error("[LAT] 页面脚本不可用。");
        return;
      }

      const conn = await testConnection(true, generation);
      if (!isCurrentOperation(generation) || conn.cancelled) return;
      if (!conn.online) {
        setStatus(conn.reason || "Runtime 离线，请启动 Personal AI Runtime 后重试。", "err");
        return;
      }
      if (!conn.available) {
        setStatus("Translation 不可用，请在 Windows Assistant 检查翻译服务。", "err");
        return;
      }

      setStatus("正在翻译...", "warn");

      // 只在「已完成且在监听」时真正短路（幂等：不清空、不请求模型、不重译）。
      // 其他情况一律继续发送 TRANSLATE_PAGE：
      // - partial：保留已有译文，只补翻尚未成功 / 未标记 source 的 record
      // - translated 但 watching=false（content script 重载后 watcher 丢失）：
      //   由 content 侧发现无新 record 并重新 arm watcher，不删旧译文、不调用模型
      // - idle / 未翻译：正常首次翻译
      let skipReset = false;
      try {
        const st = await sendToTab(tabId, { type: "GET_STATUS" });
        if (!isCurrentOperation(generation)) return;
        if (st && st.ok && st.status === "watching") {
          trackPageStatus(st);
          setStatus("翻译完成 · 正在监听新内容", "ok");
          return;
        }
        if (st && st.ok && (st.status === "partial" || st.status === "translated")) {
          skipReset = true;
        }
      } catch (e) {
        if (!isCurrentOperation(generation)) return;
        console.warn("[LAT] 读取页面状态失败，继续翻译。");
      }

      if (!isCurrentOperation(generation)) return;

      // 开始新任务前清掉旧译文与旧会话，保证状态干净且不产生重复
      if (!skipReset) {
        try {
          await sendToTab(tabId, { type: "LAT_RESET", operationId: operationIdFor(generation) });
        } catch (e) {
          if (!isCurrentOperation(generation)) return;
          console.warn("[LAT] 重置旧译文失败，继续翻译。");
        }
        if (!isCurrentOperation(generation)) return;
      }

      const resp = await sendToTab(tabId, {
        type: "TRANSLATE_PAGE",
        operationId: operationIdFor(generation)
      });
      if (!isCurrentOperation(generation)) return;

      if (!resp.ok && !resp.translated) {
        if (resp.alreadyTranslated) {
          setStatus(resp.watching ? "翻译完成 · 正在监听新内容" : "当前页面已翻译。", "ok");
        } else {
          setStatus(resp.error || "翻译失败。", "err");
        }
        return;
      }
      if (resp.failed > 0) {
        setStatus(
          "部分内容翻译失败，可重试。已翻译 " + resp.translated + " / " + resp.total + " 段。" +
          (resp.watching ? "（继续监听新内容）" : ""),
          "warn"
        );
      } else if (resp.watching) {
        setStatus("翻译完成 · 正在监听新内容", "ok");
      } else {
        setStatus("翻译完成，共 " + resp.translated + " 段。", "ok");
      }
    } catch (e) {
      console.error("[LAT] 翻译流程错误。");
      if (isCurrentOperation(generation)) setStatus("翻译出错，请重试。", "err");
    } finally {
      if (isCurrentOperation(generation)) {
        translating = false;
        finishOperation(generation);
      }
    }
  }

  async function onRestore() {
    const generation = beginOperation("restore");
    translating = false;
    if (!currentTabId) {
      if (isCurrentOperation(generation)) setStatus("无法获取当前标签页。", "err");
      finishOperation(generation);
      return;
    }
    refreshButtons();
    setStatus("正在恢复原文...", "warn");
    const tabId = currentTabId;
    try {
      const inject = await ensureContentScript(tabId);
      if (!isCurrentOperation(generation)) return;
      if (!inject || !inject.ok) {
        // 页面本就没有 content script，说明已是原始状态
        setStatus("已恢复原文。", "ok");
        return;
      }
      const resp = await sendToTab(tabId, {
        type: "RESTORE_PAGE",
        operationId: operationIdFor(generation)
      });
      if (!isCurrentOperation(generation)) return;
      if (resp.ok) {
        setStatus(resp.removed > 0 ? "已恢复原文，移除译文 " + resp.removed + " 段。" : "页面当前没有译文。", "ok");
      } else {
        setStatus("恢复失败。", "err");
      }
    } catch (e) {
      console.error("[LAT] 恢复错误。");
      if (isCurrentOperation(generation)) setStatus("恢复出错，请重试。", "err");
    } finally {
      finishOperation(generation);
    }
  }

  /* -------------------- 进度接收 -------------------- */

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "TRANSLATION_PROGRESS") return;
    // Runtime messages can arrive from any content script in the extension.
    // The popup belongs to one tab, so ignore unknown senders and other tabs.
    if (!sender || !sender.tab || sender.tab.id !== currentTabId) return;
    if (sender.frameId !== undefined && sender.frameId !== 0) return;
    const p = msg.progress || {};
    if (requireProgressMetadata) {
      if (!expectedProgressOperationId || p.operationId !== expectedProgressOperationId) return;
      if (!isSessionGeneration(p.sessionGeneration)) return;
      if (expectedProgressSessionGeneration === null) {
        expectedProgressSessionGeneration = p.sessionGeneration;
      } else if (p.sessionGeneration !== expectedProgressSessionGeneration) {
        return;
      }
    }
    if (activeOperation === "test") return;
    if (p.status === "dynamic-translating") {
      // 首次翻译完成后，页面新增内容被自动增量翻译
      setStatus("发现新内容，正在翻译... 已完成 " + (p.done || 0) + " / " + (p.total || 0) + " 段", "warn");
    } else if (p.status === "watching") {
      setStatus("翻译完成 · 正在监听新内容", "ok");
      translating = false;
      refreshButtons();
    } else if (p.status === "partial") {
      // partial 可能带有 watching=true：保留「监听中」提示，同时说明仍有失败可重试
      setStatus((p.error ? p.error + " " : "") + "部分内容翻译失败，可重试" + (translating && p.total ? "（" + (p.done || 0) + " / " + p.total + " 段）" : ""), "warn");
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
  async function restorePageState(generation) {
    try {
      const inject = await ensureContentScript(currentTabId);
      if (!isCurrentOperation(generation)) return;
      if (!inject || !inject.ok) return;
      const st = await sendToTab(currentTabId, { type: "GET_STATUS" });
      if (!isCurrentOperation(generation)) return;
      if (!st || !st.ok) return;
      trackPageStatus(st);

      if (st.status === "translating" || st.status === "dynamic-translating") {
        translating = true;
        refreshButtons();
        setStatus(st.status === "dynamic-translating" ? "发现新内容，正在翻译..." : "正在翻译...", "warn");
      } else if (st.status === "watching") {
        setStatus("翻译完成 · 正在监听新内容", "ok");
      } else if (st.status === "translated") {
        setStatus("页面已翻译。", "ok");
      } else if (st.status === "partial") {
        setStatus(st.error || "部分翻译完成。", "warn");
      }
    } catch (e) {
      if (!isCurrentOperation(generation)) return;
      // 页面无 content script 属正常情况（未翻译过）
      console.warn("[LAT] 读取页面状态失败。");
    }
  }

  async function init(generation) {
    const tab = await getActiveTab();
    if (!isCurrentOperation(generation)) return;
    currentTabId = tab ? tab.id : null;
    supported = !!(tab && !isUnsupported(tab.url));
    initialized = true;
    refreshButtons();

    if (!supported) {
      setRuntime("warn", "—");
      setTranslation("warn", "—");
      setStatus("当前页面不支持翻译。", "warn");
    }

    if (supported) await restorePageState(generation);
    if (!isCurrentOperation(generation)) return;
    await testConnection(true, generation);
  }

  el.btnTest.addEventListener("click", onTest);
  el.btnTranslate.addEventListener("click", onTranslate);
  el.btnRestore.addEventListener("click", onRestore);
  el.pairingForm.addEventListener("submit", onPair);
  el.btnForget.addEventListener("click", () => onForget().catch(() => setStatus("无法删除本地配对，请重试。", "err")));
  el.extensionOrigin.value = "chrome-extension://" + chrome.runtime.id;
  el.btnCopyOrigin.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(el.extensionOrigin.value); setStatus("Extension Origin 已复制。", "ok"); }
    catch (_) { setStatus("无法复制，请手动复制 Extension Origin。", "warn"); }
  });
  window.addEventListener("pagehide", clearProof);

  async function boot() {
    const generation = beginOperation("init");
    refreshButtons();
    try {
      const r = await sendToBackground({ type: "GET_PAIRING" });
      if (!isCurrentOperation(generation)) return;
      if (r && r.ok) showPairing(r);
    } catch (e) {
      if (!isCurrentOperation(generation)) return;
      console.warn("[LAT] 获取配对状态失败。");
    }
    if (!isCurrentOperation(generation)) return;
    try {
      await init(generation);
    } catch (e) {
      if (!isCurrentOperation(generation)) return;
      console.error("[LAT] 初始化失败。");
      setStatus("初始化失败，请重新打开扩展。", "err");
    } finally {
      initialized = true;
      finishOperation(generation);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  refreshButtons();
})();
