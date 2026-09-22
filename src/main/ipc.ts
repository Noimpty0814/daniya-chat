import { ipcMain, BrowserWindow, shell, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AppSettingsView, ChatMessage, ConversationMeta, FileProposalEvent, SearchHit, StreamEventMsg, StartReplyPayload, StartReplyResult, ToolBadge } from '../shared/types'
import { loadSettings, saveSettings, toView, setApiKey, getApiKey, applyView, type AppSettings } from './settings'
import { capturePrimaryScreen } from './screenshot'
import { registerFiles, pickFiles, injectFilesIntoLastTurn, stripFileContext } from './files/attach'
import { createProposal, applyProposal, rejectProposal } from './files/apply'
import { FileProposalParser, type ProposalResult } from './files/proposal'
import { EmotionParser, type Emotion } from './harness/emotion'
import { ConversationRegistry, NEW_CONVERSATION_TITLE } from './harness/conversations'
import { HarnessUnavailableError } from './harness/process'
import { Bridge, BridgeProtocolError, BridgeTimeoutError, BridgeTransportError, type BridgeMessage, type Json, type SessionSummary } from './harness/bridge'
import type { PetCoordinator } from './pet/coordinator'

/**
 * IPC 面（spec §5.3 映射）：通道名与载荷语义对渲染层保持不变，
 * 后端由旧 deepseek/search/storage 三件套换成 harness bridge：
 * - chat:startReply → ensure + session.create/resume + prompt（附件注入逻辑不变）
 * - chat:stopReply → cancel；stream.chunk → EmotionParser/FileProposalParser → delta/proposal（情绪只驱动 pet，不进 chat:stream）
 * - tool.call/tool.result → chat:stream{tool} 徽照搬；error → 中文映射
 * - 会话 CRUD → registry ⨝ bridge session.*；历史由 harness 持有（无本地落库、无 MAX_CONTEXT）
 * - pet:error 不经本文件：由 index.ts 的 pet 装配处推送（onError → webContents.send）
 */

/** ipc 层对运行时的最小依赖面（HarnessRuntime 结构满足；测试可注入 fake） */
export interface HarnessLike {
  ensure(): Promise<Bridge>
  readonly activeBridge: Bridge | null
  readonly isAlive: boolean
  setNotificationHandler(fn: ((method: string, params: Json) => void) | null): void
  setTransportDownHandler(fn: (() => void) | null): void
}

export interface RegisterIpcOpts {
  registry: ConversationRegistry
  runtime: HarnessLike
  settingsFile: string
  pet: () => PetCoordinator
  onSettingsChanged?: (s: AppSettings) => void
}

