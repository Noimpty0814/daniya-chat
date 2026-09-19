#!/usr/bin/env node
/**
 * fake-bridge —— daniya-bridge 协议子集 mock 进程（T-3 测试夹具）。
 *
 * 按行分帧 JSON-RPC 2.0（stdin 收 / stdout 发），实现 spec §5.2 子集：
 *   initialize / session.create / session.resume / session.list / session.history /
 *   session.delete / prompt / cancel / shutdown
 * 通知：stream.chunk / stream.end / tool.call / tool.result / error / agent.status。
 *
 * prompt 剧本（按 text 内容分派，保持协议纯净、可复现）：
 *   默认          → chunk '{EMO:happy}你好，' + chunk '世界' + stream.end
 *   含 '[tool]'   → 两段 chunk 之间插入 tool.call + tool.result
 *   含 '[toolturn]' → 真实多步 turn：chunk + stream.end（中间 assistant 消息）
 *                    → tool.call/tool.result → chunk + stream.end → idle（B-6 回归面）
 *   含 '[slow]'   → 只发 chunk 不发 stream.end（配合 cancel/停止测试）
 *   含 '[error]'  → error 通知（无 stream.end）
 *   含 '[proposal]' → chunk 内含 ```daniya-file 提案块 + stream.end
 *
 * 会话态：session.create 登记内存表；prompt 的 user 文本与流完的 assistant 原文
 * 进该 session 的 history（供 getMessages/CRUD 测试）；session.list 返回登记表。
 * 环境变量 FAKE_BRIDGE_LOG=1 时把收发帧打到 stderr 便于调试。
 */
import readline from 'node:readline'

const log = (...a) => { if (process.env.FAKE_BRIDGE_LOG) console.error('[fake-bridge]', ...a) }

let msgSeq = 0
let sessSeq = 0
const sessions = new Map() // sessionId → { sessionId, title, createdAt, updatedAt, messages, openTurn, pendingText }

const send = (obj) => { const line = JSON.stringify(obj); log('→', line); process.stdout.write(line + '\n') }
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const respondError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

function ensureSession(id) {
  return sessions.get(id) ?? null
}

function runTurn(sess, text) {
  // 全部通知延迟到响应帧之后发出（真实桥的入队语义）
  setImmediate(() => {
    sess.openTurn = true
    notify('agent.status', { sessionId: sess.sessionId, status: 'running' })
    if (text.includes('[error]')) {
      notify('error', { sessionId: sess.sessionId, message: 'HTTP 401: invalid api key' })
      sess.openTurn = false
      notify('agent.status', { sessionId: sess.sessionId, status: 'idle' })
      return
    }
    if (text.includes('[toolturn]')) {
      // 真实桥的回合内多帧：带工具调用的中间 assistant 消息先提交（stream.end），
      // 工具事件随后，最终答复是第二条 assistant 消息（再一个 stream.end）。
      sess.pendingText = ''
      const mid = '{EMO:happy}我先查一下。'
      sess.pendingText += mid
      notify('stream.chunk', { sessionId: sess.sessionId, turn: 1, text: mid })
      notify('stream.end', { sessionId: sess.sessionId, turn: 1 })
      notify('tool.call', { sessionId: sess.sessionId, callId: 'call-1', tool: 'web_search', argsPreview: '{"q":"x"}' })
      notify('tool.result', { sessionId: sess.sessionId, callId: 'call-1', ok: true, preview: 'hit-1' })
      const fin = '查完了：结果是 X。'
      sess.pendingText += fin
      notify('stream.chunk', { sessionId: sess.sessionId, turn: 1, text: fin })
      endTurn(sess, false)
      return
    }
    const proposalMatch = text.match(/\[proposal(?::([^\]]+))?\]/)
    const proposalPath = proposalMatch?.[1] || 'proposal-target.txt'
    const chunks = proposalMatch
      ? ['{EMO:happy}好的，帮你改一下。\n\n```daniya-file\n{"path":' + JSON.stringify(proposalPath) + ',"content":"new-content"}\n```\n改完了。']
      : ['{EMO:happy}你好，', '世界']
    sess.pendingText = ''
    for (const c of chunks) {
      sess.pendingText += c
      notify('stream.chunk', { sessionId: sess.sessionId, turn: 1, text: c })
    }
    if (text.includes('[tool]')) {
      notify('tool.call', { sessionId: sess.sessionId, callId: 'call-1', tool: 'pwsh', argsPreview: 'Get-ChildItem' })
      notify('tool.result', { sessionId: sess.sessionId, callId: 'call-1', ok: true, preview: 'file1.txt' })
    }
    if (text.includes('[slow]')) return // 无 stream.end：等 cancel
    endTurn(sess, false)
  })
}

function endTurn(sess, aborted) {
  notify('stream.end', { sessionId: sess.sessionId, turn: 1, aborted })
  notify('agent.status', { sessionId: sess.sessionId, status: 'idle' })
  if (!aborted && sess.pendingText) {
    sess.messages.push({ id: 'hm-' + (++msgSeq), role: 'assistant', content: sess.pendingText, createdAt: Date.now() })
  }
  sess.pendingText = ''
  sess.openTurn = false
  sess.updatedAt = Date.now()
}

const handlers = {
  // 回显测试关心的注入 env（协议契约外的附加字段，供 env 注入断言）
  'initialize': () => ({
    ok: true,
    env: {
      DSH_HOME: process.env.DSH_HOME ?? null,
      DANIYA_SETTINGS_FILE: process.env.DANIYA_SETTINGS_FILE ?? null,
      DANIYA_WORKDIR: process.env.DANIYA_WORKDIR ?? null,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? null,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null
    }
  }),
  'session.create': () => {
    const sessionId = 'sess-' + (++sessSeq)
    const now = Date.now()
    sessions.set(sessionId, { sessionId, title: '', createdAt: now, updatedAt: now, messages: [], openTurn: false, pendingText: '' })
    return { sessionId }
  },
  'session.resume': (p) => {
    const s = ensureSession(p.sessionId)
    if (!s) throw new Error('session not found')
    return { ok: true, history: s.messages }
  },
  'session.list': () => [...sessions.values()].map(s => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt })),
  'session.history': (p) => {
    const s = ensureSession(p.sessionId)
    if (!s) throw new Error('session not found')
    return { messages: s.messages }
  },
  'session.delete': (p) => {
    sessions.delete(p.sessionId)
    return { ok: true }
  },
  'prompt': (p) => {
    const s = ensureSession(p.sessionId)
    if (!s) throw new Error('session not found')
    const messageId = 'msg-' + (++msgSeq)
    s.messages.push({ id: messageId, role: 'user', content: p.text ?? '', createdAt: Date.now() })
    runTurn(s, p.text ?? '')
    return { messageId }
  },
  'cancel': (p) => {
    const s = ensureSession(p.sessionId)
    if (s?.openTurn) setImmediate(() => endTurn(s, true))
    return { ok: true }
  },
  'shutdown': () => {
    setTimeout(() => process.exit(0), 20)
    return { ok: true }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  log('←', line)
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined || msg.id === null) return // 只收请求；通知不回
  const fn = handlers[msg.method]
  if (!fn) { respondError(msg.id, 'method not found: ' + msg.method); return }
  try {
    respond(msg.id, fn(msg.params ?? {}) ?? {})
  } catch (e) {
    respondError(msg.id, e instanceof Error ? e.message : String(e))
  }
})
rl.on('close', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
