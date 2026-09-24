/**
 * daniya-bridge —— daniya-chat 自研 dsh 插件：独占 stdin/stdout 跑
 * 按行 JSON-RPC，把 dsh 进程内事件面桥给 Electron 主进程，并贡献
 * 人设段（每轮组装重读 settings）与会话沙箱 root 设定。
 *
 * 插件形态：named exports `name`/`inject`/`Config`/`apply`，无 default export。
 * stdout 只写协议帧；一切诊断走 stderr。
 *
 * 进程退出分工复刻 sdk 参照：
 * - stdin EOF 由 `exitOnStdinEnd` 接管——就绪提交后请求 `ctx.appExit(0)`，
 *   launcher 的有界退出负责整树 dispose（含本插件效果与持久层排空）。
 * - `shutdown` RPC 在响应写回后走 `disposeAndExit`：排空协议写 →
 *   dispose 根 fiber（级联执行所有插件清理）→ `exit(0)`。
 *
 * @module daniya-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline'
import { DaniyaBridgeServer, type BridgeServerConfig } from './server.js'

export const name = 'daniya-bridge'
// 声明真实依赖的服务；sessionPersistence/llm/loader/appExit 等可选面用 ctx.get 读。
export const inject = ['agents', 'sessions', 'systemPrompt', 'attachments']

/** 部署配置；`input`/`output`/`stderr`/`exit` 为运行时测试钩子，不入 profile。 */
export interface BridgeConfig extends BridgeServerConfig {
  /** 协议输入流（默认 `process.stdin`）。 */
  input?: Readable
  /** 协议输出流（默认 `process.stdout`，只写协议帧）。 */
  output?: Writable
  /** 诊断输出流（默认 `process.stderr`）。 */
  stderr?: Writable
  /** 进程退出钩子（默认 `process.exit`）。 */
  exit?: (code: number) => void
}

export const Config: Schema<BridgeConfig> = Schema.object({
  settingsFile: Schema.string().default(''),
  workdir: Schema.string().default(''),
  provider: Schema.string().default('deepseek-official'),
})

/**
 * 挂载桥：协议传输随 `ctx.effect` 启停；人设段按 agent 作用域在会话
 * create/resume setup 里注册（见 server.ts），随 agent 卸载自动回收。
 */
export function apply(ctx: Context, config: BridgeConfig): void {
  /* v8 ignore next -- 生产 stdio 接线；测试一律注入运行时钩子 */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- 生产 stdio 接线 */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- 生产诊断接线 */
  const stderr = config.stderr ?? process.stderr
  /* v8 ignore next -- 生产退出接线 */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })
  const diagnostic = (message: string): void => {
    try {
      stderr.write(`${message}\n`)
    } catch {
      // stderr 不可写时丢弃诊断，绝不回写 stdout。
    }
  }

  const transport = new JsonRpcLineTransport(input, output)
  const server = new DaniyaBridgeServer(ctx, transport, {
    settingsFile: config.settingsFile || undefined,
    workdir: config.workdir || undefined,
    provider: config.provider || undefined,
  }, diagnostic)

  const rootFiber = ctx.root.fiber
  // shutdown 响应先落线再进退出路径；EOF 与 shutdown 竞争时 exitTask 去重。
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    // initialize 是就绪界：等 Loader 当前树完全落地再宣告可用（同 sdk-server）。
    if (method === 'initialize') {
      await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'daniya-bridge.serve')

  // stdin EOF → launcher 有界退出（复刻 sdk-app-startup；launcher 必须已提供
  // ctx.appExit/ctx.appReady，缺失时此处响亮失败——stdio 桥没有退出面即部署错误）。
  exitOnStdinEnd(ctx, 'daniya-bridge.stdin')
}
