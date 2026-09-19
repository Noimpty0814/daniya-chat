/**
 * HarnessRuntime —— dsh 运行时子进程的 spawn 管理与协议接入。
 *
 * 职责（spec §3/§6/§10、ticket T-3）：
 * - spawn：以真正的 Node 运行时跑 `node harness/launch.mjs`（T-1 交付的
 *   app-owned launcher，就地加载 profile）；宿主解析见 defaultHarnessSpec——
 *   electron-as-node 在 ConPTY 下无控制台，windows-acl runner 以 execPath 为
 *   宿主会让 pwsh 工具静默死（B-7），故 packaged 自带 runtime/node.exe。
 *   env 注入 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DSH_HOME /
 *   DANIYA_SETTINGS_FILE / DANIYA_WORKDIR（凭据经 getLaunchContext 由调用方解密注入，不明文落盘）。
 * - 惰性启动：首个 startReply / getMessages 需要时 ensure()；应用启动不预热。
 * - initialize 握手（10s 超时，spec §10）；启动失败重试一次，仍败置
 *   `unavailable`，由 IPC 层映射"运行时不可用，请重启应用"。
 * - 崩溃检测：child exit / 传输死亡 → 丢弃桥、回调 onTransportDown；
 *   下一次 ensure() 重新拉起（每次 ensure 自带一次重启额度）。
 * - 排空阶梯（参照 packages/sdk/client/src/dispose.ts 语义）：
 *   `shutdown` 请求 → 等待退出 → stdin EOF → SIGTERM（POSIX）→ SIGKILL，逐级有界等待。
 * - stdio：stdout = 协议（Bridge 接管），stderr 加 `[harness]` 前缀转发 console。
 *
 * 启动命令以 harness/README.md 为准（T-1 已交付）：
 * `node harness/launch.mjs` —— launch.mjs 用 loadProfileDirectory + runProfile
 * 就地加载仓库内 profile（方案 C），stdin/stdout 归 bridge 协议，stdin EOF → shutdown。
 * 不用 `dsh --profile`（名字解析限 $DSH_HOME/profiles 下，见 README §Startup approach）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Bridge, BridgeTransportError, type Json } from './bridge'

export interface HarnessLaunchContext {
  apiKey: string | null
  baseUrl: string
  workDir: string
  model: string
}

export interface HarnessSpawnSpec {
  command: string
  args: string[]
}

/** spawn 目标：可直接给值或惰性求值（首 ensure 才解析 profile 物化路径）；函数源可异步（packaged 物化拷贝）。 */
export type HarnessSpawnSpecSource = HarnessSpawnSpec | (() => HarnessSpawnSpec | Promise<HarnessSpawnSpec>)

export interface HarnessRuntimeOptions {
  /** spawn 目标：默认见 defaultHarnessSpec()；测试注入 fake-bridge 路径 */
  spec: HarnessSpawnSpecSource
  /** DSH_HOME（userData/harness）；会话日志/patch 层的隔离数据面，launch.mjs 就地加载 profile */
  dshHome: string
  /** DANIYA_SETTINGS_FILE：bridge 每轮读它做人设热更新 */
  settingsFile: string
  /** 每次启动前调用：取最新 settings（解密 key、baseUrl、workDir、model） */
  getLaunchContext(): HarnessLaunchContext
  /** 额外 env 覆盖（测试用） */
  env?: Record<string, string | undefined>
  initializeTimeoutMs?: number
  /** shutdown 请求响应等待 */
  shutdownRequestTimeoutMs?: number
  /** shutdown 应答后等待进程退出的窗口 */
  shutdownExitGraceMs?: number
  /** stdin EOF 后等待退出的窗口 */
  eofGraceMs?: number
  /** SIGTERM/SIGKILL 后等待退出的窗口 */
  killGraceMs?: number
  stderrPrefix?: string
}

export class HarnessUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('harness 运行时不可用', { cause })
    this.name = 'HarnessUnavailableError'
  }
}

export const LAUNCHER_NAME = 'launch.mjs'

