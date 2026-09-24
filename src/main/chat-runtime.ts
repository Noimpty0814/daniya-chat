/**
 * ChatRuntime —— 回复 turn 状态机与 harness 会话编排（chat-runtime 票）。
 *
 * 从 registerIpc 闭包抽出：ipc.ts 只剩 ipcMain.handle 通道 adapter，
 * 本文件收走全部 turn 语义——
 * - ReplyTurn：每条 startReply 一个实例，EmotionParser + FileProposalParser
 *   穿线、tool 徽照累计、close(outcome) 单一路径收尾（先注销登记再发终帧）；
 * - TurnEvent：BridgeNotification 归一化——stream.end{aborted:true} 与
 *   stream.end{} 在 toTurnEvent 分流成两个事件类型，B-6 从注释约定落成类型结构；
 * - liveSessions / historyCache / lastSink / registry ⨝ dsh-session join /
 *   projectMessage 历史投影 / 错误→中文映射，原样迁入。
 *
 * 不 import electron：出站唯一通道是 ReplySender（WebContents 结构满足，
 * handler 里 e.sender 直接传入）；settings 继续模块级 import，附件授权与
 * 提案生命周期经 deps.files（FileProposalService）注入。
 */
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage, ConversationMeta, FileAttachment, FileProposalEvent, SearchHit,
  StartReplyPayload, StartReplyResult, StreamEventMsg, ToolBadge,
} from '../shared/types'
import { loadSettings, getApiKey } from './settings'
import { stripFileContext } from './files/service'
import type { FileProposalService } from './files/service'
import { FileProposalParser, type ProposalResult } from './files/proposal'
import { EmotionParser, type Emotion } from './harness/emotion'
import { ConversationRegistry, NEW_CONVERSATION_TITLE } from './harness/conversations'
import { HarnessUnavailableError } from './harness/process'
import { BridgeProtocolError, BridgeTimeoutError, BridgeTransportError } from './harness/bridge'
import type { DaniyaBridge, BridgeMessage, BridgeNotification, SessionSummary } from './harness/client'
import type { PetCoordinator } from './pet/coordinator'

/** ChatRuntime 对运行时的最小依赖面（HarnessRuntime 结构满足；测试可注入 fake） */
export interface HarnessLike {
  ensure(): Promise<DaniyaBridge>
  readonly activeBridge: DaniyaBridge | null
  readonly isAlive: boolean
  setNotificationHandler(fn: ((notification: BridgeNotification) => void) | null): void
  setTransportDownHandler(fn: (() => void) | null): void
}

/** turn 的出站口：WebContents 结构满足；测试注入 { send: 记录, isDestroyed: () => false } */
export interface ReplySender {
  send(channel: string, data: unknown): void
  isDestroyed(): boolean
}

export interface ChatRuntimeDeps {
  runtime: HarnessLike
  registry: ConversationRegistry
  settingsFile: string
  /** 附件授权与提案生命周期（file-proposal-service 票，registerIpc 构造注入） */
  files: FileProposalService
  /** 保持惰性 thunk：设置变更会重建 pet 实例 */
  pet: () => PetCoordinator
}

/**
 * BridgeNotification 的 turn 内归一形态：dispatch 先翻译再交给 turn。
 * stream.end{aborted:true} 与 stream.end{} 在此分流成两个事件类型——
 * B-6 从注释约定变成类型结构。
 */
type TurnEvent =
  | { type: 'chunk'; text: string }
  | { type: 'messageBoundary' }   // stream.end 非 aborted——turn 内消息边界，非终态
  | { type: 'aborted' }           // stream.end{aborted:true}——终态
  | { type: 'toolCall'; callId: string; name: string; preview?: string }
  | { type: 'toolResult'; callId: string; ok: boolean; preview?: string }
  | { type: 'idle' }              // agent.status idle——正常终态
  | { type: 'error'; message: string }
  | { type: 'transportDown' }

