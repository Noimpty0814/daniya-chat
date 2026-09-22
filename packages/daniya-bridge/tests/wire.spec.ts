/**
 * 线格式集成测试：真实 `JsonRpcLineTransport` + `apply()` 全程接线，
 * PassThrough 双向流验证请求/响应/通知帧、EOF 退出与 stdout 纯净。
 *
 * 注意：传输按行并发分派（与 sdk 参照一致）——测试逐个请求并等响应，
 * 与真实 Electron 客户端的串行调用习惯一致。
 *
 * @module daniya-bridge/tests/wire
 */

import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { internals } from '@deepseek-ai/dsh-cmdline'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.js'
import {
  makeAgents,
  makeAttachments,
  makeDiagnostic,
  makeLlm,
  makePersistence,
  makeSystemPrompt,
} from './helpers.js'

const WORKDIR = 'D:\\Agents\\daniya-chat'

interface WireHarness {
  ctx: Context
  input: PassThrough
  output: PassThrough
  frames: Record<string, unknown>[]
  stderrLines: string[]
  exit: ReturnType<typeof vi.fn>
  appExit: ReturnType<typeof vi.fn>
  commitReady: () => void
  agents: ReturnType<typeof makeAgents>
  store: SessionStore
  diagnostic: ReturnType<typeof makeDiagnostic>
}

function wireHarness(): WireHarness {
  const ctx = new Context()
  const store = new SessionStore(ctx)
  const agents = makeAgents(store)
  const input = new PassThrough()
  const output = new PassThrough()
  const stderrLines: string[] = []
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrLines.push(String(chunk))
      cb()
    },
  })
  const exit = vi.fn()
  const appExit = vi.fn()
  let readyListener: (() => void) | undefined
  const appReady = {
    onReady: vi.fn((listener: () => void) => {
      readyListener = listener
      return () => { readyListener = undefined }
    }),
  }
  ctx.provide('agents', agents)
  ctx.provide('attachments', makeAttachments())
  ctx.provide('systemPrompt', makeSystemPrompt())
  ctx.provide('sessionPersistence', makePersistence())
  ctx.provide('llm', makeLlm())
  ctx.provide('appExit', appExit)
  ctx.provide('appReady', appReady)
  ctx.provide('loader', { await: async () => {} })
  const diagnostic = makeDiagnostic()
  // exitOnStdinEnd 绑 internals.stdin：须在 apply 前替换为本测试输入流。
  internals.stdin = input
  apply(ctx, {
    settingsFile: '',
    workdir: WORKDIR,
    input,
    output,
    stderr,
    exit,
  })
  let buffered = ''
  const frames: Record<string, unknown>[] = []
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    for (;;) {
      const nl = buffered.indexOf('\n')
      if (nl < 0) break
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim().length > 0) frames.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  return {
    ctx,
    input,
    output,
    frames,
    stderrLines,
    exit,
    appExit,
    commitReady: () => readyListener?.(),
    agents,
    store,
    diagnostic,
  }
}

const originalStdin = internals.stdin

afterEach(() => {
  internals.stdin = originalStdin
})

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** 写一条请求并等其响应帧到达（并发分派下按 id 匹配）。 */
async function call(h: WireHarness, id: number, method: string, params?: object): Promise<Record<string, unknown>> {
  h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
  for (let i = 0; i < 50; i++) {
    const index = h.frames.findIndex(frame => frame.id === id)
    if (index >= 0) return h.frames.splice(index, 1)[0]
    await settle()
  }
  throw new Error(`no response frame for ${method} (id=${id})`)
}

describe('线格式请求/响应', () => {
  it('initialize + session.create 经行帧往返', async () => {
    const h = wireHarness()
    expect(await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'deepseek-chat' }))
      .toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    const created = await call(h, 2, 'session.create')
    expect(String((created.result as { sessionId: string }).sessionId)).toMatch(/^daniya-/)
  })

  it('非法 JSON 行被忽略；未知方法回 -32603；无会话 prompt 回错', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    h.input.write('not json {{{\n')
    const unknown = await call(h, 2, 'no.such.method')
    expect(unknown.error).toMatchObject({ code: -32603 })
    const prompted = await call(h, 3, 'prompt', { sessionId: 'ghost', text: 'x' })
    expect((prompted.error as { message: string }).message).toContain('unknown session')
  })

  it('契约外字段的请求帧仍被运行时防御拒绝（类型不替代校验）', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    // sessionId 非 string：协议类型契约之外的载荷由 handler 的 typeof 防御兜住
    const badHistory = await call(h, 2, 'session.history', { sessionId: 42 })
    expect((badHistory.error as { message: string }).message).toContain('sessionId')
    // prompt 的 text 非 string 同样被拒（先于 unknown session 检查抛出 TypeError）
    const badPrompt = await call(h, 3, 'prompt', { sessionId: 'x', text: 42 })
    expect((badPrompt.error as { message: string }).message).toContain('text')
  })

  it('契约外字段的通知帧被静默丢弃，服务不受影响', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    // 无 id 帧属通知：server 不订阅入向通知，传输层直接丢弃——这就是运行时防御面。
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'bogus.notify', params: { n: 42 } })}\n`)
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'error', params: { message: 42 } })}\n`)
    await settle()
    expect(h.frames).toEqual([])
    // 畸形通知没有污染服务面：后续正常请求仍完整往返。
    expect(await call(h, 2, 'session.list')).toEqual({ jsonrpc: '2.0', id: 2, result: [] })
  })

  it('事件通知以一行一帧写到输出流', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    await call(h, 2, 'session.create')
    const fake = [...h.agents.agents.values()][0]
    h.ctx.emit('agent/status', { agent: fake.agent, status: 'busy' })
    await settle()
    expect(h.frames).toEqual([
      {
        jsonrpc: '2.0',
        method: 'agent.status',
        params: { sessionId: String(fake.agent.session.id), status: 'busy' },
      },
    ])
  })
})

describe('退出路径', () => {
  it('stdin EOF → appReady 提交后 appExit(0)（launcher 有界退出）', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    h.input.end()
    await settle()
    // EOF 已挂 ready 监听但尚未提交：exit 未请求
    expect(h.appExit).not.toHaveBeenCalled()
    h.commitReady()
    expect(h.appExit).toHaveBeenCalledWith(0)
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('shutdown 响应先写回，随后排空→dispose 根 fiber→exit(0)', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    await call(h, 2, 'session.create')
    const shutdown = await call(h, 3, 'shutdown')
    expect(shutdown).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } })
    for (let i = 0; i < 50 && !h.exit.mock.calls.length; i++) await settle()
    expect(h.exit).toHaveBeenCalledWith(0)
    // 根 fiber dispose 级联跑过效果清理：agent handle 已 dispose
    expect([...h.agents.agents.values()].every(a => a.disposed() > 0)).toBe(true)
  })
})

describe('stdout 纯净', () => {
  it('诊断只进 stderr，输出流仅协议帧', async () => {
    const h = wireHarness()
    await call(h, 1, 'initialize', { workdir: WORKDIR, model: 'm' })
    const deleted = await call(h, 2, 'session.delete', { sessionId: 'ghost' })
    expect(deleted).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } })
    // frames 的 JSON.parse 已证明输出流每行都是合法 JSON-RPC 帧
    expect(h.stderrLines.some(l => l.includes('ghost'))).toBe(true)
  })
})
