import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamChat, ApiError, DEFAULT_PERSONA, EMOTION_CONTRACT, type DeepSeekConfig } from './client'

const cfg: DeepSeekConfig = {
  apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
  textModel: 'deepseek-chat', visionModel: 'deepseek-v4-flash-vision-exp',
  systemPrompt: DEFAULT_PERSONA
}

function sseResponse(lines: string[], status = 200): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() }
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

async function collect(gen: AsyncGenerator<{ type: string; delta?: string; emotion?: string; model?: string }>) {
  const out: { type: string; delta?: string; emotion?: string; model?: string }[] = []
  for await (const e of gen) out.push(e)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('纯文本：POST 正确地址与头，请求体含 system 与消息，事件序列 delta→emotion→done', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('deepseek-chat')
      expect(body.stream).toBe(true)
      expect(body.messages[0]).toEqual({ role: 'system', content: DEFAULT_PERSONA + '\n\n' + EMOTION_CONTRACT })
      expect(body.messages[1]).toEqual({ role: 'user', content: '你好' })
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"{EMO:"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"happy}今天"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"开心"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: '你好' }]))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(out).toEqual([
      { type: 'emotion', emotion: 'happy' },
      { type: 'delta', delta: '今天' },
      { type: 'delta', delta: '开心' },
      { type: 'done', model: 'deepseek-chat' }
    ])
  })

  it('含图消息：路由到视觉模型，content 为数组含 image_url 块', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('deepseek-v4-flash-vision-exp')
      expect(body.messages[1].content).toEqual([
        { type: 'text', text: '看看屏幕' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
      ])
      return sseResponse(['data: {"choices":[{"delta":{"content":"看到啦"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'])
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: '看看屏幕', images: ['data:image/png;base64,abc'] }]))
    expect(out.map(e => e.type)).toEqual(['delta', 'done'])
  })

  it('HTTP 401：抛出 ApiError 且信息来自响应体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401 }
    )))
    await expect(streamChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 401, message: 'Authentication Fails' })
  })

  it('HTTP 400：同样转为 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'This model does not support image' } }), { status: 400 })))
    const err = await streamChat(cfg, [{ role: 'user', content: 'hi', images: ['data:image/png;base64,x'] }]).then(
      () => null, (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
  })

  it('人设与表情契约拼接：system 消息 = cfg.systemPrompt + 空行 + EMOTION_CONTRACT（契约在后，与人设内容无关）', async () => {
    const customCfg: DeepSeekConfig = { ...cfg, systemPrompt: '自定义人设A' }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.messages[0]).toEqual({ role: 'system', content: '自定义人设A\n\n' + EMOTION_CONTRACT })
      expect(String(body.messages[0].content).startsWith('自定义人设A\n\n')).toBe(true)
      expect(String(body.messages[0].content).endsWith(EMOTION_CONTRACT)).toBe(true)
      return sseResponse(['data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'])
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(customCfg, [{ role: 'user', content: '在吗' }]))
    expect(out.map(e => e.type)).toEqual(['delta', 'done'])
  })

  it('DEFAULT_PERSONA 为达妮娅人设文本（不含 {EMO} 规则），EMOTION_CONTRACT 为固定格式契约（含 8 种情绪与首字符规则，不含人设）', () => {
    expect(DEFAULT_PERSONA).toContain('你是达妮娅（Daniya）')
    expect(DEFAULT_PERSONA).not.toContain('{EMO:')
    expect(EMOTION_CONTRACT).toContain('{EMO:xx}')
    expect(EMOTION_CONTRACT).toContain('第一个字符')
    expect(EMOTION_CONTRACT).toContain('简体中文')
    for (const e of ['happy', 'sad', 'sleepy', 'dismissive', 'shy', 'blush', 'angry', 'dark']) {
      expect(EMOTION_CONTRACT).toContain(e)
    }
    expect(EMOTION_CONTRACT).not.toContain('达妮娅')
  })
})
