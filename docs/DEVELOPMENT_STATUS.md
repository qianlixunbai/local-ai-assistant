# Development Status

## 当前版本 v0.5.0 — M2B-2B

**PARTIAL / AWAITING REAL CHROME ACCEPTANCE**。开发分支 `m2b2b-runtime-migration`，基于 clean v0.4.1 `75bede1`。
Runtime source / GitHub main baseline `25dc1df` 已只读核对；本轮不修改 Personal AI Workspace。

当前架构：Chrome Extension → authenticated Personal AI Runtime :8765 → Translate / Batch → Shared TaskManager → local Provider。
Browser Provider 配置、warmup、直连权限和 fallback 已删除；版本 manifest / package / lock / PING 均为 0.5.0。
显式 pairing、trusted-only local credential、受控 readiness、严格 task submit/poll/result、防重试 POST、Batch + Single budget 已实现。
DOM / dynamic / Restore / Selection / frame / cache / popup 生命周期保持并通过自动回归。

自动 tests 与静态 audit、真实 Runtime smoke、真实 Chrome 的当前证据和未完成项，以 [M2B-2B report](M2B-2B-RUNTIME-MIGRATION-REPORT.md) 为准。
真实 Chrome 154 已复现：POST exchange 成功，authenticated readiness GET 自然不带 Origin，Runtime `25dc1df` 返回 401。
明确 `mode: cors` 仍复现；不伪造 headers，不修改 Runtime 安全边界。Chrome integration 当前 FAIL / BLOCKED。
真实 Windows Assistant 配对/撤销、原生 Selection 菜单、MDN/sidebar/nested scroll/privacy 与 MV3 迁移验收未全部完成前，不声明 CLOSED — GO。
B11 inline BR layout / B12 mutation debounce starvation 继续 DEFERRED。
没有 merge / push / tag / Release，也没有 Workspace M2 Final Status Sync。

以下 v0.4.1 与早期条目是历史记录，原本 Chrome → Ollama 的结论保持。

## Testing Policy

Minimal High-Value Testing：优先用少量完整行为场景覆盖真实用户流程与高风险竞态。
避免测试实现细节及重复的历史回归；一个场景可以包含多个必要断言。
新增测试须有明确回归价值，测试数量和覆盖率百分比不是项目目标。

## 历史版本状态（v0.4.1）

**Result: GO / RELEASED** —— v0.4.1 Stability & Privacy Hotfix；2026-10-01 用户确认真实 Chrome 验收全部通过，进入最终封版。
manifest / package.json / package-lock.json / content PING 与当前文档版本均为 v0.4.1。
历史上代码与自动测试完成后曾保持 PARTIAL / uncommitted；下述用户验收结论关闭该等待状态。

本轮保持 Route C：Chrome Extension → background execution boundary → 本机 Ollama。
没有新 UI、权限、持久化存储、Provider Framework 或 Local AI Core。

