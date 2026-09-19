#!/usr/bin/env node
/**
 * T-5 验收冒烟：从 packaged 布局拉起 harness，验证 initialize → {ok:true}。
 *
 * 两条断言线：
 *  1. 结构：dist/win-unpacked/resources/harness/ 含 launch.mjs、
 *     profile/{package.json,cordis.patch.yml,node_modules}、daniya-bridge 为
 *     真实目录（含 lib/index.js）、全树零符号链接残留。
 *  2. 启动：复刻主进程 packaged 路径（process.ts ensureHarnessMaterialized +
 *     defaultHarnessSpec）——把 resources/harness cpSync 到临时可写目录
 *     <tmp>/app（loader 要写 profile/cordis.yml，resources 只读），再以
 *     DSH_HOME=<tmp>/home spawn `node <tmp>/app/launch.mjs`，走 stdio
 *     JSON-RPC：initialize{workdir,model} → 期望 {ok:true}；shutdown → 进程退出。
 *
 * 无需 DEEPSEEK_API_KEY：boot/initialize 不触碰模型（凭据仅在真实请求时需要）。
 *
 * 用法：node scripts/smoke-packaged-harness.mjs [harnessDir]
 *   harnessDir 默认 dist/win-unpacked/resources/harness；可传
 *   build/harness-bundle 直接验暂存产物。
 * 退出码 0 = 全过，1 = 任一断言失败。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harnessDir = path.resolve(repoRoot, process.argv[2] ?? path.join('dist', 'win-unpacked', 'resources', 'harness'))

let failed = false
const ok = (name, detail = '') => console.log(`PASS ${name}${detail ? ': ' + detail : ''}`)
const bad = (name, detail = '') => {
  failed = true
  console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`)
}

// ── 1. packaged 布局结构断言 ────────────────────────────────────────────────
const mustExist = [
  'launch.mjs',
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/node_modules/@deepseek-ai/dsh/package.json',
  'profile/node_modules/@deepseek-ai/dsh-app-boot/package.json',
  'profile/node_modules/daniya-bridge/package.json',
  'profile/node_modules/daniya-bridge/lib/index.js',
]
if (!fs.existsSync(harnessDir)) {
  bad('harness dir exists', harnessDir)
  process.exit(1)
}
for (const rel of mustExist) {
  fs.existsSync(path.join(harnessDir, rel)) ? ok(`exists ${rel}`) : bad(`exists ${rel}`)
}
const bridgeEntry = path.join(harnessDir, 'profile', 'node_modules', 'daniya-bridge')
if (fs.existsSync(bridgeEntry) && !fs.lstatSync(bridgeEntry).isSymbolicLink()) {
  ok('daniya-bridge is a real directory (junction dereferenced)')
} else {
  bad('daniya-bridge is a real directory', 'still a link or missing')
}
for (const rel of ['src', 'tests', 'node_modules']) {
  fs.existsSync(path.join(bridgeEntry, rel))
    ? bad(`bridge dev artifact absent: ${rel}`)
    : ok(`bridge dev artifact absent: ${rel}`)
}
let linkCount = 0
const countLinks = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) linkCount++
    else if (st.isDirectory()) countLinks(p)
  }
}
countLinks(harnessDir)
linkCount === 0 ? ok('no symlink remnants') : bad('no symlink remnants', `${linkCount} found`)
fs.existsSync(path.join(harnessDir, 'profile', 'cordis.yml'))
  ? bad('runtime cordis.yml excluded')
  : ok('runtime cordis.yml excluded')

// ── 2. 模拟 packaged 首启：物化到可写目录再 spawn（同 ensureHarnessMaterialized）─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-pack-smoke-'))
const appDir = path.join(tmp, 'app')
const dshHome = path.join(tmp, 'home')
console.log(`materializing ${harnessDir} -> ${appDir}`)
fs.mkdirSync(tmp, { recursive: true })
fs.cpSync(harnessDir, appDir, { recursive: true }) // 与 process.ts 相同的复制语义

// 与 defaultHarnessSpec 同款宿主解析：包内 runtime/node.exe 优先（B-7：
// electron-as-node 在 ConPTY 下无控制台，windows-acl runner 宿主必须真 Node）。
const bundledNode = path.join(appDir, 'runtime', 'node.exe')
const host = fs.existsSync(bundledNode) ? bundledNode : 'node'
fs.existsSync(bundledNode) ? ok('bundled runtime/node.exe exists') : bad('bundled runtime/node.exe exists')

const child = spawn(host, [path.join(appDir, 'launch.mjs')], {
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DANIYA_SETTINGS_FILE: path.join(dshHome, 'settings.json'),
    DANIYA_WORKDIR: tmp,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', (c) => {
  buf += c.toString('utf8')
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      bad('stdout stays JSON-RPC', `non-JSON line: ${line.slice(0, 120)}`)
      continue
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.res(msg.result)
      }
    } else {
      console.log(`  notify: ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 120)}`)
    }
  }
})
child.stderr.on('data', (c) => process.stderr.write(`[harness-stderr] ${c}`))

const req = (method, params, timeoutMs) =>
  new Promise((res, rej) => {
    const id = nextId++
    pending.set(id, { res, rej })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`timeout: ${method}`))
    }, timeoutMs).unref()
  })

try {
  // initialize 兼作就绪探测：boot 期间请求留在 stdin 缓冲，给足 boot 时间。
  const init = await req('initialize', { workdir: tmp, model: 'deepseek-chat' }, 90_000)
  init && init.ok === true
    ? ok('initialize', JSON.stringify(init))
    : bad('initialize', `unexpected result ${JSON.stringify(init)}`)
} catch (e) {
  bad('initialize', e.message)
}
try {
  await req('shutdown', {}, 10_000)
  ok('shutdown replied')
} catch (e) {
  bad('shutdown', e.message)
}
const exited = await Promise.race([
  new Promise((r) => child.once('exit', () => r(true))),
  new Promise((r) => setTimeout(() => r(false), 8_000)),
])
exited ? ok('process exited') : bad('process exited', 'still alive after shutdown')
if (!exited) child.kill('SIGKILL')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK')
process.exit(failed ? 1 : 0)
