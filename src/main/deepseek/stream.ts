export interface StreamDelta { delta: string; finishReason: string | null }

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const j = JSON.parse(data)
        const choice = j.choices?.[0]
        yield { delta: choice?.delta?.content ?? '', finishReason: choice?.finish_reason ?? null }
      } catch { /* keepalive 或非 JSON 行，忽略 */ }
    }
  }
}