| 项目 | 状态 | 修复边界 |
|---|---|---|
| B01 record granularity | FIXED / PASS | 普通 multi-record anchor 按源节点追踪每段完成、失败与重试；只重试失败段，译文跟随各自源文本；anchor 标记仅在全部段成功后设置。 |
| B02 popup operation cancellation | FIXED / PASS | popup 独立 operation generation；每个异步返回及 finally 校验操作身份，Restore 作废旧 preflight。 |
| B03 source DOM identity | FIXED / PASS | record 保存源节点、父节点与规范化文本快照；插入前校验连接、归属和文本。childList / characterData 更新会清除旧译文、marker 与失败身份，并重新收集。 |
| B04 frame privacy | FIXED / PASS | 选区消息绑定 tab / frame / document；无法确认目标时 fail closed，没有回落到 top frame 或扩大权限。用户确认真实 Chrome iframe / frame boundary PASS。 |
| B05 visibility cache | FIXED / PASS | WeakMap 限于单次 collect，下一次扫描重新判断可见性。 |
| B06 hidden inline text | FIXED / PASS | 普通和 BR 提取均检查源文本父元素的可见性，隐藏子节点不进入请求。 |
| B07 request deadline | FIXED / PASS | 翻译 deadline 覆盖 fetch、响应体读取及解析；连接检查两个 endpoint 各使用 5 秒 deadline。 |
| B08 popup tab / task isolation | FIXED / PASS | sender.tab.id 与 operationId / sessionGeneration 过滤；重开 popup 从 GET_STATUS 恢复任务身份。 |
| B09 response protocol | FIXED / PASS | 仅接受本次请求的整数 ID；重复 ID 视为 missing，非法 / 意外 ID 忽略；content 层再次校验，异常结果不进入缓存。 |
| B10 editable boundary | FIXED / PASS | 全文跳过有效 contenteditable / plaintext-only / designMode；显式选区翻译继续可用。 |
| B13 visible sidebar / nested scroll | FIXED / PASS（真实 Chrome） | 根因是 PRUNE_SELECTOR 过早排除 nav / aside / role=navigation，全文 collect 不创建 sidebar records。修复允许 navigation/sidebar 参与翻译，按 nested overflow clipping visibility 过滤，独立 scroll catch-up 复用既有流程；hidden/editable/privacy boundary 保持。真实 MDN Chrome 验收通过。 |
| R02 error privacy | FIXED / PASS | HTTP / service / parse 错误使用受控文案与 kind / status；不转发原始响应体、服务错误或异常信息。 |
| B11 inline BR layout | DEFERRED | 本次不补做，未宣称修复；保留既有 inline BR 样式。 |
| B12 mutation debounce starvation | DEFERRED | 保留现有 debounce，没有引入 max-wait 或复杂调度器。 |
| R01 MV3 long request lifecycle | PASS（真实 Chrome） | 用户确认单次 30–45 秒 long-request 验收通过；测试方法及证据范围见 hotfix report 的 MV3 Long Request。没有引入 offscreen、保活 ping、alarm、daemon 或新服务。 |

源 DOM 改变会作废 DOM 插入身份；同一 generation 内，对原始文本 A 的合法成功响应仍可缓存 A，
但不能插入已变为 B 的源区域。Restore / LAT_RESET 保留页面内存缓存并作废旧会话。
对 reinjection 前已有的 orphan translation 继续保守沿用既有标记，不猜测其源身份。

高价值自动回归覆盖：普通同 anchor 部分失败 / 单段重试 / 顺序与缓存；旧 preflight / finally
不覆盖 Restore 或后续 Translate；在途源替换 / 完成后 childList 与 characterData 更新；
BR 更新与自身 mutation 隔离；隐藏展开 / 隐藏 inline / 编辑边界；严格 ID 与错误隐私；
跨 tab / 旧操作 progress 过滤。现有 viewport、Footer、动态补翻、selection、Restore 和缓存回归保留。
B13 新增 5 个行为场景；修改前源码会遗漏可见导航，修改后通过。详细根因与验证见 hotfix report。

人工验收页：`test/privacy-hotfix-page.html`。从仓库根目录运行 `python -m http.server 8000 --bind 127.0.0.1`，
打开 `http://127.0.0.1:8000/test/privacy-hotfix-page.html`；跨 origin frame 使用 `localhost`。
该页用于长正文顺序、preflight Restore、动态源更新、frame selection、隐藏展开与可编辑区回归；
部分失败 / 只重试失败段主要由自动测试保护。fixture 包含 sticky sidebar / nested scroll 区域。

自动验证：`npm ci`、`npm test`、`git diff --check` 通过。完整 diff 已检查，权限未扩大，
生产文件无测试 fixture 引用、临时日志、个人路径或凭据。

