# daniya-bridge

daniya-chat 自研 dsh 插件。在 harness 子进程内独占 stdin/stdout 跑按行 JSON-RPC 2.0，把 dsh 进程内事件面桥给 Electron 主进程；并在每个会话的 agent setup 里注册达妮娅人设段、写入 `workspace-write` 沙箱模式。

迁移决策见 `docs/adr/0001-dsh-runtime.md`；协议即下文表格，本文档为准。

## 插件形态

named exports：`name` / `inject` / `Config` / `apply`，无 default export。

```ts
export const inject = ['agents', 'sessions', 'systemPrompt', 'attachments']
```

可选服务一律 `ctx.get` 读取：`sessionPersistence`、`llm`、`loader`、`appExit`/`appReady`。

## 配置

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `settingsFile` | `DANIYA_SETTINGS_FILE` | settings.json 路径；人设段每次组装重读其 `systemPrompt` 字段 |
| `workdir` | `DANIYA_WORKDIR`（也可由 `initialize` 参数覆盖） | 会话 `meta.cwd` 与 persona 工作目录行 |
| `provider` | 默认 `deepseek-official` | LLM provider 路由 |
| `input` / `output` / `stderr` / `exit` | 运行时测试钩子 | 默认 `process.stdin/stdout/stderr`/`process.exit`，不入 profile |

## 协议

stdout 只写协议帧（一行一个 JSON 对象）；一切诊断走 stderr。入向仅请求；入向通知与对端响应帧被丢弃。非法 JSON 行忽略，handler 抛错回 `-32603`（未知方法同，与 `sdk-jsonrpc-server` 参照一致）。**按行并发分派**——客户端应串行发请求（`initialize` 必须先完成）。

### 请求方法（9）

| 方法 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- |
| `initialize` | `{workdir, model}` | `{ok}` | 校验 workdir 绝对化、`llm.resolveCallConfig` 路由、附件存储与持久化就绪；等 `loader.await()` 后才应答。可重复调用刷新 workdir/model |
| `session.create` | `{}` | `{sessionId}` | `ctx.agents.create`：`meta.cwd=workdir`、`agentOptions={provider,model}`、setup 写沙箱+人设段。id 形如 `daniya-<uuid>` |
| `session.resume` | `{sessionId}` | `{ok, history}` | `agents.resume({resumeSessionId})`；已活会话直接返回投影历史；同 id 并发去重 |
| `session.list` | `{}` | `[{sessionId,title,updatedAt}]` | 持久层快照 ∪ 未落盘活会话，按 updatedAt 倒序。`title` 恒 `''`（显示名由主进程 conversations 登记簿自持） |
| `session.history` | `{sessionId}` | `{messages: BridgeMessage[]}` | 活会话走 `session.surface` + `deriveEventMessage`；落盘会话 `sessionPersistence.open(id,'read')` 后 `foldSurface` 重放 |
| `session.delete` | `{sessionId}` | `{ok}` | dispose 本桥接的活 agent。**持久层无删除 API**：存储目录保留（见「限制」） |
| `prompt` | `{sessionId, text, images?:[{data,mimeType}]}` | `{messageId}` | base64 图像经 `attachments.admitPromptContent` 准入为持久附件后 `agent.followup`。返回入队回执不等产出 |
| `cancel` | `{sessionId}` | `{ok}` | `agent.cancel({kind:'user'})` |
| `shutdown` | `{}` | `{ok}` | 响应写回后排空协议写 → dispose 根 fiber（级联跑所有插件清理）→ `exit(0)` |

`BridgeMessage`：`{id, role: 'user'|'assistant'|'tool', content, images?, files?, toolCalls?, model?, createdAt}`；`createdAt` 取事件时间。

### 通知（7）

