import { describe, it, expect } from 'vitest'
import { FileProposalParser } from './proposal'

function run(chunks: string[]) {
  const p = new FileProposalParser()
  let display = ''
  const proposals: unknown[] = []
  for (const c of chunks) {
    const r = p.feed(c)
    display += r.display
    if (r.proposal) proposals.push(r.proposal)
  }
  const e = p.end()
  display += e.display
  if (e.proposal) proposals.push(e.proposal)
  return { display, proposals }
}

describe('FileProposalParser', () => {
  it('单块完整提案：fence 剥离、JSON 解析、正文保留', () => {
    const r = run(['我帮你改一下。\n```daniya-file\n{"path": "C:/a.txt", "content": "新内容"}\n```\n改好了。'])
    expect(r.display).toBe('我帮你改一下。\n\n改好了。')
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: '新内容' }])
  })

  it('提案跨块拆分（标记/JSON/闭合各切开）', () => {
    const r = run(['正文\n```dani', 'ya-file\n{"path": "C:/a.txt", "cont', 'ent": "新内容"}\n```\n后续'])
    expect(r.display).toBe('正文\n\n后续')
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: '新内容' }])
  })

  it('非法 JSON：invalid 且不落 display', () => {
    const r = run(['```daniya-file\n不是JSON\n```\n正文'])
    expect(r.proposals).toEqual([{ kind: 'invalid' }])
    expect(r.display).toBe('\n正文')
  })

  it('JSON 形状错（缺 content）：invalid', () => {
    const r = run(['```daniya-file\n{"path": "C:/a.txt"}\n```'])
    expect(r.proposals).toEqual([{ kind: 'invalid' }])
  })

  it('未闭合 fence（流中断）：丢弃，无提案无残留', () => {
    const r = run(['正文\n```daniya-file\n{"path": "C:/a.txt"'])
    expect(r.display).toBe('正文\n')
    expect(r.proposals).toEqual([])
  })

  it('正文普通 fence 不误伤：原样显示', () => {
    const r = run(['看这个：\n```js\nconst x = 1\n```\n结束'])
    expect(r.display).toBe('看这个：\n```js\nconst x = 1\n```\n结束')
    expect(r.proposals).toEqual([])
  })

  it('非行首 daniya-file 字样不触发（代码示例内）', () => {
    const r = run(['例： x ```daniya-file 不是行首\n正文'])
    expect(r.display).toBe('例： x ```daniya-file 不是行首\n正文')
    expect(r.proposals).toEqual([])
  })

  it('content 内含转义换行：JSON 解析后保留', () => {
    const r = run(['```daniya-file\n{"path": "C:/a.txt", "content": "a\\nb"}\n```'])
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: 'a\nb' }])
  })
})
