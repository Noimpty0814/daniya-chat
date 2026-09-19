import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { Bridge, BridgeProtocolError, BridgeTimeoutError, BridgeTransportError } from './bridge'

/** loopback 对：incoming = peer→bridge，outgoing = bridge→peer（收集 bridge 发出的帧） */
function makePair() {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const bridge = new Bridge(incoming, outgoing)
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
  const respondErr = (id: number, code: number, message: string) => incoming.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
  const notify = (method: string, params: unknown) => incoming.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { bridge, incoming, outgoing, sent, respond, respondErr, notify }
}

afterEach(() => { vi.restoreAllMocks() })

describe('Bridge 协议分帧', () => {
  it('request→result 往返：帧含 jsonrpc/id/method/params', async () => {
    const { bridge, sent, respond } = makePair()
    const p = bridge.request('initialize', { workdir: 'x' })
    const frame = sent()[0]
    expect(frame.jsonrpc).toBe('2.0')
    expect(frame.method).toBe('initialize')
    expect(frame.params).toEqual({ workdir: 'x' })
    respond(frame.id, { ok: true })
    await expect(p).resolves.toEqual({ ok: true })
    bridge.dispose()
  })

  it('响应被切成两半到达也能正确拼帧', async () => {
    const { bridge, incoming, sent } = makePair()
    const p = bridge.request('session.list', {})
    const id = sent()[0].id
    const line = JSON.stringify({ jsonrpc: '2.0', id, result: [{ sessionId: 's1' }] })
    incoming.write(line.slice(0, 10))
    incoming.write(line.slice(10) + '\n')
    await expect(p).resolves.toEqual([{ sessionId: 's1' }])
    bridge.dispose()
  })

  it('一个 chunk 内的多行响应按 id 各自归位（乱序）', async () => {
    const { bridge, incoming, sent } = makePair()
    const p1 = bridge.request('m1')
    const p2 = bridge.request('m2')
    const [f1, f2] = sent()
    incoming.write(JSON.stringify({ jsonrpc: '2.0', id: f2.id, result: 'r2' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: f1.id, result: 'r1' }) + '\n')
    await expect(p1).resolves.toBe('r1')
    await expect(p2).resolves.toBe('r2')
    bridge.dispose()
  })

  it('error 响应 → BridgeProtocolError（带 message 与 rpcCode）', async () => {
    const { bridge, sent, respondErr } = makePair()
    const p = bridge.request('prompt', { sessionId: 's' })
    respondErr(sent()[0].id, -32000, 'session not found')
    await expect(p).rejects.toSatisfy((e) => e instanceof BridgeProtocolError && e.message === 'session not found' && e.rpcCode === -32000)
    bridge.dispose()
  })

  it('请求超时 → BridgeTimeoutError', async () => {
    const { bridge } = makePair()
    await expect(bridge.request('slow', {}, { timeoutMs: 30 })).rejects.toBeInstanceOf(BridgeTimeoutError)
    bridge.dispose()
  })

  it('通知（无 id 帧）分发给 onNotification', async () => {
    const { bridge, notify } = makePair()
    const got: [string, unknown][] = []
    bridge.onNotification((m, p) => got.push([m, p]))
    notify('stream.chunk', { sessionId: 's', turn: 1, text: 'hi' })
    notify('tool.call', { sessionId: 's', callId: 'c', tool: 'pwsh' })
    expect(got).toEqual([
      ['stream.chunk', { sessionId: 's', turn: 1, text: 'hi' }],
      ['tool.call', { sessionId: 's', callId: 'c', tool: 'pwsh' }]
    ])
    bridge.dispose()
  })

  it('非 JSON 行被跳过且不阻断后续帧', async () => {
    const { bridge, incoming, sent } = makePair()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = bridge.request('m')
    const id = sent()[0].id
    incoming.write('这不是协议行\n')
    incoming.write(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }) + '\n')
    await expect(p).resolves.toBe('ok')
    expect(console.warn).toHaveBeenCalled()
    bridge.dispose()
  })

  it('输入流关闭 → pending 以 BridgeTransportError 失败，后续请求直接拒', async () => {
    const { bridge, incoming } = makePair()
    const closed = new Promise<unknown>(r => bridge.onClose(r))
    const p = bridge.request('never')
    incoming.end()
    await expect(p).rejects.toBeInstanceOf(BridgeTransportError)
    await expect(closed).resolves.toBeInstanceOf(BridgeTransportError)
    await expect(bridge.request('after')).rejects.toBeInstanceOf(BridgeTransportError)
    bridge.dispose()
  })

  it('transportDead 幂等：pending 只拒一次，close 只发一次', async () => {
    const { bridge } = makePair()
    const onClose = vi.fn()
    bridge.onClose(onClose)
    const p = bridge.request('x')
    bridge.transportDead()
    bridge.transportDead()
    await expect(p).rejects.toBeInstanceOf(BridgeTransportError)
    expect(onClose).toHaveBeenCalledTimes(1)
    bridge.dispose()
  })
})