/**
 * 解析默认 spawn 目标：`<node> <harnessDir>/launch.mjs`（harness/README.md §Startup approach）。
 *
 * 宿主必须是真正的 Node 运行时而非 electron-as-node：windows-acl 沙箱把
 * `[process.execPath, runner.js]` 放进 ConPTY 作为 pwsh 的宿主，而 GUI 子系统的
 * electron.exe 在 ConPTY 下拿不到控制台——整条沙箱化 shell 链静默无输出（B-7）。
 * 因此 packaged 形态把 node.exe 打进 `runtime/` 随 harness 物化（prepare-harness.mjs
 * 复制构建机 process.execPath，即安装 profile 所用的同一 Node），dev 形态退回 PATH
 * 上的 `node`（npm 运行时已保证存在）。
 *
 * dev：`harness/` 直接在仓库内，就地加载 profile；
 * pack：构建期把 harness/（含 profile/node_modules + runtime/node.exe）打入
 * resources，首 run 物化到 `<dshHome>/app` 下可写目录——loader 会往 profile
 * 目录写 cordis.yml，resources 里不可写。
 */
export async function defaultHarnessSpec(opts: {
  isPackaged: boolean
  appDir: string
  resourcesPath: string
  dshHome: string
  /** 物化大拷贝进行中回调（B-8：升级首启拷贝 GB 级，给 UI 一个可见状态） */
  onMaterialize?: (active: boolean) => void
}): Promise<HarnessSpawnSpec> {
  const harnessDir = opts.isPackaged
    ? await ensureHarnessMaterialized(path.join(opts.resourcesPath, 'harness'), path.join(opts.dshHome, 'app'), opts.onMaterialize)
    : path.join(opts.appDir, 'harness')
  if (!fs.existsSync(path.join(harnessDir, LAUNCHER_NAME))) {
    // dev 下 harness/launch.mjs 必然在仓库内；缺失说明 T-1 交付不完整——报错由 ensure() 走不可用路径
    throw new HarnessUnavailableError(new Error(`harness 启动器不存在：${path.join(harnessDir, LAUNCHER_NAME)}`))
  }
  const bundled = path.join(harnessDir, 'runtime', 'node.exe')
  const command = fs.existsSync(bundled)
    ? bundled
    : opts.isPackaged
      ? (() => { throw new HarnessUnavailableError(new Error(`harness 运行时缺失：${bundled}`)) })()
      : 'node'
  return { command, args: [path.join(harnessDir, LAUNCHER_NAME)] }
}

/** 物化版本戳（prepare-harness.mjs 生成；无戳模板保持旧的"存在即复用"行为）。 */
function stampOf(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, '.stamp'), 'utf8') } catch { return null }
}

/**
 * pack 首 run 物化：resources 的 harness/ → 可写目标目录（launch.mjs 相对自身解析 profile）。
 * 复用判定：launch.mjs 存在 且（模板无 .stamp → 旧行为直接复用；有 .stamp → 戳一致才复用）。
 * 戳不一致（升级覆盖安装）时整树重拷——先落 .tmp-<pid> 再换名，半途崩溃不留半成品目标；
 * 入口无条件清扫遗留的 `<target>.tmp-*` staging（上次被杀进程的残骸）。
 * 全程 fs.promises：GB 级拷贝走线程池，主线程不得被同步 cpSync 冻结（B-8）。
 */
export async function ensureHarnessMaterialized(
  templateDir: string,
  targetDir: string,
  onMaterialize?: (active: boolean) => void
): Promise<string> {
  const parent = path.dirname(targetDir)
  const base = path.basename(targetDir)
  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(`${base}.tmp-`)) {
        await fs.promises.rm(path.join(parent, e.name), { recursive: true, force: true })
      }
    }
  } catch { /* parent 尚不存在时无陈渣可清 */ }

  const templateStamp = stampOf(templateDir)
  if (fs.existsSync(path.join(targetDir, LAUNCHER_NAME)) &&
      (templateStamp === null || stampOf(targetDir) === templateStamp)) {
    return targetDir
  }
  if (!fs.existsSync(path.join(templateDir, LAUNCHER_NAME))) {
    throw new HarnessUnavailableError(new Error(`harness 模板不存在：${templateDir}`))
  }
  await fs.promises.mkdir(parent, { recursive: true })
  const staging = `${targetDir}.tmp-${process.pid}`
  onMaterialize?.(true)
  try {
    await fs.promises.rm(staging, { recursive: true, force: true })
    await fs.promises.cp(templateDir, staging, { recursive: true })
    await fs.promises.rm(targetDir, { recursive: true, force: true })
    await fs.promises.rename(staging, targetDir)
  } finally {
    onMaterialize?.(false)
  }
  return targetDir
}

