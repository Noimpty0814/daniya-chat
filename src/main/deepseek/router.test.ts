import { describe, it, expect } from 'vitest'
import { pickModel } from './router'

const T = 'deepseek-chat'
const V = 'deepseek-v4-flash-vision-exp'

describe('pickModel', () => {
  it('无图片 → 文本模型', () => {
    expect(pickModel(T, V, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }])).toBe(T)
  })

  it('任一消息含图片 → 视觉模型', () => {
    expect(pickModel(T, V, [{ role: 'user', content: '看', images: ['data:image/png;base64,xx'] }])).toBe(V)
  })

  it('空 images 数组不算含图', () => {
    expect(pickModel(T, V, [{ role: 'user', content: 'hi', images: [] }])).toBe(T)
  })

  it('历史中的图片也触发视觉模型', () => {
    expect(pickModel(T, V, [
      { role: 'user', content: '旧图', images: ['data:image/png;base64,old'] },
      { role: 'assistant', content: '看到了' },
      { role: 'user', content: '再聊聊' }
    ])).toBe(V)
  })
})
