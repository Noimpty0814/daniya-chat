/**
 * ChatRuntime 进程内测试（chat-runtime 票）。
 *
 * HarnessLike 桩 + scripted DaniyaBridge + 记录型 ReplySender：
 * 通知经 FakeRuntime.emit 同步派发，无子进程、无 waitEvent 轮询——
 * turn 语义（B-6 终态、预登记、stray 兜底、transportDown 清扫）在这里钉死。
 * files/service 传递依赖 electron（dialog/safeStorage），故仍需 electron mock。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatRuntime, type HarnessLike, type ReplySender } from './chat-runtime'
import { FileProposalService } from './files/service'
import { ConversationRegistry } from './harness/conversations'
import { HarnessUnavailableError } from './harness/process'
import { BridgeProtocolError } from './harness/bridge'
import { setApiKey, loadSettings, saveSettings } from './settings'
import type { DaniyaBridge, BridgeNotification, BridgeMessage, SessionSummary } from './harness/client'
import type { FileProposalEvent, StreamEventMsg } from '../shared/types'
import type { PetCoordinator } from './pet/coordinator'
import type { Emotion } from './harness/emotion'

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  safeStorage: {
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

// ── scripted DaniyaBridge：只实现 ChatRuntime 触达的门面面 ──
function makeBridge() {
  let seq = 0
  return {
    isDead: false,
    prompt: vi.fn(async (_sessionId: string, _text: string) => ({ messageId: `msg-${++seq}` })),
    cancel: vi.fn(async (_sessionId: string) => ({ ok: true as const })),
    sessions: {
      create: vi.fn(async () => ({ sessionId: `sess-${++seq}` })),
      resume: vi.fn(async (_sessionId: string) => ({ ok: true as const })),
      list: vi.fn(async (): Promise<SessionSummary[]> => []),
      history: vi.fn(async (_sessionId: string): Promise<BridgeMessage[]> => []),
      delete: vi.fn(async (_sessionId: string) => ({ ok: true as const }))
    }
  }
}
type ScriptedBridge = ReturnType<typeof makeBridge>

// ── HarnessLike 桩：捕获通知/断线处理器，emit/transportDown 同步驱动 ──
class FakeRuntime implements HarnessLike {
  isAlive = true
  activeBridge: DaniyaBridge | null = null
  ensure = vi.fn(async (): Promise<DaniyaBridge> => {
    if (!this.activeBridge) throw new HarnessUnavailableError()
    return this.activeBridge
  })
  private notifier: ((n: BridgeNotification) => void) | null = null
  private downHandler: (() => void) | null = null
  setNotificationHandler(fn: ((n: BridgeNotification) => void) | null): void { this.notifier = fn }
  setTransportDownHandler(fn: (() => void) | null): void { this.downHandler = fn }
  emit(n: BridgeNotification): void { this.notifier?.(n) }
  transportDown(): void { this.downHandler?.() }
}

// ── 记录型 ReplySender ──
function makeSender(opts?: { destroyed?: boolean }) {
  const sent: { channel: string; data: unknown }[] = []
  const sender: ReplySender = {
    send: (channel: string, data: unknown) => { sent.push({ channel, data }) },
    isDestroyed: () => opts?.destroyed === true
  }
  const stream = () => sent.filter(s => s.channel === 'chat:stream').map(s => s.data as StreamEventMsg)
  const files = () => sent.filter(s => s.channel === 'file:proposal').map(s => s.data as FileProposalEvent)
  return { sender, sent, stream, files }
}

function makePet(): PetCoordinator & { bubble: ReturnType<typeof vi.fn>; emotion: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(), stop: vi.fn(), onPetClick: vi.fn(),
    bubble: vi.fn((_on: boolean) => {}), emotion: vi.fn((_e: Emotion | null) => {}),
    status: () => ({ helperRunning: false, connected: false, petWindowFound: false })
  }
}

let dir: string
let settingsFile: string
let registry: ConversationRegistry
let pet: ReturnType<typeof makePet>
let runtime: FakeRuntime
let bridge: ScriptedBridge
let files: FileProposalService
let chat: ChatRuntime

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-chatrt-'))
  settingsFile = path.join(dir, 'settings.json')
  setApiKey(settingsFile, 'sk-test')
  registry = new ConversationRegistry(path.join(dir, 'conversations.json'))
  pet = makePet()
  runtime = new FakeRuntime()
  bridge = makeBridge()
  runtime.activeBridge = bridge as unknown as DaniyaBridge
  files = new FileProposalService()
  chat = new ChatRuntime({ runtime, registry, settingsFile, pet: () => pet, files })
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// ── 通知发射器（等价真实桥的入队帧，同步派发） ──
const emit = {
  running: (s: string) => runtime.emit({ method: 'agent.status', params: { sessionId: s, status: 'running' } }),
  idle: (s: string) => runtime.emit({ method: 'agent.status', params: { sessionId: s, status: 'idle' } }),
  chunk: (s: string, text: string) => runtime.emit({ method: 'stream.chunk', params: { sessionId: s, turn: 1, text } }),
  end: (s: string, aborted?: boolean) => runtime.emit({ method: 'stream.end', params: { sessionId: s, turn: 1, aborted } }),
  toolCall: (s: string, callId: string, tool: string, argsPreview = '') =>
    runtime.emit({ method: 'tool.call', params: { sessionId: s, callId, tool, argsPreview } }),
  toolResult: (s: string, callId: string, ok: boolean, preview = '') =>
    runtime.emit({ method: 'tool.result', params: { sessionId: s, callId, ok, preview } }),
  error: (message: string, sessionId?: string) =>
    runtime.emit({ method: 'error', params: sessionId === undefined ? { message } : { sessionId, message } })
}

/** 建会话 + startReply + 取出回填的 sessionId；返回发送端记录面 */
async function startConv(content = '你好') {
  const conv = chat.createConversation()
  const s = makeSender()
  const r = await chat.startReply(s.sender, { conversationId: conv.id, content })
  const sessionId = registry.get(conv.id)!.sessionId!
  return { conv, ...s, r, sessionId }
}

