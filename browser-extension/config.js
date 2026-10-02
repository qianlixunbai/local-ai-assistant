/**
 * 集中配置。Popup / background / content script 共用。
 * - window.LOCAL_AI_CONFIG  → popup (普通 script)
 * - self.LOCAL_AI_CONFIG    → background service worker (importScripts)
 */
(function () {
  const CONFIG = {
    runtimeBaseUrl: "http://127.0.0.1:8765",
    targetLanguage: "zh-CN",
    // content script 页面生命周期内缓存的最大条目数。
    translationCacheMaxEntries: 500,

    batchCharLimit: 2800,
    batchItemLimit: 32,
    batchUtf8ByteLimit: 4096,
    // Browser admission limits verified against the stable Runtime Single contract.
    singleTextCharLimit: 4000,
    singleTextUtf8ByteLimit: 5632,
    runtimeRequestTimeoutMs: 8000,
    runtimeTaskDeadlineMs: 190000,
    runtimePollIntervalMs: 750,
    runtimeMaxPolls: 260,
    runtimeGetRetryLimit: 2,
    runtimeResponseByteLimit: 65536,

    // ---- Viewport First (v0.1.2) ----
    // 首批目标字符数：比后续批次小，让当前视口尽快出现中文。
    // 只影响 batch 1 的大小，不改变后续批次上限。
    firstBatchCharLimit: 1000,
    // 视口附近（Priority 1）的预加载范围：视口上下各扩展 1 个视口高度。
    // 仅用于排序分组，不做滚动监听 / 虚拟滚动。
    viewportPaddingRatio: 1.0,

    // ---- Dynamic Content (v0.2) ----
    // 用户主动点击「翻译当前页面」后，监听后续新增 DOM 并增量翻译。
    // 仅在翻译会话期间生效；Restore 会停止监听。当前固定开启，无设置页。
    dynamicTranslateEnabled: true,
    // 观察到新增 DOM 后的合并延迟（毫秒）。避免一次渲染几十上百个
    // mutation 时逐个触发模型请求。
    mutationDebounceMs: 750,

    // Selection UX limit; background validates characters AND UTF-8 bytes.
    hardTextLimit: 4000,
    // 跳过长度小于该值的文本块（仅作下限，不做主要过滤依据）
    minTextLength: 2,
    // 多个小文本片段合并成一条 record 的上限（如 "Posted" + "4d ago"）
    recordCharLimit: 400,

    // 页面 UI 控件 / 隐藏区域，其内部文本一律不翻译。
    // nav / aside / navigation 的普通文字交由 content.js 检查真实可见交集。
    // 注意：footer / [role='contentinfo'] 不在此列——页脚含大量有意义的
    // 导航与链接文本，交由 content.js 正常提取（<a> 只改文本，不动 href/target）。
    // 下方硬排除标签（script/style/code/button/svg 等）由 content.js 的
    // SKIP_SELECTOR 兜底，此处无需重复。
    pruneSelectors: [
      "[role='banner']",
      "[role='menu']", "[role='menubar']", "[role='tablist']", "[role='toolbar']",
      "[aria-hidden='true']", "[hidden]"
    ],

    // 译文节点 class（Restore 依据）
    translationClass: "local-ai-translation",
    // 已处理标记属性（防止重复翻译）
    sourceAttr: "data-local-ai-source",
    translationAttr: "data-local-ai-translation"
  };

  if (typeof window !== "undefined") {
    window.LOCAL_AI_CONFIG = CONFIG;
  }
  if (typeof self !== "undefined") {
    self.LOCAL_AI_CONFIG = CONFIG;
  }
})();
