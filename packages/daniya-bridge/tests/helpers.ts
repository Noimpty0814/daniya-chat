/**
 * 测试夹具：真实 cordis `Context` + 真实 `SessionStore`/`Session`，
 * 只把 agent 注册表、附件存储、持久化、LLM 路由、传输写面替换为可观测桩。
 *
 * @module daniya-bridge/tests/helpers
 */

import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AdmittedPromptContentPart } from '@deepseek-ai/dsh-attachment'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { BridgeTransportPeer } from '../src/protocol.js'

/** 捕获通知的传输桩；`sent` 按序记录 {method, params}。 */
export function makeTransport(): BridgeTransportPeer & {
  sent: { method: string; params?: object }[]
  flushed: () => number
} {
  const sent: { method: string; params?: object }[] = []
  const flush = vi.fn(async (): Promise<void> => {})
  return {
    sent,
    flushed: () => flush.mock.calls.length,
    notify: (method: string, params?: object) => { sent.push({ method, params }) },
    flush,
  }
}

export interface FakeAgent {
  agent: Agent
  handle: AgentHandle
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  disposed: () => number
}

/** 基于真实 Session 造 agent 桩：followup/cancel/dispose 为 spy。 */
export function makeAgent(store: SessionStore, sessionId: string): FakeAgent {
  const session = store.create(SessionId(sessionId))
  const followup = vi.fn()
  const cancel = vi.fn()
  const dispose = vi.fn(async (): Promise<void> => {})
  const agent = {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    followup,
    cancel,
    steer: vi.fn(),
    inject: vi.fn(),
    send: vi.fn(),
  } as unknown as Agent
  const handle = { agent, dispose } as unknown as AgentHandle
  return { agent, handle, followup, cancel, disposed: () => dispose.mock.calls.length }
}

export interface FakeAgents {
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  get: (id: unknown) => Agent | undefined
  agents: Map<string, FakeAgent>
  /** sessionId → setup 收到的 agentCtx 上的 systemPrompt 桩（含 sections）。 */
  agentPrompts: Map<string, ReturnType<typeof makeSystemPrompt>>
  lastCreateOptions: () => CreateAgentOptions | undefined
  lastResumeOptions: () => ResumeAgentOptions | undefined
}

/**
 * agent 注册表桩：`create`/`resume` 调 `options.setup`（与真实注册表同序——
 * 在首个 spawn 前执行），返回可 dispose 的 handle。setup 的 agentCtx 携带
 * `systemPrompt` 桩以观测作用域段注册。
 */
export function makeAgents(store: SessionStore): FakeAgents {
  const agents = new Map<string, FakeAgent>()
  const agentPrompts = new Map<string, ReturnType<typeof makeSystemPrompt>>()
  const createOpts: CreateAgentOptions[] = []
  const resumeOpts: ResumeAgentOptions[] = []
  const runSetup = async (options: { setup?: AgentSetup }, fake: FakeAgent): Promise<void> => {
    if (options.setup === undefined) return
    const prompt = makeSystemPrompt()
    agentPrompts.set(String(fake.agent.session.id), prompt)
    const agentCtx = { systemPrompt: prompt } as unknown as Context
    const commit = await options.setup(agentCtx, fake.agent)
    commit?.()
  }
  const create = vi.fn(async (options: CreateAgentOptions): Promise<AgentHandle> => {
    createOpts.push(options)
    const fake = makeAgent(store, String(options.sessionId))
    await runSetup(options, fake)
    agents.set(String(fake.agent.session.id), fake)
    return fake.handle
  })
  const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
    resumeOpts.push(options)
    const fake = makeAgent(store, String(options.resumeSessionId))
    await runSetup(options, fake)
    agents.set(String(fake.agent.session.id), fake)
    return fake.handle
  })
  return {
    create,
    resume,
    agents,
    agentPrompts,
    get: (id: unknown) => agents.get(String(id))?.agent,
    lastCreateOptions: () => createOpts[createOpts.length - 1],
    lastResumeOptions: () => resumeOpts[resumeOpts.length - 1],
  }
}

/** 附件存储桩：`admitPromptContent` 把 image part 换为 attachment ref 记录调用。 */
export function makeAttachments() {
  const admitPromptContent = vi.fn(async (parts: readonly unknown[]): Promise<AdmittedPromptContentPart[]> =>
    parts.map((part) => {
      const p = part as { type: string; text?: string }
      if (p.type === 'text') return { type: 'text', text: p.text ?? '' }
      return {
        type: 'image',
        attachment: {
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 2,
          height: 2,
        },
      } as AdmittedPromptContentPart
    }))
  return {
    admitPromptContent,
    imageLimits: {},
    readImage: vi.fn(async () => { throw new Error('no bytes') }),
  }
}

/** 持久化桩：快照列表 + 只读打开回放预置事件。 */
export function makePersistence(eventsById: Map<string, unknown[]> = new Map()) {
  const list = vi.fn(async (): Promise<readonly SessionPersistenceSnapshot[]> =>
    [...eventsById.keys()].map(id => ({
      header: { id: SessionId(id), createdAt: 1000 },
      revision: 'r1',
      eventCount: (eventsById.get(id) ?? []).length,
    } as unknown as SessionPersistenceSnapshot)))
  const open = vi.fn(async (id: unknown) => ({
    read: vi.fn(async (offset?: number, length?: number) => {
      const events = (eventsById.get(String(id)) ?? []) as { seq: number }[]
      const start = offset ?? 0
      const slice = length === undefined ? events.slice(start) : events.slice(start, start + length)
      return { events: slice }
    }),
    close: vi.fn(async (): Promise<void> => {}),
  }))
  const stat = vi.fn(async () => undefined)
  const flush = vi.fn(async (): Promise<void> => {})
  return { list, open, stat, flush } as unknown as SessionPersistence & {
    list: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
  }
}

/** LLM 运行时桩：`resolveCallConfig` 记录路由校验。 */
export function makeLlm() {
  return {
    resolveCallConfig: vi.fn(async (config: unknown) => config),
    listProviders: vi.fn(() => [{ id: 'deepseek-official' }]),
  }
}

/** system-prompt 服务桩：捕获注册段。 */
export function makeSystemPrompt() {
  const sections: { name: string; order: number; interpolate?: boolean; text: unknown }[] = []
  return {
    sections,
    section: vi.fn((section: { name: string; order: number; interpolate?: boolean; text: unknown }) => {
      sections.push(section)
      return () => {}
    }),
    getSectionOrder: vi.fn(() => 0),
  }
}

/** 收集 stderr 诊断。 */
export function makeDiagnostic(): { (message: string): void; lines: string[] } {
  const lines: string[] = []
  const fn = (message: string): void => { lines.push(message) }
  fn.lines = lines
  return fn
}
