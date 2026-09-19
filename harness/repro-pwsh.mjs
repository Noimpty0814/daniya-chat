// B-7 复现：真实 profile 里让模型调 pwsh，抓 tool.call/tool.result/error + stderr 全文
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// HARNESS_DIR 指向物化后的 harness 树（packaged 形态）时，宿主用其 runtime/node.exe；
// 否则用当前 node（dev 形态，与 defaultHarnessSpec 的 PATH 回退等价）。
const harnessDir = process.env.HARNESS_DIR || path.join(root, 'harness')
const host = process.env.HARNESS_HOST
  || (fs.existsSync(path.join(harnessDir, 'runtime', 'node.exe')) ? path.join(harnessDir, 'runtime', 'node.exe') : process.execPath)
console.log('host:', host, '| harness:', harnessDir)
const child = spawn(host, [path.join(harnessDir, 'launch.mjs')], {
  env: { ...process.env, DSH_HOME: path.join(root, '.dev-dsh-home'), DANIYA_WORKDIR: root },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', (c) => {
  buf += c.toString('utf8')
  for (;;) {
    const nl = buf.indexOf('\n'); if (nl < 0) return
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result) }
    } else if (['tool.call', 'tool.result', 'error', 'stream.end'].includes(msg.method)) {
      console.log('NOTIFY', msg.method, JSON.stringify(msg.params).slice(0, 400))
    }
  }
})
const errLog = fs.createWriteStream(path.join(root, 'harness', 'pwsh-stderr.log'))
child.stderr.on('data', c => { errLog.write(c); })

const req = (method, params, t = 30000) => new Promise((res, rej) => {
  const id = nextId++
  pending.set(id, { res, rej })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + method)) }, t).unref()
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

await req('initialize', { workdir: root, model: 'deepseek-flash' }, 90000)
const { sessionId } = await req('session.create', {})
console.log('session', sessionId)
await req('prompt', { sessionId, text: '请使用 pwsh 工具执行命令 echo HELLO-DANIYA，然后告诉我输出是什么。' })
await sleep(45000)
await req('shutdown', {}).catch(() => {})
await sleep(2000)
child.kill('SIGKILL')
console.log('--- stderr log written to harness/pwsh-stderr.log ---')
process.exit(0)
