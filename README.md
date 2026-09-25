# Local AI Assistant

本地 AI 助手项目。长期目标是构建一套完全运行在 Windows 本机的 AI 系统，
底层通过 [Ollama](https://ollama.com/) 调用本地模型，**所有推理均在本机进行**。

## 当前状态

**Browser Translator v0.3.0 — GO**

一个 Chrome / Chromium 浏览器扩展（Manifest V3），用于将英文网页正文
翻译为中文。原文保留，中文译文显示在原文下方，可一键恢复原文。

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

> 范围仍限定为「浏览器本地 AI 翻译插件」。
> 桌面助手 / RAG / Tool Calling / Vision / 截图翻译等均为后续阶段。

## 环境要求

- Windows
- Chrome / Chromium（支持 Manifest V3）
- [Ollama](https://ollama.com/download) 已安装并运行
- 本地模型：`qwen3.5:4b`（当前默认）

> **关于模型选择**：`qwen3.5:9b` 已进行过测试，但 Browser Translator 当前默认使用
> `qwen3.5:4b`。原因（均为**本机 RTX 5060 8GB 上的实测结果，非通用 benchmark**）：
> - `qwen3.5:4b` 可 100% GPU 运行
> - 本机实测约 97～100 tokens/s
> - 相比 9B 约 54～58 tokens/s 明显更快
> - 当前真实网页翻译测试中，4B 翻译质量已达到可用水平
>
> 因此当前阶段优先采用 4B 作为网页翻译默认模型。

## 安装与运行

1. **安装 Ollama**
   下载并安装后确认服务已启动（默认 `http://127.0.0.1:11434`）。

2. **下载模型**

   ```bash
   ollama pull qwen3.5:4b
   ```

3. **确认 Ollama 正常运行**

   ```bash
   curl http://127.0.0.1:11434/api/tags
   ```

   应能返回包含 `qwen3.5:4b` 的模型列表。

4. **加载 Chrome 扩展**
   - 打开 `chrome://extensions`
   - 打开右上角 **Developer mode（开发者模式）**
   - 点击 **Load unpacked（加载已解压的扩展程序）**
   - 选择本仓库的 `browser-extension/` 目录

## 使用

1. 打开一个英文网页（如英文 Wikipedia 或任意英文博客/新闻）
2. 点击浏览器工具栏中的扩展图标
3. 点击 **检测连接** —— 确认 `Ollama：在线`、`模型：可用`
4. 点击 **翻译当前页面**
5. 英文原文保留，原文下方出现自然中文译文（当前屏幕内容优先）
6. 若首轮翻译全部成功，状态变为 **翻译完成 · 正在监听新内容**；页面新加载的内容
   （如 `Load More Jobs`、无限滚动 / SPA 局部更新）会自动增量翻译，无需再次点击
7. 点击 **恢复原文** 移除全部译文并停止监听。再次翻译时，本页已有的成功译文可直接复用

> 页面完整刷新或整站跳转后，需重新点击 **翻译当前页面**。

## 开发 / 回归测试

自动化回归测试仅用于**开发**。页面行为测试加载真实的 `config.js` + `content.js` 到
[jsdom](https://github.com/jsdom/jsdom) 中运行；模型检测测试加载真实的 `background.js`
并模拟 Ollama 响应。测试不依赖本机 Chrome / Ollama。

```bash
npm ci
npm test
```

`npm test` 顺序执行综合行为测试与精确模型检测测试。也可单独运行：

```bash
npm run test:behavior
npm run test:background-model
```

> `package.json` 与 `node_modules/` **仅供测试 / 开发**。
> 浏览器扩展本身仍是原生 HTML / CSS / JavaScript，无 bundler、无构建步骤、
> 无运行时 npm 依赖。

## 安全说明

- **所有 AI 推理都在本机 Ollama 中进行**，不向任何云服务发送网页内容。
- 不包含 analytics / telemetry / 第三方 CDN / 远程脚本。
- 不持久化存储网页正文。v0.3.0 的成功译文缓存仅保存在当前页面的 content script 内存中，
  不跨页面、标签页或浏览器重启共享。

## 目录结构

```
local-ai-assistant/
├─ browser-extension/     Chrome 扩展（Manifest V3）
│  ├─ manifest.json
│  ├─ config.js           集中配置（Ollama 地址 / 模型名 / 批次参数）
│  ├─ background.js       service worker：注入 content script
│  ├─ content.js          正文提取 / 批量翻译 / 双语插入 / 恢复 / 动态内容监听
│  ├─ content.css         译文样式（仅作用于 .local-ai-translation）
│  ├─ popup.html
│  ├─ popup.css
│  └─ popup.js            popup 逻辑与 Ollama 连接检测
├─ docs/
│  └─ DEVELOPMENT_STATUS.md
├─ test/
│  ├─ dynamic-test-page.html   动态内容手动测试页（Load More 追加 10 张卡片）
│  ├─ behavior-test.js         翻译、动态内容、竞态与缓存行为
│  └─ background-model-test.js 精确模型名称检测
├─ package.json                测试脚本 + jsdom（devDependencies，仅供开发）
├─ .gitignore
└─ README.md
```

详细开发状态与已知限制见 [docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md)。
