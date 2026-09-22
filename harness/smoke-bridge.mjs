// 协议冒烟：真实 launch.mjs + daniya-bridge lib，无 LLM key 下验证协议面。
// 用法: node harness/smoke-bridge.mjs [harness-root]   （需要 DSH_HOME 可写；默认 .dev-dsh-home）
//   harness-root 默认 <repo>/harness；启动 <harness-root>/launch.mjs，
//   即 boot <harness-root>/profile 树（launch.mjs 的 profile 相对自身目录解析）。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'harness')
const child = spawn(process.execPath, [path.join(harnessRoot, 'launch.mjs')], {
  env: {
    ...process.env,
    DSH_HOME: process.env.DSH_HOME ?? path.join(root, '.dev-dsh-home'),
    DANIYA_SETTINGS_FILE: process.env.DANIYA_SETTINGS_FILE ?? path.join(root, '.dev-dsh-home', 'settings.json'),
    DANIYA_WORKDIR: root
  },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buf = ''
const pending = new Map()
const notes = []
let nextId = 1
child.stdout.on('data', (c) => {
  buf += c.toString('utf8')
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { console.log('NONJSON:', line.slice(0, 120)); continue }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.res(msg.result) }
    } else {
      notes.push(msg)
      console.log('  notify:', msg.method, JSON.stringify(msg.params ?? {}).slice(0, 160))
    }
  }
})
child.stderr.on('data', (c) => process.stderr.write('[stderr] ' + c))

const req = (method, params, timeoutMs = 15000) => new Promise((res, rej) => {
  const id = nextId++
  pending.set(id, { res, rej })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  setTimeout(() => { if (pending.delete(id)) rej(new Error(`timeout: ${method}`)) }, timeoutMs).unref()
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`PASS ${name}:`, JSON.stringify(r).slice(0, 200)); return r }
  catch (e) { console.log(`FAIL ${name}:`, e.message); return null }
}

// initialize 兼作就绪探测：bridge 就绪前请求留在 stdin 缓冲，给足 boot 时间
await step('initialize', () => req('initialize', { workdir: root, model: 'deepseek-chat' }, 90000))
const created = await step('session.create', () => req('session.create', {}))
const sessionId = created?.sessionId
await step('session.list', () => req('session.list', {}))
if (sessionId) {
  await step('session.history(empty)', () => req('session.history', { sessionId }))
  const p = await step('prompt(no key → enqueue)', () => req('prompt', { sessionId, text: '你好' }))
  if (p) {
    console.log('  …等待 8s 收集通知（无 key 应见 error，有 key 应见 stream.*）')
    await sleep(8000)
    await step('cancel', () => req('cancel', { sessionId }))
    await sleep(1000)
  }
  await step('session.resume', () => req('session.resume', { sessionId }))
  await step('session.history(after)', () => req('session.history', { sessionId }))
  await step('session.delete', () => req('session.delete', { sessionId }))
}
await step('shutdown', () => req('shutdown', {}))
const exited = await Promise.race([new Promise(r => child.once('exit', () => r(true))), sleep(5000).then(() => false)])
console.log(exited ? 'PASS process exited' : 'FAIL process still alive')
if (!exited) child.kill('SIGKILL')
const notifyKinds = [...new Set(notes.map(n => n.method))]
console.log('notification kinds seen:', JSON.stringify(notifyKinds))
process.exit(exited ? 0 : 1)
