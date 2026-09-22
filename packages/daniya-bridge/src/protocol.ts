/**
 * 协议层 —— spec §5.2 的按行 JSON-RPC 2.0 线格式契约（唯一类型真相源）。
 *
 * 传输本体复用 `@deepseek-ai/dsh-sdk-protocol` 的 `JsonRpcLineTransport`
 * （同一套按行分帧语义：非法行忽略、`-32601`/`-32603`、stdout 只写协议帧、
 * 入向通知无处理器则丢弃）。本文件固定 daniya 侧的 9 个请求方法与 6 种
 * 通知的参数/结果类型：server 分派表与 main 侧 `DaniyaBridge` 门面都由它
 * 在编译期约束，任一侧改字段名即编译错而非运行时漂移。
 *
 * 零导入铁律：本文件被根项目 tsconfig.node.json 直接 include 做 typecheck
 * （composite 的文件清单要求，缺了报 TS6307）；任何 import 都会把被引文件
 * 一并拖进根项目清单造成连锁报错。因此本文件只允许类型声明——禁止 import，
 * 也不得有运行时语句（零体积、零依赖的纯契约面）。
 *
 * stdin EOF 的退出语义不在传输层：插件层按 sdk 参照接线（见 index.ts）。
 *
 * @module daniya-bridge/protocol
 */

/**
 * 桥接端暴露的通知/响应写面（server 只依赖这一侧，便于测试替换）。
 * `notify` 受 `BridgeNotificationMap` 约束：写错方法名或字段是编译错。
 * `JsonRpcLineTransport` 的 `(method: string, params?: object)` 签名逆变兼容。
 */
export interface BridgeTransportPeer {
  /** 发送一条通知；`params` 形状由 `method` 在 `BridgeNotificationMap` 中钉死。 */
  notify<M extends BridgeNotificationMethod>(method: M, params: BridgeNotificationMap[M]): void
  /** 等待此前所有帧的写回调；空屏障，不写任何字节。 */
  flush(): Promise<void>
}

// ---- 请求方法（9 个） ----

/** spec §5.2 的全部入向请求方法名。 */
export type BridgeRequestMethod =
  | 'initialize'
  | 'session.create'
  | 'session.resume'
  | 'session.list'
  | 'session.history'
  | 'session.delete'
  | 'prompt'
  | 'cancel'
  | 'shutdown'

/** `initialize`：握手 + 校验 workdir/模型/LLM 路由/附件与持久化就绪。 */
export interface InitializeParams {
  workdir: string
  model: string
}

/** `session.resume`/`session.history`/`session.delete`/`prompt`/`cancel` 的会话定位参数。 */
export interface SessionIdParams {
  sessionId: string
}

/** `prompt` 的线格式图像：base64 字节 + 媒体类型。 */
export interface WireImage {
  /** base64 编码的图像字节。 */
  data: string
  /** `image/png` | `image/jpeg` | `image/webp` | `image/gif`。 */
  mimeType: string
}

/** `prompt {sessionId, text, images?}` → `{messageId}`。 */
export interface PromptParams extends SessionIdParams {
  text: string
  images?: WireImage[]
}

/**
 * 各请求方法的 params 类型索引；无参方法记 `undefined`。
 * server 分派表键集与 main 侧 `request<M>` 重载共用此表——漏一个方法是编译错。
 * 注意：这是"声明形状"，wire 对端送来的仍是裸数据，server handler 的
 * `typeof` 运行时防御不因此省略。
 */
export interface BridgeParamsMap {
  'initialize': InitializeParams
  'session.create': undefined
  'session.resume': SessionIdParams
  'session.list': undefined
  'session.history': SessionIdParams
  'session.delete': SessionIdParams
  'prompt': PromptParams
  'cancel': SessionIdParams
  'shutdown': undefined
}

/** `session.list` 行：title 恒空串（显示名由主进程登记簿自持）。 */
export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: number
}

// ---- 历史线格式（`session.history` 的 `BridgeMessage` 投影面） ----

/** 历史消息中的图像引用；`dataUrl` 在能读出附件字节时填充（还原 `ImagePart`）。 */
export interface BridgeImage {
  id: string
  dataUrl?: string
  mediaType: string
  width: number
  height: number
  name?: string
}

/** 历史消息中的文件引用（dsh 不存原路径，只有名称与字节数）。 */
export interface BridgeFile {
  name: string
  bytes: number
}

/** 消息携带的工具调用信息：assistant 消息列出发起的调用，tool 消息回填结果。 */
export interface BridgeToolCall {
  callId: string
  name: string
  ok?: boolean
}

/**
 * spec §5.2 `BridgeMessage`：字段按 `{id, role, content, images?, toolCalls?, createdAt}`
 * 对齐，`files?`/`model?` 为还原 `ChatMessage` 所需的超集字段。
 */
export interface BridgeMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  images?: BridgeImage[]
  files?: BridgeFile[]
  toolCalls?: BridgeToolCall[]
  model?: string
  createdAt: number
}

// ---- 通知（6 种） ----

/** spec §5.2 的全部出向通知方法名。 */
export type BridgeNotificationMethod =
  | 'stream.chunk'
  | 'stream.end'
  | 'tool.call'
  | 'tool.result'
  | 'agent.status'
  | 'error'

/** `stream.chunk`：可见文本增量。`turn` 取帧所属 turn（start 帧登记）。 */
export interface StreamChunkNotification {
  sessionId: string
  turn: number
  text: string
}

/** `stream.end`：回复终帧；`aborted:true` 表示取消截断。 */
export interface StreamEndNotification {
  sessionId: string
  turn: number
  aborted?: boolean
}

/** `tool.call`：调用发起；`argsPreview` 截断 ≤500 字符。 */
export interface ToolCallNotification {
  sessionId: string
  callId: string
  tool: string
  argsPreview: string
}

/** `tool.result`：调用结果；`preview` 截断 ≤500 字符。 */
export interface ToolResultNotification {
  sessionId: string
  callId: string
  ok: boolean
  preview: string
}

/** `agent.status`：dsh 生命周期状态直传。 */
export interface AgentStatusNotification {
  sessionId: string
  status: string
}

/** `error`：无 `sessionId` 时是桥级错误（初始化、传输、沙箱写入被拒等）。 */
export interface ErrorNotification {
  sessionId?: string
  message: string
}

/** 各通知方法的 params 类型索引；`safeNotify`/`on<M>` 按它收窄。 */
export interface BridgeNotificationMap {
  'stream.chunk': StreamChunkNotification
  'stream.end': StreamEndNotification
  'tool.call': ToolCallNotification
  'tool.result': ToolResultNotification
  'agent.status': AgentStatusNotification
  'error': ErrorNotification
}

/** 出向通知帧的判别联合：`method` 收窄 `params`（main 侧 switch 按此分流）。 */
export type BridgeNotification = {
  [M in BridgeNotificationMethod]: { method: M; params: BridgeNotificationMap[M] }
}[BridgeNotificationMethod]

// ---- 结果类型 ----

/** 各请求方法的结果类型索引（`shutdown` 与 `session.delete` 等以 `{ok:true}` 回执）。 */
export interface BridgeResultMap {
  'initialize': { ok: true }
  'session.create': { sessionId: string }
  'session.resume': { ok: true }
  'session.list': SessionSummary[]
  'session.history': { messages: BridgeMessage[] }
  'session.delete': { ok: true }
  'prompt': { messageId: string }
  'cancel': { ok: true }
  'shutdown': { ok: true }
}
