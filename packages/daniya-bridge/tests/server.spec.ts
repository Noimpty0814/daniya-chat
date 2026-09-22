/**
 * DaniyaBridgeServer 行为测试：真实 Context 事件面 + 真实 SessionStore/Session，
 * 桩替换 agents/attachments/persistence/llm/transport。
 *
 * @module daniya-bridge/tests/server
 */

import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { DaniyaBridgeServer, type BridgeServerConfig } from '../src/server.js'
import {
  makeAgents,
  makeAttachments,
  makeDiagnostic,
  makeLlm,
  makePersistence,
  makeSystemPrompt,
  makeTransport,
  type FakeAgent,
} from './helpers.js'

const WORKDIR = 'D:\\Agents\\daniya-chat'

interface Harness {
  ctx: Context
  server: DaniyaBridgeServer
  transport: ReturnType<typeof makeTransport>
  agents: ReturnType<typeof makeAgents>
  attachments: ReturnType<typeof makeAttachments>
  persistence: ReturnType<typeof makePersistence>
  llm: ReturnType<typeof makeLlm>
  store: SessionStore
  diagnostic: ReturnType<typeof makeDiagnostic>
}

function harness(config: BridgeServerConfig = {}, persistedEvents?: Map<string, unknown[]>): Harness {
  const ctx = new Context()
  const store = new SessionStore(ctx)
  const agents = makeAgents(store)
  const attachments = makeAttachments()
  const persistence = makePersistence(persistedEvents)
  const llm = makeLlm()
  const transport = makeTransport()
  const diagnostic = makeDiagnostic()
  ctx.provide('agents', agents)
  // SessionStore 构造即自行 provide('sessions')，无需再注册。
  ctx.provide('attachments', attachments)
  ctx.provide('systemPrompt', makeSystemPrompt())
  ctx.provide('sessionPersistence', persistence)
  ctx.provide('llm', llm)
  const server = new DaniyaBridgeServer(ctx, transport, config, diagnostic)
  return { ctx, server, transport, agents, attachments, persistence, llm, store, diagnostic }
}

async function initialized(h: Harness): Promise<void> {
  await h.server.initialize({ workdir: WORKDIR, model: 'deepseek-chat' })
}

async function createSession(h: Harness): Promise<{ sessionId: string; fake: FakeAgent }> {
  const { sessionId } = await h.server.sessionCreate()
  const fake = h.agents.agents.get(sessionId)
  if (fake === undefined) throw new Error('fake agent not registered')
  return { sessionId, fake }
}

function attemptId(id: string): LlmAttemptId {
  return id as LlmAttemptId
}

function streamStart(id: string, turn: number): AssistantStreamFrame {
  return { type: 'start', attemptId: attemptId(id), revision: 1, turn, step: 1 }
}

function streamChunk(id: string, text: string): AssistantStreamFrame {
  return {
    type: 'chunk',
    attemptId: attemptId(id),
    revision: 1,
    index: 0,
    time: 1,
    chunk: { type: 'text-delta', text },
  } as AssistantStreamFrame
}

function streamEnd(id: string, outcome: AssistantStreamFrame extends never ? never : unknown): AssistantStreamFrame {
  return { type: 'end', attemptId: attemptId(id), revision: 1, index: 1, outcome } as AssistantStreamFrame
}

function sessionEvent(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq + 1, data } as unknown as SessionEvent
}

function notificationsOf(h: Harness, method: string): { method: string; params?: object }[] {
  return h.transport.sent.filter(n => n.method === method)
}

