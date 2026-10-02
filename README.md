# Local AI Assistant

## 当前状态

**Browser Translator v0.5.0 — PARTIAL / AWAITING REAL CHROME ACCEPTANCE**

M2B-2B 将扩展迁移到已认证的 Personal AI Runtime：

```text
popup / content → background service worker → Personal AI Runtime :8765
→ Translate / Batch Translate → Shared TaskManager → translate.fast → local execution
```

Browser 负责 DOM extraction、Viewport First、Dynamic Content、Restore、Selection、frame/document、页面缓存和 UX。
Runtime 负责 Provider、模型、prompt、generation config、policy、task lifecycle、ownership 和 AI execution。
Browser 没有直连 Ollama、legacy mode 或 fallback；Runtime 失败时显式失败。

本分支只交付开发实现。v0.4.1 是上一已发布稳定版本，真实 Chrome 迁移验收全部通过前不声明 v0.5.0 GO。
完整证据与待验收事项见 [M2B-2B report](docs/M2B-2B-RUNTIME-MIGRATION-REPORT.md)。B11 / B12 继续 DEFERRED。

**已确认的兼容性阻塞**：真实 Chrome 154 的配对 POST 成功，但后续 authenticated GET 自然不带 `Origin`。
Runtime `25dc1df` 要求 Browser 请求带 Origin，该 readiness GET 返回 401。当前分支因此无法完成真实 Chrome 翻译；
扩展不伪造 Origin/Fetch Metadata。本轮保留 Runtime 只读，等待单独的 security contract review。

## 安装与配对

