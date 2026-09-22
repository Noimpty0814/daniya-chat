import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc'
import { HarnessRuntime } from './harness/process'
import { ConversationRegistry } from './harness/conversations'
import { setApiKey, saveSettings, loadSettings } from './settings'
import type { FileProposalEvent, StartReplyResult, StreamEventMsg } from '../shared/types'
import type { PetCoordinator } from './pet/coordinator'
import type { Emotion } from './harness/emotion'

const FIXTURE = fileURLToPath(new URL('./harness/fixtures/fake-bridge.mjs', import.meta.url))

// ── electron mock：ipcMain.handle 捕获 + 各模块所需的 electron 面 ──
const handlers = new Map<string, (e: unknown, p: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: { fromWebContents: () => null },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  safeStorage: {
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 100, height: 100 } }) }
}))

interface Sent { channel: string; data: unknown }
function makeSender() {
  const sent: Sent[] = []
  const sender = {
    send: vi.fn((channel: string, data: unknown) => { sent.push({ channel, data }) }),
    isDestroyed: () => false
  }
  const events = () => sent.filter(s => s.channel === 'chat:stream').map(s => s.data as StreamEventMsg)
  const fileEvents = () => sent.filter(s => s.channel === 'file:proposal').map(s => s.data as FileProposalEvent)
  return { sender, sent, events, fileEvents }
}

function makePet(): PetCoordinator & { bubble: ReturnType<typeof vi.fn>; emotion: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(), stop: vi.fn(), onPetClick: vi.fn(),
    bubble: vi.fn((_on: boolean) => {}), emotion: vi.fn((_e: Emotion | null) => {}),
    status: () => ({ helperRunning: false, connected: false, petWindowFound: false })
  }
}

const evt = { sender: null as unknown } // 占位，测试中注入 sender

let dir: string
let settingsFile: string
let registry: ConversationRegistry
let runtime: HarnessRuntime
let pet: ReturnType<typeof makePet>

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-ipc-'))
  settingsFile = path.join(dir, 'settings.json')
  registry = new ConversationRegistry(path.join(dir, 'conversations.json'))
  pet = makePet()
  runtime = new HarnessRuntime({
    spec: { command: process.execPath, args: [FIXTURE] },
    dshHome: path.join(dir, 'dsh-home'),
    settingsFile,
    getLaunchContext: () => {
      const s = loadSettings(settingsFile)
      return { apiKey: 'sk-test', baseUrl: s.baseUrl, workDir: s.file.workDir, model: s.model }
    }
  })
  registerIpc({ registry, runtime, settingsFile, pet: () => pet })
}

async function teardown() {
  await runtime?.shutdown().catch(() => {})
  handlers.clear()
  fs.rmSync(dir, { recursive: true, force: true })
}

const invoke = <T>(ch: string, p?: unknown, sender?: unknown): Promise<T> =>
  handlers.get(ch)!(sender ?? evt, p) as Promise<T>

async function waitEvent(events: () => StreamEventMsg[], pred: (e: StreamEventMsg) => boolean, ms = 4000): Promise<StreamEventMsg> {
  const t0 = Date.now()
  for (;;) {
    const hit = events().find(pred)
    if (hit) return hit
    if (Date.now() - t0 > ms) throw new Error('等待流事件超时：' + JSON.stringify(events()))
    await new Promise(r => setTimeout(r, 15))
  }
}

beforeEach(() => { setup() })
afterEach(async () => { await teardown() })

async function newConversationWithKey(): Promise<{ convId: string }> {
  setApiKey(settingsFile, 'sk-test')
  const meta = await invoke<{ id: string }>('chat:createConversation')
  return { convId: meta.id }
}

