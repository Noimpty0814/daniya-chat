/**
 * Bridge —— daniya-bridge 协议客户端（spec §5.2）。
 *
 * 传输：harness 子进程 stdio，按行分帧 JSON-RPC 2.0。
 * - 请求：`{jsonrpc:'2.0', id, method, params}` → `{id, result}` / `{id, error:{code,message}}`
 * - 通知：`{jsonrpc:'2.0', method, params}`（无 id）→ onNotification 分发
 * - stdout 纯净给协议；stderr 由 process.ts 接管做日志。
 *
 * 类型化错误：
 * - BridgeTimeoutError   请求超过 timeoutMs 未收到响应
 * - BridgeProtocolError  对端返回 error 对象 / 帧非法
 * - BridgeTransportError 传输死亡（子进程退出/流关闭），所有 pending 请求以此失败
 */
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export type Json = Record<string, unknown>

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BridgeError'
  }
}
export class BridgeTimeoutError extends BridgeError {
  constructor(method: string, timeoutMs: number) {
    super('BRIDGE_TIMEOUT', `bridge 请求超时（${timeoutMs}ms）：${method}`)
  }
}
export class BridgeProtocolError extends BridgeError {
  constructor(message: string, public readonly rpcCode?: number) { super('BRIDGE_PROTOCOL', message) }
}
export class BridgeTransportError extends BridgeError {
  constructor(message = 'harness 连接中断') { super('BRIDGE_TRANSPORT', message) }
}

/** session.history/session.resume 返回的投影消息（daniya-bridge history.ts 的线格式） */
export interface BridgeMessage {
  id?: string
  /** 'tool' 为工具结果消息（含 tool-result 块），用户可见历史应过滤 */
  role: 'user' | 'assistant' | 'tool'
  content: string
  images?: { id?: string; dataUrl?: string; mediaType?: string; name?: string }[]
  /** dsh 只存名称与字节数，原路径不可还原 */
  files?: { name: string; bytes?: number }[]
  /** assistant 消息携带 tool-call 块；tool 消息回填 tool-result 块（含 ok） */
  toolCalls?: { callId: string; name: string; ok?: boolean }[]
  model?: string
  createdAt?: number
}

export interface SessionSummary { sessionId: string; title?: string; updatedAt?: number }

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

interface Pending {
  method: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class Bridge {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buf = ''
  private dead: BridgeTransportError | null = null
  private readonly emitter = new EventEmitter()
  private readonly onData = (chunk: Buffer | string): void => { this.push(chunk) }

  /**
   * @param input  协议入向流（子进程 stdout）
   * @param output 协议出向流（子进程 stdin）
   */
  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    input.on('data', this.onData)
    const onEnd = (): void => { this.transportDead(new BridgeTransportError('harness 输出流已关闭')) }
    input.once('end', onEnd)
    input.once('close', onEnd)
    input.once('error', (e) => { this.transportDead(new BridgeTransportError(`harness 输出流错误：${e.message}`)) })
    output.once('error', (e) => { this.transportDead(new BridgeTransportError(`harness 输入流错误：${e.message}`)) })
  }

  /** 发送 JSON-RPC 请求；超时/协议错/传输死时以对应类型化错误 reject。 */
  request<T = unknown>(method: string, params?: Json, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    const frame = JSON.stringify(params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeTimeoutError(method, timeoutMs))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
      this.output.write(frame + '\n', (err) => {
        if (!err) return
        const p = this.pending.get(id)
        if (p) {
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.reject(new BridgeTransportError(`harness 写入失败：${err.message}`))
        }
      })
    })
  }

  /** 订阅对端通知（stream.chunk / stream.end / tool.call / tool.result / error / agent.status / session.event）。 */
  onNotification(fn: (method: string, params: Json) => void): () => void {
    this.emitter.on('notification', fn)
    return () => { this.emitter.off('notification', fn) }
  }

  /** 传输死亡一次性通知（先于 pending reject 之外独立观察）。 */
  onClose(fn: (err: BridgeTransportError) => void): () => void {
    this.emitter.on('close', fn)
    return () => { this.emitter.off('close', fn) }
  }

  get isDead(): boolean { return this.dead !== null }

  /** 标记传输死亡：拒绝全部 pending，发出 close。幂等。 */
  transportDead(err?: BridgeTransportError): void {
    if (this.dead) return
    this.dead = err ?? new BridgeTransportError()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(this.dead)
    }
    this.pending.clear()
    this.emitter.emit('close', this.dead)
    this.emitter.removeAllListeners()
  }

  /** 主动断开（不杀进程；进程生命周期归 process.ts 管）。 */
  dispose(): void {
    this.input.off('data', this.onData)
    this.transportDead(new BridgeTransportError('bridge 已关闭'))
  }

  private push(chunk: Buffer | string): void {
    if (this.dead) return
    this.buf += chunk.toString('utf8')
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) return
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.trim()) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      // 非协议行（对端把日志写上了 stdout）：跳过不阻断后续帧
      console.warn('[bridge] 跳过无法解析的输出行:', line.slice(0, 200))
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
      const p = this.pending.get(id)
      if (!p) {
        console.warn('[bridge] 收到未知请求 id 的响应:', msg.id)
        return
      }
      this.pending.delete(id)
      clearTimeout(p.timer)
      const e = msg.error as { code?: unknown; message?: unknown } | undefined
      if (e && typeof e === 'object') {
        const text = typeof e.message === 'string' ? e.message : 'bridge 请求失败'
        p.reject(new BridgeProtocolError(text, typeof e.code === 'number' ? e.code : undefined))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string') {
      this.emitter.emit('notification', msg.method, (msg.params ?? {}) as Json)
    }
  }
}
