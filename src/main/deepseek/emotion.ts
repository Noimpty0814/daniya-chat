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
