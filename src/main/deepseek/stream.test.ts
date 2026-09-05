import { describe, it, expect } from 'vitest'
import { parseSSE } from './stream'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    }
  })
}

async function collect(chunks: string[]) {
  const out: { delta: string; finishReason: string | null }[] = []
  for await (const d of parseSSE(streamOf(chunks))) out.push(d)
  return out
}

describe('parseSSE', () => {
  it('解析多个 data 行并累积 delta', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['你', '好'])
  })

  it('单个 chunk 含多行时逐行产出', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['a', 'b'])
  })

  it('[DONE] 后结束，不产出额外事件', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"y"}}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['x'])
  })

  it('忽略注释行与空 delta，透传 finish_reason', async () => {
    const out = await collect([
      ': keepalive\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    ])
    expect(out).toEqual([{ delta: '', finishReason: 'stop' }])
  })

  it('忽略解析失败的 data 行', async () => {
    const out = await collect(['data: 不是JSON\n\n', 'data: {"choices":[{"delta":{"content":"z"}}]}\n\n'])
    expect(out.map(x => x.delta)).toEqual(['z'])
  })
})