function toTurnEvent(n: BridgeNotification): TurnEvent | null {
  switch (n.method) {
    case 'stream.chunk':
      return { type: 'chunk', text: n.params.text }
    case 'stream.end':
      // stream.end 是"一条已提交 assistant 消息"的边界，不是请求终态：
      // 一个 turn 可能是 中间消息(带 toolCalls) → tool.* → 最终消息 多帧序列，
      // 首个 stream.end 就收尾会把后续 tool/流帧全部丢掉（B-6）。
      // 正常终态由 agent.status→idle 落地；aborted 终帧是 turn 级取消信号，可直接收尾。
      return n.params.aborted === true ? { type: 'aborted' } : { type: 'messageBoundary' }
    case 'tool.call':
      return { type: 'toolCall', callId: n.params.callId, name: n.params.tool || 'tool', preview: n.params.argsPreview || undefined }
    case 'tool.result':
      return { type: 'toolResult', callId: n.params.callId, ok: n.params.ok === true, preview: n.params.preview || undefined }
    case 'agent.status':
      return n.params.status === 'idle' ? { type: 'idle' } : null
    case 'error':
      return { type: 'error', message: mapBridgeErrorMessage(n.params.message) }
    default:
      return null
  }
}

/** turn 终局：done 发终帧、error 发错误帧、drop 静默注销（prompt 拒绝/删除清扫路径） */
type TurnOutcome = { kind: 'done' } | { kind: 'error'; error: string } | { kind: 'drop' }

interface TurnDeps {
  /** 惰性 thunk：设置变更会重建 pet 实例 */
  pet: () => PetCoordinator
  settingsFile: string
  /** 提案授权/查表走服务（授权作用域 = 发起 turn 的会话） */
  files: FileProposalService
  /** turn 关闭时回调宿主注销登记（先于此发终帧，保住"立刻再发"守卫） */
  onClosed: (t: ReplyTurn) => void
}

/**
 * 单条回复 turn：open→closed 两相，取消期间帧照排（既有行为）。
 * 携带 requestId/conversationId/sessionId/sender 与双 parser，
 * 累计 display 文本 / emotion / tool 徽照。
 */
class ReplyTurn {
  /** 已确认的 display 文本（剔 EMO 标记与提案块后） */
  private text = ''
  private emotion: Emotion | null = null
  private tools: ToolBadge[] = []
  /** callId → 工具名（tool.result 不携带名） */
  private toolNames = new Map<string, string>()
  private readonly emotionParser = new EmotionParser()
  private readonly fileParser = new FileProposalParser()
  private closed = false

  constructor(
    readonly requestId: string,
    readonly conversationId: string,
    readonly sessionId: string,
    private readonly sender: ReplySender,
    private readonly model: string,
    private readonly deps: TurnDeps
  ) {}

  handle(ev: TurnEvent): void {
    if (this.closed) return
    switch (ev.type) {
      case 'chunk': this.feed(ev.text); return
      case 'toolCall': this.toolCall(ev); return
      case 'toolResult': this.toolResult(ev); return
      case 'aborted':
      case 'idle': this.finish(); return
      case 'error': this.fail(ev.message); return
      case 'transportDown': this.fail('harness 连接中断，请重试'); return
      case 'messageBoundary': return
    }
  }

  /** 静默终局（prompt 拒绝/会话删除清扫）：只注销登记，不发终帧 */
  drop(): void { this.close({ kind: 'drop' }) }

  private send(msg: Omit<StreamEventMsg, 'requestId'>): void {
    if (!this.sender.isDestroyed()) this.sender.send('chat:stream', { requestId: this.requestId, ...msg })
  }

  private sendFile(f: FileProposalEvent): void {
    if (!this.sender.isDestroyed()) this.sender.send('file:proposal', f)
  }

  private feed(chunk: string): void {
    const { display, emotion } = this.emotionParser.feed(chunk)
    if (emotion) {
      this.emotion = emotion
      this.deps.pet().emotion(emotion)
    }
    if (display) {
      const out = this.fileParser.feed(display)
      if (out.display) {
        this.text += out.display
        this.send({ type: 'delta', delta: out.display })
      }
      if (out.proposal) this.handleProposal(out.proposal)
    }
  }

