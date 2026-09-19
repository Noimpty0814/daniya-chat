# T-2 daniya-bridge 插件实现

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md` **§5 全文是契约**（职责表、协议词汇、IPC 映射）；§5.3 的"渲染层零协议改动"约束必须守住——bridge 通知要能还原出现行 `chat:stream` 的 `delta`/`emotion`/`done`/`error` 语义。
- 参照仓库 `D:\Agents\deepseek-harness` **只读**。先读这些再动手：
  - `packages/sdk/server/src/` —— **最重要的参照实现**：一个插件如何占 stdio、挂载按行 JSON-RPC、按 sessionId 建 agent、订阅生命周期事件、处理 EOF/shutdown。bridge 是它的"加料版"。
  - `packages/core/agent/src/runtime-types.ts` —— 事件签名：`agent/assistant-stream`（`{agent, frame}`，frame=start/chunk/end）、`agent/status`、`agent/error`、`agent/request-error`、`agent/turn-stopping`；`Agent.cancel(cause)`、`Agent.steer()`、`CreateAgentOptions`/`ResumeAgentOptions`。
  - `docs/subsystems/core.md` —— Agent handle 契约（cancel 语义、inbox、scope 过滤监听）。
  - `docs/subsystems/session.md` + `packages/core/session/` —— `ctx.sessions`、`session/event` 订阅、`deriveMessages` 历史投影、stat/list。
  - `packages/attachment/attachment/README.zh.md` + `src/index.ts` —— `ctx.attachments.admitPromptContent()`：图像块入 prompt 的准入/持久化入口。
  - `docs/subsystems/system-prompt.md` + `packages/core/system-prompt/` —— prompt 段注册 API（bridge 要贡献人设段）。
  - `packages/sandbox/sandbox-policy/` + `packages/terminal/terminal-bash/README.zh.md` —— `sandbox/mode` 会话级写入的确切面（V-3：进行中会话会被拒，须在首个 spawn 前写）。
  - `docs/event-producer-consumer.md` —— 事件全表。
- 插件形态（`packages/AGENTS.md` 规则）：函数插件 = named exports `name`/`inject`/`Config`/`apply`，**不得 default export**；`Config` 用 Cordis schema；注册皆 effects（`ctx.effect()`/`ctx.on()`）。
- 骨架已由主会话建好：`packages/daniya-bridge/`（package.json、tsconfig、`src/index.ts` stub、`npm run build` → `lib/`）。在其内实现。

## 目标

可工作的 `daniya-bridge` 插件：占 stdin/stdout 跑 spec §5.2 的 JSON-RPC 协议，把 dsh 进程内事件面（assistant-stream、session/event、agent.status、tool 事件）桥给 Electron 主进程，并提供人设段贡献与会话沙箱 root 设定。

## 文件所有权

- `packages/daniya-bridge/**`（src、tests、package.json、tsconfig、README.md）

**禁止**：`harness/**`、`src/**`、`docs/**`、deepseek-harness 任何文件。

## 任务

1. **协议层**（`src/protocol.ts`）：按行分帧 JSON-RPC 2.0，spec §5.2 的 9 个请求方法 + 6 种通知。stdout 只写协议帧；诊断一律 stderr。stdin `end` → 有序 dispose（`ctx.dispose` 或等效，让持久化排空后退出 0）。
2. **会话管理**：
   - `session.create` → `ctx.agents.create({...})` 拿 sessionId；`session.resume` → `ResumeAgentOptions.resumeSessionId`；`session.list`/`session.history` → `ctx.sessions` stat/list + `deriveMessages` 投影为 `BridgeMessage`（`{id, role:'user'|'assistant'|'tool', content, images?, toolCalls?, createdAt}`，形状对齐 spec §5.2 并能还原 `ChatMessage`）。
   - `session.delete` → 关闭 agent + 委托 `ctx.sessions` 的删除能力（若无 API，删目录语义以 session-persistence-jsonl 为准，写进报告）。
   - agent 注册表：sessionId ↔ Agent 映射，防重复 create/resume。
3. **prompt 路径**：`{sessionId, text, images?[]}` → 图像经 `ctx.attachments.admitPromptContent`（或参照 sdk-server 的实际调用面）转持久附件 → 组 `ContentBlock[]` → 投 agent inbox（`steer` 或规范投递面）。返回 `{messageId}` 入队回执。
4. **事件转发**：
   - `ctx.on('agent/assistant-stream', ...)`（Scoped\<Agent\> 过滤）→ `stream.chunk`/`stream.end` 通知。frame 的 text 取法以源码为准（V-1）。
   - `session/event` → 提取 `tool/call`、`tool/result`（durable）→ `tool.call`/`tool.result` 通知（args 截断 preview ≤500 字符）；`assistant/message`/`assistant/attempt` 不必逐条转（chunk 已覆盖增量），但 `stream.end` 须带 `aborted` 标记（从 attempt/turn/end 因果判断）。
   - `agent/status` → `agent.status` 通知；`agent/error`、`agent/request-error` → `error` 通知。
5. **cancel**：`agent.cancel(cause)`；`AgentCancelCause` 取值以 runtime-types 为准（如 `'user'`）。
6. **人设段**：向 `ctx.systemPrompt` 注册段，每次组装读 `config.settingsFile`（JSON）→ `systemPrompt` 字段 + 固定 `EMOTION_CONTRACT` + `FILE_CONTRACT` + `用户当前工作目录：<DANIYA_WORKDIR>`（文本常量从 `src/contracts.ts` 导出，逐字复制自 `src/main/deepseek/client.ts` 的 `EMOTION_CONTRACT`/`FILE_CONTRACT`——注意保留原样，包括 markdown）。读文件失败/字段缺失 → 段内容为空串（不阻塞组装）。**每轮重读，不缓存**（保持"改完即生效"）。
7. **沙箱 root**：agent create/resume 时、首个 spawn 前，按 `sandbox/mode` 写入面设 `workspace-write` + root=`config.workdir`（env `DANIYA_WORKDIR` 传入）。进行中会话被拒 → 记 stderr + 通知 `error`（不崩）。
8. **单测**（`tests/`）：fake ctx（自实现最小 Context stub：on/emit/service 注册表）覆盖——协议分帧与派发、事件→通知映射、人设段文本拼装、cancel 调用、图像块→attachments 调用。vitest 运行。
9. 写 `packages/daniya-bridge/README.md`：协议表（与 spec 对齐）、配置字段、事件来源表。

## 验收标准

- [ ] `npm run build`（tsc）与 `npx vitest run` 在本包内绿
- [ ] 导出形态合规（named exports；无 default export；`inject` 声明真实依赖的服务）
- [ ] 协议方法与通知逐条对上 spec §5.2 表（报告里给对照）
- [ ] stdin EOF → 进程有序退出（测试或手工证据）
- [ ] 报告列出：每个 spec 职责的实现方式 + 未解决项（如 V-1 frame 形状、V-3 mode 写入 API 的实际签名）、与 spec 的偏差

## 备注

- 与 T-1 的耦合：真实 profile 冒烟不属本票范围（集成阶段做）；本票验证以单测 + 可选的临时 cordis 冒烟为限。
- stdout 纪律：任何 `console.log` 只允许走 stderr。
- 文本契约逐字性：`EMOTION_CONTRACT`/`FILE_CONTRACT` 复制时不得改写任何字符。
