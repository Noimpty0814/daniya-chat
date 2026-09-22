import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { DaniyaBridge } from './client'
import type { BridgeNotification, BridgeNotificationMap } from './client'

/** loopback 对：incoming = peer→bridge，outgoing = bridge→peer（收集发出的帧） */
function makePair() {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const bridge = new DaniyaBridge(incoming, outgoing)
  const sentLines: string[] = []
  let buf = ''
  outgoing.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      sentLines.push(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  const sent = () => sentLines.map(l => JSON.parse(l))
  const respond = (id: number, result: unknown) => incoming.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  const notify = (method: string, params: unknown) => incoming.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { bridge, incoming, sent, respond, notify }
}

describe('DaniyaBridge 门面', () => {
  it('领域方法发正确帧：initialize/prompt 带参，无参方法不写 params 字段', async () => {
    const { bridge, sent, respond } = makePair()
    const p1 = bridge.initialize('D:/work', 'deepseek-chat')
    const p2 = bridge.sessions.create()
    const p3 = bridge.prompt('s-1', '你好', [{ data: 'aGk=', mimeType: 'image/png' }])
    const [f1, f2, f3] = sent()
    expect(f1).toMatchObject({ method: 'initialize', params: { workdir: 'D:/work', model: 'deepseek-chat' } })
    expect(f2.method).toBe('session.create')
    expect('params' in f2).toBe(false) // 无参方法不写 params 字段
    expect(f3).toMatchObject({ method: 'prompt', params: { sessionId: 's-1', text: '你好', images: [{ data: 'aGk=', mimeType: 'image/png' }] } })
    respond(f1.id, { ok: true })
    respond(f2.id, { sessionId: 'sess-1' })
    respond(f3.id, { messageId: 'msg-1' })
    await expect(p1).resolves.toEqual({ ok: true })
    await expect(p2).resolves.toEqual({ sessionId: 'sess-1' })
    await expect(p3).resolves.toEqual({ messageId: 'msg-1' })
    bridge.dispose()
  })

  it('prompt 空 images 不写线（与 ipc 旧行为一致）', async () => {
    const { bridge, sent, respond } = makePair()
    const p = bridge.prompt('s-1', 'hi', [])
    const f = sent()[0]
    expect(f.params).toEqual({ sessionId: 's-1', text: 'hi' })
    respond(f.id, { messageId: 'm' })
    await p
    bridge.dispose()
  })

  it('sessions.history 直接解 {messages} 信封', async () => {
    const { bridge, sent, respond } = makePair()
    const p = bridge.sessions.history('sess-1')
    const f = sent()[0]
    expect(f).toMatchObject({ method: 'session.history', params: { sessionId: 'sess-1' } })
    respond(f.id, { messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }] })
    await expect(p).resolves.toEqual([{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }])
    bridge.dispose()
  })

  it('逃生门重载：契约外方法与显式 T 仍可用', async () => {
    const { bridge, sent, respond } = makePair()
    const p = bridge.request<{ env: Record<string, string | null> }>('initialize', {})
    respond(sent()[0].id, { ok: true, env: { DSH_HOME: '/x' } })
    await expect(p).resolves.toEqual({ ok: true, env: { DSH_HOME: '/x' } })
    bridge.dispose()
  })

  it('on<M> 按 method 过滤并收窄 params；onAny 发判别联合整帧', async () => {
    const { bridge, notify } = makePair()
    const chunks: BridgeNotificationMap['stream.chunk'][] = []
    const all: BridgeNotification[] = []
    bridge.on('stream.chunk', p => chunks.push(p))
    bridge.onAny(n => all.push(n))
    notify('stream.chunk', { sessionId: 's', turn: 1, text: 'hi' })
    notify('agent.status', { sessionId: 's', status: 'idle' })
    notify('bogus.method', { x: 1 }) // 协议外帧：整帧透传到 default 分支语义
    expect(chunks).toEqual([{ sessionId: 's', turn: 1, text: 'hi' }])
    expect(all.map(n => n.method)).toEqual(['stream.chunk', 'agent.status', 'bogus.method'])
    bridge.dispose()
  })
})
