/**
 * registerIpc 接线冒烟（chat-runtime 票后收缩）：
 * - 通道注册表全量钉死（adapter 职责）；
 * - 1-2 条 fake-bridge 子进程全链用例保住真实 stdio 接线。
 * turn 语义细粒度覆盖已迁 chat-runtime.test.ts（进程内同步派发）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc'
import { HarnessRuntime } from './harness/process'
import { ConversationRegistry } from './harness/conversations'
import { setApiKey, loadSettings } from './settings'
import type { StartReplyResult, StreamEventMsg } from '../shared/types'
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
  return { sender, sent, events }
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

describe('registerIpc 接线冒烟', () => {
  it('全部通道注册（adapter 面不变）', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'chat:createConversation', 'chat:deleteConversation', 'chat:getMessages',
      'chat:listConversations', 'chat:renameConversation', 'chat:search',
      'chat:startReply', 'chat:stopReply',
      'file:apply', 'file:pick', 'file:pickDir', 'file:register', 'file:reject',
      'pet:status', 'screen:capture',
      'settings:get', 'settings:save', 'settings:setApiKey', 'settings:testConnection',
      'shell:openExternal', 'window:hide'
    ].sort())
  })

  it('file:register/file:pick 载荷带 conversationId：无 id/未知会话拒绝，已登记会话放行', async () => {
    const p = path.join(dir, 'a.txt')
    fs.writeFileSync(p, 'x')
    expect(await invoke('file:register', { conversationId: 'nope', paths: [p] }))
      .toMatchObject({ ok: false, error: '会话不存在' })
    expect(await invoke('file:register', { paths: [p] }))
      .toMatchObject({ ok: false, error: '会话不存在' })
    expect(await invoke('file:pick', {})).toMatchObject({ files: [], error: '会话不存在' })
    const meta = await invoke<{ id: string }>('chat:createConversation')
    expect(await invoke('file:register', { conversationId: meta.id, paths: [p] }))
      .toMatchObject({ ok: true, files: [{ name: 'a.txt', path: p }] })
  })

  it('发消息 → delta/emotion/done：EMO 标记剥离、情绪事件先行、pet 联动', async () => {
    setApiKey(settingsFile, 'sk-test')
    const meta = await invoke<{ id: string }>('chat:createConversation')
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: meta.id, content: '你好' }, { sender })
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
    setApiKey(settingsFile, 'sk-test')
    const meta = await invoke<{ id: string }>('chat:createConversation')
    const { sender, events } = makeSender()
    const r = await invoke<StartReplyResult>('chat:startReply', { conversationId: meta.id, content: '[toolturn] 查一下' }, { sender })
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
    const again = await invoke<StartReplyResult>('chat:startReply', { conversationId: meta.id, content: '再来一句' }, { sender })
    expect(again.ok).toBe(true)
  })
})
