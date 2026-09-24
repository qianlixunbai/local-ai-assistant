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

  let session = null;
  let sessionProgress = { status: "idle", done: 0, total: 0 };
  let lastError = "";
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

  /* ------------------------------------------------------------------ */
  /* 文本判定                                                            */
  /* ------------------------------------------------------------------ */

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
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
    return !!(next && next.classList.contains(CFG.translationClass));
  }

  /** 锚点是否仍需要翻译（未断开、无译文、未标记 source）。用于 partial 追踪剪枝。 */
  function anchorStillNeedsWork(anchor) {
    return !!anchor && anchor.isConnected && !hasTranslation(anchor) && !anchor.hasAttribute(CFG.sourceAttr);
  }

  /** 剪除已成功 / 已断开的 anchor；剩余集合即「仍然失败、等待显式重试」的 record。 */
  function pruneCatchupSkip() {
    catchupSkipAnchors.forEach((a) => {
      if (!anchorStillNeedsWork(a)) catchupSkipAnchors.delete(a);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 提取                                                                */
  /* ------------------------------------------------------------------ */

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
      null
    );

    const records = [];
    const lastByAnchor = new Map();
    let id = 0;
    let node;

    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(SKIP_SELECTOR)) continue;
      if (PRUNE_SELECTOR && parent.closest(PRUNE_SELECTOR)) continue;
      if (parent.closest("." + CFG.translationClass)) continue;

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
    if (!resp.ok) throw new Error(resp.error || "翻译请求失败。");

    const byId = new Map();
    (resp.results || []).forEach((r) => byId.set(Number(r.id), r.translation));
    return byId;
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

    const inline = INLINE_TAGS.has(anchor.tagName) || INNER_INSERT_TAGS.has(anchor.tagName);
    if (inline) {
      node.classList.add("local-ai-translation--inline");
      anchor.appendChild(node);
    } else {
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    }
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* 动态内容监听（v0.2）                                                */
  /* ------------------------------------------------------------------ */

  /** mutation 节点是否由本插件产生（译文节点本身，或位于译文节点内部）。 */
  function isOwnTranslationNode(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest("." + CFG.translationClass));
  }

  /**
   * 观察到的 mutation 是否可能带来新的可翻译文本。
   * 只做很轻的判断：忽略插件自身产生的 mutation（防止翻译↔观察反馈循环），
   * 其余一律标记 dirty，交给 debounce 后的 collectRecords 过滤。
   */
  function mutationMightAddContent(mutations) {
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      if (isOwnTranslationNode(m.target)) continue;
      const added = m.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (n.nodeType === 1) {
          if (isOwnTranslationNode(n)) continue;
          return true;
        }
        if (n.nodeType === 3 && normalize(n.nodeValue)) return true; // 直接插入的文本节点
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
    catchupSkipAnchors.clear();
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
          console.warn(TAG, "跳过超长文本（" + r.text.length + " 字符）:", r.text.slice(0, 80) + "…");
          return false;
        }
        return true;
      });
      if (!batch.length) continue;

      batch.forEach((r) => r.anchor.classList.add("local-ai-translating"));
      try {
        const byId = await requestBatch(batch);
        // stale：丢弃结果，不插入、不改 session / progress
        if (!isCurrentSession(myGen) || !watching) {
          batch.forEach((r) => r.anchor.classList.remove("local-ai-translating"));
          break;
        }
        batch.forEach((r) => {
          const translation = byId.get(r.id);
          if (typeof translation === "string" && translation.trim()) {
            insertTranslation(r, translation.trim());
            r.anchor.setAttribute(CFG.sourceAttr, "1");
            translated++;
          } else {
            failed++;
            failedAnchors.push(r.anchor);
          }
          r.anchor.classList.remove("local-ai-translating");
        });
      } catch (e) {
        console.error(TAG, "动态批次翻译失败:", e);
        failed += batch.length;
        batch.forEach((r) => { failedAnchors.push(r.anchor); r.anchor.classList.remove("local-ai-translating"); });
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
    catchupSkipAnchors.clear();

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
          console.warn(TAG, "跳过超长文本（" + r.text.length + " 字符）:", r.text.slice(0, 80) + "…");
          skipped++;
        } else {
          usable.push(r);
        }
      });

      if (!usable.length) {
        sendProgress({ status: "translating", done: translated, total, batch: i + 1, batches: batches.length });
        continue;
      }

      usable.forEach((r) => r.anchor.classList.add("local-ai-translating"));

      const batchChars = usable.reduce((s, r) => s + r.text.length, 0);
      const bt0 = performance.now();
      try {
        const byId = await requestBatch(usable);
        // stale（Restore / 新会话已开始）：丢弃结果，不插图、不写状态，立即退出
        if (!isCurrentSession(myGen)) {
          usable.forEach((r) => r.anchor.classList.remove("local-ai-translating"));
          return { ok: false, stale: true, cancelled: true };
        }
        usable.forEach((r) => {
          const translation = byId.get(r.id);
          if (typeof translation === "string" && translation.trim()) {
            insertTranslation(r, translation.trim());
            r.anchor.setAttribute(CFG.sourceAttr, "1");
            translated++;
          } else {
            failed++;
            failedAnchors.push(r.anchor);
          }
          r.anchor.classList.remove("local-ai-translating");
        });
      } catch (e) {
        if (!isCurrentSession(myGen)) {
          usable.forEach((r) => r.anchor.classList.remove("local-ai-translating"));
          return { ok: false, stale: true, cancelled: true };
        }
        console.error(TAG, "批次翻译失败:", e);
        lastError = e && e.message ? e.message : String(e);
        failed += usable.length;
        usable.forEach((r) => { failedAnchors.push(r.anchor); r.anchor.classList.remove("local-ai-translating"); });
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
    catchupSkipAnchors.clear();
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
      sendResponse({ ok: true, version: "0.2.2" });
      return false;
    }
    if (msg.type === "TRANSLATE_PAGE") {
      translatePage()
        .then((r) => sendResponse(Object.assign({ ok: true }, r)))
        .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
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