| 通知 | 参数 | 事件来源 |
| --- | --- | --- |
| `stream.chunk` | `{sessionId, turn, text}` | `agent/assistant-stream` chunk 帧中的 `text-delta`（attemptId→turn 由 start 帧登记） |
| `stream.end` | `{sessionId, turn, aborted?}` | end 帧且 outcome 为已提交 `assistant/message`；该消息 `interrupted:true` 或 `turn/end{aborted}` 兜底时带 `aborted:true`（每 turn 至多一次） |
| `tool.call` | `{sessionId, callId, tool, argsPreview}` | `session/event` 的 `tool/call`；`argsPreview` 截断 ≤500 字符 |
| `tool.result` | `{sessionId, callId, ok, preview}` | `tool/result`；`ok = !isError`，preview ≤500 字符 |
| `agent.status` | `{sessionId, status}` | `agent/status` 直传 |
| `error` | `{sessionId?, message}` | `agent/error` 与终态 `agent/request-error`（后者 waterfall 只观察不接管，按 `turn:step:message` 去重随后的 `agent/error`）；桥级错误（初始化、沙箱写入被拒）无 `sessionId` |
| `session.event` | `{sessionId, event}` | `session/event` 原样透传（调试/扩展消费） |

只转发本桥接注册的会话；`assistant/attempt` 与 `abandoned` 终帧不构成可见回复，不发 `stream.end`（取消场景由 `turn/end{aborted}` 兜底）。

## 人设段

每个会话的 agent setup 里，经 `agent.ctx.systemPrompt.section` 注册名为 `deployment:persona-prefix` 的段——按 dsh-scope 遮蔽规则盖掉 sdk-minimal 部署的通用 personaPrefix。段文本每次组装重读 settings：`systemPrompt` 字段 + `EMOTION_CONTRACT` + `FILE_CONTRACT`（逐字复制自旧 `deepseek/client.ts`）+ `用户当前工作目录：<workdir>`，`\n\n` 相连；`interpolate:false` 保留 `{{…}}` 字面量。settings 缺失/损坏/字段缺失时人设为空串，契约与工作目录行仍输出。注册随 agent 卸载自动回收；非本桥接的 agent 不受影响。

## 沙箱

setup 内（首个 spawn 前）`setSandboxMode(session, 'workspace-write')`——持久终端运行后改模式会被拒；被拒时写 stderr + 发 `error` 通知，不阻断会话创建。workspace root 取 `session.header.cwd`（create 经 `meta.cwd` 注入 `config.workdir`/`initialize` 参数；resume 沿用会话创建时的 cwd）。

## 进程退出

- **stdin EOF**：`exitOnStdinEnd`（`@deepseek-ai/dsh-cmdline`）——`appReady` 提交后请求 `ctx.appExit(0)`，由 launcher 有界退出完成整树 dispose 与持久层排空。launcher 未提供 `appExit`/`appReady` 时 apply 响亮失败。
- **`shutdown` RPC**：响应落线后 `transport.flush()` → `ctx.root.fiber.dispose()` → `exit(0)`，与 `sdk-jsonrpc-server` 同规。
- 两条路径经 `exitTask` 去重。

## 限制

- **`session.delete` 不删持久数据**：`SessionPersistence`（`dsh-session-persistence-jsonl`）只暴露 `create/open/stat/list/flush`，无删除 API——append-only 存储目录会留在磁盘上。delete 只排干并卸除活 agent；主进程应从自身 conversations 登记簿移除该会话。
- **`session.list` 的 `title` 恒 `''`**：dsh 不拥有会话显示名，由主进程登记簿自持；`updatedAt` 为末事件时间（取不到时退化为创建时间）。
- **`foldSurface` 对含未知 plugin 投影的日志抛错**：只能回放本部署插件集认识的会话日志（外来会话的 `session.history`/`resume` 会以 RPC 错误失败）。
- **图像 admission 限四型**：`image/png|jpeg|webp|gif`，由附件存储归一化。
- **请求并发分派**：同连接请求不串行化（与 sdk 参照一致）；客户端须先等 `initialize` 应答再发后续请求。

## 开发

```sh
npm install
npm run build      # tsc → lib/
npx vitest run     # tests/**/*.spec.ts
```