describe('initialize', () => {
  it('校验 LLM 路由并回执 ok', async () => {
    const h = harness()
    await expect(h.server.initialize({ workdir: WORKDIR, model: 'deepseek-chat' })).resolves.toEqual({ ok: true })
    expect(h.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('空 model / 非法 workdir 参数被拒绝', async () => {
    const h = harness()
    await expect(h.server.initialize({ workdir: WORKDIR, model: '' })).rejects.toThrow(TypeError)
    await expect(h.server.initialize({ workdir: 42, model: 'm' })).rejects.toThrow(TypeError)
  })

  it('持久化缺失时响亮失败', async () => {
    const h = harness()
    // 用未提供 sessionPersistence 的上下文重建 server
    const ctx2 = new Context()
    ctx2.provide('agents', h.agents)
    ctx2.provide('sessions', h.store)
    ctx2.provide('attachments', h.attachments)
    ctx2.provide('systemPrompt', makeSystemPrompt())
    ctx2.provide('llm', h.llm)
    const server2 = new DaniyaBridgeServer(ctx2, h.transport, {}, h.diagnostic)
    await expect(server2.initialize({ workdir: WORKDIR, model: 'm' })).rejects.toThrow(/persistence/)
  })

  it('未 initialize 的会话操作被拒绝', async () => {
    const h = harness()
    await expect(h.server.sessionCreate()).rejects.toThrow(/initialize/)
  })
})

describe('session.create / resume / delete', () => {
  it('create 经 agents.create 建会话并写 workspace-write 沙箱模式', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    expect(sessionId).toMatch(/^daniya-/)
    const opts = h.agents.lastCreateOptions()
    // initialize 对 workdir 做 resolve() 归一化——Windows 上返回原值，POSIX 上
    // 拼上 cwd；断言对齐服务端归一化后的生效值而非字面量。
    expect(opts?.meta).toEqual({ cwd: resolve(WORKDIR) })
    expect(opts?.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    // setup 已在 create 内执行：首个事件为 sandbox/mode = workspace-write
    const first = fake.agent.session.eventAt(fake.agent.session.eventAt(0)!.seq)
    expect(first?.type).toBe('sandbox/mode')
    expect((first?.data as { mode: string }).mode).toBe('workspace-write')
  })

  it('setup 在 agent 作用域注册遮蔽部署 persona 的同名段', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId } = await createSession(h)
    const prompt = h.agents.agentPrompts.get(sessionId)
    expect(prompt).toBeDefined()
    expect(prompt!.section).toHaveBeenCalledTimes(1)
    const section = prompt!.sections[0]
    expect(section.name).toBe('deployment:persona-prefix')
    expect(section.interpolate).toBe(false)
    expect(typeof section.text).toBe('function')
    const text = (section.text as () => string)()
    expect(text).toContain('用户当前工作目录：')
    expect(text).toContain('每次回复的第一个字符必须是情绪标记')
  })

  it('沙箱写入被拒时发 error 通知 + stderr，不阻断创建', async () => {
    const h = harness()
    await initialized(h)
    // 让 setup 内的 setSandboxMode 失败：会话 append 拒 sandbox/mode
    const origCreate = h.agents.create.getMockImplementation()
    h.agents.create.mockImplementation(async (options) => {
      const rec = await origCreate?.(options)
      return rec!
    })
    // 更直接：替换 store.create 产出的 session.append（对 sandbox/mode 抛出）
    const origStoreCreate = h.store.create.bind(h.store)
    vi.spyOn(h.store, 'create').mockImplementation((id, options) => {
      const session = origStoreCreate(id, options)
      const origAppend = session.append.bind(session)
      session.append = ((type: string, data: unknown, ...rest: unknown[]) => {
        if (type === 'sandbox/mode') throw new Error('persistent terminal in progress')
        return origAppend(type as never, data as never, ...(rest as never[]))
      }) as typeof session.append
      return session
    })
    const { sessionId } = await h.server.sessionCreate()
    expect(sessionId).toMatch(/^daniya-/)
    const errors = notificationsOf(h, 'error')
    expect(errors.length).toBe(1)
    expect((errors[0].params as { message: string }).message).toContain('persistent terminal in progress')
    expect(h.diagnostic.lines.some(l => l.includes('sandbox/mode'))).toBe(true)
  })

  it('resume 走 agents.resume 且同 id 并发去重', async () => {
    const h = harness()
    await initialized(h)
    const [a, b] = await Promise.all([
      h.server.sessionResume({ sessionId: 'sess-1' }),
      h.server.sessionResume({ sessionId: 'sess-1' }),
    ])
    expect(h.agents.resume).toHaveBeenCalledTimes(1)
    expect(h.agents.lastResumeOptions()?.resumeSessionId).toBe(SessionId('sess-1'))
    expect(a).toEqual({ ok: true })
    expect(b).toEqual(a)
    // 已活会话再 resume：直接命中注册表，不再调 resume
    await h.server.sessionResume({ sessionId: 'sess-1' })
    expect(h.agents.resume).toHaveBeenCalledTimes(1)
  })

  it('delete dispose 活 agent 并回 ok；未知会话也幂等回 ok + 记 stderr', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    await expect(h.server.sessionDelete({ sessionId })).resolves.toEqual({ ok: true })
    expect(fake.disposed()).toBe(1)
    await expect(h.server.sessionDelete({ sessionId: 'ghost' })).resolves.toEqual({ ok: true })
    expect(h.diagnostic.lines.some(l => l.includes('ghost'))).toBe(true)
  })
})