1. 启动 [Personal AI Workspace](https://github.com/qianlixunbai/personal-ai-workspace) 的兼容 Runtime 和 Windows Assistant；Runtime 仅监听 `http://127.0.0.1:8765`。
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → 选择本仓库 `browser-extension/`。
3. 打开扩展 popup，点击 **Copy Origin**，复制来自 `chrome.runtime.id` 的 exact Extension Origin。
4. Windows Assistant → **Pair Browser** → 粘贴 Origin → 明确创建一次性 pairing。
5. 将 Pairing ID 和 One-time Secret 输入扩展，点击 **Pair**。扩展自行 exchange；不自动配对、不读取剪贴板。
6. proof 在尝试开始时即从输入框清除；成功后显示 **Paired**、Runtime 在线、Translation 可用。

Browser-specific credential 仅保存在 `chrome.storage.local`；worker 初始化先建立 `TRUSTED_CONTEXTS` 边界。
扩展不读取 Runtime native token 或 Windows Credential Manager，也不向 content/page 消息返回 credential。
安全存储失败会 fail closed，并要求到 Windows Assistant → Paired Browsers 撤销刚创建客户端。

**Forget local pairing** 仅删除本地凭据；真正 revoke 在 Windows Assistant → Paired Browsers 执行。
Exchange 通信失败可能已经消费 proof：请先检查 Paired Browsers，必要时 revoke 后重新创建 pairing；扩展不会自动重放 proof。

## 使用

- 打开英文网页，点击 **翻译当前页面**。当前视口优先，保留原文并在附近插入中文。
- 首轮后自动翻译新增内容。Restore 停止监听；再次 Translate 可重新开始。partial 只在显式 Translate 时重试未成功 records。
- 选中英文 → 右键 **使用 Local AI 翻译选中文本** → 在本 frame 的浮层查看中文；点击 × 关闭。
- Restore → Translate 可复用当前 content-script 生命周期内成功译文。缓存绑定规范化文本、目标语言和 Runtime public profile/version/promptVersion。
- 未获成功任务 identity 时缓存 lookup 只允许 miss；Batch / Single identity 分开处理。观察到 identity 变化清理缓存。
- cache hit 仍检查认证和 readiness，不能绕过 Runtime offline 或 revoke；不缓存失败、空结果或 stale generation。
- Runtime 离线、Translation 不可用、凭据失效会明确提示。没有模型/provider 诊断出现在 popup 或 selection card。

普通 batch 同时满足 ≤32 items / ≤2800 chars / ≤4096 UTF-8 bytes，首批目标约 1000 chars。
一个 Browser batch 提交一个 Runtime task。超出 batch 的完整 record 可用 Single：当前基线最多 4000 chars / 5632 UTF-8 bytes。
超出 Single 预算的 record 受控失败，保留 partial；不截断、不拆句、不改变执行设置。
POST 不自动重试。已知 taskId 的 GET 可做最多两次临时网络重试，轮询有整体 deadline 和 response 上限。

## 开发与验证

原生 HTML/CSS/JS，无 build step、bundler 或运行时 npm 依赖。npm 仅供开发测试。

```shell
npm ci
npm test
npm run test:behavior
npm run test:background-runtime
npm run test:popup
git diff --check
```

自动测试加载真实生产脚本，mock fetch / Chrome API，不依赖真实 Runtime 或模型。
`test/real-runtime-smoke.js`、`test/chrome-runtime-smoke.js` 是单独显式运行的集成检查，需传入实际 Java executable、已构建 Runtime jar，Chrome 检查另需传入 Chrome executable。
它们启动独立测试进程、使用隔离的 native dev authority，不读取已有 native credential；状态位于 ignored `.verification/`。
Synthetic HTTP 和开发 authority 配对不能替代 Windows Assistant GUI / 原生右键 / MDN 人工验收。

## 隐私与权限

- Manifest permissions：`activeTab` / `scripting` / `contextMenus` / `storage`。
- Host permission 仅 `http://127.0.0.1:8765/*`；没有网页权限扩张。
- credential/proof、正文、译文、prompt、raw response/error 不进入生产日志。
- 正文与译文仅存在任务/页面内存，不持久化；缓存不跨页面、标签页或浏览器重启。
- Selection 不读写剪贴板。Copy Origin 只在明确点击时写入安全 Origin。
- 不含 analytics、telemetry、CDN、远程脚本或其他 AI capability。

## v0.4.1 与早期版本历史

v0.4.1 **GO / RELEASED** 的真实历史链路是 **Chrome → background → Ollama**。
2026-10-01 用户确认的 Chrome / MDN / R01 PASS 属于该版本，不能当作本次 Runtime migration 的验收。
历史参数、直接 Provider 权限及 hotfix 证据保留在 [v0.4.1 hotfix report](docs/V0.4.1_HOTFIX_REPORT.md) 和 [development history](docs/DEVELOPMENT_STATUS.md)。

- **Viewport First（v0.1.2）**：点击翻译后，当前屏幕内容优先出现中文
- **Dynamic Content（v0.2.0 引入）**：点击翻译时先处理当前页面内容；首轮翻译完成后
  开启 `MutationObserver`，自动检测并增量翻译新加载的内容（如 `Load More Jobs`、无限滚动
  / SPA 局部更新）。首轮翻译期间新增的内容会在结束后补翻。Restore 会停止监听；页面完整
  刷新或整站跳转后需重新点击翻译。
- **v0.2.1**：稳定性修复（初始翻译窗口内新增 DOM 补翻、会话 generation 隔离、
  重复点击 Translate 幂等），无新功能。
- **v0.2.2**：公开前准确性修复（动态内容文档说明、模型完整名称检测），无新功能。
- **v0.3.0**：同一批次重复文本只请求一次模型，并在当前页面生命周期内复用成功译文。
  Restore 和 `LAT_RESET` 会清除页面译文及当前会话，但保留内存缓存；完整页面刷新后缓存消失。
- **v0.4.0 Selection / Context Menu Translation**：选中英文文本 → 右键点击
  **使用 Local AI 翻译选中文本** → 在页面浮层查看中文译文。不会改动原网页文本，
  并与整页翻译共享当前页面的内存缓存。整页翻译也改进了以 `<br>` 排版的正文兼容性。

> 范围仍限定为「浏览器本地 AI 翻译插件」。
> 桌面助手 / RAG / Tool Calling / Vision / 截图翻译等均为后续阶段。

v0.4.1 **Stability & Privacy Hotfix**：改善 Restore / Translate 取消稳定性、动态 DOM 源版本处理，以及 frame / 可编辑正文的安全边界。
用户已确认真实 Chrome 验收通过，包括真实 MDN sidebar / nested scroll-container 与 R01 MV3 30–45 秒 long-request；
B01–B10 / B13 / R01 / R02 均 PASS，B11 / B12 继续 DEFERRED。详见 [v0.4.1 hotfix report](docs/V0.4.1_HOTFIX_REPORT.md)。
