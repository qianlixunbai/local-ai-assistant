# Development Status

## 版本状态（v0.2.1）

**Result: GO** —— v0.2.1 为稳定性 hotfix（P1-1 / P1-2 / P2）。
代码与自动化测试已通过（Race 33 / Dynamic 35 / Footer 34 / Viewport 26 / StateMachine 45，
共 173 checks），并已通过真实 Chrome 人工验收。

v0.2.1 真实 Chrome 人工验收（通过）：

- **Dynamic Content 正常**：`Load More Jobs` 新增卡片自动增量翻译，无需再次点击
- **Restore → immediate Translate race 正常**：恢复原文后立即重新点击翻译，
  不残留旧会话译文、无重复节点、无 stale 结果写入
- **extension reload 后 watcher re-arm 正常**：页面已翻译状态下 reload 扩展，
  DOM 译文仍在、watcher 丢失；再次点击 Translate 恢复监听，不重译、不删旧译文
- 初始页面翻译 / Restore / 动态新增内容 / 关闭 popup 不中断翻译 等既有行为回归正常

v0.2.1 automated regression suite is reproducible from repository.
测试脚本位于 `test/`，仅依赖 `jsdom`（devDependency）。新机器执行：

```bash
npm ci
npm test
```

即可离线复现全部 173 checks（不依赖本机 Chrome / Ollama / 临时目录 / 绝对路径）。
`package.json` 仅供开发 / 测试，浏览器扩展仍是原生 HTML/CSS/JS，无构建步骤、
无运行时 npm 依赖。

v0.2.0 已通过真实 Chrome 人工验收（历史记录）：

- 初始页面翻译正常
- `Load More Jobs` 新增内容可自动翻译（MutationObserver 动态翻译正常）
- Restore 正常
- Restore 后停止动态翻译（watcher 已 disconnect）
- 重新 Translate 后 watcher 可再次启动

v0.2.1 相对 v0.2.0 的改动（不含新功能，仅稳定性）：

- **P1-1 初始翻译窗口 catch-up**：首次整页翻译完成后，除了 `startWatching()`，
  还会主动做一次动态 catch-up 扫描，补翻「首次翻译进行期间新增、但 observer
  尚未启动」的 DOM，不再依赖后续 mutation 碰巧触发
- **P1-2 会话 generation 隔离**：以 `sessionGeneration` 取代原先的全局
  `cancelRequested` boolean。Restore / LAT_RESET / 每次新翻译都会递增 generation；
  所有 async 翻译循环捕获自己的 generation，`await` 返回后若已换代则丢弃结果，
  不插入 DOM、不改 `session` / `watching` / `progress`
- **P2 重复点击幂等**：popup 在 `LAT_RESET` 之前先 `GET_STATUS`；
  页面为 `watching` 时不再清空、不再请求模型；
  `partial` 页面跳过 `LAT_RESET`，只补翻未翻译 record

### P2 补充：partial 状态机（本轮 Reviewer 复核后修复）

Reviewer 发现上一版 P2 存在两个边界问题，本轮修复：

- **问题 1：partial 被 watching 吞掉**
  - 旧 `GET_STATUS` 优先级为 `watching && translated > 0 → watching`，首次翻译
    若为 `partial`（如 95 成功 / 5 失败），watcher 一启动状态即被改写为 `watching`，
    popup 看不到 `partial`，再次点击 Translate 直接短路，失败的 5 条永久无法重试
  - 修复：`partial` 改为**独立业务状态**，不再由 `sessionProgress.status` 推断，
    而由「仍失败、等待显式重试的 anchor 集合」`catchupSkipAnchors` 推导
  - 新 `GET_STATUS` 优先级：
    `translating / dynamic-translating > partial > watching > translated > idle`
  - `partial` 与 `watching` **不互斥**：页面可同时 `status="partial"` 且 `watching=true`。
    popup 对 `partial` 不清空、不 `LAT_RESET`，继续发送 `TRANSLATE_PAGE`，
    只重新 collect 未成功 / 未标记 source 的 record；补齐后恢复 `watching`；
    仍有失败则继续保持 `partial`
- **问题 2：translated 但 watcher 丢失后无法重新开启**
  - 场景：页面已有译文 → 扩展 reload / content script 重新注入 → DOM 译文仍在，
    但新 content script 内 `watching=false`。旧 popup 对 `translated` 直接 return，
    用户点击 Translate 无法重新开启 watcher
  - 修复：popup 仅在 `status === "watching"` 时真正短路；对
    `status === "translated" && watching === false` 不 `LAT_RESET`、但继续发送
    `TRANSLATE_PAGE`。content 侧发现 `records.length === 0 && already > 0`，
    调用 `startWatching()` 并返回 `alreadyTranslated + watching=true`——
    不调用模型、不删除旧译文，仅恢复 watcher
