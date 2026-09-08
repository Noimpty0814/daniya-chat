import { describe, it, expect } from 'vitest'
import { diffLines } from './diff'

describe('diffLines', () => {
  it('无变化：全 same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }
    ])
  })

  it('增加一行', () => {
    expect(diffLines('a', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'add', text: 'b' }
    ])
  })

  it('删除一行', () => {
    expect(diffLines('a\nb', 'b')).toEqual([
      { kind: 'del', text: 'a' }, { kind: 'same', text: 'b' }
    ])
  })

  it('改一行 = 删旧+增新', () => {
    expect(diffLines('旧行', '新行')).toEqual([
      { kind: 'del', text: '旧行' }, { kind: 'add', text: '新行' }
    ])
  })

  it('空 → 全文：全 add；全文 → 空：全 del', () => {
    expect(diffLines('', 'x\ny')).toEqual([{ kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }])
    expect(diffLines('x\ny', '')).toEqual([{ kind: 'del', text: 'x' }, { kind: 'del', text: 'y' }])
  })

  it('超限退化：大输入退化为整文件替换（全 del + 全 add）', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line${i}`).join('\n')
    const r = diffLines(big, big + '\nextra')
    expect(r.length).toBe(4001 + 4000)
    expect(r[0].kind).toBe('del')
    expect(r[4000].kind).toBe('add')
    // 简报断言 r[4000].text 为 'extra'，但 4000 del + 4001 add 排列下 'extra' 是 add 块末元素（整体下标 8000）；按排列语义修正下标
    expect(r[8000].text).toBe('extra')
  })
})
