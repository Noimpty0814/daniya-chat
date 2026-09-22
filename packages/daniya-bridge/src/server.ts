/**
 * daniya-bridge 服务面 —— spec §5.2 的 9 个请求方法与 6 种通知的实现。
 *
 * 会话注册表：`sessionId ↔ AgentHandle`，`ctx.agents` 为活 agent 权威；
 * create/resume 去重经 `sessionCreations` 在途表（同 id 并发只跑一次工厂）。
 *
 * 事件转发全部先按注册表过滤（本插件只桥接自己创建的会话）：
 * - `agent/assistant-stream`：`start` 记 attemptId→turn；`chunk` 的
 *   `text-delta` 帧转 `stream.chunk`；`end` 帧仅在 outcome 为已提交的
 *   `assistant/message` 时转 `stream.end`（`assistant/attempt`/`abandoned`
 *   不视为可见回复终帧——取消时由 `turn/end` 兜底补 `stream.end{aborted}`）。
 * - `session/event`：`tool/call`/`tool/result` 转 `tool.call`/`tool.result`
 *   （args/preview 截断 ≤500 字符）；`assistant/message{interrupted}` 记 seq
 *   供 end 帧判 `aborted`；`turn/end{aborted}` 兜底补 `stream.end{aborted:true}`
 *   （同一 turn 已发过 aborted 终帧则不重复）。
 * - `agent/status` → `agent.status`。
 * - `agent/request-error`（waterfall）：先 `next()` 再按终态与否转 `error`，
 *   并记 `turn:step:message` 去重紧随其后的 `agent/error`。
 * - `agent/error` → `error`（被 request-error 覆盖的按键去重）。
 * - `agent/disposed`：清理注册表与流跟踪状态。
 *
 * @module daniya-bridge/server
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  AssistantStreamFrame,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type {
  AttachmentAdmissionPart,
  AttachmentStore,
  ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { LlmAttemptId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { BridgeTransportPeer } from './protocol.js'
import { projectEvents, projectLiveSession, type BridgeMessage, type Diagnostic } from './history.js'
import { buildPersonaText } from './persona.js'

/** 工具徽照搬预览的字符上限（spec：args/result preview ≤500）。 */
const PREVIEW_MAX_CHARS = 500

/** bridge 接收的图像媒体类型（与 dsh-attachment 的版本一集合一致）。 */
const IMAGE_MEDIA_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface SessionRecord {
  handle: AgentHandle
}

/** 一个会话的流式终帧判定与错误去重状态。 */
interface StreamTracking {
  /** attemptId → 帧所属 turn（start 帧登记）。 */
  attemptTurns: Map<LlmAttemptId, number>
  /** 已提交的 `assistant/message{interrupted:true}`：event seq → turn。 */
  interruptedSeqs: Map<number, number>
  /** 已发出 `stream.end{aborted:true}` 的 turn（防 turn/end 兜底重复）。 */
  abortedEnds: Set<number>
  /** request-error 已通知的 `turn:step:message` 键（agent/error 去重）。 */
  requestErrorKeys: Set<string>
}

