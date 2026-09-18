# 达妮娅聊天（Daniya Chat）

接入 DeepSeek 的桌宠聊天软件 —— 一个可以对话、看图、读改文件、联网搜索的桌面 AI 助手，并能与你的桌宠「达妮娅」联动：AI 的情绪会实时驱动桌宠的表情。

## 功能特性

- **流式对话**：DeepSeek 大模型流式回复（自实现 SSE，不依赖 SDK）
- **视觉理解**：一键截屏，让 AI「看」你的屏幕回答问题
- **历史保存**：会话历史落盘，支持多会话与恢复
- **联网搜索**：博查（Bocha）搜索注入，回复附带来源引用徽章
- **文件读写**：拖拽/选择文件给 AI 阅读；AI 可提出修改提案，确认后应用（自动 .bak 备份，可重试）
- **桌宠联动**：AI 回复首 token 携带情绪标记（`{EMO:happy|...}`），驱动桌宠表情；支持托盘左键呼出，窗口出现在光标附近（联动可关闭，不影响聊天功能）

## 技术栈

- Electron 44 + electron-vite
- React 19 + TypeScript
- highlight.js / react-markdown（Markdown 渲染 + 代码高亮）
- Vitest（187 项测试）
- electron-builder（NSIS 安装包）

## 快速开始

```bash
npm install
npm run dev          # 开发模式（带远程调试端口可用 -- -- --remote-debugging-port=9222）
npm run test         # 运行测试
npm run typecheck    # 类型检查
npm run pack         # 打包 Windows 安装包（输出到 dist/）
```

## 配置

- **DeepSeek API Key**：应用内「设置」页填写。密钥经系统 DPAPI 加密后存于 `%APPDATA%/daniya-chat/settings.json`，不会明文落盘
- **博查搜索 Key**（可选）：不填则联网搜索功能不可用，其余功能不受影响
- **桌宠联动**（可选）：集成说明见 `resources/pet-helper.ps1`，联动开关在设置页

## 项目结构

```
src/
├── main/           # 主进程
│   ├── deepseek/   #   DeepSeek 客户端：流式、路由、情绪解析
│   ├── files/      #   文件读改：附件、提案、diff、应用
│   ├── pet/        #   桌宠联动：协调器、按键、管道通信
│   ├── search/     #   博查搜索客户端
│   ├── storage/    #   本地存储
│   └── ...
├── preload/        # 预加载桥
└── renderer/       # React 渲染进程
resources/          # 图标、桌宠 PowerShell 助手
docs/               # 设计文档与实施计划
```

## 已知事项

- 仅支持 Windows（桌宠联动依赖 PowerShell/全局钩子）
- 安装版与开发版共用 `%APPDATA%\daniya-chat`，密钥无需重配

## License

[MIT](LICENSE)
