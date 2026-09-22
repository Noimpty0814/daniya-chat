/**
 * EmotionParser —— 情绪标记 `{EMO:xx}` / 简写 `{happy}` 流式解析器。
 */
export type Emotion = 'happy' | 'sad' | 'sleepy' | 'dismissive' | 'shy' | 'blush' | 'angry' | 'dark'
const EMOTIONS: readonly Emotion[] = ['happy', 'sad', 'sleepy', 'dismissive', 'shy', 'blush', 'angry', 'dark']
const PREFIX = '{EMO:'

function isEmotion(s: string): s is Emotion { return (EMOTIONS as readonly string[]).includes(s) }

export class EmotionParser {
  private buf = ''
  private state: 'matching' | 'done' = 'matching'

  feed(chunk: string): { display: string; emotion?: Emotion } {
    if (this.state === 'done') return { display: chunk }
    this.buf += chunk
    const ws = this.buf.match(/^\s*/)?.[0].length ?? 0
    const body = this.buf.slice(ws)
    if (body.startsWith(PREFIX)) {
      const close = body.indexOf('}')
      if (close >= 0) {
        const token = body.slice(0, close + 1)
        const m = token.match(/^\{EMO:([a-z]+)\}$/)
        const emotion = m && isEmotion(m[1]) ? m[1] : undefined
        const display = this.buf.slice(ws + close + 1)
        this.buf = ''
        this.state = 'done'
        return { display, emotion }
      }
      return { display: '' }
    }
    // 简写完整匹配：{<词表内>}，行为与 {EMO:xx} 一致（词表外如 {code}/{sadness} 走 ⑤ 原样透传）
    const short = body.match(/^\{([a-z]+)\}/)
    if (short && isEmotion(short[1])) {
      const close = short[0].length - 1
      const display = this.buf.slice(ws + close + 1)
      this.buf = ''
      this.state = 'done'
      return { display, emotion: short[1] }
    }
    // 简写前缀暂扣：body 形如 {+纯小写字母（尚无闭合 }）且是某合法简写标记的严格前缀
    const shortPrefix = body.match(/^\{[a-z]+$/)
    if (shortPrefix && EMOTIONS.some(e => e.startsWith(shortPrefix[0].slice(1)))) return { display: '' }
    if (body.length < PREFIX.length && PREFIX.startsWith(body)) return { display: '' }
    this.state = 'done'
    const out = this.buf
    this.buf = ''
    return { display: out }
  }

  end(): { display: string; emotion?: Emotion } {
    const out = this.buf
    this.buf = ''
    this.state = 'done'
    return { display: out }
  }
}