describe('chat:startReply 全链（fake-bridge 集成）', () => {
  it('发消息 → delta/emotion/done：EMO 标记剥离、情绪事件先行、pet 联动', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '你好' }, { sender })
    expect(r.ok).toBe(true)
    expect(r.requestId).toBeTruthy()
    expect(r.userMessage?.content).toBe('你好')
    expect(r.userMessage?.role).toBe('user')

    const done = await waitEvent(events, e => e.type === 'done')
    const deltas = events().filter(e => e.type === 'delta').map(e => e.delta).join('')
    expect(deltas).toBe('你好，世界')
    expect(done.message?.content).toBe('你好，世界')
    // EMO 标记剥离为 pet.emotion（情绪不进 chat:stream）
    expect(pet.emotion).toHaveBeenCalledWith('happy')
    expect(pet.bubble).toHaveBeenCalledWith(true)
    expect(pet.bubble).toHaveBeenCalledWith(false)
    // 所有流事件都带同一 requestId
    expect(events().every(e => e.requestId === r.requestId)).toBe(true)
  })

  it('多步 turn（B-6）：中间 stream.end 不终结请求，tool 事件与终帧文本全保留', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '[toolturn] 查一下' }, { sender })
    expect(r.ok).toBe(true)
    const done = await waitEvent(events, e => e.type === 'done')
    // 两条 assistant 消息的文本都应存活：中间消息 + 工具结果后的最终答复
    expect(done.message?.content).toBe('我先查一下。查完了：结果是 X。')
    // 中间 stream.end 之后的 tool 事件不丢
    const tools = events().filter(e => e.type === 'tool').map(e => e.tool)
    expect(tools[0]).toMatchObject({ name: 'web_search', callId: 'call-1' })
    expect(tools[1]).toMatchObject({ name: 'web_search', callId: 'call-1', ok: true })
    expect(done.message?.tools).toEqual([{ name: 'web_search', ok: true }])
    // done 只来一次，且此后无滞留活动请求（能立刻再发）
    expect(events().filter(e => e.type === 'done')).toHaveLength(1)
    const again = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '再来一句' }, { sender })
    expect(again.ok).toBe(true)
  })

  it('工具徽照搬：[tool] 触发 tool.call/tool.result → chat:stream{tool} + done.tools', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '[tool] 跑个命令' }, { sender })
    expect(r.ok).toBe(true)
    const done = await waitEvent(events, e => e.type === 'done')
    const tools = events().filter(e => e.type === 'tool').map(e => e.tool)
    expect(tools[0]).toMatchObject({ name: 'pwsh', callId: 'call-1' })
    expect(tools[1]).toMatchObject({ name: 'pwsh', callId: 'call-1', ok: true })
    expect(done.message?.tools).toEqual([{ name: 'pwsh', ok: true }])
  })

  it('停止：[slow] 流未结束 → stopReply → cancel → done 保留残文', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '[slow] 慢慢说' }, { sender })
    expect(r.ok).toBe(true)
    await waitEvent(events, e => e.type === 'delta')
    await invoke('chat:stopReply', { requestId: r.requestId })
    const done = await waitEvent(events, e => e.type === 'done')
    expect(done.message?.content).toContain('你好')
  })

  it('错误通知 → 中文映射的 error 事件（401 → Key 无效）', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '[error] boom' }, { sender })
    expect(r.ok).toBe(true)
    const err = await waitEvent(events, e => e.type === 'error')
    expect(err.error).toBe('API Key 无效，请在设置中检查')
    expect(events().some(e => e.type === 'done')).toBe(false)
  })

  it('提案透传：```daniya-file 块 → file:proposal（授权后带 diff），正文不含提案块', async () => {
    const { convId } = await newConversationWithKey()
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-work-'))
    const target = path.join(workDir, 'target.txt')
    fs.writeFileSync(target, 'old-content')
    const s = loadSettings(settingsFile)
    saveSettings(settingsFile, { ...s, file: { workDir, autoApply: false } })

    const { sender, events, fileEvents } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: `[proposal:${target}] 改文件` }, { sender })
    expect(r.ok).toBe(true)
    await waitEvent(events, e => e.type === 'done')
    const fe = fileEvents()[0]
    expect(fe.path).toBe(target)
    expect(fe.error).toBeUndefined()
    expect(fe.autoApplied).toBe(false)
    expect(fe.diff.length).toBeGreaterThan(0)
    const full = events().filter(e => e.type === 'delta').map(e => e.delta).join('')
    expect(full).not.toContain('daniya-file')
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('守卫：空内容 / 无 Key / 同会话并发', async () => {
    const { convId } = await newConversationWithKey()
    const { sender } = makeSender()
    expect((await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '  ' }, { sender })).error).toBe('消息内容不能为空')

    // 无 Key：删掉 settings 文件重测
    saveSettings(settingsFile, { ...loadSettings(settingsFile), apiKeyEncrypted: null })
    expect((await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: 'x' }, { sender })).error).toBe('请先在设置中填写 API Key')

    setApiKey(settingsFile, 'sk-test')
    const { sender: s2, events: ev2 } = makeSender()
    const r1 = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: '[slow] a' }, { sender: s2 })
    expect(r1.ok).toBe(true)
    const r2 = await invoke<StartReplyResult>('chat:startReply', { conversationId: convId, content: 'b' }, { sender: s2 })
    expect(r2.ok).toBe(false)
    expect(r2.error).toBe('该会话正在生成回复中')
    await invoke('chat:stopReply', { requestId: r1.requestId })
    await waitEvent(ev2, e => e.type === 'done')
  })
})

