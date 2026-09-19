/**
 * 协议层 —— spec §5.2 的按行 JSON-RPC 2.0 线格式契约。
 *
 * 传输本体复用 `@deepseek-ai/dsh-sdk-protocol` 的 `JsonRpcLineTransport`
 * （同一套按行分帧语义：非法行忽略、`-32601`/`-32603`、stdout 只写协议帧、
 * 入向通知无处理器则丢弃）。本文件固定 daniya 侧的 9 个请求方法与 7 种
 * 通知的参数/结果类型，供 server 实现与测试共同引用。
 *
 * stdin EOF 的退出语义不在传输层：插件层按 sdk 参照接线（见 index.ts）。
 *
 * @module daniya-bridge/protocol
 */

import type { BridgeMessage } from './history.js'

/** 桥接端暴露的通知/响应写面（server 只依赖这一侧，便于测试替换）。 */
export interface BridgeTransportPeer {
  /** 发送一条通知；省略 `params` 时不写 `params` 字段。 */
  notify(method: string, params?: object): void
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

/** `session.list` 行：title 恒空串（显示名由主进程登记簿自持）。 */
export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: number
}

// ---- 通知（7 种） ----

/** spec §5.2 的全部出向通知方法名。 */
export type BridgeNotificationMethod =
  | 'stream.chunk'
  | 'stream.end'
  | 'tool.call'
  | 'tool.result'
  | 'agent.status'
  | 'error'
  | 'session.event'

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

/** `session.event`：原始 `SessionEvent` 透传（便于调试/未来扩展消费）。 */
export interface SessionEventNotification {
  sessionId: string
  event: unknown
}

// ---- 结果类型 ----

/** 各请求方法的结果类型索引（`shutdown` 与 `session.delete` 等以 `{ok:true}` 回执）。 */
export interface BridgeResultMap {
  'initialize': { ok: true }
  'session.create': { sessionId: string }
  'session.resume': { ok: true; history: BridgeMessage[] }
  'session.list': SessionSummary[]
  'session.history': { messages: BridgeMessage[] }
  'session.delete': { ok: true }
  'prompt': { messageId: string }
  'cancel': { ok: true }
  'shutdown': { ok: true }
}
