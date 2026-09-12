# Development Status

## 版本状态（v0.1.2）

**Result: PARTIAL** —— 在真实 Chrome / SEEK 页面完成人工验收之前，Browser Translator
v0.1.2 不标记为 GO / PASS。代码与自动化测试（jsdom）已通过，真实浏览器端到端验收待办。

## 当前实际配置（v0.1.2）

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
- 不支持动态新增内容（无 MutationObserver / 无限滚动 / SPA 路由监听）
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

## 下一阶段候选

- 设置页（模型选择、批次大小、目标语言）
- 翻译缓存（按文本 hash）
- 划词 / 右键菜单翻译
- 动态内容支持（MutationObserver）
- 流式逐段回显
- 桌面助手 / 本地文件 RAG / Tool Calling / Vision（长期目标）

## Scope Audit（v0.1.2）

**NO** —— 未超出本轮范围。

本轮仅实现 Viewport First（viewport 优先级排序 + 首批约 1000 字符 + 本地性能日志），
未实现任何禁止功能：无右键翻译 / 划词翻译 / 桌面助手 / RAG / Agent / MCP / OCR /
PDF / 语音 / 多模型切换 UI / 设置页面 / 自动语言检测 / MutationObserver / SPA 监听 /
滚动动态队列 / 云 API / 并发模型请求。
