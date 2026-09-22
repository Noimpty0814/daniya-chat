import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessRuntime, HarnessUnavailableError, ensureHarnessMaterialized, defaultHarnessSpec } from './process'
import type { BridgeNotification } from './client'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-bridge.mjs', import.meta.url))

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-harness-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function makeRuntime(overrides: Partial<ConstructorParameters<typeof HarnessRuntime>[0]> = {}) {
  return new HarnessRuntime({
    spec: { command: process.execPath, args: [FIXTURE] },
    dshHome: path.join(dir, 'dsh-home'),
    settingsFile: path.join(dir, 'settings.json'),
    getLaunchContext: () => ({ apiKey: 'sk-test', baseUrl: 'https://example.com', workDir: 'D:/work', model: 'm' }),
    ...overrides
  })
}

describe('HarnessRuntime 生命周期', () => {
  it('ensure 惰性启动：spawn + initialize 后返回活桥，二次 ensure 复用', async () => {
    const rt = makeRuntime()
    const b1 = await rt.ensure()
    expect(rt.isAlive).toBe(true)
    const b2 = await rt.ensure()
    expect(b2).toBe(b1)
    await rt.shutdown()
    expect(rt.isAlive).toBe(false)
  })

  it('env 注入：DSH_HOME / DANIYA_SETTINGS_FILE / DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DANIYA_WORKDIR', async () => {
    const settingsFile = path.join(dir, 'settings.json')
    const dshHome = path.join(dir, 'dsh-home')
    const rt = makeRuntime({ dshHome, settingsFile })
    const bridge = await rt.ensure()
    const r = await bridge.request<{ env: Record<string, string | null> }>('initialize', {})
    expect(r.env.DSH_HOME).toBe(dshHome)
    expect(r.env.DANIYA_SETTINGS_FILE).toBe(settingsFile)
    expect(r.env.DANIYA_WORKDIR).toBe('D:/work')
    expect(r.env.DEEPSEEK_API_KEY).toBe('sk-test')
    expect(r.env.DEEPSEEK_BASE_URL).toBe('https://example.com')
    // 宿主是真 Node 后不再需要 ELECTRON_RUN_AS_NODE（且不向子进程转发）
    expect(r.env.ELECTRON_RUN_AS_NODE).toBeNull()
    await rt.shutdown()
  })

  it('env 封堵：settings 无 key 时删除继承的 DEEPSEEK_API_KEY/BASE_URL/DANIYA_WORKDIR', async () => {
    const saved = {
      key: process.env.DEEPSEEK_API_KEY, url: process.env.DEEPSEEK_BASE_URL, wd: process.env.DANIYA_WORKDIR
    }
    process.env.DEEPSEEK_API_KEY = 'sk-machine-level'
    process.env.DEEPSEEK_BASE_URL = 'https://machine.example.com'
    process.env.DANIYA_WORKDIR = 'D:/machine-wd'
    try {
      const rt = makeRuntime({
        getLaunchContext: () => ({ apiKey: null, baseUrl: '', workDir: '', model: 'm' })
      })
      const bridge = await rt.ensure()
      const r = await bridge.request<{ env: Record<string, string | null> }>('initialize', {})
      expect(r.env.DEEPSEEK_API_KEY).toBeNull()
      expect(r.env.DEEPSEEK_BASE_URL).toBeNull()
      expect(r.env.DANIYA_WORKDIR).toBeNull()
      await rt.shutdown()
    } finally {
      if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key
      if (saved.url === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = saved.url
      if (saved.wd === undefined) delete process.env.DANIYA_WORKDIR; else process.env.DANIYA_WORKDIR = saved.wd
    }
  })

  it('通知经 setNotificationHandler 分发（prompt → stream.chunk/end）', async () => {
    const rt = makeRuntime()
    const events: BridgeNotification[] = []
    rt.setNotificationHandler(n => events.push(n))
    const bridge = await rt.ensure()
    const { sessionId } = await bridge.sessions.create()
    await bridge.prompt(sessionId, 'hi')
    await vi.waitFor(() => {
      expect(events.some(n => n.method === 'stream.end')).toBe(true)
    }, { timeout: 3000 })
    expect(events.some(n => n.method === 'stream.chunk')).toBe(true)
    await rt.shutdown()
  })

  it('崩溃检测：子进程被杀 → onTransportDown 回调 → 下次 ensure 重启新进程', async () => {
    const rt = makeRuntime()
    const down = vi.fn()
    rt.setTransportDownHandler(down)
    const b1 = await rt.ensure()
    const pid1 = (rt as unknown as { child: { pid?: number } }).child?.pid
    ;(rt as unknown as { child: { kill(): void } }).child?.kill()
    await vi.waitFor(() => expect(down).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(b1.isDead).toBe(true)
    const b2 = await rt.ensure()
    expect(b2).not.toBe(b1)
    const pid2 = (rt as unknown as { child: { pid?: number } }).child?.pid
    expect(pid2).not.toBe(pid1)
    await rt.shutdown()
  })

  it('连续两次启动失败 → HarnessUnavailableError 且 isUnavailable 锁存', async () => {
    const rt = makeRuntime({ spec: { command: process.execPath, args: [path.join(dir, '不存在的脚本.js')] } })
    await expect(rt.ensure()).rejects.toBeInstanceOf(HarnessUnavailableError)
    expect(rt.isUnavailable).toBe(true)
    await expect(rt.ensure()).rejects.toBeInstanceOf(HarnessUnavailableError)
  })

  it('shutdown：协议层 shutdown 应答后进程退出，重复调用安全', async () => {
    const rt = makeRuntime()
    await rt.ensure()
    const t0 = Date.now()
    await rt.shutdown()
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(rt.isAlive).toBe(false)
    await rt.shutdown() // 幂等
  })

  it('shutdown 不触发 onTransportDown（正常排空不算崩溃）', async () => {
    const rt = makeRuntime()
    const down = vi.fn()
    rt.setTransportDownHandler(down)
    await rt.ensure()
    await rt.shutdown()
    expect(down).not.toHaveBeenCalled()
  })

  it('并发 ensure 共享同一次启动（只 spawn 一次）', async () => {
    const rt = makeRuntime()
    const [b1, b2] = await Promise.all([rt.ensure(), rt.ensure()])
    expect(b1).toBe(b2)
    await rt.shutdown()
  })
})

describe('defaultHarnessSpec 宿主解析（B-7：必须是真 Node，不能是 electron-as-node）', () => {
  it('dev：无 runtime/node.exe → 回退 PATH 上的 node', async () => {
    const appDir = path.join(dir, 'app')
    fs.mkdirSync(path.join(appDir, 'harness'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'harness', 'launch.mjs'), '// x')
    const spec = await defaultHarnessSpec({ isPackaged: false, appDir, resourcesPath: '', dshHome: path.join(dir, 'home') })
    expect(spec.command).toBe('node')
    expect(spec.args[0]).toBe(path.join(appDir, 'harness', 'launch.mjs'))
  })

  it('runtime/node.exe 存在 → 以它为宿主（packaged 物化后的形态）', async () => {
    const appDir = path.join(dir, 'app')
    const harnessDir = path.join(appDir, 'harness')
    fs.mkdirSync(path.join(harnessDir, 'runtime'), { recursive: true })
    fs.writeFileSync(path.join(harnessDir, 'launch.mjs'), '// x')
    fs.writeFileSync(path.join(harnessDir, 'runtime', 'node.exe'), 'bin')
    const spec = await defaultHarnessSpec({ isPackaged: false, appDir, resourcesPath: '', dshHome: path.join(dir, 'home') })
    expect(spec.command).toBe(path.join(harnessDir, 'runtime', 'node.exe'))
  })

  it('packaged：物化树缺 runtime/node.exe → HarnessUnavailableError', async () => {
    const resDir = path.join(dir, 'resources', 'harness')
    fs.mkdirSync(resDir, { recursive: true })
    fs.writeFileSync(path.join(resDir, 'launch.mjs'), '// x') // 无 .stamp：存在性路径，仍要求 node.exe
    await expect(defaultHarnessSpec({
      isPackaged: true, appDir: '', resourcesPath: path.join(dir, 'resources'), dshHome: path.join(dir, 'home')
    })).rejects.toBeInstanceOf(HarnessUnavailableError)
  })
})

describe('ensureHarnessMaterialized', () => {
  it('模板不存在 → HarnessUnavailableError', async () => {
    await expect(ensureHarnessMaterialized(path.join(dir, '没有模板'), path.join(dir, 'target')))
      .rejects.toBeInstanceOf(HarnessUnavailableError)
  })

  it('首 run 拷贝 harness 目录到可写目标，二次调用跳过', async () => {
    const tpl = path.join(dir, 'tpl')
    fs.mkdirSync(tpl, { recursive: true })
    fs.writeFileSync(path.join(tpl, 'launch.mjs'), '// x')
    fs.writeFileSync(path.join(tpl, 'cordis.patch.yml'), '# x')
    const target = path.join(dir, 'target')
    const p1 = await ensureHarnessMaterialized(tpl, target)
    expect(p1).toBe(target)
    expect(fs.existsSync(path.join(p1, 'cordis.patch.yml'))).toBe(true)
    fs.writeFileSync(path.join(p1, 'marker.txt'), 'keep')
    const p2 = await ensureHarnessMaterialized(tpl, target)
    expect(fs.existsSync(path.join(p2, 'marker.txt'))).toBe(true) // 未重拷
  })

  it('.stamp 一致复用、不一致整树重拷（升级覆盖安装面）', async () => {
    const tpl = path.join(dir, 'tpl')
    fs.mkdirSync(tpl, { recursive: true })
    fs.writeFileSync(path.join(tpl, 'launch.mjs'), '// v1')
    fs.writeFileSync(path.join(tpl, '.stamp'), 'stamp-v1')
    const target = path.join(dir, 'target')

    await ensureHarnessMaterialized(tpl, target)
    fs.writeFileSync(path.join(target, 'marker.txt'), 'keep')
    expect(await ensureHarnessMaterialized(tpl, target)).toBe(target)
    expect(fs.existsSync(path.join(target, 'marker.txt'))).toBe(true) // 同戳：复用

    fs.writeFileSync(path.join(tpl, '.stamp'), 'stamp-v2') // 模板升级
    await ensureHarnessMaterialized(tpl, target)
    expect(fs.existsSync(path.join(target, 'marker.txt'))).toBe(false) // 戳不同：重拷
    expect(fs.readFileSync(path.join(target, '.stamp'), 'utf8')).toBe('stamp-v2')
  })

  it('模板有戳而已物化树无戳 → 视为旧版整树重拷', async () => {
    const tpl = path.join(dir, 'tpl')
    fs.mkdirSync(tpl, { recursive: true })
    fs.writeFileSync(path.join(tpl, 'launch.mjs'), '// v1')
    fs.writeFileSync(path.join(tpl, '.stamp'), 'stamp-v1')
    const target = path.join(dir, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'launch.mjs'), '// old') // 旧物化：无 .stamp
    fs.writeFileSync(path.join(target, 'old-only.txt'), 'old')

    await ensureHarnessMaterialized(tpl, target)
    expect(fs.existsSync(path.join(target, 'old-only.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(target, '.stamp'), 'utf8')).toBe('stamp-v1')
  })

  it('入口清扫遗留 <target>.tmp-* staging（上次被杀进程的残骸，B-8）', async () => {
    const tpl = path.join(dir, 'tpl')
    fs.mkdirSync(tpl, { recursive: true })
    fs.writeFileSync(path.join(tpl, 'launch.mjs'), '// v1')
    fs.writeFileSync(path.join(tpl, '.stamp'), 'stamp-v1')
    const target = path.join(dir, 'target')
    // 场景：上次升级物化被杀 → 残留 staging；且已物化树戳一致（本次本可复用）
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'launch.mjs'), '// ok')
    fs.writeFileSync(path.join(target, '.stamp'), 'stamp-v1')
    const stale = `${target}.tmp-32012`
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'partial'), 'x')

    await ensureHarnessMaterialized(tpl, target)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(path.join(target, 'launch.mjs'))).toBe(true) // 复用路径未动
  })

  it('物化期间回调 active true→false；复用路径不触发', async () => {
    const tpl = path.join(dir, 'tpl')
    fs.mkdirSync(tpl, { recursive: true })
    fs.writeFileSync(path.join(tpl, 'launch.mjs'), '// v1')
    fs.writeFileSync(path.join(tpl, '.stamp'), 'stamp-v1')
    const target = path.join(dir, 'target')
    const seen: boolean[] = []
    const cb = (a: boolean): void => { seen.push(a) }
    await ensureHarnessMaterialized(tpl, target, cb)
    expect(seen).toEqual([true, false])
    await ensureHarnessMaterialized(tpl, target, cb) // 同戳复用
    expect(seen).toEqual([true, false])
  })
})
