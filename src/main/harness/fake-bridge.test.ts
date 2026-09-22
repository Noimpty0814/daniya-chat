/**
 * fake-bridge 契约对账（bridge-contract Decision 8）。
 *
 * 预期帧字面量以 `satisfies BridgeNotificationMap[M]` / `satisfies BridgeResultMap[M]`
 * 钉在协议类型上，再与真实 fixture 子进程的收发 `toEqual` 对账——
 * 契约漂移 → 本文件编译错；fixture 漂移 → 测试红。`fake-bridge.mjs` 本体
 * 保持零依赖 .mjs 不动。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DaniyaBridge } from './client'
import type {
  BridgeNotification,
  BridgeNotificationMap,
  BridgeResultMap,
} from './client'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-bridge.mjs', import.meta.url))

let child: ChildProcess | null = null

function makeFixture(): { bridge: DaniyaBridge; notifications: BridgeNotification[] } {
  child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] })
  const bridge = new DaniyaBridge(child.stdout!, child.stdin!)
  const notifications: BridgeNotification[] = []
  bridge.onAny(n => notifications.push(n))
  return { bridge, notifications }
}

afterEach(() => {
  child?.kill()
  child = null
})

describe('fake-bridge 契约对账', () => {
  it('[toolturn] 全帧序列 + 请求结果按契约对账', async () => {
    const { bridge, notifications } = makeFixture()
    // fixture 的 initialize 额外回显 env（协议外的测试字段），契约部分按 toMatchObject 对账
    await expect(bridge.initialize('D:/work', 'm')).resolves.toMatchObject(
      { ok: true } satisfies BridgeResultMap['initialize'],
    )
    await expect(bridge.sessions.create()).resolves.toEqual(
      { sessionId: 'sess-1' } satisfies BridgeResultMap['session.create'],
    )
    await expect(bridge.prompt('sess-1', '[toolturn] 查一下')).resolves.toEqual(
      { messageId: 'msg-1' } satisfies BridgeResultMap['prompt'],
    )

    await vi.waitFor(() => { expect(notifications).toHaveLength(8) }, { timeout: 3000 })
    const expected: BridgeNotification[] = [
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'running' } satisfies BridgeNotificationMap['agent.status'] },
      { method: 'stream.chunk', params: { sessionId: 'sess-1', turn: 1, text: '{EMO:happy}我先查一下。' } satisfies BridgeNotificationMap['stream.chunk'] },
      { method: 'stream.end', params: { sessionId: 'sess-1', turn: 1 } satisfies BridgeNotificationMap['stream.end'] },
      { method: 'tool.call', params: { sessionId: 'sess-1', callId: 'call-1', tool: 'web_search', argsPreview: '{"q":"x"}' } satisfies BridgeNotificationMap['tool.call'] },
      { method: 'tool.result', params: { sessionId: 'sess-1', callId: 'call-1', ok: true, preview: 'hit-1' } satisfies BridgeNotificationMap['tool.result'] },
      { method: 'stream.chunk', params: { sessionId: 'sess-1', turn: 1, text: '查完了：结果是 X。' } satisfies BridgeNotificationMap['stream.chunk'] },
      { method: 'stream.end', params: { sessionId: 'sess-1', turn: 1, aborted: false } satisfies BridgeNotificationMap['stream.end'] },
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'idle' } satisfies BridgeNotificationMap['agent.status'] },
    ]
    expect(notifications).toEqual(expected)

    const list = await bridge.sessions.list()
    // 全形状 satisfies 钉契约；updatedAt 是动态字段，值本身由 expect.any 断言为 number。
    expect(list).toEqual([
      { sessionId: 'sess-1', title: '', updatedAt: expect.any(Number) },
    ] satisfies BridgeResultMap['session.list'])

    const messages = await bridge.sessions.history('sess-1')
    expect(messages).toEqual([
      { id: 'msg-1', role: 'user', content: '[toolturn] 查一下', createdAt: expect.any(Number) },
      { id: 'hm-2', role: 'assistant', content: '{EMO:happy}我先查一下。查完了：结果是 X。', createdAt: expect.any(Number) },
    ] satisfies BridgeResultMap['session.history']['messages'])

    await expect(bridge.sessions.delete('sess-1')).resolves.toEqual({ ok: true } satisfies BridgeResultMap['session.delete'])
    await expect(bridge.shutdown()).resolves.toEqual({ ok: true } satisfies BridgeResultMap['shutdown'])
  })

  it('[slow] + cancel → stream.end{aborted:true} 终帧对账', async () => {
    const { bridge, notifications } = makeFixture()
    await bridge.initialize('D:/work', 'm')
    await bridge.sessions.create()
    await bridge.prompt('sess-1', '[slow] 慢慢说')
    await vi.waitFor(() => {
      expect(notifications.filter(n => n.method === 'stream.chunk')).toHaveLength(2)
    }, { timeout: 3000 })
    await expect(bridge.cancel('sess-1')).resolves.toEqual({ ok: true } satisfies BridgeResultMap['cancel'])
    await vi.waitFor(() => { expect(notifications).toHaveLength(5) }, { timeout: 3000 })
    expect(notifications).toEqual([
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'running' } satisfies BridgeNotificationMap['agent.status'] },
      { method: 'stream.chunk', params: { sessionId: 'sess-1', turn: 1, text: '{EMO:happy}你好，' } satisfies BridgeNotificationMap['stream.chunk'] },
      { method: 'stream.chunk', params: { sessionId: 'sess-1', turn: 1, text: '世界' } satisfies BridgeNotificationMap['stream.chunk'] },
      { method: 'stream.end', params: { sessionId: 'sess-1', turn: 1, aborted: true } satisfies BridgeNotificationMap['stream.end'] },
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'idle' } satisfies BridgeNotificationMap['agent.status'] },
    ])
    await bridge.shutdown()
  })

  it('[error] → error 通知对账；session.resume → {ok:true}', async () => {
    const { bridge, notifications } = makeFixture()
    await bridge.initialize('D:/work', 'm')
    await bridge.sessions.create()
    await expect(bridge.sessions.resume('sess-1')).resolves.toEqual({ ok: true } satisfies BridgeResultMap['session.resume'])
    await bridge.prompt('sess-1', '[error] boom')
    await vi.waitFor(() => { expect(notifications).toHaveLength(3) }, { timeout: 3000 })
    expect(notifications).toEqual([
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'running' } satisfies BridgeNotificationMap['agent.status'] },
      { method: 'error', params: { sessionId: 'sess-1', message: 'HTTP 401: invalid api key' } satisfies BridgeNotificationMap['error'] },
      { method: 'agent.status', params: { sessionId: 'sess-1', status: 'idle' } satisfies BridgeNotificationMap['agent.status'] },
    ])
    await bridge.shutdown()
  })
})
