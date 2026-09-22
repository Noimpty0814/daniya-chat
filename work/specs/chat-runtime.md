# Spec: chat-runtime — 回复 turn 状态机从 registerIpc 闭包抽为可测模块

依赖：`bridge-contract`（C2）已合入 main。本票在其门面面上施工——`DaniyaBridge` 类型化方法 + `BridgeNotification` 判别联合 + `HarnessLike` 指向 `DaniyaBridge`；派发前确认 `feat/bridge-contract` 已合并，分支从合并后的 main 切。

## Problem

`registerIpc`（src/main/ipc.ts ~478 行）把两类不相干的东西焊在同一闭包里：

- 21 个 `ipcMain.handle` 通道注册，其中 ~13 个是 settings/file/screen/pet 的一至三行透传；
- 一条回复 turn 状态机：`ActiveRequest` 双索引（byRequest/bySession）、`liveSessions`、`historyCache`、`lastSender`、`handleNotification` 分发、每条请求一对 `EmotionParser`+`FileProposalParser` 穿线、`pet()` 副作用、registry ⨝ dsh-session join、`projectMessage` 历史投影、错误→中文映射。

`HarnessLike`（ipc.ts:26-32）自称"可注入"，实则无人注入——turn 语义只能靠 spawn 真 `HarnessRuntime` + fake-bridge 子进程测（ipc.test.ts 全程 `waitEvent` 轮询、秒级超时）。`stream.end` 非终态、`agent.status→idle` 才是正常终态（B-6）这条最容易回退的规则只存在于注释里。这是全仓 bug 密度最高的代码，也是测试路径最贵的代码。

## Design

新文件 `src/main/chat-runtime.ts`，一个 `ChatRuntime` 类收走全部 turn 语义；`ipc.ts` 退化为纯通道 adapter。

### 出站口：ReplySender

```ts
export interface ReplySender {
  send(channel: string, data: unknown): void
  isDestroyed(): boolean
}
```

`WebContents` 结构满足，handler 里 `e.sender` 直接传入；测试注入 `{ send: vi.fn(), isDestroyed: () => false }`。turn 在 `startReply` 时捕获 sender，模块内部完成 `'chat:stream'`/`'file:proposal'` 发送与 `isDestroyed()` 守卫。`lastSender` 变为 `lastSink: ReplySender | null`，保留"无归属 error 兜底发最后窗口"语义。

### 归一化：TurnEvent

dispatch 先把 `BridgeNotification` 翻成 `TurnEvent` 再交给 turn——`stream.end{aborted:true}` 与 `stream.end{}` 在此分流成**两个事件类型**，B-6 从注释变成类型结构：

```ts
type TurnEvent =
  | { type: 'chunk'; text: string }
  | { type: 'messageBoundary' }   // stream.end 非 aborted——turn 内消息边界，非终态
  | { type: 'aborted' }           // stream.end{aborted:true}——终态
  | { type: 'toolCall'; callId: string; name: string }
  | { type: 'toolResult'; callId: string; ok: boolean }
  | { type: 'idle' }              // agent.status idle——正常终态
  | { type: 'error'; message: string }
  | { type: 'transportDown' }
```

### ReplyTurn（模块私有）

每条 `startReply` 一个实例：携带 requestId/conversationId/sessionId/sender、两个 parser、累计 text/emotion/tools/toolNames；动词 `feed(chunk)`/`toolCall`/`toolResult`/`finish()`/`fail(error)`。parser 穿线顺序与 flush 顺序（emotionParser.end → fileParser.feed → fileParser.end → 尾 delta → pet 复位 → done）原样迁入。三个终态闭包（finishRequest/failRequest/dropRequest）收敛为一条 `close(outcome)` 路径：先注销登记（保住"立刻再发"守卫），再发终帧。

### ChatRuntime 公共面

