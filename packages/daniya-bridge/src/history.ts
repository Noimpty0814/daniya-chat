/**
 * 历史投影 —— 把 session 事件日志投影为 spec §5.2 的 `BridgeMessage`。
 *
 * 模型可见面（surface）是唯一历史来源：`foldSurface` / `session.surface.nodes`
 * 给出有序 surface 节点，`deriveEventMessage` 把每个节点事件投成 LLM `Message`。
 * 本模块只做展示层映射，不做模型-facing 投影（刻意不传 projectedMessages：
 * 用户可见历史要看到原文，不是压缩/修剪后的模型视图）。
 *
 * `createdAt` 取事件时间（`Message` 本身无时间字段）。
 * `role` 映射：`user`（source.kind==='user'）、`assistant`、`tool`（source.kind==='tool'）；
 * 其他来源（plugin 注入上下文等）不进入用户可见历史。
 *
 * @module daniya-bridge/history
 */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, foldSurface, SessionSeq } from '@deepseek-ai/dsh-session'
// 线类型唯一真相在 protocol.ts（零导入铁律见该文件头注）；本模块只导入、不扩展。
import type { BridgeFile, BridgeImage, BridgeMessage, BridgeToolCall } from './protocol.js'

/** 诊断输出（stderr）；保持协议 stdout 纯净。 */
export type Diagnostic = (message: string) => void

/** 连接 tool-result 内容块里的文本；非文本块以占位符表示。 */
function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('')
}

/** 收集日志里 `tool/call` 的 callId → 工具名映射，供 tool 消息回填 `name`。 */
function toolNameIndex(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(String(event.data.callId), event.data.name)
  }
  return names
}

/**
 * 把一条派生 `Message` 投成 `BridgeMessage`；`system` 角色与 plugin/其他来源的
 * user 消息返回 `undefined`（不进入用户可见历史）。
 */
async function projectMessage(
  message: Message,
  createdAt: number,
  toolNames: Map<string, string>,
  attachments: AttachmentStore | undefined,
  diagnostic: Diagnostic,
): Promise<BridgeMessage | undefined> {
  let role: BridgeMessage['role']
  if (message.role === 'assistant') role = 'assistant'
  else if (message.role === 'user' && message.source.kind === 'tool') role = 'tool'
  else if (message.role === 'user' && message.source.kind === 'user') role = 'user'
  else return undefined

  const text: string[] = []
  const images: BridgeImage[] = []
  const files: BridgeFile[] = []
  const toolCalls: BridgeToolCall[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'image':
        images.push(await projectImage(block.attachment, attachments, diagnostic))
        break
      case 'file':
        files.push({ name: block.attachment.name, bytes: block.attachment.bytes })
        break
      case 'tool-call':
        toolCalls.push({ callId: String(block.id), name: block.name })
        break
      case 'tool-result':
        toolCalls.push({
          callId: String(block.toolCallId),
          name: toolNames.get(String(block.toolCallId)) ?? 'unknown',
          ok: block.isError !== true,
        })
        text.push(textOfBlocks(block.content))
        break
      default:
        // reasoning 等模型内部块不进入展示历史；合并扩展块按未知默认跳过。
        break
    }
  }

  const projected: BridgeMessage = {
    id: String(message.id),
    role,
    content: text.join(''),
    createdAt,
  }
  if (images.length > 0) projected.images = images
  if (files.length > 0) projected.files = files
  if (toolCalls.length > 0) projected.toolCalls = toolCalls
  if (role === 'assistant' && message.source.kind === 'model') projected.model = message.source.model
  return projected
}

/** 读附件字节拼 dataUrl；服务缺失或读失败时保留引用但缺省 `dataUrl`。 */
async function projectImage(
  ref: ImageAttachmentRef,
  attachments: AttachmentStore | undefined,
  diagnostic: Diagnostic,
): Promise<BridgeImage> {
  const image: BridgeImage = {
    id: String(ref.attachmentId),
    mediaType: ref.mediaType,
    width: ref.width,
    height: ref.height,
  }
  if (ref.name !== undefined) image.name = ref.name
  if (attachments === undefined) return image
  try {
    const stored = await attachments.readImage(ref)
    image.dataUrl = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  } catch (error) {
    diagnostic(`daniya-bridge: image attachment ${image.id} could not be read for history: ${error instanceof Error ? error.message : String(error)}`)
  }
  return image
}

/** 共享投影核：按 surface 节点序投影消息，附带工具名索引与事件时间。 */
async function projectWithNodes(
  events: readonly SessionEvent[],
  nodes: readonly SessionSeq[],
  derive: (event: SessionEvent) => Message | null,
  attachments: AttachmentStore | undefined,
  diagnostic: Diagnostic,
): Promise<BridgeMessage[]> {
  const toolNames = toolNameIndex(events)
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) bySeq.set(event.seq as number, event)
  const messages: BridgeMessage[] = []
  for (const seq of nodes) {
    const event = bySeq.get(seq as number)
    if (event === undefined) continue
    const message = derive(event)
    if (message === null) continue
    const projected = await projectMessage(message, event.time, toolNames, attachments, diagnostic)
    if (projected !== undefined) messages.push(projected)
  }
  return messages
}

/**
 * 把一整段连续事件日志投成 `BridgeMessage[]`（stored 路径用全量事件）。
 * `foldSurface` 重放 surface 折叠（含压缩 replace 与已记录的 message 投影）；
 * 含未知 plugin 投影的日志会按其规则抛错，直接上抛为 RPC 失败。
 */
export async function projectEvents(
  events: readonly SessionEvent[],
  attachments: AttachmentStore | undefined,
  diagnostic: Diagnostic = () => {},
): Promise<BridgeMessage[]> {
  const { nodes, projectedMessages } = foldSurface(events)
  return projectWithNodes(
    events,
    nodes,
    event => deriveEventMessage(event, projectedMessages),
    attachments,
    diagnostic,
  )
}

/**
 * 活会话路径：`session.surface.nodes` 是带生命周期投影的活 surface，
 * `session.eventAt` 按 seq 取事件，`session.deriveEventMessage` 应用活投影。
 */
export async function projectLiveSession(
  session: Session,
  attachments: AttachmentStore | undefined,
  diagnostic: Diagnostic = () => {},
): Promise<BridgeMessage[]> {
  const events: SessionEvent[] = []
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event !== undefined) events.push(event)
  }
  return projectWithNodes(
    events,
    session.surface.nodes,
    event => session.deriveEventMessage(event),
    attachments,
    diagnostic,
  )
}