describe('session.list / session.history', () => {
  it('list 合并持久层快照与活会话并按 updatedAt 倒序', async () => {
    const persisted = new Map<string, unknown[]>([
      ['old-session', [sessionEvent('turn/end', 0, { turn: 1, reason: { kind: 'completed' } })]],
    ])
    const h = harness({}, persisted)
    await initialized(h)
    const { sessionId } = await createSession(h)
    const rows = await h.server.sessionList()
    const ids = rows.map(r => r.sessionId)
    expect(ids).toContain(sessionId)
    expect(ids).toContain('old-session')
    expect(rows.every(r => r.title === '')).toBe(true)
    // 持久会话 updatedAt 取末事件时间（seq+1=1）
    expect(rows.find(r => r.sessionId === 'old-session')?.updatedAt).toBe(1)
  })

  it('history 活会话投 live surface，落盘会话走持久层', async () => {
    const h = harness()
    await initialized(h)
    const { fake } = await createSession(h)
    const msg = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    fake.agent.session.append('user/message', msg, { surfaceOp: 'append' })
    const live = await h.server.sessionHistory({ sessionId: String(fake.agent.session.id) })
    expect(live.messages.length).toBe(1)
    expect(live.messages[0].content).toBe('hello')
    // 落盘会话：持久层 open('read') 回放
    const stored = new Map<string, unknown[]>()
    const storedSession = new SessionStore(new Context()).create(SessionId('stored-1'))
    const storedMsg = createUserMessage({ content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } })
    stored.set('stored-1', [storedSession.append('user/message', storedMsg, { surfaceOp: 'append' })])
    const h2 = harness({}, stored)
    await initialized(h2)
    const past = await h2.server.sessionHistory({ sessionId: 'stored-1' })
    expect(h2.persistence.open).toHaveBeenCalled()
    expect(past.messages.length).toBe(1)
    expect(past.messages[0].content).toBe('old')
  })
})

describe('prompt / cancel', () => {
  it('prompt 先准入图像再 followup，返回 messageId', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const result = await h.server.prompt({
      sessionId,
      text: '看看这张图',
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(result.messageId).toBeTruthy()
    expect(h.attachments.admitPromptContent).toHaveBeenCalledWith([
      { type: 'text', text: '看看这张图' },
      { type: 'image', mediaType: 'image/png', data: 'aGk=' },
    ])
    expect(fake.followup).toHaveBeenCalledTimes(1)
    const message = fake.followup.mock.calls[0][0] as { content: { type: string }[] }
    expect(message.content.map(b => b.type)).toEqual(['text', 'image'])
  })

  it('非法图像媒体类型与空 prompt 被拒绝', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId } = await createSession(h)
    await expect(h.server.prompt({ sessionId, text: '', images: [{ data: 'eA==', mimeType: 'image/tiff' }] }))
      .rejects.toThrow(TypeError)
    await expect(h.server.prompt({ sessionId, text: '' })).rejects.toThrow(/non-empty text or at least one image/)
  })

  it('未知会话的 prompt/cancel 抛错', async () => {
    const h = harness()
    await initialized(h)
    await expect(h.server.prompt({ sessionId: 'nope', text: 'x' })).rejects.toThrow(/unknown session/)
    await expect(h.server.cancel({ sessionId: 'nope' })).rejects.toThrow(/unknown session/)
  })

  it('cancel 调 agent.cancel({kind:user})', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    await expect(h.server.cancel({ sessionId })).resolves.toEqual({ ok: true })
    expect(fake.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })
})