历史自动执行记录：检测到 Chrome 154.0.8037.59，但以独立临时 profile 加载测试扩展的
启动操作被执行策略以 `blocked by policy` 拒绝，未产生测试浏览器进程。
当时 **B04 Chrome UNVERIFIED；B11 未验证；R01 >30 秒请求 UNVERIFIED / Risk**，未记为 NOT REPRODUCED。
临时本地测试服务已停止；原有 Ollama 服务未改动。执行策略也拒绝临时目录的递归清理，
该目录保留在系统 TEMP 中，不属于仓库变更。

最终真实 Chrome 验收（2026-10-01，用户确认）：B01–B10、B13、R01、R02 均 PASS。
iframe / frame boundary、Selection Translation、Dynamic Content、Restore、cache second-hit、
editable / designMode privacy boundary、popup reconnect / progress 均 PASS。
真实 MDN Chrome 验收通过：sidebar 当前可见文字可翻译，独立滚动可 catch-up，回滚不重复翻译，
Restore 后滚动不再翻译，折叠 / 隐藏内容仍保持排除。
R01 已通过真实 Chrome 单次 30–45 秒 long-request 验证；方法与历史限制见 hotfix report。
B11 / B12 继续 DEFERRED，不在本次补做；在已验收范围内无已知 release-blocking risk。

## 版本状态（v0.4.0）

**Result: GO** —— v0.4.0 已通过真实 Chrome 人工验收与自动验证。
用户确认：选区右键翻译正常，关闭后同文缓存复用近乎即时，旧选区响应不覆盖新浮层；
Selection Card 与全文翻译共存，不被二次翻译且无反馈循环。
同一 Steam 页面复测确认：`<br>` 排版的普通正文、标题和粗体内容均能翻译，
未观察到明显重复；中文位于对应英文之后，没有堆到容器底部；Restore 正常，
Selection Translation 仍正常。

选中文字后使用唯一的右键菜单，在当前页面显示可关闭的翻译浮层。后台仅负责菜单编排与
本机 Ollama 请求，页面 content script 处理选区、浮层与共享的页面生命周期内缓存。
独立的 `selectionGeneration` 防止过期选区响应覆盖新浮层或写入缓存；
浮层及子节点被正文提取和动态内容监听排除。日志只记录状态、长度和错误类型，
不记录选中文字、网页正文或模型原始输出。

整页提取现按直接子级 `<br>` 与块级子元素划分视觉段落，在原文段落后插入译文；
同一容器的段落分别判断是否已翻译，避免因容器级标记漏掉其他段落。
初始翻译、动态新增内容和 Restore 共用现有流程；无站点专用选择器。

已知限制：仅支持网页中可选中的普通文本；浏览器内部页面等不可注入页面无法使用；
复杂布局下浮层可能退回到视口内安全位置；当前没有复制、历史或设置功能。

## 版本状态（v0.3.0）

**Result: GO** —— Translation Cache 与测试精简已完成。`npm ci`、`npm test`、
`git diff --check` 通过；当前测试包含 10 个综合行为场景和 3 个精确模型检测检查，
覆盖翻译、DOM 提取、动态内容、竞态和缓存边界。

本轮仅增加当前页面 content script 生命周期内的内存译文缓存与同批重复文本合并。
缓存与 translation session 分离：Translate 可读取和写入；Restore / `LAT_RESET` 清除译文、
结束会话但保留缓存；页面完整刷新会重建 content script，缓存自然消失。
首次翻译、后续批次和动态内容共用缓存解析逻辑。只缓存当前 generation 的非空成功译文，
失败、缺失 ID、超长跳过项和过期响应均不写入。缓存上限为 500 条，最近使用的条目保留；
该上限可覆盖常见页面的大量重复短语，同时限制单页内存增长。

缓存 key 精确包含规范化原文、模型、目标语言、翻译规则版本及会影响输出的生成参数。
如修改 `background.js` 的翻译 system prompt 或翻译规则，须同步提升
`config.js` 的 `translationPromptVersion`。当前翻译 prompt 与模型参数保持原样。