/** 截断到 ≤500 字符，超长时末位替换为省略号标记。 */
function previewText(text: string): string {
  return text.length <= PREVIEW_MAX_CHARS ? text : `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

/** tool-result 内容块的文本化预览（非文本块以类型占位符表示）。 */
function blocksPreview(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text ?? '' : `[${block.type}]`)).join('')
}

/** 提取可发送的错误消息文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件解析后的运行配置。 */
export interface BridgeServerConfig {
  /** settings.json 路径（`DANIYA_SETTINGS_FILE`）；人设段每次组装重读。 */
  settingsFile?: string
  /** 会话 cwd / 沙箱 workspace root（`DANIYA_WORKDIR` 或 initialize 参数）。 */
  workdir?: string
  /** LLM provider 路由（默认 `deepseek-official`）。 */
  provider?: string
}

/**
 * JSON-RPC 方法与通知的实现体。构造时完成事件订阅（`ctx.on` 即效果注册，
 * 随插件 fiber 一并卸除）；`shutdown()` 幂等，排干在途创建与全部 agent。
 */
export class DaniyaBridgeServer {
  private initialized = false
  private shuttingDown = false
  private workdir: string
  private readonly provider: string
  private model = ''
  private readonly records = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly streamStates = new Map<string, StreamTracking>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly transport: BridgeTransportPeer,
    private readonly config: BridgeServerConfig,
    private readonly diagnostic: Diagnostic,
  ) {
    this.provider = config.provider ?? 'deepseek-official'
    this.workdir = config.workdir ?? process.env.DANIYA_WORKDIR ?? process.cwd()
    this.disposers.push(ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)))
    this.disposers.push(ctx.on('agent/status', payload => this.onAgentStatus(payload)))
    this.disposers.push(ctx.on('agent/assistant-stream', payload => this.onStreamFrame(payload.agent, payload.frame)))
    this.disposers.push(ctx.on('agent/error', payload => this.onAgentError(payload)))
    this.disposers.push(ctx.on('agent/request-error', (payload, next) => this.onRequestError(payload, next)))
    this.disposers.push(ctx.on('agent/disposed', payload => this.onAgentDisposed(payload.agent)))
  }

  /** 当前生效的工作目录（initialize 可更新）；人设段每轮组装读取。 */
  get currentWorkdir(): string {
    return this.workdir
  }

  /**
   * 派发一个 JSON-RPC 请求。未知方法抛错（经协议层成为 `-32603`，与
   * 参照实现 sdk-server 的分派语义一致）。
   */
  async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params)
      case 'session.create':
        return this.sessionCreate()
      case 'session.resume':
        return this.sessionResume(params)
      case 'session.list':
        return this.sessionList()
      case 'session.history':
        return this.sessionHistory(params)
      case 'session.delete':
        return this.sessionDelete(params)
      case 'prompt':
        return this.prompt(params)
      case 'cancel':
        return this.cancel(params)
      case 'shutdown':
        await this.shutdown()
        return { ok: true }
      default:
        throw new Error(`method not found: ${method}`)
    }
  }

  /**
   * `initialize {workdir, model}` → `{ok}`：校验 workdir 绝对性、LLM 路由
   * （`llm.resolveCallConfig`）、附件存储与持久化服务就绪。幂等可重复，
   * 重复调用刷新 workdir/model（既有会话的 cwd 不受影响）。
   */
  async initialize(params: Record<string, unknown>): Promise<{ ok: true }> {
    const workdirParam = params.workdir
    if (workdirParam !== undefined && (typeof workdirParam !== 'string' || workdirParam.length === 0)) {
      throw new TypeError('initialize workdir must be a non-empty string')
    }
    const model = params.model
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('initialize model must be a non-empty string')
    }
    // resolve() 归一化并保证绝对路径（sdk 参照对 cwd 同款处理）。
    const workdir = resolve(workdirParam ?? this.config.workdir ?? process.env.DANIYA_WORKDIR ?? process.cwd())
    const llm = this.ctx.get('llm') as LlmRuntime | undefined
    if (llm === undefined) throw new Error('daniya-bridge: llm service is not mounted')
    // 路由校验：provider/model 组合不可解析时在此失败（spec：校验路由就绪）。
    await llm.resolveCallConfig({ provider: this.provider, model })
    // 附件存储就绪性：inject 保证服务存在；读取其部署解析结果证明可用。
    void (this.ctx.attachments as AttachmentStore).imageLimits
    this.requirePersistence()
    this.workdir = workdir
    this.model = model
    this.initialized = true
    return { ok: true }
  }

  /** `session.create {}` → `{sessionId}`：新会话 + agent，`meta.cwd` 设为当前 workdir。 */
  async sessionCreate(): Promise<{ sessionId: string }> {
    this.assertInitialized()
    const sessionId = SessionId(`daniya-${randomUUID()}`)
    const key = String(sessionId)
    // 与 resume 同规：在途创建入表，shutdown 排干它——否则竞速时 agent 会漏注册。
    const creation = this.createRecord(sessionId, 'create')
    this.sessionCreations.set(key, creation)
    try {
      await creation
    } finally {
      this.sessionCreations.delete(key)
    }
    return { sessionId: key }
  }

  /**
   * `session.resume {sessionId}` → `{ok}`：经 `ResumeAgentOptions`
   * 载入持久会话；已活会话命中注册表即回 ok；同 id 并发 resume 去重。
   * 历史由 `session.history` 独立投影，此处不回传。
   */
  async sessionResume(params: Record<string, unknown>): Promise<{ ok: true }> {
    this.assertInitialized()
    const sessionId = this.requireSessionId(params)
    await this.getOrResume(sessionId)
    return { ok: true }
  }

  /**
   * `session.list {}` → `[{sessionId, title, updatedAt}]`：持久层快照
   * ∪ 尚未落盘的活会话。`title` 恒为 `''`——显示标题与排序由主进程
   * conversations 登记簿自持；`updatedAt` 为末事件时间（取不到时退化为创建时间）。
   */
  async sessionList(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    this.assertInitialized()
    const persistence = this.requirePersistence()
    const snapshots = await persistence.list()
    const seen = new Set<string>()
    const rows: { sessionId: string; title: string; updatedAt: number }[] = []
    for (const snapshot of snapshots) {
      const id = String(snapshot.header.id)
      seen.add(id)
      rows.push({ sessionId: id, title: '', updatedAt: await this.lastActivityAt(snapshot) })
    }
    for (const session of this.ctx.sessions.list()) {
      const id = String(session.id)
      if (seen.has(id)) continue
      rows.push({ sessionId: id, title: '', updatedAt: session.header.createdAt })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }

  /**
   * `session.history {sessionId}` → `{messages}`：活会话读内存日志
   * （surface + eventAt），否则经持久层只读打开后整投影。
   */
  async sessionHistory(params: Record<string, unknown>): Promise<{ messages: BridgeMessage[] }> {
    this.assertInitialized()
    const sessionId = this.requireSessionId(params)
    const live = this.ctx.sessions.get(SessionId(sessionId))
    if (live !== undefined) {
      return { messages: await projectLiveSession(live, this.ctx.attachments, this.diagnostic) }
    }
    const persistence = this.requirePersistence()
    const handle = await persistence.open(SessionId(sessionId), 'read')
    try {
      const result = await handle.read()
      return { messages: await projectEvents(result.events, this.ctx.attachments, this.diagnostic) }
    } finally {
      await handle.close()
    }
  }

  /**
   * `session.delete {sessionId}` → `{ok}`：排干并关闭本桥接的活 agent。
   * 持久层无删除 API——存储日志是 append-only，磁盘上的 session 目录会保留
   * （已知限制，README 记录）；非本桥接的活 agent 不动。
   */
  async sessionDelete(params: Record<string, unknown>): Promise<{ ok: true }> {
    this.assertInitialized()
    const sessionId = this.requireSessionId(params)
    const rec = this.records.get(sessionId)
    if (rec !== undefined) {
      this.records.delete(sessionId)
      this.streamStates.delete(sessionId)
      await rec.handle.dispose()
    } else {
      this.diagnostic(`daniya-bridge: session.delete found no live agent for ${sessionId}; stored log retained (no persistence delete API)`)
    }
    return { ok: true }
  }

  /**
   * `prompt {sessionId, text, images?}` → `{messageId}`：图像先经
   * `ctx.attachments.admitPromptContent` 准入为持久附件，再组 `ContentBlock[]`
   * 由 `agent.followup` 入队。返回即入队回执，不等模型产出。
   */
  async prompt(params: Record<string, unknown>): Promise<{ messageId: string }> {
    this.assertInitialized()
    const sessionId = this.requireSessionId(params)
    const text = params.text
    if (typeof text !== 'string') throw new TypeError('prompt text must be a string')
    const images = params.images
    if (images !== undefined && !Array.isArray(images)) throw new TypeError('prompt images must be an array')
    const rec = this.records.get(sessionId)
    if (rec === undefined) throw new Error(`unknown session: ${sessionId}`)
    this.assertLiveAgent(rec, sessionId)

    const parts: AttachmentAdmissionPart[] = []
    if (text.length > 0) parts.push({ type: 'text', text })
    for (const [index, image] of (images ?? []).entries()) {
      const mediaType = (image as { mimeType?: unknown }).mimeType
      const data = (image as { data?: unknown }).data
      if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new TypeError(`prompt images[${index}].mimeType must be one of ${[...IMAGE_MEDIA_TYPES].join(', ')}`)
      }
      if (typeof data !== 'string' || data.length === 0) {
        throw new TypeError(`prompt images[${index}].data must be a non-empty base64 string`)
      }
      parts.push({ type: 'image', mediaType: mediaType as ImageMediaType, data })
    }
    if (parts.length === 0) throw new Error('prompt requires non-empty text or at least one image')

    const admitted = await this.ctx.attachments.admitPromptContent(parts)
    // 附件准入跨异步边界，之后活 agent 可能已被外部卸除，投递前再校验一次。
    this.assertLiveAgent(rec, sessionId)
    const message = createUserMessage({ content: admitted, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: String(message.id) }
  }

  /** `cancel {sessionId}` → `{ok}`：`agent.cancel({kind:'user'})`。 */
  async cancel(params: Record<string, unknown>): Promise<{ ok: true }> {
    this.assertInitialized()
    const sessionId = this.requireSessionId(params)
    const rec = this.records.get(sessionId)
    if (rec === undefined) throw new Error(`unknown session: ${sessionId}`)
    this.assertLiveAgent(rec, sessionId)
    rec.handle.agent.cancel({ kind: 'user' })
    return { ok: true }
  }

  /**
   * `shutdown {}`：排干在途创建、摘监听、dispose 全部 agent（幂等）。
   * 响应由插件层写回后再触发进程退出；本方法不含退出语义。
   */
  async shutdown(): Promise<void> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.records.values()]
    this.records.clear()
    this.streamStates.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const results = await Promise.allSettled(records.map(rec => rec.handle.dispose()))
    failures.push(...results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'daniya-bridge teardown failed')
  }

  // ---- 会话注册表 ----

  private async getOrResume(sessionId: string): Promise<SessionRecord> {
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending !== undefined) return pending
    const creation = this.createRecord(SessionId(sessionId), 'resume')
    this.sessionCreations.set(sessionId, creation)
    try {
      return await creation
    } finally {
      this.sessionCreations.delete(sessionId)
    }
  }

  /**
   * create/resume 共用工厂路径：agent 作用域 setup 在首个 spawn 前写
   * `sandbox/mode = workspace-write`（terminal 打开后改模式会被拒；
   * 被拒时记 stderr + `error` 通知，不阻断创建）。
   * workspace root 取 `session.header.cwd`（create 时经 `meta.cwd` 注入；
   * resume 沿用该会话创建时的 cwd——持久头不可改）。
   */
  private async createRecord(sessionId: SessionId, kind: 'create' | 'resume'): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('daniya-bridge is shutting down')
    const setup: AgentSetup = (agentCtx, agent) => {
      // 人设段：agent 作用域注册与部署 persona 同名段，按 dsh-scope 遮蔽规则
      // 盖掉全局 personaPrefix（sdk-minimal 的通用 "helpful software engineer"）。
      // 段提供者每次组装重读 settings 与当前 workdir；interpolate:false 保留
      // 用户人设里的 {{…}} 字面量。注册随 agent 卸载自动回收。
      agentCtx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        interpolate: false,
        text: () => buildPersonaText(this.config.settingsFile, this.workdir),
      })
      try {
        setSandboxMode(agent.session, 'workspace-write')
      } catch (error) {
        const message = messageOf(error)
        this.diagnostic(`daniya-bridge: sandbox/mode write rejected for session ${String(agent.session.id)}: ${message}`)
        this.safeNotify('error', { sessionId: String(agent.session.id), message: `工作目录沙箱写入被拒：${message}` })
      }
    }
    const agentOptions = { provider: this.provider, model: this.model }
    const handle = kind === 'create'
      ? await this.ctx.agents.create({ sessionId, meta: { cwd: this.workdir }, agentOptions, setup })
      : await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    const rec: SessionRecord = { handle }
    this.records.set(String(sessionId), rec)
    return rec
  }

  /** 注册表活体验证：agent-loop 重载可在外部卸除 handle，投前对照权威注册表。 */
  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the bridge: ${sessionId}`)
    }
  }

  private requireSessionId(params: Record<string, unknown>): string {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string')
    }
    return sessionId
  }

  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) throw new Error('daniya-bridge: session persistence is not configured')
    return persistence
  }

  private assertInitialized(): void {
    if (this.shuttingDown) throw new Error('daniya-bridge is shutting down')
    if (!this.initialized) throw new Error('daniya-bridge: initialize required')
  }

  /** 末事件时间作 updatedAt；取不到（eventCount 缺失/读失败）退化为 createdAt。 */
  private async lastActivityAt(snapshot: SessionPersistenceSnapshot): Promise<number> {
    const eventCount = snapshot.eventCount
    if (eventCount === undefined || eventCount <= 0) return snapshot.header.createdAt
    const persistence = this.requirePersistence()
    try {
      const handle = await persistence.open(snapshot.header.id, 'read')
      try {
        const result = await handle.read(eventCount - 1, 1)
        return result.events[0]?.time ?? snapshot.header.createdAt
      } finally {
        await handle.close()
      }
    } catch (error) {
      this.diagnostic(`daniya-bridge: could not read last event of ${String(snapshot.header.id)}: ${messageOf(error)}`)
      return snapshot.header.createdAt
    }
  }

  private streamState(sessionId: string): StreamTracking {
    let state = this.streamStates.get(sessionId)
    if (state === undefined) {
      state = { attemptTurns: new Map(), interruptedSeqs: new Map(), abortedEnds: new Set(), requestErrorKeys: new Set() }
      this.streamStates.set(sessionId, state)
    }
    return state
  }

  /** 通知写失败只记 stderr——监听器内抛出会沿 cordis dispatch 回灌进 loop。 */
  private safeNotify(method: string, params?: object): void {
    try {
      this.transport.notify(method, params)
    } catch (error) {
      this.diagnostic(`daniya-bridge: notify "${method}" failed: ${messageOf(error)}`)
    }
  }

  // ---- 事件转发（全部先按会话注册表过滤，不桥接外来会话） ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const sessionId = String(session.id)
    if (!this.records.has(sessionId)) return
    const state = this.streamState(sessionId)
    switch (event.type) {
      case 'turn/start': {
        // turn 单调递增：丢弃更早 turn 的判定残留，集合有界。
        const turn = event.data.turn
        for (const [seq, owner] of state.interruptedSeqs) if (owner < turn) state.interruptedSeqs.delete(seq)
        for (const ended of state.abortedEnds) if (ended < turn) state.abortedEnds.delete(ended)
        break
      }
      case 'assistant/message':
        if (event.data.interrupted === true) state.interruptedSeqs.set(event.seq, event.data.turn)
        break
      case 'turn/end':
        // 取消兜底：attempt 级终帧被抑制（attempt/abandoned）或根本未流式时，
        // turn/end{aborted} 是唯一可靠终界，补发 stream.end{aborted:true}。
        if (event.data.reason.kind === 'aborted' && !state.abortedEnds.has(event.data.turn)) {
          state.abortedEnds.add(event.data.turn)
          this.safeNotify('stream.end', { sessionId, turn: event.data.turn, aborted: true })
        }
        break
      case 'tool/call':
        this.safeNotify('tool.call', {
          sessionId,
          callId: String(event.data.callId),
          tool: event.data.name,
          argsPreview: previewText(event.data.arguments),
        })
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        this.safeNotify('tool.result', {
          sessionId,
          callId: String(event.data.message.source.callId),
          ok: block.isError !== true,
          preview: previewText(blocksPreview(block.content)),
        })
        break
      }
      default:
        break
    }
  }

  private onAgentStatus(payload: { agent: Agent; status: string }): void {
    const sessionId = String(payload.agent.session.id)
    if (!this.records.has(sessionId)) return
    this.safeNotify('agent.status', { sessionId, status: payload.status })
  }

  private onStreamFrame(agent: Agent, frame: AssistantStreamFrame): void {
    const sessionId = String(agent.session.id)
    if (!this.records.has(sessionId)) return
    const state = this.streamState(sessionId)
    if (frame.type === 'start') {
      state.attemptTurns.set(frame.attemptId, frame.turn)
      return
    }
    if (frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta') {
        this.safeNotify('stream.chunk', {
          sessionId,
          turn: state.attemptTurns.get(frame.attemptId) ?? 0,
          text: frame.chunk.text,
        })
      }
      return
    }
    // end 帧：只有提交为 assistant/message 的 attempt 才构成可见回复终帧。
    const turn = state.attemptTurns.get(frame.attemptId) ?? 0
    state.attemptTurns.delete(frame.attemptId)
    if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') {
      const aborted = state.interruptedSeqs.delete(frame.outcome.seq) === true
      this.safeNotify('stream.end', aborted ? { sessionId, turn, aborted: true } : { sessionId, turn })
      if (aborted) state.abortedEnds.add(turn)
    }
  }

  private onAgentError(payload: { agent: Agent; turn: number; step: number; error: unknown }): void {
    const sessionId = String(payload.agent.session.id)
    if (!this.records.has(sessionId)) return
    const message = messageOf(payload.error)
    const state = this.streamState(sessionId)
    // 终态 request-error 已转 error 通知；紧随的 agent/error 是同一失败，去重。
    if (state.requestErrorKeys.delete(`${payload.turn}:${payload.step}:${message}`)) return
    this.safeNotify('error', { sessionId, message })
  }

  private async onRequestError(
    payload: { agent: Agent; turn: number; step: number; failure: { message: string } },
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    // waterfall 必须先委托；本监听器只观察，不接管恢复。
    const action = await next()
    const sessionId = String(payload.agent.session.id)
    if (!this.records.has(sessionId) || action?.kind === 'retry') return action
    try {
      const message = payload.failure.message
      this.streamState(sessionId).requestErrorKeys.add(`${payload.turn}:${payload.step}:${message}`)
      this.transport.notify('error', { sessionId, message })
    } catch (error) {
      // waterfall 监听器的抛出会破坏恢复链——通知失败只记 stderr。
      this.diagnostic(`daniya-bridge: request-error notify failed: ${messageOf(error)}`)
    }
    return action
  }

  private onAgentDisposed(agent: Agent): void {
    const sessionId = String(agent.session.id)
    if (this.records.get(sessionId)?.handle.agent === agent) this.records.delete(sessionId)
    this.streamStates.delete(sessionId)
  }
}