interface ActiveRequest {
  requestId: string
  conversationId: string
  sessionId: string
  sender: WebContents
  emotionParser: EmotionParser
  fileParser: FileProposalParser
  /** 已确认的 display 文本（剔 EMO 标记与提案块后） */
  text: string
  emotion: Emotion | null
  tools: ToolBadge[]
  /** callId → 工具名（tool.result 不携带名） */
  toolNames: Map<string, string>
  model: string
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

function dataUrlToImage(u: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(u)
  return m ? { mimeType: m[1], data: m[2] } : null
}

function mapBridgeErrorMessage(msg: unknown): string {
  const m = str(msg) || '未知错误'
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

export function registerIpc(opts: RegisterIpcOpts): void {
  const { registry, runtime, settingsFile, pet } = opts
  const activeByRequest = new Map<string, ActiveRequest>()
  const activeBySession = new Map<string, ActiveRequest>()
  /** 本进程内已 create/resume 过的 dsh session；传输死亡后清空（重启需重新 resume） */
  const liveSessions = new Set<string>()
  /** getMessages 缓存：降级版 chat:search 的"已加载消息"数据源 */
  const historyCache = new Map<string, ChatMessage[]>()
  /** 无活动请求时的兜底通知出口（stray error 送达最近一个窗口） */
  let lastSender: WebContents | null = null

  const send = (r: ActiveRequest, msg: Omit<StreamEventMsg, 'requestId'>): void => {
    if (!r.sender.isDestroyed()) r.sender.send('chat:stream', { requestId: r.requestId, ...msg })
  }
  const sendFile = (r: ActiveRequest, f: FileProposalEvent): void => {
    if (!r.sender.isDestroyed()) r.sender.send('file:proposal', f)
  }

  const findBySession = (sessionId: string): ActiveRequest | undefined => activeBySession.get(sessionId)

  const dropRequest = (r: ActiveRequest): void => {
    activeByRequest.delete(r.requestId)
    if (activeBySession.get(r.sessionId) === r) activeBySession.delete(r.sessionId)
  }

  const handleProposal = (r: ActiveRequest, proposal: ProposalResult): void => {
    if (proposal.kind === 'invalid') {
      sendFile(r, { id: '', path: '', resolvedPath: '', diff: [], autoApplied: false, error: '达妮娅的修改提案格式无效，已忽略（可让她重试）' })
      return
    }
    const res = createProposal(proposal.path, proposal.content, loadSettings(settingsFile).file)
    if (!res.ok) {
      sendFile(r, { id: '', path: proposal.path, resolvedPath: '', diff: [], autoApplied: false, error: res.error })
      return
    }
    sendFile(r, res.event)
    if (res.event.autoApplied) {
      const applied = applyProposal(res.event.id)
      if (!applied.ok) sendFile(r, { ...res.event, error: '自动应用失败：' + (applied.error ?? '未知错误') })
    }
  }

  /** stream.end / agent.status idle 兜底共用的收尾：冲刷 parser、发 done、清理 */
  const finishRequest = (r: ActiveRequest): void => {
    const eEnd = r.emotionParser.end()
    if (eEnd.emotion) {
      r.emotion = eEnd.emotion
      pet().emotion(eEnd.emotion)
    }
    let tail = ''
    if (eEnd.display) {
      const out = r.fileParser.feed(eEnd.display)
      tail += out.display
      if (out.proposal) handleProposal(r, out.proposal)
    }
    tail += r.fileParser.end().display
    if (tail) {
      r.text += tail
      send(r, { type: 'delta', delta: tail })
    }
    dropRequest(r)
    if (r.emotion === null) pet().emotion(null)
    pet().bubble(false)
    const message: ChatMessage = {
      id: randomUUID(), role: 'assistant', content: r.text,
      tools: r.tools.length ? r.tools.map(t => ({ name: t.name, ok: t.ok })) : undefined,
      model: r.model || undefined,
      createdAt: Date.now()
    }
    send(r, { type: 'done', message })
  }

  const failRequest = (r: ActiveRequest, error: string): void => {
    send(r, { type: 'error', error })
    dropRequest(r)
    pet().bubble(false)
  }

  const handleNotification = (method: string, params: Json): void => {
    const sessionId = str(params.sessionId)
    switch (method) {
      case 'stream.chunk': {
        const r = findBySession(sessionId)
        if (!r) return
        const { display, emotion } = r.emotionParser.feed(str(params.text))
        if (emotion) {
          r.emotion = emotion
          pet().emotion(emotion)
        }
        if (display) {
          const out = r.fileParser.feed(display)
          if (out.display) {
            r.text += out.display
            send(r, { type: 'delta', delta: out.display })
          }
          if (out.proposal) handleProposal(r, out.proposal)
        }
        return
      }
      case 'stream.end': {
        const r = findBySession(sessionId)
        if (!r) { pet().bubble(false); return }
        // stream.end 是"一条已提交 assistant 消息"的边界，不是请求终态：
        // 一个 turn 可能是 中间消息(带 toolCalls) → tool.* → 最终消息 多帧序列，
        // 首个 stream.end 就收尾会把后续 tool/流帧全部丢掉（B-6）。
        // 正常终态由 agent.status→idle 落地；aborted 终帧是 turn 级取消信号，可直接收尾。
        if (params.aborted === true) finishRequest(r)
        return
      }
      case 'tool.call': {
        const r = findBySession(sessionId)
        if (!r) return
        const callId = str(params.callId)
        const name = str(params.tool) || 'tool'
        r.toolNames.set(callId, name)
        r.tools.push({ name, callId })
        send(r, { type: 'tool', tool: { name, callId, preview: str(params.argsPreview) || undefined } })
        return
      }
      case 'tool.result': {
        const r = findBySession(sessionId)
        if (!r) return
        const callId = str(params.callId)
        const ok = params.ok === true
        const badge = r.tools.find(t => t.callId === callId)
        if (badge) badge.ok = ok
        const name = r.toolNames.get(callId) ?? badge?.name ?? 'tool'
        send(r, { type: 'tool', tool: { name, callId, ok, preview: str(params.preview) || undefined } })
        return
      }
      case 'error': {
        const text = mapBridgeErrorMessage(params.message)
        const r = findBySession(sessionId)
        if (r) { failRequest(r, text); return }
        if (lastSender && !lastSender.isDestroyed()) {
          lastSender.send('chat:stream', { requestId: '', type: 'error', error: text })
        }
        return
      }
      case 'agent.status': {
        if (params.status !== 'idle') return
        // 流终态兜底：正常 stream.end 先行时此处只剩 pet.bubble 复位
        const r = findBySession(sessionId)
        if (r) finishRequest(r)
        else pet().bubble(false)
        return
      }
      default:
        return
    }
  }

  runtime.setNotificationHandler((method, params) => {
    try { handleNotification(method, params) } catch (err) { console.warn('[ipc] bridge 通知处理失败:', err) }
  })
  runtime.setTransportDownHandler(() => {
    liveSessions.clear()
    for (const r of [...activeByRequest.values()]) failRequest(r, 'harness 连接中断，请重试')
    pet().bubble(false)
    pet().emotion(null)
  })

  /** sessionId 保证在本运行时内已 attach（create 或 resume 一次） */
  const ensureLiveSession = async (bridge: Bridge, sessionId: string): Promise<void> => {
    if (liveSessions.has(sessionId)) return
    await bridge.request('session.resume', { sessionId })
    liveSessions.add(sessionId)
  }

  const toMeta = (e: { id: string; sessionId?: string; titleOverride?: string; createdAt: number; updatedAt: number }, dsh?: SessionSummary): ConversationMeta => ({
    id: e.id,
    // bridge 契约保证 dsh title 恒 ''（server.ts sessionList），标题只有 titleOverride 一个真源
    title: e.titleOverride || NEW_CONVERSATION_TITLE,
    createdAt: e.createdAt,
    updatedAt: typeof dsh?.updatedAt === 'number' ? dsh.updatedAt : e.updatedAt
  })

  ipcMain.handle('chat:listConversations', async (): Promise<ConversationMeta[]> => {
    const entries = registry.list()
    let dshList: SessionSummary[] = []
    const b = runtime.activeBridge
    if (b && !b.isDead) {
      try {
        const r = await b.request<SessionSummary[] | { sessions?: SessionSummary[] }>('session.list', {})
        dshList = Array.isArray(r) ? r : (r.sessions ?? [])
      } catch { /* harness 不在线时降级 registry-only */ }
    }
    const bySession = new Map(dshList.map(s => [s.sessionId, s]))
    return entries.map(e => toMeta(e, e.sessionId ? bySession.get(e.sessionId) : undefined))
  })

  ipcMain.handle('chat:createConversation', (): ConversationMeta => toMeta(registry.create()))

  ipcMain.handle('chat:renameConversation', (_e, p: { id: string; title: string }) => { registry.rename(p.id, p.title) })

  ipcMain.handle('chat:deleteConversation', async (_e, p: { id: string }) => {
    for (const r of [...activeByRequest.values()]) {
      if (r.conversationId !== p.id) continue
      dropRequest(r)
      void runtime.activeBridge?.request('cancel', { sessionId: r.sessionId }).catch(() => {})
    }
    const entry = registry.get(p.id)
    const b = runtime.activeBridge
    if (entry?.sessionId && b && !b.isDead) {
      try { await b.request('session.delete', { sessionId: entry.sessionId }) } catch { /* dsh 侧删除失败不阻断本地登记删除 */ }
      liveSessions.delete(entry.sessionId)
    }
    historyCache.delete(p.id)
    registry.remove(p.id)
  })

  ipcMain.handle('chat:getMessages', async (_e, p: { id: string }): Promise<ChatMessage[]> => {
    const entry = registry.get(p.id)
    if (!entry?.sessionId) return []
    try {
      const bridge = await runtime.ensure()
      await ensureLiveSession(bridge, entry.sessionId)
      const r = await bridge.request<{ messages?: BridgeMessage[] }>('session.history', { sessionId: entry.sessionId })
      const raw = r.messages ?? []
      // 'tool' 角色消息是工具结果（不进用户可见气泡），但其 tool-result 块回填徽照搬终态
      const okByCall = new Map<string, boolean>()
      for (const m of raw) {
        if (m.role !== 'tool') continue
        for (const t of m.toolCalls ?? []) if (t.ok !== undefined) okByCall.set(t.callId, t.ok)
      }
      const msgs = raw.filter(m => m.role !== 'tool').map(m => projectMessage(m, okByCall))
      historyCache.set(p.id, msgs)
      return msgs
    } catch (err) {
      console.warn('[ipc] getMessages 读取 harness 历史失败:', err)
      return historyCache.get(p.id) ?? []
    }
  })

  // 降级搜索（spec §13 不补全文索引）：registry/已知标题 + 本次运行已加载过的消息
  ipcMain.handle('chat:search', (_e, p: { q: string }): SearchHit[] => {
    const q = (p.q ?? '').toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    for (const e of registry.list()) {
      const title = e.titleOverride ?? NEW_CONVERSATION_TITLE
      if (title.toLowerCase().includes(q)) {
        hits.push({ conversationId: e.id, messageId: '', role: 'title', snippet: title })
      }
      for (const m of historyCache.get(e.id) ?? []) {
        const i = m.content.toLowerCase().indexOf(q)
        if (i >= 0) {
          hits.push({ conversationId: e.id, messageId: m.id, role: m.role, snippet: m.content.slice(Math.max(0, i - 20), i + 60) })
        }
      }
    }
    return hits
  })

  ipcMain.handle('chat:startReply', async (e: IpcMainInvokeEvent, p: StartReplyPayload): Promise<StartReplyResult> => {
    lastSender = e.sender
    if (!p.content.trim() && !(p.images && p.images.length > 0) && !(p.files && p.files.length > 0)) return { ok: false, error: '消息内容不能为空' }
    if (!p.conversationId) return { ok: false, error: '会话不存在' }
    if ([...activeByRequest.values()].some(r => r.conversationId === p.conversationId)) return { ok: false, error: '该会话正在生成回复中' }
    const settings = loadSettings(settingsFile)
    if (!getApiKey(settings)) return { ok: false, error: '请先在设置中填写 API Key' }

    let bridge: Bridge
    try {
      bridge = await runtime.ensure()
    } catch (err) {
      return { ok: false, error: bridgeErrorText(err) }
    }

    const entry = registry.getOrCreate(p.conversationId)
    let sessionId = entry.sessionId
    try {
      if (!sessionId) {
        const created = await bridge.request<{ sessionId: string }>('session.create', {})
        sessionId = created.sessionId
        registry.setSessionId(p.conversationId, sessionId)
        liveSessions.add(sessionId)
      } else {
        await ensureLiveSession(bridge, sessionId)
      }
    } catch (err) {
      return { ok: false, error: bridgeErrorText(err) }
    }

    // 附件注入逻辑不变：仍把本轮附带文件内容拼进 prompt 文本（模型无需读附件路径）
    const turn = { role: 'user', content: p.content }
    injectFilesIntoLastTurn([turn], p.files ?? [])
    const images = (p.images ?? []).map(dataUrlToImage).filter((i): i is { data: string; mimeType: string } => i !== null)

    // 预登记请求位：stream.* 通知按 sessionId 路由，prompt 回执前后的帧都不丢
    const req: ActiveRequest = {
      requestId: randomUUID(), conversationId: p.conversationId, sessionId, sender: e.sender,
      emotionParser: new EmotionParser(), fileParser: new FileProposalParser(),
      text: '', emotion: null, tools: [], toolNames: new Map(), model: settings.model
    }
    activeByRequest.set(req.requestId, req)
    activeBySession.set(sessionId, req)
    try {
      await bridge.request<{ messageId: string }>('prompt', {
        sessionId, text: turn.content, ...(images.length ? { images } : {})
      }, { timeoutMs: 15_000 })
    } catch (err) {
      dropRequest(req)
      return { ok: false, error: bridgeErrorText(err) }
    }

    registry.touch(p.conversationId)
    // 首消息自动标题（沿用旧 Store 约定：仍是默认标题时取首条内容 20 字；手动改名后不再覆盖）
    if (entry.titleOverride === undefined) {
      const title = p.content.replace(/\s+/g, ' ').trim().slice(0, 20)
      if (title) registry.rename(p.conversationId, title)
    }
    pet().bubble(true)
    const userMessage: ChatMessage = {
      id: randomUUID(), role: 'user', content: p.content,
      images: p.images?.map(u => ({ id: randomUUID(), dataUrl: u })),
      files: p.files,
      createdAt: Date.now()
    }
    return { ok: true, requestId: req.requestId, userMessage }
  })

  ipcMain.handle('chat:stopReply', (_e, p: { requestId: string }) => {
    const r = activeByRequest.get(p.requestId)
    if (!r) return
    void runtime.activeBridge?.request('cancel', { sessionId: r.sessionId }).catch(() => {})
  })

  ipcMain.handle('settings:get', () => toView(loadSettings(settingsFile)))
  ipcMain.handle('settings:save', (_e, v: AppSettingsView) => {
    const next = applyView(loadSettings(settingsFile), v)
    saveSettings(settingsFile, next)
    opts.onSettingsChanged?.(next)
  })
  ipcMain.handle('settings:setApiKey', (_e, p: { key: string }) => { setApiKey(settingsFile, p.key ?? '') })
  ipcMain.handle('settings:testConnection', async () => {
    const s = loadSettings(settingsFile)
    const apiKey = getApiKey(s)
    if (!apiKey) return { ok: false, message: '请先填写 API Key' }
    try {
      const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      return res.ok
        ? { ok: true, message: '连接成功，API Key 有效' }
        : { ok: false, message: `连接失败 (HTTP ${res.status})，请检查 Key 与 Base URL` }
    } catch {
      return { ok: false, message: '网络错误，无法连接到 Base URL' }
    }
  })
  ipcMain.handle('screen:capture', async (): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => {
    try { return { ok: true, dataUrl: await capturePrimaryScreen() } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : '截屏失败' } }
  })
  ipcMain.handle('shell:openExternal', (_e, p: { url: string }) => { if (/^https?:\/\//.test(p.url)) return shell.openExternal(p.url) })
  ipcMain.handle('window:hide', (e) => { BrowserWindow.fromWebContents(e.sender)?.hide() })
  ipcMain.handle('pet:status', () => pet().status())

  ipcMain.handle('file:pick', () => pickFiles())
  ipcMain.handle('file:register', (_e, p: { paths?: unknown[] }) => registerFiles((p.paths ?? []).filter((x): x is string => typeof x === 'string')))
  ipcMain.handle('file:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0]
  })
  ipcMain.handle('file:apply', (_e, p: { id: string }) => applyProposal(p.id))
  ipcMain.handle('file:reject', (_e, p: { id: string }) => { rejectProposal(p.id) })
}

/** BridgeMessage → ChatMessage 投影：assistant 原文重跑 parser 还原 display（EMO 标记/提案块不入气泡）；okByCall 回填徽照搬终态 */
function projectMessage(m: BridgeMessage, okByCall: Map<string, boolean>): ChatMessage {
  const role = m.role === 'assistant' ? 'assistant' : 'user'
  let content = typeof m.content === 'string' ? m.content : ''
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
  const images = Array.isArray(m.images)
    ? m.images.filter(i => typeof i.dataUrl === 'string').map(i => ({ id: i.id ?? randomUUID(), dataUrl: i.dataUrl! }))
    : undefined
  const tools = Array.isArray(m.toolCalls)
    ? m.toolCalls.map(t => ({ name: t.name, ok: t.ok ?? okByCall.get(t.callId) }))
    : undefined
  return {
    id: typeof m.id === 'string' && m.id ? m.id : randomUUID(),
    role, content, images,
    files: Array.isArray(m.files) ? m.files.map(f => ({ name: f.name, path: '' })) : undefined,
    tools,
    model: typeof m.model === 'string' ? m.model : undefined,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now()
  }
}