用户已在真实 Chrome + SEEK 页面确认：正文、长文本、列表及 Footer 的翻译显示正常，
原文保留，页面结构未明显破坏；Translate → Restore → 再 Translate 的第二次译文恢复近乎即时。
动态缓存命中及请求中的竞态由自动测试覆盖，本轮没有对应的人工验收记录。
公开发布审计移除了 Console 中的网页正文片段和模型原始回复输出，保留非敏感的长度与错误类型。

已知限制：相同原文在不同语境中可能需要不同译法；当前缓存按精确文本与翻译配置复用。

## 版本状态（v0.2.2）

**Result: GO** —— 公开前准确性修复：文档说明初始翻译、动态新增内容补翻和 watcher 生命周期；
Ollama 模型检测改为按配置的完整模型名匹配，不再把 `qwen3.5:9b` 误判为 `qwen3.5:4b`。
无翻译流程或模型参数变更。原有五组 173 checks 保持通过，新增模型检测 4 checks，
`npm test` 共 177 checks。v0.2.1 的真实 Chrome 验收记录保留如下。

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

v0.2.1 当时的五组自动化回归测试已在 v0.3.0 合并为综合行为测试。
测试脚本位于 `test/`，仅依赖 `jsdom`（devDependency）。新机器执行：

```bash
npm ci
npm test
```

历史 v0.2.2 测试结果为 177 checks，其中 v0.2.1 五组为 173 checks，
v0.2.2 模型检测增加 4 checks。v0.3.0 的当前测试套件已精简。
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