- **防无限重试循环（实现细节）**：`partial` 期间把失败的 anchor 登记进
  `catchupSkipAnchors`，`collectRecords` 跳过它们；因此 observer / 初始 catch-up
  既**不会**自动重试已失败 record（否则会无限循环），也**仍会**翻译该期间新增的 DOM。
  用户再次点击 Translate 时清空该集合，显式重试。`pruneCatchupSkip()` 会在每轮结束时
  剪除已成功 / 已断开的 anchor，并由剩余集合推导 `partial`，避免「后续成功轮次误清 partial」

## 当前实际配置（v0.2.1）

以 `browser-extension/config.js` 为事实来源（**本文件数值与其保持同步**）：

| 参数 | 当前值 |
|---|---|
| `model` | `qwen3.5:4b` |
| `batchCharLimit` | `2800` |
| `firstBatchCharLimit` | `1000` |
| `num_ctx` | `8192` |
| `num_predict` | `2048` |
| `temperature` | `0` |
| `think` | `false` |
| `stream` | `false` |
| `keep_alive` | `"30m"` |
| `dynamicTranslateEnabled` | `true` |
| `mutationDebounceMs` | `750` |

## 模型选择说明

`qwen3.5:9b` 已进行过测试，但 Browser Translator 当前默认使用 `qwen3.5:4b`。
以下均为**本机 RTX 5060 8GB 上的实测结果，不是通用 benchmark**：

- `qwen3.5:4b` 可在 RTX 5060 8GB 上 100% GPU 运行
- 本机实测约 97～100 tokens/s
- 相比 9B 约 54～58 tokens/s 明显更快
- 当前真实网页翻译测试中，4B 翻译质量已达到可用水平

因此当前阶段优先采用 4B 作为网页翻译默认模型。9B 相关记录均为历史测试，非当前默认配置。

## 项目目标

构建一套完全运行在 Windows 本机的 AI 系统，底层通过 Ollama 调用本地模型。
长期规划包含：浏览器 AI 翻译插件、Windows 本地 AI 助手、本地文件 / RAG、
Tool Calling、截图 / Vision 等。

## 当前完成范围

**第一轮 MVP：Chrome / Chromium 浏览器本地 AI 翻译插件**

完整链路：

```
打开英文网页 → 点击插件 → 检测 Ollama → 翻译当前页面
→ 调用本机 qwen3.5:4b → 正文翻译为中文 → 原文保留、译文显示在下方
→ 可恢复原网页
```

## 本轮 MVP 功能

- Chrome Extension Manifest V3，纯 HTML / CSS / 原生 JavaScript
- Popup UI：连接状态卡、当前模型、主/次按钮、面向用户的状态提示
- Ollama 连接检测：`GET /api/version` + `GET /api/tags`（非「让模型说话」方式）
- 区分三种状态：Ollama 离线 / Ollama 在线但模型未安装 / 模型可用
- 正文文本提取（v0.1.1 起）：用 `TreeWalker(SHOW_TEXT)` 遍历全部可见文本节点，
  按「锚点元素」聚合成 record。不再依赖固定标签选择器，因此
  `div / span / a` 及组件化 DOM 中的可见英文都能被发现
- 锚点规则：文本归属到「最近的、子元素全为行内的祖先元素」。
  被 `span` 拆开的连续文本（如 `Posted` + `4d ago`）合并为一条；
  链接等行内元素单独成条，译文插入其内部
- 过滤：`script / style / noscript / code / pre / textarea / input / button /
  select / option / nav / aside / [aria-hidden] / [hidden] /
  隐藏元素 / 纯数字 / URL / email / 路径 / 极短单词 / 纯符号`
- `footer` / `[role='contentinfo']` **不**整体排除：页脚含大量有意义的导航与
  链接文本，正常参与翻译；`<a>` 只替换/追加文本，不改动 `href` / `target` / 点击行为
- 批量翻译：按 DOM record 拼批（默认上限 2800 字符），非逐节点调用
- **Viewport First（v0.1.2）**：提取完成后按 `getBoundingClientRect()` 将 record
  分为 Priority 0（当前视口）/ 1（视口上下各 1 个视口高度内）/ 2（其余），
  同 priority 内保持原始 DOM 顺序；**首批目标约 1000 字符**（`firstBatchCharLimit`），
  让当前屏幕尽快出现中文，后续批次恢复 2800 上限。仅改变翻译顺序，不会减少
  最终翻译范围（整页仍全部翻译）。仅在翻译开始时计算一次优先级，不做滚动监听
