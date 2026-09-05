import { parseSSE } from './stream'
import { EmotionParser, type Emotion } from './emotion'
import { pickModel } from './router'

export interface ChatTurn { role: 'user' | 'assistant'; content: string; images?: string[] }
export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
}
export type StreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'emotion'; emotion: Emotion }
  | { type: 'done'; model: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
}

export const SYSTEM_PROMPT = [
  '你是达妮娅（Daniya），一个可爱的桌面桌宠 AI 助手，性格活泼温柔，偶尔调皮。',
  '回答使用中文（用户用其他语言时跟随用户语言），简洁自然，像朋友聊天。',
  '每次回复的正文必须以一个情绪标记开头，且标记必须是回复的第一个字符（标记前不要有任何空格或换行）：{EMO:emotion}',
  'emotion 取值：happy（开心）、sad（难过）、sleepy（困倦）、dismissive（不屑）、shy（害羞）、blush（脸红）、angry（生气）、dark（黑化）。',
  '没有明显情绪时可以不写标记。标记后直接接正文，不要空格不要换行。'
].join('\n')

export async function streamChat(cfg: DeepSeekConfig, turns: ChatTurn[], signal?: AbortSignal): Promise<AsyncGenerator<StreamEvent>> {
  const model = pickModel(cfg.textModel, cfg.visionModel, turns)
  const messages = [
    { role: 'system', content: cfg.systemPrompt },
    ...turns.map(t => t.images && t.images.length > 0
      ? { role: t.role, content: [{ type: 'text', text: t.content }, ...t.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] }
      : { role: t.role, content: t.content })
  ]
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 })
  })
  if (!res.ok || !res.body) {
    let msg = `请求失败 (HTTP ${res.status})`
    try { const j = await res.json(); msg = j?.error?.message ?? msg } catch { /* 响应体非 JSON 时用默认信息 */ }
    throw new ApiError(res.status, msg)
  }
  const body: ReadableStream<Uint8Array> = res.body
  return (async function* () {
    const parser = new EmotionParser()
    for await (const d of parseSSE(body)) {
      const { display, emotion } = parser.feed(d.delta)
      if (emotion) yield { type: 'emotion', emotion }
      if (display) yield { type: 'delta', delta: display }
      if (d.finishReason) break
    }
    const { display, emotion } = parser.end()
    if (emotion) yield { type: 'emotion', emotion }
    if (display) yield { type: 'delta', delta: display }
    yield { type: 'done', model }
  })()
}