```ts
export interface ChatRuntimeDeps {
  runtime: HarnessLike            // ensure(): Promise<DaniyaBridge>；HarnessLike 迁来本文件
  registry: ConversationRegistry
  settingsFile: string
  pet: () => PetCoordinator       // 保持惰性 thunk：设置变更会重建 pet 实例
}

export class ChatRuntime {
  constructor(deps: ChatRuntimeDeps)  // ctor 内完成 setNotificationHandler/setTransportDownHandler 接线
  startReply(sender: ReplySender, p: StartReplyPayload): Promise<StartReplyResult>
  stopReply(requestId: string): void
  listConversations(): Promise<ConversationMeta[]>
  getMessages(conversationId: string): Promise<ChatMessage[]>
  createConversation(): ConversationMeta
  renameConversation(id: string, title: string): void
  deleteConversation(id: string): Promise<void>
  search(q: string): SearchHit[]
}
```

`startReply` 主线读成直线：守卫（空消息/会话/busy/API Key）→ `runtime.ensure()` → create/resume + `liveSessions` → `injectFilesIntoLastTurn`+图片 → **先登记 turn 再 `prompt`**（帧不丢）→ touch + B-5 自动标题 + `bubble(true)` → 返回 `{ok, requestId, userMessage}`。

### 留在 ipc.ts 的

全部 `ipcMain.handle` 注册；`chat:*` 八条变一行委托；settings×4 / file×5 / screen / shell / window:hide / pet:status 原样不动；`RegisterIpcOpts` 形状不变；`pet:error` 推送仍属 index.ts。

## 明确不做

- 通道表/生成式 handler 映射——损失 grep 性，显式一行委托保留。
- `SettingsPort`/`ProposalPort`/`AttachPort` 端口抽象——settings/提案/附件继续模块内直接 import，留给 C4 FileProposalService 定形。
- `HarnessBackend` 领域端口（bridge-contract spec 中 A4 方案）——若未来做，`deps.runtime` 就是换装点。
- FSM 框架/更多状态（如 Cancelling）——open→closed 两相即可，取消期间帧照排是既有行为。
- `turn` 字段仍不参与路由（按 session 路由），仅记录。
- 任何 IPC 通道名、载荷形状、事件顺序的对外变化——渲染器协议零改动。

## Acceptance

- `src/main/chat-runtime.ts` 存在且承载上述全部职责；`src/main/ipc.ts` 只剩 adapter（预期 ≤200 行）。
- `ipc.ts` 中不再出现 `ActiveRequest`/`activeByRequest`/`liveSessions`/`historyCache`/`handleNotification`/`projectMessage`/`lastSender`。
- `ReplySender` 为出站唯一通道；`chat:stream`/`file:proposal` 字面量只在 chat-runtime.ts 出现。
- `TurnEvent` 联合存在；`stream.end` 的 aborted 分流在 `toTurnEvent`（或等价归一函数）内完成；B-6 注释保留在分流处。
- `HarnessLike` 定义移入 chat-runtime.ts（或 harness 侧重新导出），`runtime` 依赖经构造器注入。
- 新增 `chat-runtime.test.ts`：进程内 stub（HarnessLike + scripted DaniyaBridge + RecordingSender）覆盖——B-6 多帧序、aborted 终帧、无归属 error 走 lastSink、destroyed sender 不炸、transportDown 全灭+重 resume、busy 守卫、prompt 拒绝后 turn 注销可重发、**prompt 期间到达的 chunk 不丢**（预登记不变式的看门测试）。
- `ipc.test.ts` 保留为接线冒烟（通道注册 + 一条 happy path），fixture 子进程用例可留 1-2 条；不得因本票整体删除。
- `npm run typecheck` 全绿；`npm run test` 全绿。

## Testing

远端可验证：typecheck + 全部 vitest（含新 chat-runtime.test.ts）。`npm run build` 本地收尾验证（main 侧 wiring 变了）。

不可远端验证（Windows 复核项）：真实 harness 全链冒烟、pet 气泡/情绪实际联动、packaging——记为 follow-up，不阻塞合并。