describe('会话 CRUD 与历史', () => {
  it('create/list/rename/delete：registry 主导，sessionId 惰性回填', async () => {
    const { convId } = await newConversationWithKey()
    let list = await invoke<{ id: string; title: string }[]>('chat:listConversations')
    expect(list[0]).toMatchObject({ id: convId, title: '新会话' })

    const { sender, events } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: 'hi' }, { sender })
    await waitEvent(events, e => e.type === 'done')
    expect(registry.get(convId)?.sessionId).toBe('sess-1')

    await invoke('chat:renameConversation', { id: convId, title: '改名' })
    list = await invoke<{ id: string; title: string }[]>('chat:listConversations')
    expect(list[0].title).toBe('改名')

    await invoke('chat:deleteConversation', { id: convId })
    list = await invoke<{ id: string; title: string }[]>('chat:listConversations')
    expect(list).toEqual([])
    expect(registry.list()).toEqual([])
    // dsh 侧 session 也被删除：session.list 应无 sess-1
    const bridge = runtime.activeBridge!
    const sessions = await bridge.request<unknown[]>('session.list', {})
    expect(sessions).toEqual([])
  })

  it('getMessages：bridge history 投影为 ChatMessage（assistant 原文清洗 EMO/提案块）', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: 'hi' }, { sender })
    await waitEvent(events, e => e.type === 'done')

    const msgs = await invoke<{ role: string; content: string }[]>('chat:getMessages', { id: convId })
    expect(msgs.length).toBe(2)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('hi')
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].content).toBe('你好，世界') // '{EMO:happy}' 已剥离
    expect(msgs[1].content).not.toContain('{EMO:')
  })

  it('getMessages：带文件发送的用户消息剥离 [文件] 注入块', async () => {
    const { convId } = await newConversationWithKey()
    const filePath = path.join(dir, 'note.txt')
    fs.writeFileSync(filePath, '文件里的秘密')
    const reg = await invoke<{ ok: boolean; files: { name: string; path: string }[] }>('file:register', { paths: [filePath] })
    expect(reg.ok).toBe(true)

    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', {
      conversationId: convId, content: '读文件', files: reg.files
    }, { sender })
    expect(r.ok).toBe(true)
    await waitEvent(events, e => e.type === 'done')

    const msgs = await invoke<{ role: string; content: string }[]>('chat:getMessages', { id: convId })
    const user = msgs.find(m => m.role === 'user')!
    expect(user.content).toBe('读文件')
    expect(user.content).not.toContain('[文件')
    expect(user.content).not.toContain('文件里的秘密')
  })

  it('首消息自动标题（B-5）：取首条内容 20 字；手动改名后不再覆盖', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: '聊聊周末爬山计划顺便带点水' }, { sender })
    await waitEvent(events, e => e.type === 'done')
    expect(registry.get(convId)?.titleOverride).toBe('聊聊周末爬山计划顺便带点水')

    // 第二条消息不重取标题
    const { sender: s2, events: e2 } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: '完全不同的第二句' }, { sender: s2 })
    await waitEvent(e2, e => e.type === 'done')
    expect(registry.get(convId)?.titleOverride).toBe('聊聊周末爬山计划顺便带点水')

    // 手动改名后依然不被覆盖
    await invoke('chat:renameConversation', { id: convId, title: '我的命名' })
    const { sender: s3, events: e3 } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: '第三句' }, { sender: s3 })
    await waitEvent(e3, e => e.type === 'done')
    expect(registry.get(convId)?.titleOverride).toBe('我的命名')
  })

  it('首消息标题截断 20 字并折叠空白', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: '  一二三四五六七八九十一二三四五六七八九十一二三四五六  \n第二行' }, { sender })
    await waitEvent(events, e => e.type === 'done')
    // 折叠空白 → trim → 取前 20 字（第 21 字起截断）
    expect(registry.get(convId)?.titleOverride).toBe('一二三四五六七八九十一二三四五六七八九十')
  })

  it('降级搜索：命中标题与已加载消息', async () => {
    const { convId } = await newConversationWithKey()
    const { sender, events } = makeSender()
    await invoke('chat:startReply', { conversationId: convId, content: '关键词甲乙' }, { sender })
    await waitEvent(events, e => e.type === 'done')
    await invoke('chat:getMessages', { id: convId }) // 填充缓存
    await invoke('chat:renameConversation', { id: convId, title: '包含关键词的标题' })

    const hits = await invoke<{ role: string; snippet: string }[]>('chat:search', { q: '关键词' })
    expect(hits.some(h => h.role === 'title' && h.snippet === '包含关键词的标题')).toBe(true)
    expect(hits.some(h => h.role === 'user' && h.snippet.includes('关键词甲乙'))).toBe(true)
  })

  it('getMessages：未建 session 的会话返回空；未启动 harness 也不误启动', async () => {
    const { convId } = await newConversationWithKey()
    const msgs = await invoke<unknown[]>('chat:getMessages', { id: convId })
    expect(msgs).toEqual([])
    expect(runtime.isAlive).toBe(false)
  })
})