describe('事件 → 通知映射', () => {
  it('agent/status 转发为 agent.status（仅注册会话）', async () => {
    const h = harness()
    await initialized(h)
    const { fake } = await createSession(h)
    h.ctx.emit('agent/status', { agent: fake.agent, status: 'busy' })
    expect(notificationsOf(h, 'agent.status')).toEqual([
      { method: 'agent.status', params: { sessionId: String(fake.agent.session.id), status: 'busy' } },
    ])
    // 外来 agent 不转发
    const foreign = h.agents.agents.get('x') ?? (await h.agents.create({ sessionId: SessionId('foreign') })).agent
    h.ctx.emit('agent/status', { agent: foreign, status: 'busy' })
    expect(notificationsOf(h, 'agent.status').length).toBe(1)
  })

  it('assistant-stream：text-delta → stream.chunk，committed assistant/message end → stream.end', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const agent = fake.agent
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamStart('a1', 3) })
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamChunk('a1', '{EMO:happy}') })
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamChunk('a1', ' 早啊') })
    h.ctx.emit('agent/assistant-stream', {
      agent,
      frame: streamEnd('a1', { kind: 'committed', eventType: 'assistant/message', seq: 7 }),
    })
    const chunks = notificationsOf(h, 'stream.chunk')
    expect(chunks.map(c => (c.params as { text: string }).text)).toEqual(['{EMO:happy}', ' 早啊'])
    expect((chunks[0].params as { turn: number }).turn).toBe(3)
    const ends = notificationsOf(h, 'stream.end')
    expect(ends).toEqual([{ method: 'stream.end', params: { sessionId, turn: 3 } }])
    void sessionId
  })

  it('attempt/abandoned 终帧不发 stream.end；turn/end aborted 兜底补发一次', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const agent = fake.agent
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamStart('a1', 1) })
    h.ctx.emit('agent/assistant-stream', {
      agent,
      frame: streamEnd('a1', { kind: 'committed', eventType: 'assistant/attempt', seq: 4 }),
    })
    expect(notificationsOf(h, 'stream.end').length).toBe(0)
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamEnd('a2', { kind: 'abandoned' }) })
    expect(notificationsOf(h, 'stream.end').length).toBe(0)
    // turn/end{aborted} 兜底
    h.ctx.emit('session/event', agent.session, sessionEvent('turn/end', 9, { turn: 1, reason: { kind: 'aborted', cause: { kind: 'user' } } }))
    const ends = notificationsOf(h, 'stream.end')
    expect(ends).toEqual([{ method: 'stream.end', params: { sessionId, turn: 1, aborted: true } }])
    // 重复 turn/end 不再补发
    h.ctx.emit('session/event', agent.session, sessionEvent('turn/end', 10, { turn: 1, reason: { kind: 'aborted', cause: { kind: 'user' } } }))
    expect(notificationsOf(h, 'stream.end').length).toBe(1)
  })

  it('interrupted assistant/message + committed end → stream.end{aborted:true}，turn/end 不重复', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const agent = fake.agent
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamStart('a1', 2) })
    h.ctx.emit('agent/assistant-stream', { agent, frame: streamChunk('a1', '半句话') })
    h.ctx.emit('session/event', agent.session, sessionEvent('assistant/message', 6, {
      turn: 2, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '半句话' }], source: { provider: 'p', model: 'm' } }),
      stream: [], interrupted: true,
    }))
    h.ctx.emit('agent/assistant-stream', {
      agent,
      frame: streamEnd('a1', { kind: 'committed', eventType: 'assistant/message', seq: 6 }),
    })
    expect(notificationsOf(h, 'stream.end')).toEqual([
      { method: 'stream.end', params: { sessionId, turn: 2, aborted: true } },
    ])
    h.ctx.emit('session/event', agent.session, sessionEvent('turn/end', 7, { turn: 2, reason: { kind: 'aborted', cause: { kind: 'user' } } }))
    expect(notificationsOf(h, 'stream.end').length).toBe(1)
  })

  it('tool/call → tool.call 截断 argsPreview ≤500；tool/result → tool.result', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const session = fake.agent.session
    const longArgs = 'x'.repeat(600)
    h.ctx.emit('session/event', session, sessionEvent('tool/call', 3, {
      turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: longArgs,
    }))
    const call = notificationsOf(h, 'tool.call')[0].params as { callId: string; tool: string; argsPreview: string }
    expect(call).toMatchObject({ callId: 'c1', tool: 'bash' })
    expect(call.argsPreview.length).toBe(500)
    const resultMsg = createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'ok output' }],
      isError: false,
    })
    h.ctx.emit('session/event', session, sessionEvent('tool/result', 4, { turn: 1, step: 1, message: resultMsg }))
    const result = notificationsOf(h, 'tool.result')[0].params as { callId: string; ok: boolean; preview: string; sessionId: string }
    expect(result).toEqual({ sessionId, callId: 'c1', ok: true, preview: 'ok output' })
  })

  it('agent/error → error；request-error 终态已通知的同失败去重', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    const agent = fake.agent
    // 终态 request-error：先通知 error，紧随的 agent/error 同键去重
    const action = await h.ctx.waterfall('agent/request-error', {
      agent, turn: 1, step: 1, provider: 'p', failure: { message: 'rate limited' }, retryPolicy: undefined, signal: new AbortController().signal,
    }, async () => undefined)
    expect(action).toBeUndefined()
    expect(notificationsOf(h, 'error')).toEqual([
      { method: 'error', params: { sessionId, message: 'rate limited' } },
    ])
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('rate limited') })
    expect(notificationsOf(h, 'error').length).toBe(1)
    // 不同消息不去重
    h.ctx.emit('agent/error', { agent, turn: 1, step: 2, error: new Error('other failure') })
    expect(notificationsOf(h, 'error').length).toBe(2)
  })

  it('request-error 走 next() 委托；retry 终态不发 error', async () => {
    const h = harness()
    await initialized(h)
    const { fake } = await createSession(h)
    const agent = fake.agent
    let delegated = 0
    const action = await h.ctx.waterfall('agent/request-error', {
      agent, turn: 1, step: 1, provider: 'p', failure: { message: 'retry me' }, retryPolicy: undefined, signal: new AbortController().signal,
    }, async () => { delegated += 1; return { kind: 'retry' as const } })
    expect(delegated).toBe(1)
    expect(action).toEqual({ kind: 'retry' })
    expect(notificationsOf(h, 'error').length).toBe(0)
  })

  it('agent/disposed 清理注册表：之后事件不再转发', async () => {
    const h = harness()
    await initialized(h)
    const { sessionId, fake } = await createSession(h)
    h.ctx.emit('agent/disposed', { agent: fake.agent })
    h.ctx.emit('agent/status', { agent: fake.agent, status: 'disposed' })
    expect(notificationsOf(h, 'agent.status').length).toBe(0)
    await expect(h.server.cancel({ sessionId })).rejects.toThrow(/unknown session|disposed/)
  })
})

