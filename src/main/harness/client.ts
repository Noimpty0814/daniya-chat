/**
 * DaniyaBridge —— daniya-bridge 协议的类型化门面。
 *
 * `Bridge` 之上按 `packages/daniya-bridge/src/protocol.ts` 的唯一契约收敛：
 * - `request<M>` 类型化重载在前，返回值按 `BridgeResultMap[M]` 自动推导；
 *   原始 `request<T>(method: string)` 逃生门在后（任意方法探针仍可用）。
 * - 领域方法 `initialize`/`shutdown`/`prompt`/`cancel`/`sessions.*` 与 ipc 层的
 *   手写方法字符串一一对应地消掉；`sessions.history` 直接解 `{messages}` 信封。
 * - 通知经 `on<M>`（按 method 收窄 params）或 `onAny`（判别联合整帧）订阅。
 *
 * 原则：1:1 协议客户端，不做 liveSessions/registry 编排（那是 ipc/C1 的地盘）；
 * 唯一破例是 history 解信封。对端与本进程同包同发布，帧信任契约构造——
 * 不做运行时 schema 校验（spec Decision 9）。
 *
 * 线类型经本文件 re-export：main 侧只认 `./harness/client` 一个入口，
 * 不各自回指包内路径。
 */
import { Bridge, type Json, type RequestOptions } from './bridge'
import type {
  BridgeMessage,
  BridgeNotification,
  BridgeNotificationMap,
  BridgeNotificationMethod,
  BridgeParamsMap,
  BridgeRequestMethod,
  BridgeResultMap,
  SessionSummary,
  WireImage,
} from '../../../packages/daniya-bridge/src/protocol'

export type {
  BridgeFile,
  BridgeImage,
  BridgeMessage,
  BridgeNotification,
  BridgeNotificationMap,
  BridgeNotificationMethod,
  BridgeParamsMap,
  BridgeRequestMethod,
  BridgeResultMap,
  BridgeToolCall,
  SessionSummary,
  WireImage,
} from '../../../packages/daniya-bridge/src/protocol'

export class DaniyaBridge extends Bridge {
  /**
   * 契约内请求：method 收窄 params/result（漏参/拼错方法名是编译错）。
   * params 按 `BridgeParamsMap[M]` 有无键决定可否省略——零参方法
   * `request('session.create')` 直达本重载，返回值照样自动推导。
   */
  request<M extends BridgeRequestMethod>(
    method: M,
    ...rest: keyof BridgeParamsMap[M] extends never
      ? [params?: BridgeParamsMap[M], opts?: RequestOptions]
      : [params: BridgeParamsMap[M], opts?: RequestOptions]
  ): Promise<BridgeResultMap[M]>
  /** 逃生门：契约外/任意方法探针保持可用（测试与调试面）。 */
  request<T = unknown>(method: string, params?: Json, opts?: RequestOptions): Promise<T>
  request(method: string, params?: unknown, opts?: RequestOptions): Promise<unknown> {
    return super.request(method, params as Json | undefined, opts)
  }

  /**
   * 订阅全部协议通知，整帧按 `BridgeNotification` 判别联合分发。
   * 边界断言只此一处：同包对端按契约构造，协议外 method 落到调用方
   * switch 的 default 分支（与改造前静默语义一致）。
   */
  onAny(fn: (notification: BridgeNotification) => void): () => void {
    return this.onNotification((method, params) => {
      fn({ method, params } as unknown as BridgeNotification)
    })
  }

  /** 按 method 订阅类型化通知：`params` 收窄为 `BridgeNotificationMap[M]`。 */
  on<M extends BridgeNotificationMethod>(
    method: M,
    fn: (params: BridgeNotificationMap[M]) => void,
  ): () => void {
    return this.onAny(n => {
      if (n.method === method) fn(n.params as BridgeNotificationMap[M])
    })
  }

  /** `initialize {workdir, model}` → `{ok:true}`（握手 + 就绪界）。 */
  initialize(workdir: string, model: string, opts?: RequestOptions): Promise<{ ok: true }> {
    return this.request('initialize', { workdir, model }, opts)
  }

  /** `shutdown {}` → `{ok:true}`（响应写回后对端自行排空退出）。 */
  shutdown(opts?: RequestOptions): Promise<{ ok: true }> {
    return this.request('shutdown', undefined, opts)
  }

  /** `prompt {sessionId, text, images?}` → `{messageId}`；空 images 不写线。 */
  prompt(sessionId: string, text: string, images?: WireImage[], opts?: RequestOptions): Promise<{ messageId: string }> {
    const params: BridgeParamsMap['prompt'] = images !== undefined && images.length > 0
      ? { sessionId, text, images }
      : { sessionId, text }
    return this.request('prompt', params, opts)
  }

  /** `cancel {sessionId}` → `{ok:true}`。 */
  cancel(sessionId: string): Promise<{ ok: true }> {
    return this.request('cancel', { sessionId })
  }

  /** `session.*` 方法族：会话生命周期与历史投影。 */
  readonly sessions = {
    /** `session.create {}` → `{sessionId}`。 */
    create: (): Promise<{ sessionId: string }> => this.request('session.create'),
    /** `session.resume {sessionId}` → `{ok:true}`（历史由 history 独立投影）。 */
    resume: (sessionId: string): Promise<{ ok: true }> => this.request('session.resume', { sessionId }),
    /** `session.list {}` → `SessionSummary[]`（title 恒 `''`）。 */
    list: (): Promise<SessionSummary[]> => this.request('session.list'),
    /** `session.history {sessionId}` → `BridgeMessage[]`（唯一破例：直接解 `{messages}` 信封）。 */
    history: async (sessionId: string): Promise<BridgeMessage[]> =>
      (await this.request('session.history', { sessionId })).messages,
    /** `session.delete {sessionId}` → `{ok:true}`（持久层日志仍留盘）。 */
    delete: (sessionId: string): Promise<{ ok: true }> => this.request('session.delete', { sessionId }),
  }
}