  private toolCall(ev: { callId: string; name: string; preview?: string }): void {
    this.toolNames.set(ev.callId, ev.name)
    this.tools.push({ name: ev.name, callId: ev.callId })
    this.send({ type: 'tool', tool: { name: ev.name, callId: ev.callId, preview: ev.preview } })
  }

  private toolResult(ev: { callId: string; ok: boolean; preview?: string }): void {
    const badge = this.tools.find(t => t.callId === ev.callId)
    if (badge) badge.ok = ev.ok
    const name = this.toolNames.get(ev.callId) ?? badge?.name ?? 'tool'
    this.send({ type: 'tool', tool: { name, callId: ev.callId, ok: ev.ok, preview: ev.preview } })
  }

  private handleProposal(proposal: ProposalResult): void {
    if (proposal.kind === 'invalid') {
      this.sendFile({ id: '', path: '', resolvedPath: '', diff: [], autoApplied: false, error: '达妮娅的修改提案格式无效，已忽略（可让她重试）' })
      return
    }
    const res = this.deps.files.createProposal(this.conversationId, proposal.path, proposal.content, loadSettings(this.deps.settingsFile).file)
    if (!res.ok) {
      this.sendFile({ id: '', path: proposal.path, resolvedPath: '', diff: [], autoApplied: false, error: res.error })
      return
    }
    this.sendFile(res.event)
    if (res.event.autoApplied) {
      const applied = this.deps.files.applyProposal(res.event.id)
      if (!applied.ok) this.sendFile({ ...res.event, error: '自动应用失败：' + (applied.error ?? '未知错误') })
    }
  }

  /** 正常终态：冲刷 parser（emotionParser.end → fileParser.feed → fileParser.end → 尾 delta）后发 done */
  private finish(): void {
    const eEnd = this.emotionParser.end()
    if (eEnd.emotion) {
      this.emotion = eEnd.emotion
      this.deps.pet().emotion(eEnd.emotion)
    }
    let tail = ''
    if (eEnd.display) {
      const out = this.fileParser.feed(eEnd.display)
      tail += out.display
      if (out.proposal) this.handleProposal(out.proposal)
    }
    tail += this.fileParser.end().display
    if (tail) {
      this.text += tail
      this.send({ type: 'delta', delta: tail })
    }
    this.close({ kind: 'done' })
  }

  private fail(error: string): void {
    this.close({ kind: 'error', error })
  }

  /**
   * 唯一收尾路径：先注销登记（保住"立刻再发"守卫——done/error 帧到达渲染层
   * 触发重发时登记已清），再发终帧；drop 不发任何帧。
   */
  private close(outcome: TurnOutcome): void {
    if (this.closed) return
    this.closed = true
    this.deps.onClosed(this)
    switch (outcome.kind) {
      case 'done': {
        if (this.emotion === null) this.deps.pet().emotion(null)
        this.deps.pet().bubble(false)
        const message: ChatMessage = {
          id: randomUUID(), role: 'assistant', content: this.text,
          tools: this.tools.length ? this.tools.map(t => ({ name: t.name, ok: t.ok })) : undefined,
          model: this.model || undefined,
          createdAt: Date.now()
        }
        this.send({ type: 'done', message })
        return
      }
      case 'error':
        this.send({ type: 'error', error: outcome.error })
        this.deps.pet().bubble(false)
        return
      case 'drop':
        return
    }
  }
}

function dataUrlToImage(u: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(u)
  return m ? { mimeType: m[1], data: m[2] } : null
}

function mapBridgeErrorMessage(msg: string): string {
  const m = msg || '未知错误'
  if (/401|unauthorized|invalid.{0,12}key|api.?key/i.test(m)) return 'API Key 无效，请在设置中检查'
  if (/model.{0,24}(not.?found|不存在)|404/i.test(m)) return '模型不存在，请在设置中检查模型名'
  if (/timeout|超时/i.test(m)) return '请求超时，请重试'
  return m
}

