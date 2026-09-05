import { describe, it, expect } from 'vitest'
import { EmotionParser } from './emotion'

function run(chunks: string[]): { displays: string[]; emotion: string | undefined; final: string } {
  const p = new EmotionParser()
  const displays: string[] = []
  let emotion: string | undefined
  for (const c of chunks) {
    const r = p.feed(c)
    if (r.display) displays.push(r.display)
    if (r.emotion) emotion = r.emotion
  }
  const e = p.end()
  if (e.display) displays.push(e.display)
  if (e.emotion) emotion = e.emotion
  return { displays, emotion, final: displays.join('') }
}

describe('EmotionParser', () => {
  it('完整标记单块到达：剔除标记，正文直通', () => {
    const r = run(['{EMO:happy}你好呀！'])
    expect(r.emotion).toBe('happy')
    expect(r.final).toBe('你好呀！')
  })

  it('标记跨块拆分：拆到每个字符', () => {
    const r = run(['{', 'EM', 'O:sad', '}', '难过'])
    expect(r.emotion).toBe('sad')
    expect(r.final).toBe('难过')
  })

  it('无标记：全部按原样显示', () => {
    const r = run(['直接说话'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('直接说话')
  })

  it('标记前有空白也可识别', () => {
    const r = run(['\n {EMO:blush}嘿嘿'])
    expect(r.emotion).toBe('blush')
    expect(r.final).toBe('嘿嘿')
  })

  it('非法 emotion 值：标记剔除但无情绪，正文正常', () => {
    const r = run(['{EMO:banana}哈喽'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('哈喽')
  })

  it('形似标记但不是标记的文本：原样显示', () => {
    const r = run(['{EMO 不是标记}正文'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('{EMO 不是标记}正文')
  })

  it('流结束仍有未决缓冲：end() 冲刷', () => {
    const r = run(['{EMO:sleep'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('{EMO:sleep')
  })

  it('标记后再出现标记形状文本不再解析（直通）', () => {
    const r = run(['{EMO:happy}提到 {EMO:sad} 字面量'])
    expect(r.emotion).toBe('happy')
    expect(r.final).toBe('提到 {EMO:sad} 字面量')
  })
})