- 性能日志：console 输出 `viewport-first: visibleRecords/nearRecords/restRecords/firstBatchChars`、
  `first translation visible in Ns`、`total translation time Ns`
- **Dynamic Content（v0.2.0 引入）**：首次整页翻译完成后启动 `MutationObserver`
  （`document.body`，`childList + subtree`，**不监听 `characterData`**）。
  observer 回调只做轻量判断 + debounce（默认 750ms，`mutationDebounceMs`），
  到点后复用同一套 `collectRecords` / 过滤 / 锚点 / 去重 / 分批 / 插入，
  仅翻译新增 record；动态批次直接用 2800 上限（不套用 Viewport First 的 1000 首批）。
  日志：`dynamic watcher started` / `mutations detected` / `dynamic collect` /
  `dynamic translation done` / `dynamic watcher stopped`
- **防反馈循环**：observer 忽略 `.local-ai-translation` 自身及其内部节点产生的
  mutation（插件自己插入/删除译文不会再次进入队列）
- **单飞（single-flight）**：同一 content script 内始终最多一个「当前会话」翻译循环；
  首次翻译或动态翻译运行中到达的新 DOM 只标记 `dirty`，待当前循环结束后再 collect；
  动态翻译期间再次新增会再排一轮，**不并发调用 Ollama**。
  跨会话（Restore 后新翻译）可能短暂与已作废的旧请求重叠，但旧请求结果会被
  generation 检查丢弃（见 v0.2.1 P1-2）
- **动态新增 DOM 无遗漏（v0.2.1 P1-1）**：首次整页翻译完成后立即
  `startWatching()` 并主动触发一次 catch-up 扫描，保证首次翻译窗口内新增的
  DOM 一定被补翻，不依赖后续 mutation
- 每批完成后**立即插入**该批译文（不等待整页完成）
- 明确 ID 的 JSON 批量协议：输入 `[{id, text}]` → 输出 `[{id, translation}]`
- 调用 `POST /api/chat`，`think = false`，`stream = false`，
  `temperature = 0`，显式 `num_ctx = 8192`，`keep_alive = "30m"`
- 模型预热：popup 打开且连接正常时静默 `WARMUP`，让模型保持驻留，
  首次翻译不必等待加载
- 请求超时保护：`AbortController`，默认 90 秒（首次请求需加载模型）
- 轻量重试：网络失败 / 超时 / HTTP 5xx / JSON 解析失败最多重试 1 次；
  4xx、模型不存在、页面不可注入不重试
- 双语显示：译文节点 `.local-ai-translation` 插入原文下方，原文不改动
- 防重复翻译：`data-local-ai-source` 标记；已全部翻译时提示「当前页面已翻译」
- 恢复原文：删除全部译文节点并清理标记，不刷新页面；可反复「翻译 → 恢复」
- **任务不依赖 popup 生命周期**：翻译任务运行在 content script 中，
  关闭 popup 不会中断翻译
- popup 重新打开时通过 `GET_STATUS` 读取页面真实状态（idle / translating /
  translated / partial）
- 错误处理：Ollama 离线 / 模型缺失 / HTTP 异常 / 超时 / JSON 异常 /
  单批失败（保留已翻译部分，继续后续批次）/ 超长节点跳过 / 不可注入页面
- 进度显示：`正在翻译，第 N / M 批... 已完成 X / Y 段`

## 技术栈

| 层 | 技术 |
|---|---|
| 扩展 | Chrome Extension Manifest V3 |
| UI | 原生 HTML / CSS / JavaScript（无框架、无构建工具） |
| 推理 | 本机 Ollama，`POST /api/chat`（`stream:false`, `think:false`） |
| 模型 | `qwen3.5:4b`（当前默认） |
| 通信 | popup / content → `chrome.runtime` messaging → background → Ollama |

架构分层（Fix 1 后）：

```
popup.js  ──┐
            ├─ chrome.runtime messaging ─► background.js ─► Ollama (127.0.0.1:11434)
content.js ─┘                                （唯一访问 Ollama 的地方）
```