/** 竞速等待子进程退出（dispose.ts 同款：unref 定时器 + 退出即清理）。 */
function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false) }, ms).unref()
    child.once('exit', onExit)
  })
}

export class HarnessRuntime {
  private child: ChildProcess | null = null
  private bridge: Bridge | null = null
  private starting: Promise<Bridge> | null = null
  /** 函数源 spec 解析一次并缓存：prewarm 与 ensure 共享同一物化，避免并发双拷 */
  private specCache: Promise<HarnessSpawnSpec> | null = null
  private unavailable = false
  private shuttingDown = false
  private notificationHandler: ((method: string, params: Json) => void) | null = null
  private transportDownHandler: (() => void) | null = null
  private readonly opts: HarnessRuntimeOptions

  constructor(opts: HarnessRuntimeOptions) {
    this.opts = opts
  }

  /** 注册协议通知分发（每个新 bridge 实例都会接上）；IPC 层装配时调用一次。 */
  setNotificationHandler(fn: ((method: string, params: Json) => void) | null): void {
    this.notificationHandler = fn
  }

  /** 非计划性传输死亡（崩溃/流断）回调；正常 shutdown 不触发。 */
  setTransportDownHandler(fn: (() => void) | null): void {
    this.transportDownHandler = fn
  }

  get isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }

  get isUnavailable(): boolean { return this.unavailable }

  /** 当前活跃桥（未启动/已死为 null） */
  get activeBridge(): Bridge | null { return this.bridge }

  /**
   * 惰性启动：有活桥直接返回；否则 spawn + initialize。
   * 每次调用带一次重启额度（spec §10"重启一次仍败→运行时不可用"）；
   * 并发 ensure 共享同一次启动。
   */
  async ensure(): Promise<Bridge> {
    if (this.bridge && !this.bridge.isDead && this.isAlive) return this.bridge
    if (this.unavailable) throw new HarnessUnavailableError()
    if (this.starting) return this.starting
    this.starting = this.startWithRetry()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startWithRetry(): Promise<Bridge> {
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.startAndInit()
      } catch (err) {
        lastErr = err
        console.warn(`[harness] 启动尝试 ${attempt}/2 失败:`, err)
        await this.teardown()
      }
    }
    this.unavailable = true
    throw new HarnessUnavailableError(lastErr)
  }

  private buildEnv(ctx: HarnessLaunchContext): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.opts.dshHome,
      DANIYA_SETTINGS_FILE: this.opts.settingsFile
    }
    // electron 启动指令不是环境配置：harness 宿主是真 Node，转发它只会污染嵌套 spawn 语义
    delete env.ELECTRON_RUN_AS_NODE
    // settings 是唯一来源：ctx 为空时删除继承值，机器级 env 不得漏进 harness
    if (ctx.apiKey) env.DEEPSEEK_API_KEY = ctx.apiKey
    else delete env.DEEPSEEK_API_KEY
    if (ctx.baseUrl) env.DEEPSEEK_BASE_URL = ctx.baseUrl
    else delete env.DEEPSEEK_BASE_URL
    if (ctx.workDir) env.DANIYA_WORKDIR = ctx.workDir
    else delete env.DANIYA_WORKDIR
    for (const [k, v] of Object.entries(this.opts.env ?? {})) {
      if (v === undefined) delete env[k]; else env[k] = v
    }
    return env
  }

  /**
   * 预热：仅解析函数源 spec（packaged 下触发 harness 物化大拷贝），不拉起进程。
   * 应用启动即后台跑，首个 startReply/getMessages 到达时多半已拷完（B-8）。
   */
  prewarm(): void {
    if (typeof this.opts.spec !== 'function') return
    this.resolveSpec().catch(err => console.warn('[harness] 预热物化失败:', err))
  }

  private resolveSpec(): Promise<HarnessSpawnSpec> {
    this.specCache ??= Promise.resolve().then(() => {
      const s = this.opts.spec
      return typeof s === 'function' ? s() : s
    })
    return this.specCache
  }

  private async startAndInit(): Promise<Bridge> {
    const ctx = this.opts.getLaunchContext()
    const spec = await this.resolveSpec()
    this.shuttingDown = false
    const child = spawn(spec.command, spec.args, {
      env: this.buildEnv(ctx),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.pipeStderr(child)
    child.once('exit', () => { this.handleTransportDown(child) })
    child.once('error', () => { this.handleTransportDown(child) })

    const bridge = new Bridge(child.stdout!, child.stdin!)
    bridge.onNotification((m, p) => this.notificationHandler?.(m, p))
    bridge.onClose(() => { this.handleTransportDown(child) })
    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (e) => { reject(e) })
    })
    try {
      await Promise.race([
        // workdir 空时回退 cwd，与 patch 中 `DANIYA_WORKDIR || process.cwd()` 同语义（子进程继承父 cwd）
        bridge.request('initialize', { workdir: ctx.workDir || process.cwd(), model: ctx.model }, { timeoutMs: this.opts.initializeTimeoutMs ?? 10_000 }),
        spawnError
      ])
    } catch (err) {
      bridge.dispose()
      throw err
    }
    this.bridge = bridge
    return bridge
  }

  private pipeStderr(child: ChildProcess): void {
    const prefix = this.opts.stderrPrefix ?? '[harness]'
    let rest = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      for (;;) {
        const nl = rest.indexOf('\n')
        if (nl < 0) break
        const line = rest.slice(0, nl)
        rest = rest.slice(nl + 1)
        if (line.trim()) console.error(prefix, line)
      }
    })
    child.stderr?.once('end', () => { if (rest.trim()) console.error(prefix, rest) })
  }

  /** 崩溃/流断/退出：丢弃桥与子进程句柄，通知上层（正常 shutdown 静默）。 */
  private handleTransportDown(child: ChildProcess): void {
    if (child !== this.child) return
    const wasShutdown = this.shuttingDown
    this.child = null
    const b = this.bridge
    this.bridge = null
    b?.transportDead(new BridgeTransportError('harness 进程已退出'))
    if (wasShutdown) return
    if (child.exitCode === null && child.signalCode === null) {
      // stdout 断了但进程还在：杀掉避免孤儿
      try { child.kill() } catch { /* 已死则忽略 */ }
    }
    this.transportDownHandler?.()
  }

  /** 强杀当前子进程并等待退出（ensure 失败路径用）。 */
  private async teardown(): Promise<void> {
    const child = this.child
    this.shuttingDown = true
    if (!child) return
    await this.drainChild(child)
  }

  /**
   * 优雅退出阶梯：shutdown 请求 → 等退出 → stdin EOF → SIGTERM（POSIX）→ SIGKILL。
   * 全程有界；应用 before-quit 调用。
   */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    this.shuttingDown = true
    const bridge = this.bridge
    if (bridge && !bridge.isDead) {
      try {
        await bridge.request('shutdown', {}, { timeoutMs: this.opts.shutdownRequestTimeoutMs ?? 3_000 })
      } catch { /* 协议层失败不阻塞信号阶梯 */ }
    }
    await this.drainChild(child)
    this.bridge = null
  }

  private async drainChild(child: ChildProcess): Promise<void> {
    const exitGrace = this.opts.shutdownExitGraceMs ?? 3_000
    const eofGrace = this.opts.eofGraceMs ?? 1_500
    const killGrace = this.opts.killGraceMs ?? 2_000
    if (await exitsWithin(child, exitGrace)) { this.handleTransportDown(child); return }
    try { child.stdin?.end() } catch { /* stdin 可能已断 */ }
    if (await exitsWithin(child, eofGrace)) { this.handleTransportDown(child); return }
    if (process.platform !== 'win32') {
      try { child.kill('SIGTERM') } catch { /* 已死则忽略 */ }
      if (await exitsWithin(child, killGrace)) { this.handleTransportDown(child); return }
    }
    try { child.kill('SIGKILL') } catch { /* 已死则忽略 */ }
    await exitsWithin(child, killGrace)
    this.handleTransportDown(child)
  }
}