const deltas = (stream: () => StreamEventMsg[]) => stream().filter(e => e.type === 'delta').map(e => e.delta).join('')
const dones = (stream: () => StreamEventMsg[]) => stream().filter(e => e.type === 'done')
const errors = (stream: () => StreamEventMsg[]) => stream().filter(e => e.type === 'error')

describe('turn 终态（B-6）', () => {
  it('多帧序列：中间 stream.end 不收尾，tool 事件续流，idle 落定一次 done', async () => {
    const { conv, sender, stream, r, sessionId } = await startConv('查一下')
    expect(r.ok).toBe(true)

    emit.running(sessionId)
    emit.chunk(sessionId, '{EMO:happy}我先查一下。')
    emit.end(sessionId) // 非 aborted → messageBoundary，非终态
    expect(dones(stream)).toHaveLength(0)
    emit.toolCall(sessionId, 'call-1', 'web_search', '{"q":"x"}')
    emit.toolResult(sessionId, 'call-1', true, 'hit-1')
    emit.chunk(sessionId, '查完了：结果是 X。')
    emit.end(sessionId, false)
    emit.idle(sessionId)

    expect(deltas(stream)).toBe('我先查一下。查完了：结果是 X。')
    const tools = stream().filter(e => e.type === 'tool').map(e => e.tool)
    expect(tools[0]).toMatchObject({ name: 'web_search', callId: 'call-1', preview: '{"q":"x"}' })
    expect(tools[1]).toMatchObject({ name: 'web_search', callId: 'call-1', ok: true, preview: 'hit-1' })
    expect(dones(stream)).toHaveLength(1)
    expect(dones(stream)[0].message?.content).toBe('我先查一下。查完了：结果是 X。')
    expect(dones(stream)[0].message?.tools).toEqual([{ name: 'web_search', ok: true }])
    expect(stream().every(e => e.requestId === r.requestId)).toBe(true)
    expect(pet.emotion).toHaveBeenCalledWith('happy')
    expect(pet.bubble).toHaveBeenCalledWith(true)
    expect(pet.bubble).toHaveBeenCalledWith(false)

    // drop-before-done：done 落地后同会话可立刻再发
    const again = await chat.startReply(sender, { conversationId: conv.id, content: '再来一句' })
    expect(again.ok).toBe(true)
  })

  it('stream.end{aborted:true} 是终态：残文进 done，其后 idle 不重复收尾', async () => {
    const { stream, sessionId } = await startConv('慢慢说')
    emit.chunk(sessionId, '你好，')
    emit.chunk(sessionId, '世界')
    emit.end(sessionId, true)
    expect(dones(stream)).toHaveLength(1)
    expect(dones(stream)[0].message?.content).toBe('你好，世界')

    emit.idle(sessionId) // turn 已注销 → stray：pet 复位，无第二帧 done
    expect(dones(stream)).toHaveLength(1)
    expect(pet.bubble).toHaveBeenCalledWith(false)
  })

  it('无归属 error 走 lastSink；有归属 error 按 session 路由并终结该 turn', async () => {
    const { stream, r, sessionId } = await startConv('boom')
    emit.error('HTTP 401: invalid api key') // 无 sessionId → 桥级错误兜底
    const strayErr = errors(stream).find(e => e.requestId === '')
    expect(strayErr?.error).toBe('API Key 无效，请在设置中检查')

    emit.error('request timeout', sessionId) // 有归属 → turn 失败
    const routed = errors(stream).find(e => e.requestId === r.requestId)
    expect(routed?.error).toBe('请求超时，请重试')
    expect(dones(stream)).toHaveLength(0)
    emit.idle(sessionId) // stray idle：不产生 done
    expect(dones(stream)).toHaveLength(0)
  })

  it('destroyed sender：帧静默丢弃不炸，turn 正常收尾注销', async () => {
    const conv = chat.createConversation()
    const s = makeSender({ destroyed: true })
    const r = await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' })
    expect(r.ok).toBe(true)
    const sessionId = registry.get(conv.id)!.sessionId!
    emit.chunk(sessionId, 'hi')
    emit.end(sessionId)
    emit.idle(sessionId)
    expect(s.sent).toHaveLength(0)
    // turn 已注销 → 同会话立刻再发不受 busy 拦截
    const s2 = makeSender()
    const again = await chat.startReply(s2.sender, { conversationId: conv.id, content: 'y' })
    expect(again.ok).toBe(true)
  })

  it('transportDown：全部活动 turn 收连接中断错误帧；liveSessions 清空后重新 resume', async () => {
    const c1 = chat.createConversation()
    registry.setSessionId(c1.id, 'sess-1')
    const c2 = chat.createConversation()
    registry.setSessionId(c2.id, 'sess-2')
    const s1 = makeSender()
    const s2 = makeSender()
    await chat.startReply(s1.sender, { conversationId: c1.id, content: 'a' })
    await chat.startReply(s2.sender, { conversationId: c2.id, content: 'b' })
    expect(bridge.sessions.resume).toHaveBeenCalledTimes(2)

    runtime.transportDown()
    for (const s of [s1, s2]) {
      expect(errors(s.stream)).toHaveLength(1)
      expect(errors(s.stream)[0].error).toBe('harness 连接中断，请重试')
      expect(dones(s.stream)).toHaveLength(0)
    }
    expect(pet.emotion).toHaveBeenCalledWith(null)
    expect(pet.bubble).toHaveBeenCalledWith(false)

    // liveSessions 已清：同会话再发触发重新 resume（重 resume 语义）
    const r = await chat.startReply(s1.sender, { conversationId: c1.id, content: 'c' })
    expect(r.ok).toBe(true)
    expect(bridge.sessions.resume).toHaveBeenCalledTimes(3)
    expect(bridge.sessions.resume).toHaveBeenLastCalledWith('sess-1')
  })

  it('busy 守卫：同会话并发拒绝，异会话放行', async () => {
    const c1 = chat.createConversation()
    const c2 = chat.createConversation()
    const s1 = makeSender()
    const s2 = makeSender()
    const r1 = await chat.startReply(s1.sender, { conversationId: c1.id, content: 'a' })
    expect(r1.ok).toBe(true)
    const r2 = await chat.startReply(s1.sender, { conversationId: c1.id, content: 'b' })
    expect(r2).toMatchObject({ ok: false, error: '该会话正在生成回复中' })
    const r3 = await chat.startReply(s2.sender, { conversationId: c2.id, content: 'b' })
    expect(r3.ok).toBe(true)
  })

  it('prompt 拒绝：turn 静默注销返回映射错误，可立刻重发', async () => {
    const conv = chat.createConversation()
    const s = makeSender()
    bridge.prompt.mockRejectedValueOnce(new BridgeProtocolError('HTTP 401: invalid api key'))
    const r1 = await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' })
    expect(r1.ok).toBe(false)
    expect(r1.error).toBe('API Key 无效，请在设置中检查')
    expect(s.sent).toHaveLength(0) // drop 终局：无终帧
    // turn 已注销：同会话重发不被 busy 拦截；session 已建直接复用
    const r2 = await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' })
    expect(r2.ok).toBe(true)
    expect(bridge.prompt).toHaveBeenCalledTimes(2)
  })

  it('预登记不变式：prompt 回执前到达的 chunk 不丢（看门测试）', async () => {
    const conv = chat.createConversation()
    const s = makeSender()
    bridge.prompt.mockImplementationOnce(async (sessionId: string) => {
      emit.chunk(sessionId, '早帧') // 回执到达前的流帧
      return { messageId: 'm-early' }
    })
    const r = await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' })
    expect(r.ok).toBe(true)
    expect(deltas(s.stream)).toBe('早帧')

    const sessionId = registry.get(conv.id)!.sessionId!
    emit.idle(sessionId)
    expect(dones(s.stream)[0].message?.content).toBe('早帧')
  })

  it('删除会话：活动 turn 静默注销 + cancel 上游，无终帧', async () => {
    const { conv, stream, sessionId } = await startConv('a')
    await chat.deleteConversation(conv.id)
    expect(bridge.cancel).toHaveBeenCalledWith(sessionId)
    expect(bridge.sessions.delete).toHaveBeenCalledWith(sessionId)
    expect(dones(stream)).toHaveLength(0)
    expect(errors(stream)).toHaveLength(0)
    expect(registry.get(conv.id)).toBeUndefined()
    // 同 id 重建会话可再发（登记已清）
    const again = await chat.startReply(makeSender().sender, { conversationId: conv.id, content: 'b' })
    expect(again.ok).toBe(true)
  })

  it('提案透传：```daniya-file 块 → file:proposal，正文剥离提案块', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-work-'))
    const target = path.join(workDir, 'target.txt')
    fs.writeFileSync(target, 'old-content')
    saveSettings(settingsFile, { ...loadSettings(settingsFile), file: { workDir, autoApply: false } })

    const { stream, files: sent, sessionId } = await startConv('改文件')
    emit.chunk(sessionId, '好的，帮你改。\n\n```daniya-file\n' + JSON.stringify({ path: target, content: 'new-content' }) + '\n```\n改完了。')
    emit.idle(sessionId)
    const fe = sent()[0]
    expect(fe.path).toBe(target)
    expect(fe.error).toBeUndefined()
    expect(fe.autoApplied).toBe(false)
    expect(fe.diff.length).toBeGreaterThan(0)
    expect(deltas(stream)).not.toContain('daniya-file')
    expect(deltas(stream)).toContain('改完了')
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('同会话附带→提案放行（跨轮仍有效）；跨会话附带→拒绝', async () => {
    // 附件在工作目录之外：唯一授权路径是"该会话附带过"
    const target = path.join(dir, 'attached.txt')
    fs.writeFileSync(target, 'old-content')

    const a = await startConv('会话A')
    expect(chat.registerFiles(a.conv.id, [target]).ok).toBe(true)
    emit.idle(a.sessionId)
    // 第二轮提案仍放行：同会话授权跨轮持续有效
    const s2 = makeSender()
    const r2 = await chat.startReply(s2.sender, { conversationId: a.conv.id, content: '再改' })
    expect(r2.ok).toBe(true)
    emit.chunk(a.sessionId, '\n```daniya-file\n' + JSON.stringify({ path: target, content: 'new-a' }) + '\n```\n')
    emit.idle(a.sessionId)
    expect(s2.files()[0]?.error).toBeUndefined()
    expect(s2.files()[0]?.resolvedPath).toBe(path.resolve(target))

    // 会话 B 提案同一附件路径：授权不跨会话泄漏 → file:proposal error 帧
    const b = await startConv('会话B')
    emit.chunk(b.sessionId, '\n```daniya-file\n' + JSON.stringify({ path: target, content: 'new-b' }) + '\n```\n')
    emit.idle(b.sessionId)
    expect(b.files()[0]?.error).toContain('拒绝')
    expect(fs.readFileSync(target, 'utf8')).toBe('old-content')
  })

  it('file:register/file:pick 会话校验：无 id 或未知会话拒绝', async () => {
    const p = path.join(dir, 'a.txt')
    fs.writeFileSync(p, 'x')
    expect(chat.registerFiles('', [p])).toMatchObject({ ok: false, error: '会话不存在' })
    expect(chat.registerFiles('no-such-conv', [p])).toMatchObject({ ok: false, error: '会话不存在' })
    await expect(chat.pickFiles('no-such-conv')).resolves.toMatchObject({ files: [], error: '会话不存在' })

    const conv = chat.createConversation()
    expect(chat.registerFiles(conv.id, [p]).ok).toBe(true)
  })

  it('删除会话回收附件授权与未决提案', async () => {
    const target = path.join(dir, 'attached.txt')
    fs.writeFileSync(target, 'old-content')

    const { conv, files: sent, sessionId } = await startConv('改文件')
    chat.registerFiles(conv.id, [target])
    emit.chunk(sessionId, '\n```daniya-file\n' + JSON.stringify({ path: target, content: 'new' }) + '\n```\n')
    emit.idle(sessionId)
    const proposalId = sent()[0].id
    expect(proposalId).toBeTruthy()

    await chat.deleteConversation(conv.id)
    // 未决提案随会话回收：apply 返回不存在；授权集已清：同路径提案被拒
    expect(files.applyProposal(proposalId).ok).toBe(false)
    expect(files.createProposal(conv.id, target, 'x', { workDir: '', autoApply: false }).ok).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('old-content')
  })
})

describe('入参守卫与历史投影', () => {
  it('空消息 / 无会话 id / 无 API Key / ensure 失败（运行时不可用）', async () => {
    const conv = chat.createConversation()
    const s = makeSender()
    expect(await chat.startReply(s.sender, { conversationId: conv.id, content: '  ' }))
      .toMatchObject({ ok: false, error: '消息内容不能为空' })
    expect(await chat.startReply(s.sender, { conversationId: '', content: 'x' }))
      .toMatchObject({ ok: false, error: '会话不存在' })

    saveSettings(settingsFile, { ...loadSettings(settingsFile), apiKeyEncrypted: null })
    expect(await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' }))
      .toMatchObject({ ok: false, error: '请先在设置中填写 API Key' })
    setApiKey(settingsFile, 'sk-test')

    runtime.activeBridge = null
    expect(await chat.startReply(s.sender, { conversationId: conv.id, content: 'x' }))
      .toMatchObject({ ok: false, error: '运行时不可用，请重启应用' })
    runtime.activeBridge = bridge as unknown as DaniyaBridge
  })

  it('listConversations：registry ⨝ dsh session.list join（离线降级 registry-only）', async () => {
    const conv = chat.createConversation()
    let list = await chat.listConversations()
    expect(list[0]).toMatchObject({ id: conv.id, title: '新会话' })

    registry.setSessionId(conv.id, 'sess-9')
    bridge.sessions.list.mockResolvedValue([{ sessionId: 'sess-9', title: '', updatedAt: 4242 }])
    list = await chat.listConversations()
    expect(list[0].updatedAt).toBe(4242)

    bridge.sessions.list.mockRejectedValue(new Error('离线'))
    list = await chat.listConversations()
    expect(list[0].id).toBe(conv.id) // join 失败不阻断列表
  })

  it('getMessages：history 投影（tool 角色滤除、okByCall 回填徽照、EMO 剥离），未建 session 返回空', async () => {
    const empty = chat.createConversation()
    expect(await chat.getMessages(empty.id)).toEqual([])
    expect(runtime.ensure).not.toHaveBeenCalled() // 无 sessionId 不拉起 harness

    const conv = chat.createConversation()
    registry.setSessionId(conv.id, 'sess-1')
    bridge.sessions.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '{EMO:happy}你好，世界', toolCalls: [{ callId: 'c1', name: 'pwsh' }], createdAt: 2 },
      { id: 't1', role: 'tool', content: 'out', toolCalls: [{ callId: 'c1', name: 'pwsh', ok: true }], createdAt: 3 }
    ])
    const msgs = await chat.getMessages(conv.id)
    expect(bridge.sessions.resume).toHaveBeenCalledWith('sess-1') // resume 前置
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toBe('你好，世界')
    expect(msgs[1].tools).toEqual([{ name: 'pwsh', ok: true }])
  })

  it('B-5 自动标题：首条内容折叠空白取 20 字；手动改名后不再覆盖', async () => {
    const { conv, sessionId } = await startConv('  一二三四五六七八九十一二三四五六七八九十一二三四五六  \n第二行')
    emit.idle(sessionId)
    expect(registry.get(conv.id)?.titleOverride).toBe('一二三四五六七八九十一二三四五六七八九十')

    // 第二条消息不重取标题
    const s2 = makeSender()
    await chat.startReply(s2.sender, { conversationId: conv.id, content: '完全不同的第二句' })
    emit.idle(sessionId)
    expect(registry.get(conv.id)?.titleOverride).toBe('一二三四五六七八九十一二三四五六七八九十')

    chat.renameConversation(conv.id, '我的命名')
    const s3 = makeSender()
    await chat.startReply(s3.sender, { conversationId: conv.id, content: '第三句' })
    emit.idle(sessionId)
    expect(registry.get(conv.id)?.titleOverride).toBe('我的命名')
  })

  it('降级搜索：命中标题与已加载消息', async () => {
    const conv = chat.createConversation()
    registry.setSessionId(conv.id, 'sess-1')
    bridge.sessions.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: '关键词甲乙', createdAt: 1 }
    ])
    await chat.getMessages(conv.id) // 填充 historyCache
    chat.renameConversation(conv.id, '包含关键词的标题')

    const hits = chat.search('关键词')
    expect(hits.some(h => h.role === 'title' && h.snippet === '包含关键词的标题')).toBe(true)
    expect(hits.some(h => h.role === 'user' && h.snippet.includes('关键词甲乙'))).toBe(true)
  })

  it('stopReply：按 requestId cancel 对应 session', async () => {
    const { r, sessionId } = await startConv('慢慢说')
    chat.stopReply(r.requestId!)
    expect(bridge.cancel).toHaveBeenCalledWith(sessionId)
    chat.stopReply('不存在的-request') // 静默
    expect(bridge.cancel).toHaveBeenCalledTimes(1)
  })
})