function bridgeErrorText(err: unknown): string {
  if (err instanceof HarnessUnavailableError) return '运行时不可用，请重启应用'
  if (err instanceof BridgeTimeoutError) return 'harness 响应超时，请重试'
  if (err instanceof BridgeTransportError) return 'harness 连接中断，请重试'
  if (err instanceof BridgeProtocolError) return mapBridgeErrorMessage(err.message)
  return '网络错误，请重试'
}

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps
  private readonly activeByRequest = new Map<string, ReplyTurn>()
  private readonly activeBySession = new Map<string, ReplyTurn>()
  /** 本进程内已 create/resume 过的 dsh session；传输死亡后清空（重启需重新 resume） */
  private readonly liveSessions = new Set<string>()
  /** getMessages 缓存：降级版 chat:search 的"已加载消息"数据源 */
  private readonly historyCache = new Map<string, ChatMessage[]>()
  /** 无活动请求时的兜底通知出口（stray error 送达最近一个窗口） */
  private lastSink: ReplySender | null = null
  private readonly turnDeps: TurnDeps

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps
    this.turnDeps = { pet: deps.pet, settingsFile: deps.settingsFile, files: deps.files, onClosed: t => { this.unregister(t) } }
    deps.runtime.setNotificationHandler(n => {
      try { this.dispatch(n) } catch (err) { console.warn('[chat-runtime] bridge 通知处理失败:', err) }
    })
    deps.runtime.setTransportDownHandler(() => { this.handleTransportDown() })
  }

  async startReply(sender: ReplySender, p: StartReplyPayload): Promise<StartReplyResult> {
    this.lastSink = sender
    if (!p.content.trim() && !(p.images && p.images.length > 0) && !(p.files && p.files.length > 0)) return { ok: false, error: '消息内容不能为空' }
    if (!p.conversationId) return { ok: false, error: '会话不存在' }
    if ([...this.activeByRequest.values()].some(t => t.conversationId === p.conversationId)) return { ok: false, error: '该会话正在生成回复中' }
    const settings = loadSettings(this.deps.settingsFile)
    if (!getApiKey(settings)) return { ok: false, error: '请先在设置中填写 API Key' }

    let bridge: DaniyaBridge
    try {
      bridge = await this.deps.runtime.ensure()
    } catch (err) {
      return { ok: false, error: bridgeErrorText(err) }
    }

    const entry = this.deps.registry.getOrCreate(p.conversationId)
    let sessionId = entry.sessionId
    try {
      if (!sessionId) {
        const created = await bridge.sessions.create()
        sessionId = created.sessionId
        this.deps.registry.setSessionId(p.conversationId, sessionId)
        this.liveSessions.add(sessionId)
      } else {
        await this.ensureLiveSession(bridge, sessionId)
      }
    } catch (err) {
      return { ok: false, error: bridgeErrorText(err) }
    }

    // 附件注入逻辑不变：仍把本轮附带文件内容拼进 prompt 文本（只读本会话授权内的附件）
    const turn = { role: 'user', content: p.content }
    this.deps.files.injectTurn(p.conversationId, turn, p.files ?? [])
    const images = (p.images ?? []).map(dataUrlToImage).filter((i): i is { data: string; mimeType: string } => i !== null)

    // 预登记请求位：stream.* 通知按 sessionId 路由，prompt 回执前后的帧都不丢
    const replyTurn = new ReplyTurn(randomUUID(), p.conversationId, sessionId, sender, settings.model, this.turnDeps)
    this.register(replyTurn)
    try {
      await bridge.prompt(sessionId, turn.content, images, { timeoutMs: 15_000 })
    } catch (err) {
      replyTurn.drop()
      return { ok: false, error: bridgeErrorText(err) }
    }

    this.deps.registry.touch(p.conversationId)
    // 首消息自动标题（沿用旧 Store 约定：仍是默认标题时取首条内容 20 字；手动改名后不再覆盖）
    if (entry.titleOverride === undefined) {
      const title = p.content.replace(/\s+/g, ' ').trim().slice(0, 20)
      if (title) this.deps.registry.rename(p.conversationId, title)
    }
    this.deps.pet().bubble(true)
    const userMessage: ChatMessage = {
      id: randomUUID(), role: 'user', content: p.content,
      images: p.images?.map(u => ({ id: randomUUID(), dataUrl: u })),
      files: p.files,
      createdAt: Date.now()
    }
    return { ok: true, requestId: replyTurn.requestId, userMessage }
  }

  stopReply(requestId: string): void {
    const t = this.activeByRequest.get(requestId)
    if (!t) return
    void this.deps.runtime.activeBridge?.cancel(t.sessionId).catch(() => {})
  }

  /** file:register：会话存在性校验（无 id/未知会话拒绝）后委托服务登记附件授权 */
  registerFiles(conversationId: string, paths: string[]): { ok: boolean; files: FileAttachment[]; error?: string } {
    if (!conversationId || !this.deps.registry.get(conversationId)) return { ok: false, files: [], error: '会话不存在' }
    return this.deps.files.register(conversationId, paths)
  }

  /** file:pick：同 registerFiles 的会话校验，通过后由服务弹框+登记 */
  async pickFiles(conversationId: string): Promise<{ files: FileAttachment[]; error?: string }> {
    if (!conversationId || !this.deps.registry.get(conversationId)) return { files: [], error: '会话不存在' }
    return this.deps.files.pick(conversationId)
  }

  async listConversations(): Promise<ConversationMeta[]> {
    const entries = this.deps.registry.list()
    let dshList: SessionSummary[] = []
    const b = this.deps.runtime.activeBridge
    if (b && !b.isDead) {
      try {
        dshList = await b.sessions.list()
      } catch { /* harness 不在线时降级 registry-only */ }
    }
    const bySession = new Map(dshList.map(s => [s.sessionId, s]))
    return entries.map(e => toMeta(e, e.sessionId ? bySession.get(e.sessionId) : undefined))
  }

  createConversation(): ConversationMeta {
    return toMeta(this.deps.registry.create())
  }

  renameConversation(id: string, title: string): void {
    this.deps.registry.rename(id, title)
  }

  async deleteConversation(id: string): Promise<void> {
    for (const t of [...this.activeByRequest.values()]) {
      if (t.conversationId !== id) continue
      t.drop()
      void this.deps.runtime.activeBridge?.cancel(t.sessionId).catch(() => {})
    }
    const entry = this.deps.registry.get(id)
    const b = this.deps.runtime.activeBridge
    if (entry?.sessionId && b && !b.isDead) {
      try { await b.sessions.delete(entry.sessionId) } catch { /* dsh 侧删除失败不阻断本地登记删除 */ }
      this.liveSessions.delete(entry.sessionId)
    }
    this.historyCache.delete(id)
    // 会话生命周期即授权生命周期：回收该会话附件授权与未决提案（file-proposal-service 票）
    this.deps.files.closeConversation(id)
    this.deps.registry.remove(id)
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const entry = this.deps.registry.get(conversationId)
    if (!entry?.sessionId) return []
    try {
      const bridge = await this.deps.runtime.ensure()
      await this.ensureLiveSession(bridge, entry.sessionId)
      const raw = await bridge.sessions.history(entry.sessionId)
      // 'tool' 角色消息是工具结果（不进用户可见气泡），但其 tool-result 块回填徽照搬终态
      const okByCall = new Map<string, boolean>()
      for (const m of raw) {
        if (m.role !== 'tool') continue
        for (const t of m.toolCalls ?? []) if (t.ok !== undefined) okByCall.set(t.callId, t.ok)
      }
      const msgs = raw.filter(m => m.role !== 'tool').map(m => projectMessage(m, okByCall))
      this.historyCache.set(conversationId, msgs)
      return msgs
    } catch (err) {
      console.warn('[chat-runtime] getMessages 读取 harness 历史失败:', err)
      return this.historyCache.get(conversationId) ?? []
    }
  }

  // 降级搜索（不补全文索引）：registry/已知标题 + 本次运行已加载过的消息
  search(q: string): SearchHit[] {
    const needle = (q ?? '').toLowerCase()
    if (!needle) return []
    const hits: SearchHit[] = []
    for (const e of this.deps.registry.list()) {
      const title = e.titleOverride ?? NEW_CONVERSATION_TITLE
      if (title.toLowerCase().includes(needle)) {
        hits.push({ conversationId: e.id, messageId: '', role: 'title', snippet: title })
      }
      for (const m of this.historyCache.get(e.id) ?? []) {
        const i = m.content.toLowerCase().indexOf(needle)
        if (i >= 0) {
          hits.push({ conversationId: e.id, messageId: m.id, role: m.role, snippet: m.content.slice(Math.max(0, i - 20), i + 60) })
        }
      }
    }
    return hits
  }

  /** 通知 → TurnEvent → 按 sessionId 路由给 turn；无归属帧走 stray */
  private dispatch(n: BridgeNotification): void {
    const ev = toTurnEvent(n)
    if (ev === null) return
    const sessionId = n.params.sessionId ?? ''
    const turn = this.activeBySession.get(sessionId)
    if (!turn) { this.handleStray(ev); return }
    turn.handle(ev)
  }

  /** 无归属帧的兜底：终态/边界帧复位 pet 气泡；error 发最近窗口（lastSink） */
  private handleStray(ev: TurnEvent): void {
    switch (ev.type) {
      case 'error':
        if (this.lastSink && !this.lastSink.isDestroyed()) {
          this.lastSink.send('chat:stream', { requestId: '', type: 'error', error: ev.message })
        }
        return
      case 'messageBoundary':
      case 'aborted':
      case 'idle':
        this.deps.pet().bubble(false)
        return
      default:
        return
    }
  }

  private handleTransportDown(): void {
    this.liveSessions.clear()
    for (const t of [...this.activeByRequest.values()]) t.handle({ type: 'transportDown' })
    this.deps.pet().bubble(false)
    this.deps.pet().emotion(null)
  }

  private register(t: ReplyTurn): void {
    this.activeByRequest.set(t.requestId, t)
    this.activeBySession.set(t.sessionId, t)
  }

  private unregister(t: ReplyTurn): void {
    this.activeByRequest.delete(t.requestId)
    if (this.activeBySession.get(t.sessionId) === t) this.activeBySession.delete(t.sessionId)
  }

  /** sessionId 保证在本运行时内已 attach（create 或 resume 一次） */
  private async ensureLiveSession(bridge: DaniyaBridge, sessionId: string): Promise<void> {
    if (this.liveSessions.has(sessionId)) return
    await bridge.sessions.resume(sessionId)
    this.liveSessions.add(sessionId)
  }
}