- `background.js`：Ollama 在线检测、`/api/tags` 模型检测、`/api/chat` 翻译请求、超时与重试、网络/HTTP/JSON 错误处理
- `content.js`：仅 DOM 职责（文本提取、分批、插入译文、Restore、进度）；翻译任务在此运行，因此不依赖 popup 存活
- `popup.js`：仅 UI 与消息编排，不直接访问 Ollama，且**不等待整页翻译完成**

本轮不引入独立的 Local AI Core 服务或后端。

## 已知限制

- 当前只处理**用户点击时刻已存在**的 DOM
- **v0.2.0 起支持动态新增 DOM 的增量翻译**：用户主动点击「翻译当前页面」后，
  插件通过 `MutationObserver`（`childList + subtree`）监听新增内容，
  debounce 750ms 后仅收集**尚未翻译**的新 record 并增量翻译；已翻译内容不会重发。
  限制：
  - 页面完整 reload / 整站跳转后 content script 重新加载，需**重新点击翻译**
  - 不做 URL / history router hook（不 monkey patch `pushState` / `popstate`）
  - 不保证 Shadow DOM 内部
  - 动态 collect 目前仍会对页面做一次完整 `TreeWalker` 扫描（未按 `addedNodes`
    缩小扫描范围）；`hasTranslation` / `data-local-ai-source` 保证不重发已翻译内容，
    正确性不受影响，仅在超大页面 + 极高频新增时可能偏重
  - MutationObserver **仅在用户主动开启一次翻译后生效**；未点击翻译不会自动翻译任何页面
  - Restore 会停止监听；再次点击翻译可重新开启
- 不保证适配所有网站，目标为 Wikipedia / 博客 / 新闻 / 技术文章类正文页面
- 暂无翻译缓存；「翻译当前页面」对已翻译页面会提示已翻译，不会重译，
  但对 partial 页面会重新收集未翻译节点
- 暂无 token 流式回显（`stream:false`，整批返回后插入该批译文）
- 暂无右键菜单 / 划词翻译 / 词典 / OCR / PDF / 视频字幕
- 模型固定为 `qwen3.5:4b`（当前默认，config.js 为事实来源），未做设置界面
- Context 固定 `num_ctx = 8192`，批次上限约 2800 字符。根据 RTX 5060 8GB 实测，
  5000 chars 在 `num_predict = 2048` 下存在输出截断风险，2800 作为当前稳定默认值
  （接近实测稳定的 ~2500 字符区间）
- `format: "json"`（Ollama structured output）**经实测不可用**：历史测试的 9B 在
  该模式下会把多条译文压成一个带重复 key 的扁平对象，导致解析后只剩 1 条。
  因此本轮不使用 structured output，改为依靠输入 JSON 数组 + 文本解析
  （该结论为历史测试记录，与当前默认模型 4B 无关）
- 单条文本 2800–12000 字符单独成批；超过 12000 字符的节点被跳过并记录
- 页面 UI 噪声靠 `nav/aside/button` 等通用选择器排除，未做站点专用规则；
  少数站点仍可能有遗漏或误判（`footer` 已不再整体排除，见上文）
- 部分使用 Shadow DOM 或极度动态渲染的站点可能提取不到正文
- popup 内不做长任务保活：翻译进行中关闭 popup，进度条不会更新（任务本身继续，
  译文会正常插入页面）
- 重新翻译会先清空旧译文（`LAT_RESET`）再从头翻译；已全部翻译的页面重复点击
  只提示「当前页面已翻译」，不重新请求
- 页面为 `partial`（部分译文 + 部分失败）时再次点击翻译不会清空已有译文，
  只重试失败的 record；`partial` 期间自动 watcher 不会自动重试失败 record
  （避免无限重试循环），需用户再次点击翻译显式重试
- `translated` 但 watcher 丢失（扩展 reload / content script 重新注入）时，
  再次点击翻译会恢复 watcher，不重译、不删除已有译文

## 下一阶段候选

- 设置页（模型选择、批次大小、目标语言）
- 翻译缓存（按文本 hash）
- 划词 / 右键菜单翻译
- 流式逐段回显
- 桌面助手 / 本地文件 RAG / Tool Calling / Vision（长期目标）

## Scope Audit（v0.2.1）

**NO** —— 未超出本轮范围。

本轮仅做稳定性 hotfix（P1-1 初始翻译 catch-up、P1-2 会话 generation 隔离、
P2 重复点击幂等 + partial 状态机补充修复），未新增任何功能：无翻译缓存 / 划词翻译 /
右键菜单 / 设置页 / 多模型 UI / 语言选择 / `addedNodes` 局部扫描优化 / streaming /
OCR / PDF / RAG / Agent / 桌面助手 / history router hook / 新架构。
