export type ProposalResult =
  | { kind: 'proposal'; path: string; content: string }
  | { kind: 'invalid' }

const OPEN = '```daniya-file'

export class FileProposalParser {
  private inFence = false
  private pending = ''
  private fenceLines: string[] = []

  feed(chunk: string): { display: string; proposal?: ProposalResult } {
    this.pending += chunk
    let display = ''
    for (;;) {
      if (!this.inFence) {
        const idx = this.findOpen()
        if (idx === null) {
          const keep = this.holdLen(OPEN)
          display += this.pending.slice(0, keep)
          this.pending = this.pending.slice(keep)
          return { display }
        }
        display += this.pending.slice(0, idx)
        this.pending = this.pending.slice(idx + OPEN.length)
        this.inFence = true
        this.fenceLines = []
      } else {
        const close = this.findClose()
        if (close === null) {
          // 只推完整行：最后一条不完整行（可能含被切开的闭合标记）整体留在 pending，待下个 chunk 补齐
          const nl = this.pending.lastIndexOf('\n')
          this.fenceLines.push(this.pending.slice(0, nl + 1))
          this.pending = this.pending.slice(nl + 1)
          return { display }
        }
        this.fenceLines.push(this.pending.slice(0, close.bodyEnd))
        this.pending = this.pending.slice(close.next)
        this.inFence = false
        const proposal = this.parseBody(this.fenceLines.join('\n'))
        this.fenceLines = []
        return { display, proposal }
      }
    }
  }

  end(): { display: string; proposal?: ProposalResult } {
    if (this.inFence) {
      this.inFence = false
      this.pending = ''
      this.fenceLines = []
      return { display: '' }
    }
    const display = this.pending
    this.pending = ''
    return { display }
  }

  /** 找行首 OPEN（流首或 \n 之后）；返回标记首字符位置或 null */
  private findOpen(): number | null {
    for (let i = 0; i <= this.pending.length - OPEN.length; i++) {
      if (this.pending.startsWith(OPEN, i) && (i === 0 || this.pending[i - 1] === '\n')) return i
    }
    return null
  }

  /** 找闭合行：行首 ``` 后跟 \n 或 EOF（前导 \n 可能已在上个 chunk 进 fenceLines）；bodyEnd 不含闭合行前导换行 */
  private findClose(): { bodyEnd: number; next: number } | null {
    const m = /(?:^|\n)```(?=\n|$)/.exec(this.pending)
    if (!m) return null
    const bodyEnd = m.index + (m[0].startsWith('\n') ? 1 : 0)
    return { bodyEnd, next: m.index + m[0].length }
  }

  /**
   * 尾部保留起点：最后一个 \n 之后的部分若以 needle 的严格前缀结尾，
   * 则连同其前内容（整行）整体保留（防标记跨 chunk 被切开）；
   * 返回保留区间的起点下标；无前缀时返回 pending.length（全部输出，不保留）。
   */
  private holdLen(needle: string): number {
    const nl = this.pending.lastIndexOf('\n')
    const tail = this.pending.slice(nl + 1)
    for (let k = Math.min(tail.length, needle.length - 1); k >= 1; k--) {
      if (needle.startsWith(tail.slice(tail.length - k))) return nl + 1
    }
    return this.pending.length
  }

  private parseBody(body: string): ProposalResult {
    try {
      const j = JSON.parse(body) as { path?: unknown; content?: unknown }
      if (typeof j.path === 'string' && j.path.length > 0 && typeof j.content === 'string') {
        return { kind: 'proposal', path: j.path, content: j.content }
      }
    } catch { /* 落 invalid */ }
    return { kind: 'invalid' }
  }
}
