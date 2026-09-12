/**
 * 集中配置。Popup / background / content script 共用。
 * - window.LOCAL_AI_CONFIG  → popup (普通 script)
 * - self.LOCAL_AI_CONFIG    → background service worker (importScripts)
 */
(function () {
  const CONFIG = {
    // Ollama 本地服务地址
    ollamaBaseUrl: "http://127.0.0.1:11434",
    // 使用的本地模型
    model: "qwen3.5:4b",

    // 关闭 thinking / reasoning。翻译任务不需要推理链。
    think: false,

    // 翻译请求参数
    temperature: 0,
    top_p: 0.9,
    num_predict: 2048,
    // 显式限定上下文，避免 Ollama 使用默认值导致内存/截断问题
    num_ctx: 8192,
    // 模型加载后保持驻留，避免频繁 unload/reload（Ollama 0.34+ 支持）
    keepAlive: "30m",

    // 单次翻译请求超时（毫秒）。首次请求可能触发 Ollama 加载模型，不宜过短。
    requestTimeoutMs: 90000,
    // 单个批次最多额外重试次数（仅针对可重试错误）
    maxRetries: 1,

    // 每批最多发送的字符数。本机 context 8K，需留出
    // system prompt / JSON 外壳 / 输出空间，故保留安全余量。
    // RTX 5060 8GB + qwen3.5:9b 实测：5000 chars 在 num_predict 2048 下
    // 存在输出截断风险，2800 为当前稳定默认值（接近实测稳定的 ~2500 区间）。
    batchCharLimit: 2800,

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

    // 单个文本块超过该长度则单独成批，避免过长的单条。
    singleTextLimit: 5000,
    // 超过该长度的单条直接跳过（防止一个超长节点拖垮整页）
    hardTextLimit: 12000,
    // 跳过长度小于该值的文本块（仅作下限，不做主要过滤依据）
    minTextLength: 2,
    // 多个小文本片段合并成一条 record 的上限（如 "Posted" + "4d ago"）
    recordCharLimit: 400,

    // 页面 UI 噪声容器，其内部文本一律不翻译。
    // 注意：footer / [role='contentinfo'] 不在此列——页脚含大量有意义的
    // 导航与链接文本，交由 content.js 正常提取（<a> 只改文本，不动 href/target）。
    // 下方硬排除标签（script/style/code/button/svg 等）由 content.js 的
    // SKIP_SELECTOR 兜底，此处无需重复。
    pruneSelectors: [
      "nav", "aside",
      "[role='navigation']", "[role='banner']",
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
