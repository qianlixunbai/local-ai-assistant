/**
 * Local AI Translator — content script
 *
 * 只负责 DOM 相关职责：
 * 1. 用 TreeWalker(SHOW_TEXT) 提取页面真实可见的文本节点
 * 2. 把文本节点按「锚点元素」聚合成 translation record，分批交给 background 翻译
 * 3. 将译文作为独立节点插入原文附近（原文保留）
 * 4. 恢复原文（删除译文节点）
 * 5. 向 popup 推送进度 / 输出本地性能日志
 *
 * 网络请求全部由 background service worker 通过 chrome.runtime messaging
 * 完成，本脚本不包含任何 fetch / Ollama 逻辑。
 *
 * 提取策略（v0.1.1）：
 * 不依赖 p/li/h* 等固定标签选择器，而是遍历所有文本节点，因此
 * div / span / a 内部以及组件化 DOM 中的可见英文都能被发现。
 *
 * 锚点（anchor）选择：
 *   文本节点归属到「最近的、其子元素全为行内的祖先元素」。
 *   - <div class="meta"><span>Full time</span><span>4d ago</span></div>
 *     → 锚点 = div.meta，两个 span 合并成一条 record
 *   - <div class="card"><a>View all jobs</a></div>（card 含块级子元素）
 *     → 锚点 = <a>，单独成一条，且译文插在链接内部
 *   这样既避免父子重复翻译，又不会把 <a> 文本错误地挂到整个卡片上。
 *
 * 幂等：重复注入不会重复绑定监听器（通过 window 上的哨兵标记）。
 */