const toMeta = (e: { id: string; sessionId?: string; titleOverride?: string; createdAt: number; updatedAt: number }, dsh?: SessionSummary): ConversationMeta => ({
  id: e.id,
  // bridge 契约保证 dsh title 恒 ''（server.ts sessionList），标题只有 titleOverride 一个真源
  title: e.titleOverride || NEW_CONVERSATION_TITLE,
  createdAt: e.createdAt,
  updatedAt: dsh?.updatedAt ?? e.updatedAt
})

/** BridgeMessage → ChatMessage 投影：assistant 原文重跑 parser 还原 display（EMO 标记/提案块不入气泡）；okByCall 回填徽照搬终态 */
function projectMessage(m: BridgeMessage, okByCall: Map<string, boolean>): ChatMessage {
  const role = m.role === 'assistant' ? 'assistant' : 'user'
  let content = m.content
  if (role === 'user' && content) content = stripFileContext(content)
  if (role === 'assistant' && content) {
    const ep = new EmotionParser()
    const fp = new FileProposalParser()
    const f1 = ep.feed(content)
    const d1 = fp.feed(f1.display)
    const f2 = ep.end()
    const d2 = f2.display ? fp.feed(f2.display) : { display: '' }
    const d3 = fp.end()
    content = d1.display + d2.display + d3.display
  }
  const images = m.images !== undefined
    ? m.images.filter((i): i is typeof i & { dataUrl: string } => i.dataUrl !== undefined).map(i => ({ id: i.id, dataUrl: i.dataUrl }))
    : undefined
  const tools = m.toolCalls !== undefined
    ? m.toolCalls.map(t => ({ name: t.name, ok: t.ok ?? okByCall.get(t.callId) }))
    : undefined
  return {
    id: m.id,
    role, content, images,
    files: m.files !== undefined ? m.files.map(f => ({ name: f.name, path: '' })) : undefined,
    tools,
    model: m.model,
    createdAt: m.createdAt
  }
}