describe('shutdown', () => {
  it('幂等 dispose 全部 agent 并摘监听', async () => {
    const h = harness()
    await initialized(h)
    const { fake } = await createSession(h)
    await h.server.shutdown()
    await h.server.shutdown()
    expect(fake.disposed()).toBe(1)
    // 监听已摘：之后 emit 无通知
    h.ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    expect(notificationsOf(h, 'agent.status').length).toBe(0)
    // 关闭后再操作被拒
    await expect(h.server.sessionCreate()).rejects.toThrow(/shutting down/)
  })
})

describe('投影细节', () => {
  it('assistant/tool 消息投影为 BridgeMessage 角色与 toolCalls', async () => {
    const h = harness()
    await initialized(h)
    const { fake } = await createSession(h)
    const session: Session = fake.agent.session
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'run ls' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: '{EMO:happy} 好' },
          { type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{}' },
        ],
        source: { provider: 'p', model: 'm1' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }),
    }, { surfaceOp: 'append' })
    const { messages } = await h.server.sessionHistory({ sessionId: String(session.id) })
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[1].toolCalls).toEqual([{ callId: 'c1', name: 'bash' }])
    expect(messages[1].model).toBe('m1')
    expect(messages[2].toolCalls).toEqual([{ callId: 'c1', name: 'bash', ok: true }])
    expect(messages[2].content).toBe('out')
  })
})