(function () {
  if (window.__LOCAL_AI_TRANSLATOR_LOADED__) return;
  window.__LOCAL_AI_TRANSLATOR_LOADED__ = true;

  const CFG = window.LOCAL_AI_CONFIG;
  if (!CFG) {
    console.error("[LAT] config 未加载，content.js 无法运行");
    return;
  }

  const TAG = "[LAT]";

  // 行内元素：可以成为锚点（译文插入其内部），也可以被更外层锚点合并
  const INLINE_TAGS = new Set([
    "A", "SPAN", "B", "I", "EM", "STRONG", "SMALL", "LABEL", "TIME",
    "SUP", "SUB", "U", "S", "MARK", "ABBR", "CITE", "Q", "BDI", "BDO",
    "FONT", "NOBR", "INS", "DEL", "VAR", "KBD", "SAMP"
  ]);
  // 译文插入元素内部（而非之后）的锚点，避免破坏列表/表格结构
  const INNER_INSERT_TAGS = new Set(["LI", "TD", "TH", "DD", "DT"]);

  // 一律不翻译的区域
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "code", "pre", "textarea", "input",
    "select", "option", "button", "svg", "canvas", "iframe", "object",
    "embed", "template", "head", "title"
  ].join(",");
  const PRUNE_SELECTOR = (CFG.pruneSelectors || []).join(",");
  const SELECTION_CARD_SELECTOR = ".local-ai-selection-card";
  const LINE_TRANSLATION_ATTR = "data-local-ai-line-translation";

  let session = null;
  let sessionProgress = { status: "idle", done: 0, total: 0 };
  let lastError = "";
  // 页面级缓存独立于翻译 session；Restore / LAT_RESET 不清除此 Map。
  const translationCache = new Map();
  // 选区翻译使用独立 generation，不改变整页翻译 session 的生命周期。
  let selectionGeneration = 0;
  let selectionCard = null;
  let contextMenuSelection = null;
  // 会话 generation：Restore / LAT_RESET / 每次新翻译都会递增。
  // 所有 async 翻译循环在 await 之后必须核对自己的 generation，
  // 不匹配即视为 stale，丢弃结果且不得修改任何会话状态（见 v0.2.1 P1-2）。
  let sessionGeneration = 0;

  /** 当前 async 循环是否仍属于最新会话。stale 循环必须放弃一切状态写入。 */
  function isCurrentSession(gen) {
    return gen === sessionGeneration;
  }

  // ---- 动态内容监听（v0.2）----
  let observer = null;        // MutationObserver 实例
  let watching = false;       // 是否处于监听状态
  let dirty = false;          // 是否观察到尚未处理的新增内容
  let dynamicTimer = null;    // debounce 定时器

  // ---- partial 业务状态（v0.2.1 P2 补充）----
  // 上一次翻译/动态翻译运行结束时仍有失败 record。这是一个独立的业务状态，
  // 与 watching 不互斥：页面可以同时 status="partial" 且 watching=true。
  // 运行中（session.running）不设置本标记，由 getStatus 优先返回 translating。
  let partialPending = false;
  // catch-up 需要跳过的 anchor。动态翻译运行期间，若这些 anchor 再次被标记 dirty，
  // observer / catch-up 不得重试它们，否则失败 record 会陷入无限重试循环。
  // 用户再次点击 Translate 时清空（显式重试）。
  let catchupSkipAnchors = new Set();
  // BR 段落失败时以该段首个原始 DOM 节点为稳定 key，不跳过同容器的其他段落。
  const failedLineKeys = new WeakSet();

  /* ------------------------------------------------------------------ */
  /* 文本判定                                                            */
  /* ------------------------------------------------------------------ */

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  /** 节点是否位于选区翻译卡片内（覆盖卡片本身和所有后代）。 */
  function isSelectionCardNode(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest(SELECTION_CARD_SELECTOR));
  }

  /** 判断一段可见文本是否值得翻译 */
  function isTranslatableText(text) {
    if (!text) return false;
    if (text.length < CFG.minTextLength) return false;
    // 必须包含英文字母
    if (!/[A-Za-z]/.test(text)) return false;
    // 至少有一个长度 ≥2 的连续字母片段（排除 "A"、"x" 这类单字母噪声）
    if (!/[A-Za-z]{2}/.test(text)) return false;
    // 极短的无分隔单词（如 "AI"、"OK"）不翻译；含空格的多词短语仍会翻译
    if (!/\s/.test(text) && text.length < 4) return false;
    // 纯数字 / 日期 / 数字加标点
    if (/^[\d\s.,:%+\-()/年月日]+$/.test(text)) return false;
    // 纯 URL
    if (/^https?:\/\/\S+$/i.test(text)) return false;
    // 纯 email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
    // 纯路径（含分隔符、无空格）
    if (/^[\w.\-\\/]+$/.test(text) && /[\\/]/.test(text)) return false;
    // 明显的代码片段特征（含大量符号且无正常单词）
    if (/^[{}()[\];=<>&|!*/\\]+$/.test(text)) return false;
    return true;
  }

  /** 元素是否可见 */
  const visibilityCache = new WeakMap();
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (visibilityCache.has(el)) return visibilityCache.get(el);
    let visible;
    if (typeof el.checkVisibility === "function") {
      visible = el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    } else {
      visible = el.getClientRects().length > 0;
    }
    visibilityCache.set(el, visible);
    return visible;
  }

  /** 元素是否「纯文本块」：子元素全部为行内（没有块级子元素） */
  function isTextBlock(el) {
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (!INLINE_TAGS.has(child.tagName)) return false;
    }
    return true;
  }

  /**
   * 找到文本节点归属的锚点元素。
   * 从直接父元素向上爬，只要父元素仍是「纯文本块」就继续合并，
   * 这样被 span 拆开的连续文本会聚成一条；遇到含块级子元素的祖先即停止。
   */
  function findAnchor(textNode) {
    let el = textNode.parentElement;
    if (!el) return null;

    while (el.parentElement) {
      const parent = el.parentElement;
      if (parent.tagName === "BODY" || parent.tagName === "HTML") break;
      if (!isTextBlock(parent)) break;
      el = parent;
    }
    return el;
  }

  /** 锚点是否已经带有本插件插入的译文（含页面重载后的「孤儿译文」） */
  function hasTranslation(anchor) {
    if (anchor.querySelector(":scope > ." + CFG.translationClass)) return true;
    const next = anchor.nextElementSibling;
    return !!(next && next.classList.contains(CFG.translationClass) && !next.hasAttribute(LINE_TRANSLATION_ATTR));
  }

  /** 锚点是否仍需要翻译（未断开、无译文、未标记 source）。用于 partial 追踪剪枝。 */
  function anchorStillNeedsWork(anchor) {
    if (failedLineKeys.has(anchor)) return anchor.isConnected;
    return !!anchor && anchor.isConnected && !hasTranslation(anchor) && !anchor.hasAttribute(CFG.sourceAttr);
  }

  /** 剪除已成功 / 已断开的 anchor；剩余集合即「仍然失败、等待显式重试」的 record。 */
  function pruneCatchupSkip() {
    catchupSkipAnchors.forEach((a) => {
      if (!anchorStillNeedsWork(a)) {
        catchupSkipAnchors.delete(a);
        failedLineKeys.delete(a);
      }
    });
  }

  function clearCatchupSkip() {
    catchupSkipAnchors.forEach((a) => failedLineKeys.delete(a));
    catchupSkipAnchors.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 提取                                                                */
  /* ------------------------------------------------------------------ */

  function hasDirectBreak(el, cache) {
    if (cache.has(el)) return cache.get(el);
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (child.tagName === "BR") {
        cache.set(el, true);
        return true;
      }
    }
    cache.set(el, false);
    return false;
  }

  /** 仅沿行内祖先上溯，找到以直接子级 BR 排版的容器。 */
  function findBreakContainer(textNode, directBreakCache, nestedBreakCache) {
    let el = textNode.parentElement;
    while (el && el.tagName !== "BODY" && el.tagName !== "HTML") {
      if (hasDirectBreak(el, directBreakCache)) return el;
      if (!INLINE_TAGS.has(el.tagName)) break;
      // Inline descendants may themselves contain nested BR markup. Keep their
      // surrounding text with that inline subtree rather than losing it upstream.
      if (!nestedBreakCache.has(el)) nestedBreakCache.set(el, !!el.querySelector("br"));
      if (nestedBreakCache.get(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 把 BR 容器的直接子级按换行和块级子元素切段。只读原始 DOM；
   * 已插入的行译文作为该段完成标记，下一段仍可独立收集。
   */
  function indexBreakSegments(container, byTextNode) {
    let segment = { anchor: container, nodes: [], textNodes: [], pieces: [], translated: false };

    const flush = () => {
      if (segment.nodes.length) {
        segment.key = segment.nodes[0];
        segment.text = normalize(segment.pieces.join(" "));
        segment.textNodes.forEach((textNode) => byTextNode.set(textNode, segment));
      }
      segment = { anchor: container, nodes: [], textNodes: [], pieces: [], translated: false };
    };

    const gather = (node) => {
      if (node.nodeType === 3) {
        segment.textNodes.push(node);
        const piece = normalize(node.nodeValue);
        if (piece) segment.pieces.push(piece);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.matches(SKIP_SELECTOR) || (PRUNE_SELECTOR && node.matches(PRUNE_SELECTOR)) ||
          node.matches(SELECTION_CARD_SELECTOR) || node.classList.contains(CFG.translationClass) ||
          node.hasAttribute(CFG.sourceAttr) ||
          node.querySelector(":scope > ." + CFG.translationClass) || !isVisible(node)) return;
      for (let child = node.firstChild; child; child = child.nextSibling) gather(child);
    };

    for (let child = container.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        if (child.classList.contains(CFG.translationClass)) {
          segment.translated = true;
          flush();
          continue;
        }
        if (child.tagName === "BR" || !INLINE_TAGS.has(child.tagName) || child.querySelector("br")) {
          flush();
          continue;
        }
      }
      if (child.nodeType !== 1 && child.nodeType !== 3) continue;
      segment.nodes.push(child);
      const before = segment.pieces.length;
      gather(child);
      if (segment.pieces.length > before) segment.afterNode = child;
    }
    flush();
  }

  /**
   * 遍历文本节点，聚合成 translation record。
   * root 默认为 document.body（整页）；动态阶段可传入新增子树以缩小扫描范围。
   * 返回数组 [{ id, text, anchor, domOrder }]
   */
  function collectRecords(root) {
    const scope = root || document.body || document.documentElement;
    const walker = document.createTreeWalker(
      scope,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return isSelectionCardNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const records = [];
    const lastByAnchor = new Map();
    const breakSegmentsByText = new WeakMap();
    const indexedBreakContainers = new WeakSet();
    const directBreakCache = new WeakMap();
    const nestedBreakCache = new WeakMap();
    let id = 0;
    let node;

    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(SKIP_SELECTOR)) continue;
      if (PRUNE_SELECTOR && parent.closest(PRUNE_SELECTOR)) continue;
      if (parent.closest(SELECTION_CARD_SELECTOR)) continue;
      if (parent.closest("." + CFG.translationClass)) continue;

      const breakContainer = findBreakContainer(node, directBreakCache, nestedBreakCache);
      if (breakContainer) {
        // A translated container from an older content-script version remains owned by that version.
        const next = breakContainer.nextElementSibling;
        if (breakContainer.hasAttribute(CFG.sourceAttr) ||
            (next && next.classList.contains(CFG.translationClass) && !next.hasAttribute(LINE_TRANSLATION_ATTR))) continue;
        if (!indexedBreakContainers.has(breakContainer)) {
          indexBreakSegments(breakContainer, breakSegmentsByText);
          indexedBreakContainers.add(breakContainer);
        }
        const line = breakSegmentsByText.get(node);
        if (!line || line.emitted) continue;
        line.emitted = true;
        if (line.translated || catchupSkipAnchors.has(line.key) || !isVisible(breakContainer) ||
            !isTranslatableText(line.text)) continue;
        records.push({ id: id++, text: line.text, anchor: breakContainer, line, domOrder: records.length });
        continue;
      }

      const anchor = findAnchor(node);
      if (!anchor || !anchor.parentNode) continue;
      if (anchor.hasAttribute(CFG.sourceAttr)) continue;
      if (hasTranslation(anchor)) continue;
      // partial 会话：自动 retry 跳过本轮已知失败的 anchor（用户显式重试会清空该集合）
      if (catchupSkipAnchors.has(anchor)) continue;
      if (!isVisible(anchor)) continue;

      const piece = normalize(node.nodeValue);
      if (!piece) continue;

      // 同一锚点内，后续片段直接并入已有 record（保留 "·" 之类的连接符）
      const prev = lastByAnchor.get(anchor);
      if (prev && prev.text.length + 1 + piece.length <= CFG.recordCharLimit) {
        prev.text = normalize(prev.text + " " + piece);
        continue;
      }

      // 新锚点：只接受本身有翻译价值的文本
      if (!isTranslatableText(piece)) continue;

      const rec = { id: id++, text: piece, anchor, domOrder: records.length };
      lastByAnchor.set(anchor, rec);
      records.push(rec);
    }

    return records;
  }

  /* ------------------------------------------------------------------ */
  /* 分批                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 计算视口优先级（仅排序用，不做滚动监听 / 虚拟滚动）：
   *   0 = 当前视口内
   *   1 = 视口上下各扩展 viewportPaddingRatio 个视口高度以内
   *   2 = 页面其余内容
   * 同 priority 内保持原始 DOM 顺序（稳定排序依据 domOrder）。
   */
  function prioritizeRecords(records) {
    const height = window.innerHeight || 0;
    const pad = height * CFG.viewportPaddingRatio;

    const items = records.map((rec, i) => {
      let rect;
      try {
        rect = rec.anchor.getBoundingClientRect();
      } catch (e) {
        rect = { top: 0, bottom: 0 };
      }
      let priority = 2;
      if (rect.bottom >= 0 && rect.top <= height) {
        priority = 0;
      } else if (rect.bottom >= -pad && rect.top <= height + pad) {
        priority = 1;
      }
      return { rec, priority, domOrder: i };
    });

    // 先按 priority，再按原始 DOM 顺序 —— 保证同区域文字不乱序
    items.sort((a, b) => (a.priority - b.priority) || (a.domOrder - b.domOrder));
    return items;
  }

  /**
   * 按顺序切批。首批使用 firstLimit（更小，让首屏尽快出现），
   * 之后每批使用 batchCharLimit。以完整 record 为最小单位，不拆分。
   */
  function buildBatches(orderedRecords, firstLimit) {
    const batches = [];
    let current = [];
    let currentLen = 0;
    let limit = firstLimit;

    const flush = () => {
      if (!current.length) return;
      batches.push(current);
      current = [];
      currentLen = 0;
      limit = CFG.batchCharLimit; // 首批之后恢复常规上限
    };

    for (const rec of orderedRecords) {
      const len = rec.text.length;
      if (len > CFG.singleTextLimit) {
        flush();
        batches.push([rec]);
        limit = CFG.batchCharLimit;
        continue;
      }
      if (current.length && currentLen + len > limit) {
        flush();
      }
      current.push(rec);
      currentLen += len;
    }
    flush();
    return batches;
  }

  /* ------------------------------------------------------------------ */
  /* 与 background 通信                                                  */
  /* ------------------------------------------------------------------ */

  /** 请求 background 翻译一批。返回 id → 译文 的 Map。 */
  async function requestBatch(batch) {
    const items = batch.map((r) => ({ id: r.id, text: r.text }));
    const resp = await chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", items });

    if (!resp) throw new Error("background 未响应。");
    if (!resp.ok) {
      const error = new Error(resp.error || "翻译请求失败。");
      error.kind = resp.kind;
      throw error;
    }

    const byId = new Map();
    (resp.results || []).forEach((r) => byId.set(Number(r.id), r.translation));
    return byId;
  }

  /** 精确翻译缓存 key；keep_alive 与 DOM / session 信息不影响翻译结果。 */
  function translationCacheKey(text) {
    return JSON.stringify({
      text: normalize(text),
      model: CFG.model,
      targetLanguage: CFG.targetLanguage,
      promptVersion: CFG.translationPromptVersion,
      think: CFG.think,
      temperature: CFG.temperature,
      topP: CFG.top_p,
      numPredict: CFG.num_predict,
      numCtx: CFG.num_ctx
    });
  }

  /** Cache hit 时提升为最近使用项。 */
  function getCachedTranslation(key) {
    if (!translationCache.has(key)) return null;
    const value = translationCache.get(key);
    translationCache.delete(key);
    translationCache.set(key, value);
    return value;
  }

  /** 只保存成功的非空译文，并按最近使用顺序限制页面缓存容量。 */
  function setCachedTranslation(key, translation) {
    if (typeof translation !== "string" || !translation.trim()) return;
    translationCache.delete(key);
    translationCache.set(key, translation.trim());
    while (translationCache.size > CFG.translationCacheMaxEntries) {
      const oldestKey = translationCache.keys().next().value;
      translationCache.delete(oldestKey);
    }
  }

  /**
   * 先查页面缓存，再将未命中的相同 key 合并为唯一请求项。
   * cachePlan.byId 仅包含当前 batch 的 cache hit；missGroups 用于回填和 fan-out。
   */
  function prepareCachedBatch(batch) {
    const byId = new Map();
    const missGroups = new Map();
    let hits = 0;
    let misses = 0;

    batch.forEach((record) => {
      const key = translationCacheKey(record.text);
      const cached = getCachedTranslation(key);
      if (cached !== null) {
        byId.set(record.id, cached);
        hits++;
        return;
      }

      misses++;
      let group = missGroups.get(key);
      if (!group) {
        group = { key, records: [] };
        missGroups.set(key, group);
      }
      group.records.push(record);
    });

    const requests = Array.from(missGroups.values(), (group) => group.records[0]);
    console.log(
      TAG + " cache: hits=" + hits +
      " misses=" + misses +
      " deduped=" + (misses - requests.length) +
      " requests=" + requests.length
    );
    return { byId, missGroups, requests };
  }

  /**
   * 成功响应只在调用方完成 post-await generation 校验后传入此处，
   * 再写缓存并把 unique response 映射回所有原 record id。
   */
  function resolveCachedBatch(cachePlan, translatedById, generation) {
    if (!isCurrentSession(generation)) return null;
    const byId = cachePlan.byId;

    for (const group of cachePlan.missGroups.values()) {
      const representative = group.records[0];
      const translation = translatedById && translatedById.get(representative.id);
      if (typeof translation !== "string" || !translation.trim()) continue;

      const normalizedTranslation = translation.trim();
      // generation 校验必须位于任何 cache write 之前。
      if (!isCurrentSession(generation)) return null;
      setCachedTranslation(group.key, normalizedTranslation);
      group.records.forEach((record) => byId.set(record.id, normalizedTranslation));
    }

    return byId;
  }

  /* ------------------------------------------------------------------ */
  /* 选区翻译                                                            */
  /* ------------------------------------------------------------------ */

  function rectSnapshot(rect) {
    if (!rect) return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const right = Number(rect.right);
    const bottom = Number(rect.bottom);
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  function readSelectionGeometry(selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    try {
      const range = selection.getRangeAt(0);
      const rect = rectSnapshot(range.getBoundingClientRect());
      return rect ? { text: selection.toString().trim(), rect } : null;
    } catch (_) {
      return null;
    }
  }

  /** 捕获右键时选区的位置，供扩展 context-menu 消息定位浮卡片。 */
  function captureContextMenuSelection(event) {
    const selection = window.getSelection();
    const geometry = readSelectionGeometry(selection);
    const text = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (!text) {
      contextMenuSelection = null;
      return;
    }
    contextMenuSelection = {
      text,
      rect: geometry && geometry.rect,
      mouseX: Number.isFinite(event.clientX) ? event.clientX : null,
      mouseY: Number.isFinite(event.clientY) ? event.clientY : null,
      timestamp: Date.now()
    };
  }

  document.addEventListener("contextmenu", captureContextMenuSelection, true);

  function selectionPlacement(selectionText) {
    const now = Date.now();
    const context = contextMenuSelection;
    if (
      context && now - context.timestamp <= 30000 &&
      normalize(context.text) === normalize(selectionText)
    ) {
      return context;
    }

    const current = readSelectionGeometry(window.getSelection());
    if (current && normalize(current.text) === normalize(selectionText)) {
      return { rect: current.rect, mouseX: null, mouseY: null, timestamp: now };
    }
    return { rect: null, mouseX: null, mouseY: null, timestamp: now };
  }

  function ensureSelectionCard() {
    if (selectionCard && selectionCard.root.isConnected) return selectionCard;

    // A content-script reinjection may leave a card from the previous context.
    document.querySelectorAll(SELECTION_CARD_SELECTOR).forEach((node) => node.remove());

    const root = document.createElement("section");
    root.className = "local-ai-selection-card";
    root.setAttribute("data-local-ai-selection-card", "1");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "所选内容翻译");

    const header = document.createElement("div");
    header.className = "local-ai-selection-card__header";

    const title = document.createElement("span");
    title.className = "local-ai-selection-card__title";
    title.textContent = "Local AI 翻译";

    const status = document.createElement("span");
    status.className = "local-ai-selection-card__status";
    status.setAttribute("aria-live", "polite");

    const closeButton = document.createElement("button");
    closeButton.className = "local-ai-selection-card__close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭选区翻译");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => {
      if (selectionCard && selectionCard.root === root) selectionGeneration++;
      root.remove();
      if (selectionCard && selectionCard.root === root) selectionCard = null;
    });

    const body = document.createElement("div");
    body.className = "local-ai-selection-card__body";
    body.setAttribute("aria-live", "polite");

    header.append(title, status, closeButton);
    root.append(header, body);
    selectionCard = { root, status, body };
    return selectionCard;
  }

  function placeSelectionCard(card, placement) {
    const root = card.root;
    const host = document.body || document.documentElement;
    if (!root.isConnected && host) host.appendChild(root);
    if (!root.isConnected) return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    root.style.position = "fixed";
    root.style.zIndex = "2147483647";
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.style.maxWidth = Math.max(0, viewportWidth - 16) + "px";
    root.style.maxHeight = Math.max(0, viewportHeight - 16) + "px";
    root.style.left = "0px";
    root.style.top = "0px";
    root.style.visibility = "hidden";

    const measured = root.getBoundingClientRect();
    const cardWidth = measured.width || Math.min(360, Math.max(0, viewportWidth - 16));
    const cardHeight = measured.height || 160;
    const rect = placement && placement.rect;
    let left;
    let top;

    if (rect) {
      left = rect.left;
      top = rect.bottom + 10;
      if (top + cardHeight > viewportHeight - 8) top = rect.top - cardHeight - 10;
    } else if (placement && Number.isFinite(placement.mouseX) && Number.isFinite(placement.mouseY)) {
      left = placement.mouseX + 12;
      top = placement.mouseY + 12;
    } else {
      left = (viewportWidth - cardWidth) / 2;
      top = (viewportHeight - cardHeight) / 2;
    }

    const maxLeft = Math.max(8, viewportWidth - cardWidth - 8);
    const maxTop = Math.max(8, viewportHeight - cardHeight - 8);
    root.style.left = Math.min(maxLeft, Math.max(8, left)) + "px";
    root.style.top = Math.min(maxTop, Math.max(8, top)) + "px";
    root.style.visibility = "visible";
  }

  function isCurrentSelection(generation) {
    return generation === selectionGeneration;
  }

  async function translateSelection(selectionText) {
    const generation = ++selectionGeneration;
    const text = typeof selectionText === "string" ? selectionText.trim() : "";
    const card = ensureSelectionCard();
    const placement = selectionPlacement(text);
    contextMenuSelection = null;
    card.status.textContent = "";
    card.body.textContent = "";
    placeSelectionCard(card, placement);

    if (!text) {
      card.status.textContent = "未找到选中文本";
      card.body.textContent = "请先选择要翻译的文本。";
      placeSelectionCard(card, placement);
      return { ok: false, error: "请先选择要翻译的文本。" };
    }
    if (text.length > CFG.hardTextLimit) {
      const error = "所选内容过长，最多支持 " + CFG.hardTextLimit + " 个字符。";
      card.status.textContent = "无法翻译";
      card.body.textContent = error;
      placeSelectionCard(card, placement);
      return { ok: false, error };
    }

    card.status.textContent = "正在翻译…";
    placeSelectionCard(card, placement);
    const key = translationCacheKey(text);
    try {
      let translation = getCachedTranslation(key);
      const cached = translation !== null;
      if (!cached) {
        const translatedById = await requestBatch([{ id: 0, text }]);
        // Only the latest selection may cache or render an async result.
        if (!isCurrentSelection(generation)) return { ok: false, stale: true };
        translation = translatedById.get(0);
        if (typeof translation !== "string" || !translation.trim()) {
          const error = new Error("empty translation");
          error.kind = "empty";
          throw error;
        }
        if (!isCurrentSelection(generation)) return { ok: false, stale: true };
        setCachedTranslation(key, translation.trim());
      }

      if (!isCurrentSelection(generation)) return { ok: false, stale: true };
      card.status.textContent = "翻译完成";
      card.body.textContent = translation.trim();
      placeSelectionCard(card, placement);
      return { ok: true, cached };
    } catch (error) {
      if (!isCurrentSelection(generation)) return { ok: false, stale: true };
      const messages = {
        network: "无法连接本机 Ollama，请确认服务已启动。",
        model: "本地模型不可用，请确认已安装所需模型。",
        timeout: "翻译请求超时，请稍后重试。",
        empty: "未获得译文，请重试。"
      };
      const friendly = messages[error && error.kind] || "翻译暂时失败，请稍后重试。";
      card.status.textContent = "翻译失败";
      card.body.textContent = friendly;
      placeSelectionCard(card, placement);
      // Do not log selection text, model output, response payloads, or exception details.
      console.warn(TAG + " selection translation failed: " + (messages[error && error.kind] ? error.kind : "unknown"));
      return { ok: false, error: friendly };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 插入译文                                                            */
  /* ------------------------------------------------------------------ */

  /** 译文插入位置：行内锚点插入内部，块级锚点插入其后。 */
  function insertTranslation(record, translation) {
    const anchor = record.anchor;
    if (!anchor || !anchor.parentNode) return null;

    const node = document.createElement("div");
    node.className = CFG.translationClass;
    node.setAttribute(CFG.translationAttr, "1");
    node.setAttribute("lang", "zh-CN");
    node.textContent = translation;

    if (record.line) {
      const line = record.line;
      node.setAttribute(LINE_TRANSLATION_ATTR, "1");
      if (INLINE_TAGS.has(anchor.tagName)) node.classList.add("local-ai-translation--inline");
      // The collected source node is stable even if the page moves its BR
      // boundary while a batch is in flight. Always insert after that source.
      if (!line.afterNode || line.afterNode.parentNode !== anchor) return null;
      line.afterNode.after(node);
      return node;
    }

    const inline = INLINE_TAGS.has(anchor.tagName) || INNER_INSERT_TAGS.has(anchor.tagName);
    if (inline) {
      node.classList.add("local-ai-translation--inline");
      anchor.appendChild(node);
    } else {
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    }
    return node;
  }

  function setRecordTranslating(record, active) {
    if (record.line) return;
    record.anchor.classList.toggle("local-ai-translating", active);
  }

  function recordFailureKey(record) {
    if (record.line) {
      failedLineKeys.add(record.line.key);
      return record.line.key;
    }
    return record.anchor;
  }

  /* ------------------------------------------------------------------ */
  /* 动态内容监听（v0.2）                                                */
  /* ------------------------------------------------------------------ */

  /** mutation 节点是否由本插件产生（译文节点本身，或位于译文节点内部）。 */
  function isOwnTranslationNode(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest("." + CFG.translationClass));
  }

  function isOwnContentUiNode(node) {
    return isOwnTranslationNode(node) || isSelectionCardNode(node);
  }

  /**
   * 观察到的 mutation 是否可能带来新的可翻译文本。
   * 只做很轻的判断：忽略插件自身产生的 mutation（防止翻译↔观察反馈循环），
   * 其余一律标记 dirty，交给 debounce 后的 collectRecords 过滤。
   */
  function mutationMightAddContent(mutations) {
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      if (isOwnContentUiNode(m.target)) continue;
      const added = m.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (n.nodeType === 1) {
          if (isOwnContentUiNode(n)) continue;
          return true;
        }
        if (n.nodeType === 3 && !isOwnContentUiNode(n) && normalize(n.nodeValue)) return true; // 直接插入的文本节点
      }
    }
    return false;
  }

  /**
   * 启动监听。仅在用户主动翻译后调用。
   * observer 回调只标记 dirty + schedule debounce，不做扫描 / 请求。
   */
  function startWatching() {
    if (!CFG.dynamicTranslateEnabled) return;
    if (watching) return;
    if (typeof MutationObserver === "undefined") return;

    watching = true;
    dirty = false;
    observer = new MutationObserver((mutations) => {
      if (!watching) return;
      if (!mutationMightAddContent(mutations)) return;
      dirty = true;
      scheduleDynamic(CFG.mutationDebounceMs);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
    console.log(TAG + " dynamic watcher started");
  }

  /** 停止监听并清掉所有待处理状态（Restore 时调用）。 */
  function stopWatching() {
    if (dynamicTimer) {
      clearTimeout(dynamicTimer);
      dynamicTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (watching) console.log(TAG + " dynamic watcher stopped");
    watching = false;
    dirty = false;
  }

  function scheduleDynamic(delay) {
    if (!watching) return;
    // 捕获当前 generation：debounce 到点时若会话已换代，回调直接作废
    const gen = sessionGeneration;
    if (dynamicTimer) clearTimeout(dynamicTimer);
    dynamicTimer = setTimeout(() => {
      dynamicTimer = null;
      if (!isCurrentSession(gen)) return;
      runDynamicOnce();
    }, delay);
  }

  /** 由 popup 明确要求恢复：停止监听 + 换代作废在途请求 + 删除译文。 */
  function restorePage() {
    stopWatching();
    sessionGeneration++;                 // 作废所有在途 async 循环
    const r = restoreOriginal();
    partialPending = false;
    clearCatchupSkip();
    session = null;
    sessionProgress = { status: "idle", done: 0, total: 0 };
    return r;
  }

  /** debounce 到点后在「无翻译循环运行」时触发一次动态翻译。 */
  function runDynamicOnce() {
    if (!watching || !CFG.dynamicTranslateEnabled) return;
    if (session && session.running) return; // 有循环在跑：保留 dirty，待其结束后再处理
    if (dirty) drainDynamic();
  }

  /**
   * 收集尚未翻译的新增 record 并顺序翻译。与首次翻译共用
   * collectRecords / isTranslatableText / findAnchor / hasTranslation /
   * buildBatches / requestBatch / insertTranslation。
   * 动态批次不使用 Viewport First 的小首批规则（record 通常较少）。
   */
  async function drainDynamic() {
    if (!watching) return;

    const myGen = sessionGeneration;
    const mySession = { running: true };
    session = mySession;
    dirty = false;

    const records = collectRecords();
    if (!records.length) {
      if (isCurrentSession(myGen)) session = null;
      return;
    }

    const batches = buildBatches(records, CFG.batchCharLimit);

    console.log(TAG + " dynamic collect: " + records.length + " new records, batches = " + batches.length);
    sendProgress({ status: "dynamic-translating", done: 0, total: records.length, batch: 0, batches: batches.length });

    let translated = 0;
    let failed = 0;
    const failedAnchors = [];

    for (let i = 0; i < batches.length; i++) {
      // stale 会话（Restore / 新翻译）：立即退出，绝不写入任何状态
      if (!isCurrentSession(myGen) || !watching) break;

      const batch = batches[i].filter((r) => {
        if (r.text.length > CFG.hardTextLimit) {
          console.warn(TAG, "跳过超长文本（" + r.text.length + " 字符）");
          return false;
        }
        return true;
      });
      if (!batch.length) continue;

      batch.forEach((r) => setRecordTranslating(r, true));
      try {
        const cachePlan = prepareCachedBatch(batch);
        let translatedById = null;
        let requestError = null;
        if (cachePlan.requests.length) {
          try {
            translatedById = await requestBatch(cachePlan.requests);
          } catch (e) {
            requestError = e;
          }
        }
        // stale：丢弃结果，不插入、不改 session / progress
        if (!isCurrentSession(myGen) || !watching) {
          break;
        }
        const byId = resolveCachedBatch(cachePlan, translatedById, myGen);
        if (!byId) break;
        if (requestError) console.error(TAG, "动态批次翻译失败:", requestError.name || "error");
        batch.forEach((r) => {
          const translation = byId.get(r.id);
          if (typeof translation === "string" && translation.trim() && insertTranslation(r, translation.trim())) {
            if (!r.line) r.anchor.setAttribute(CFG.sourceAttr, "1");
            translated++;
          } else {
            failed++;
            failedAnchors.push(recordFailureKey(r));
          }
          setRecordTranslating(r, false);
        });
      } catch (e) {
        console.error(TAG, "动态批次翻译失败:", e && e.name ? e.name : "error");
        failed += batch.length;
        batch.forEach((r) => { failedAnchors.push(recordFailureKey(r)); setRecordTranslating(r, false); });
      }
      if (!isCurrentSession(myGen)) break;
      sendProgress({ status: "dynamic-translating", done: translated, total: records.length, batch: i + 1, batches: batches.length });
    }

    // stale 循环到此为止：不碰 session.running / watching / progress
    if (!isCurrentSession(myGen)) return;

    session = null;
    console.log(TAG + " dynamic translation done: " + translated + " records");

    // 本次动态翻译仍失败的 anchor 加入 catchup 跳过集合，防止 observer / catch-up
    // 自动重试造成无限循环。用户再次点击 Translate 会清空该集合并显式重试。
    failedAnchors.forEach((a) => catchupSkipAnchors.add(a));
    // 剪除已被翻译 / 已断开的 anchor，再由剩余失败集推导 partial。
    pruneCatchupSkip();
    partialPending = catchupSkipAnchors.size > 0;

    if (watching) {
      sendProgress({ status: partialPending ? "partial" : "watching", done: translated, total: records.length });
      // 本轮翻译期间又出现新增内容：再排一轮增量。
      // catchupSkipAnchors 保证本轮已失败的 anchor 不会被自动重试，避免无限循环。
      if (dirty) scheduleDynamic(0);
    }
  }



  function sendProgress(partial) {
    sessionProgress = Object.assign({}, sessionProgress, partial);
    try {
      const p = chrome.runtime.sendMessage({ type: "TRANSLATION_PROGRESS", progress: sessionProgress });
      // popup 可能已关闭，此时消息端口关闭会 reject，忽略即可
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  async function translatePage() {
    if (session && session.running) {
      return { ok: false, error: "翻译正在进行中。" };
    }

    const already = document.querySelectorAll("." + CFG.translationClass).length;

    // 新的一轮用户发起翻译：清空上一轮的 partial 状态与自动 retry 跳过集合，
    // 让本次可以显式重试此前失败的 record。
    partialPending = false;
    clearCatchupSkip();

    // 开启新会话：换代（作废任何在途旧循环），并持有自己的 generation
    const myGen = ++sessionGeneration;
    const mySession = { running: true };
    session = mySession;
    lastError = "";

    const t0 = performance.now();
    const records = collectRecords();
    const totalChars = records.reduce((s, r) => s + r.text.length, 0);

    if (!records.length) {
      // 无新内容可翻（多为已翻译页面）：结束本次会话并（重新）开启监听
      if (isCurrentSession(myGen)) session = null;
      if (already > 0) {
        if (CFG.dynamicTranslateEnabled) startWatching();
        return { ok: false, alreadyTranslated: true, watching, error: "当前页面已翻译。" };
      }
      return { ok: false, error: "未找到可翻译的英文正文。" };
    }

    const prioritized = prioritizeRecords(records);
    const batches = buildBatches(prioritized.map((x) => x.rec), CFG.firstBatchCharLimit);
    const total = records.length;

    const priorityCounts = { 0: 0, 1: 0, 2: 0 };
    prioritized.forEach((x) => { priorityCounts[x.priority]++; });

    const firstBatch = batches[0] || [];
    const firstBatchChars = firstBatch.reduce((s, r) => s + r.text.length, 0);

    console.log(
      TAG + " translate: records = " + total +
      ", batches = " + batches.length +
      ", chars = " + totalChars
    );
    console.log(
      TAG + " viewport-first: visibleRecords = " + priorityCounts[0] +
      ", nearRecords = " + priorityCounts[1] +
      ", restRecords = " + priorityCounts[2] +
      ", firstBatchChars = " + firstBatchChars
    );
    sendProgress({ status: "translating", done: 0, total, batch: 0, batches: batches.length });

    let translated = 0;
    let failed = 0;
    let skipped = 0;
    const failedAnchors = [];            // partial 时进入自动 retry 跳过集合
    let firstTranslationVisibleMs = null;
    let firstBatchDone = false;

    for (let i = 0; i < batches.length; i++) {
      // 换代即退出（不加日志、不写任何状态）
      if (!isCurrentSession(myGen)) break;
      const batch = batches[i];

      const usable = [];
      batch.forEach((r) => {
        if (r.text.length > CFG.hardTextLimit) {
          console.warn(TAG, "跳过超长文本（" + r.text.length + " 字符）");
          skipped++;
        } else {
          usable.push(r);
        }
      });

      if (!usable.length) {
        sendProgress({ status: "translating", done: translated, total, batch: i + 1, batches: batches.length });
        continue;
      }

      usable.forEach((r) => setRecordTranslating(r, true));

      const batchChars = usable.reduce((s, r) => s + r.text.length, 0);
      const bt0 = performance.now();
      try {
        const cachePlan = prepareCachedBatch(usable);
        let translatedById = null;
        let requestError = null;
        if (cachePlan.requests.length) {
          try {
            translatedById = await requestBatch(cachePlan.requests);
          } catch (e) {
            requestError = e;
          }
        }
        // stale（Restore / 新会话已开始）：丢弃结果，不插图、不写状态，立即退出
        if (!isCurrentSession(myGen)) {
          return { ok: false, stale: true, cancelled: true };
        }
        const byId = resolveCachedBatch(cachePlan, translatedById, myGen);
        if (!byId) return { ok: false, stale: true, cancelled: true };
        if (requestError) {
          console.error(TAG, "批次翻译失败:", requestError.name || "error");
          lastError = requestError && requestError.message ? requestError.message : String(requestError);
        }
        usable.forEach((r) => {
          const translation = byId.get(r.id);
          if (typeof translation === "string" && translation.trim() && insertTranslation(r, translation.trim())) {
            if (!r.line) r.anchor.setAttribute(CFG.sourceAttr, "1");
            translated++;
          } else {
            failed++;
            failedAnchors.push(recordFailureKey(r));
          }
          setRecordTranslating(r, false);
        });
      } catch (e) {
        if (!isCurrentSession(myGen)) {
          return { ok: false, stale: true, cancelled: true };
        }
        console.error(TAG, "批次翻译失败:", e && e.name ? e.name : "error");
        lastError = e && e.message ? e.message : String(e);
        failed += usable.length;
        usable.forEach((r) => { failedAnchors.push(recordFailureKey(r)); setRecordTranslating(r, false); });
        // 保留已翻译部分，继续后续批次
      }
      const btMs = Math.round(performance.now() - bt0);
      console.log(
        TAG + " batch " + (i + 1) + "/" + batches.length + ": " +
        batchChars + " chars, " + (btMs / 1000).toFixed(1) + "s"
      );

      // 首批译文插入后立即记录「用户第一次看到中文」的耗时
      if (i === 0 && !firstBatchDone) {
        firstBatchDone = true;
        firstTranslationVisibleMs = Math.round(performance.now() - t0);
        console.log(TAG + " first translation visible in " + (firstTranslationVisibleMs / 1000).toFixed(1) + "s");
      }

      // 每批完成立即插入并上报进度（不等待整页完成）
      sendProgress({
        status: "translating",
        done: translated,
        total,
        batch: i + 1,
        batches: batches.length
      });
    }

    // 循环因换代而中断（Restore 或新会话已开始）：本会话已作废，
    // 绝不继续写 session / 启动 watcher / 覆盖 progress。
    if (!isCurrentSession(myGen)) {
      return { ok: false, stale: true, cancelled: true };
    }

    const totalMs = Math.round(performance.now() - t0);
    console.log(
      TAG + " translate done: records = " + total +
      ", batches = " + batches.length +
      ", chars = " + totalChars +
      ", totalMs = " + totalMs +
      ", avgBatchMs = " + Math.round(totalMs / Math.max(1, batches.length))
    );
    if (firstTranslationVisibleMs !== null) {
      console.log(TAG + " total translation time " + (totalMs / 1000).toFixed(1) + "s");
    }

    const hasWork = translated + failed > 0;
    const status = !hasWork ? "error" : failed === 0 ? "translated" : "partial";

    session = null;

    // partial 是独立业务状态，不会被后续 watcher 覆盖：本会话仍有失败 record
    // 时登记它们并置位，自动 retry（observer / catch-up）将跳过它们，避免无限循环。
    failedAnchors.forEach((a) => catchupSkipAnchors.add(a));
    pruneCatchupSkip();
    partialPending = catchupSkipAnchors.size > 0;

    // 首次整页翻译完成后才正式进入监听；随后立即做一次 catch-up，
    // 补翻「本次翻译期间新增、但 observer 尚未启动」的 DOM（见 v0.2.1 P1-1）。
    if (CFG.dynamicTranslateEnabled) {
      startWatching();
      dirty = true;
      scheduleDynamic(0);
    }

    // watching 与 partial 不互斥：partial 优先上报，watcher 照常保持开启
    sendProgress({ status: watching ? (partialPending ? "partial" : "watching") : status, done: translated, total });

    return {
      ok: translated > 0,
      translated,
      failed,
      skipped,
      total,
      watching,
      error: translated === 0 ? (lastError || "全部批次翻译失败。") : undefined
    };
  }

  /**
   * 移除所有译文与标记，但不取消正在进行的批次。
   * （翻译过程中点击「恢复原文」应只删除当前已有译文，不影响已发出的请求）
   */
  function restoreOriginal() {
    const nodes = document.querySelectorAll("." + CFG.translationClass);
    const removed = nodes.length;
    nodes.forEach((n) => n.remove());

    document.querySelectorAll("[" + CFG.sourceAttr + "]").forEach((el) => {
      el.removeAttribute(CFG.sourceAttr);
    });
    document.querySelectorAll(".local-ai-translating").forEach((el) => {
      el.classList.remove("local-ai-translating");
    });

    return { ok: true, removed };
  }

  /** 完全取消当前会话（重新翻译前调用，确保旧批次停止且清空旧译文）。 */
  function resetSession() {
    stopWatching();
    sessionGeneration++;                 // 作废所有在途 async 循环
    const r = restoreOriginal();
    partialPending = false;
    clearCatchupSkip();
    session = null;
    sessionProgress = { status: "idle", done: 0, total: 0 };
    return r;
  }

  /** 页面状态以真实 DOM 为准（可靠状态来源，不依赖 background 内存）。 */
  function getStatus() {
    const translated = document.querySelectorAll("." + CFG.translationClass).length;
    const running = !!(session && session.running);
    // 优先级：translating / dynamic-translating > partial > watching > translated > idle
    // partial 是独立业务状态，不能被 watching 覆盖（页面可同时 partial + watching）。
    let status = "idle";
    if (running) {
      status = sessionProgress.status === "dynamic-translating" ? "dynamic-translating" : "translating";
    } else if (partialPending) {
      status = "partial";
    } else if (watching && translated > 0) {
      status = "watching";
    } else if (translated > 0) {
      status = "translated";
    }
    return { ok: true, status, watching, translated, progress: sessionProgress };
  }

  /* ------------------------------------------------------------------ */
  /* 消息路由                                                            */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "PING") {
      sendResponse({ ok: true, version: "0.4.0" });
      return false;
    }
    if (msg.type === "TRANSLATE_PAGE") {
      translatePage()
        .then((r) => sendResponse(Object.assign({ ok: true }, r)))
        .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
      return true; // 异步
    }
    if (msg.type === "TRANSLATE_SELECTION") {
      translateSelection(msg.selectionText)
        .then((r) => sendResponse(r))
        .catch(() => sendResponse({ ok: false, error: "翻译暂时失败，请稍后重试。" }));
      return true; // 异步
    }
    if (msg.type === "RESTORE_PAGE") {
      try {
        sendResponse(restorePage());
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
      return false;
    }
    if (msg.type === "LAT_RESET") {
      try {
        sendResponse(resetSession());
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
      return false;
    }
    if (msg.type === "GET_STATUS") {
      sendResponse(getStatus());
      return false;
    }
    return false;
  });

  sendProgress({ status: "ready", done: 0, total: 0 });
})();