## 当前实际配置（v0.4.1）

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
| `targetLanguage` | `Simplified Chinese (zh-CN)` |
| `translationPromptVersion` | `v1` |
| `translationCacheMaxEntries` | `500` |

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
  select / option / [aria-hidden='true'] / [hidden] /
  隐藏元素 / 纯数字 / URL / email / 路径 / 极短单词 / 纯符号`
- `footer` / `[role='contentinfo']` **不**整体排除：页脚含大量有意义的导航与
  链接文本，正常参与翻译；`<a>` 只替换/追加文本，不改动 `href` / `target` / 点击行为
- 批量翻译：按 DOM record 拼批（默认上限 2800 字符），非逐节点调用
- **Viewport First（v0.1.2）**：提取完成后按 `getBoundingClientRect()` 将 record
  分为 Priority 0（当前视口）/ 1（视口上下各 1 个视口高度内）/ 2（其余），
  同 priority 内保持原始 DOM 顺序；**首批目标约 1000 字符**（`firstBatchCharLimit`），
  让当前屏幕尽快出现中文，后续批次恢复 2800 上限。仅改变翻译顺序，不会减少
  普通文档正文的最终翻译范围。导航与独立 overflow 容器只翻译当前可见部分；
  激活 watcher 后，捕获 scroll 并复用动态 catch-up，补翻新进入可视区的文字
- 性能日志：console 输出 `viewport-first: visibleRecords/nearRecords/restRecords/firstBatchChars`、
  `first translation visible in Ns`、`total translation time Ns`
- **Dynamic Content（v0.2.0 引入）**：首次整页翻译完成后启动 `MutationObserver`
  （`document.body`，`childList + characterData + subtree`，并监听可见性 / 编辑状态相关属性）。
  observer 回调忽略自身 mutation、校验已有源身份并清理失效译文；debounce（默认 750ms，`mutationDebounceMs`）后，
  到点后复用同一套 `collectRecords` / 过滤 / 锚点 / 去重 / 分批 / 插入，
  仅翻译新增或失效 record；动态批次直接用 2800 上限（不套用 Viewport First 的 1000 首批）。
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

- 初始翻译在用户点击「翻译当前页面」时收集当前页面内容；首轮翻译处理完成后开启
  watcher，并立即进行 catch-up 扫描，补翻首轮处理期间新增的 DOM。之后，
  `MutationObserver`（`childList + characterData + subtree`）自动检测动态新增内容与源正文更新；debounce 750ms 后
  仅收集**尚未翻译**的新 record 并增量翻译，已翻译内容不会重发。`Load More Jobs`、
  无限滚动及 SPA 局部更新均可触发增量翻译。Restore 会停止 watcher；再次点击翻译可重新开启。
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
- 译文缓存仅限当前页面的 content script 内存：Restore / `LAT_RESET` 保留缓存，
  页面 reload 后缓存消失；不跨页面、标签页，也不持久化
- 暂无 token 流式回显（`stream:false`，整批返回后插入该批译文）
- 选中文字需要主动点击右键菜单才会翻译；无自动划词弹窗、词典 / OCR / PDF / 视频字幕
- 模型固定为 `qwen3.5:4b`（当前默认，config.js 为事实来源），未做设置界面
- Context 固定 `num_ctx = 8192`，批次上限约 2800 字符。根据 RTX 5060 8GB 实测，
  5000 chars 在 `num_predict = 2048` 下存在输出截断风险，2800 作为当前稳定默认值
  （接近实测稳定的 ~2500 字符区间）
- `format: "json"`（Ollama structured output）**经实测不可用**：历史测试的 9B 在
  该模式下会把多条译文压成一个带重复 key 的扁平对象，导致解析后只剩 1 条。
  因此本轮不使用 structured output，改为依靠输入 JSON 数组 + 文本解析
  （该结论为历史测试记录，与当前默认模型 4B 无关）
- 单条文本 2800–12000 字符单独成批；超过 12000 字符的节点被跳过并记录
- 页面 UI 控件靠 `button` 与既有 role 选择器排除，未做站点专用规则；
  `nav/aside/[role='navigation']` 的普通文字按真实可见交集参与翻译，overflow 裁剪内容待滚动补翻。
  少数站点仍可能有遗漏或误判（`footer` 不整体排除，见上文）
- 部分使用 Shadow DOM 或极度动态渲染的站点可能提取不到正文
- popup 内不做长任务保活：翻译进行中关闭 popup，进度条不会更新（任务本身继续，
  译文会正常插入页面）
- 重新开始翻译时可以重置当前 DOM 译文和 translation session，但当前页面生命周期内的
  成功译文缓存不会被清除；相同文本可直接复用，因此可能无需再次请求 Ollama
- 页面为 `partial`（部分译文 + 部分失败）时再次点击翻译不会清空已有译文，
  只重试失败的 record；`partial` 期间自动 watcher 不会自动重试失败 record
  （避免无限重试循环），需用户再次点击翻译显式重试
- `translated` 但 watcher 丢失（扩展 reload / content script 重新注入）时，
  再次点击翻译会恢复 watcher，不重译、不删除已有译文

## 下一阶段候选

- 设置页（模型选择、批次大小、目标语言）
- 流式逐段回显
- 桌面助手 / 本地文件 RAG / Tool Calling / Vision（长期目标）

## Scope Audit（v0.2.1）

**NO** —— 未超出本轮范围。

本轮仅做稳定性 hotfix（P1-1 初始翻译 catch-up、P1-2 会话 generation 隔离、
P2 重复点击幂等 + partial 状态机补充修复），未新增任何功能：无翻译缓存 / 划词翻译 /
右键菜单 / 设置页 / 多模型 UI / 语言选择 / `addedNodes` 局部扫描优化 / streaming /
OCR / PDF / RAG / Agent / 桌面助手 / history router hook / 新架构。

## Route C / Local AI Core Trigger

Core = LATER。只有以下任一需求真正开始实现才进入 Stage 2：

1. Desktop Assistant 需要共享 translate / chat / health / model execution。
2. 跨应用 queue / cancel / GPU scheduling。
3. 本地文件 / RAG indexing 需要长期后台任务。

届时优先评估 Java 21 + Spring Boot 模块化单体；v0.4.1 保持现有扩展架构。
