# 达妮娅聊天（Daniya Chat）

一个可以对话、看图、读改文件、执行命令、联网搜索的桌面 AI 助手，并能与你的桌宠「达妮娅」联动：AI 的情绪会实时驱动桌宠的表情。

## 架构

```
┌─ dsh 运行时子进程（DeepSeek Harness，daniya profile）─┐
│  agent 循环 · 流式 · 会话持久化 · 工具 · 联网搜索        │
│  ├─ 模型可见工具：pwsh（持久 PowerShell）· web_search · web_fetch
│  ├─ 沙箱：workspace-write，写入围栏在设置页工作目录       │
│  └─ daniya-bridge（自研插件）：stdio JSON-RPC 双向桥     │
├─ Electron 主进程 ──────────────────────────────────────┤
│  harness 生命周期 · bridge 客户端 · IPC（渲染层语义不变） │
│  DPAPI Key → 子进程 env 注入 · 桌宠协调 · 截屏 · 提案面板  │
└─ 渲染进程：React UI ────────────────────────────────────┘
```

- agent 循环/流式/会话持久化由 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）运行时承担
- 仓库内 `packages/daniya-bridge` dsh 插件：向主进程暴露 token 级流式、工具调用事件、会话 CRUD，并按轮注入人设与情绪/文件契约
- 文件修改走 ```` ```daniya-file ```` 提案约定（模型出提案块，用户确认后应用）

## 功能特性

- **视觉理解**：一键截屏，让 AI「看」你的屏幕回答问题
- **历史保存**：会话由 harness 以事件日志持久化，支持多会话与恢复
- **联网搜索**：模型自主调用 `web_search` 工具；气泡上的工具徽照搬实时显示进行中→成功/失败
- **命令执行**：模型可调用 `pwsh` 持久 PowerShell；工作目录外写入被沙箱直接拒绝
- **文件读写**：拖拽/选择文件给 AI 阅读；AI 可提出修改提案，确认后应用（自动 .bak 备份，可重试）
- **桌宠联动**：AI 回复首 token 携带情绪标记（`{EMO:happy|...}`），驱动桌宠表情；支持托盘左键呼出，窗口出现在光标附近（联动可关闭，不影响聊天功能）

## 技术栈

- Electron 44 + electron-vite
- React 19 + TypeScript
- DeepSeek Harness（`@deepseek-ai/dsh`，daniya profile + `daniya-bridge` 自研插件）
- highlight.js / react-markdown（Markdown 渲染 + 代码高亮）
- Vitest
- electron-builder（NSIS 安装包）

## 快速开始

```bash
npm install
npm run dev          # 开发模式（带远程调试端口可用 -- -- --remote-debugging-port=9222）
npm run dev:harness  # 单独拉起 dsh 运行时（调试用；应用内会自动拉起）
npm run test         # 运行测试
npm run typecheck    # 类型检查
npm run pack         # 打包 Windows 安装包（输出到 dist/）
```

## 配置

- **DeepSeek API Key**：应用内「设置」页填写。密钥经系统 DPAPI 加密后存于 `%APPDATA%/daniya-chat/settings.json`，不明文落盘；运行时以 env 注入 harness 子进程（`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`）
- **模型**：设置页单一模型字段，文本与图像输入共用
- **联网搜索**：无需配置——`web_search` 由模型按需自主调用，复用同一个 DeepSeek Key
- **桌宠联动**（可选）：集成说明见 `resources/pet-helper.ps1`，联动开关在设置页

## 项目结构

```
src/
├── main/           # 主进程
│   ├── harness/    #   dsh 运行时管理：进程、bridge 协议客户端、会话登记簿、情绪解析
│   ├── files/      #   文件读改：附件、提案、diff、应用
│   ├── pet/        #   桌宠联动：协调器、按键、管道通信
│   └── ...
├── preload/        # 预加载桥
└── renderer/       # React 渲染进程
packages/
└── daniya-bridge/  # 自研 dsh 插件：stdio JSON-RPC 桥 + 人设/契约注入
harness/
└── profile/        # daniya profile 模板（bundle + cordis.patch.yml 定制）
resources/          # 图标、桌宠 PowerShell 助手
docs/adr/           # 架构决策记录（dsh 迁移、提案契约等）
```

## 已知事项

- 仅支持 Windows（桌宠联动依赖 PowerShell/全局钩子）
- 安装版与开发版共用 `%APPDATA%\daniya-chat`，密钥无需重配
- 旧版本地会话文件不迁移（dsh 会话是事件日志，不可逆平迁）；旧 `conversations*` 文件保留不读，可自行删除

## License

[MIT](LICENSE)
