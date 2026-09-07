import { describe, it, expect } from 'vitest'
import { comboFor, isValidComboChar, DEFAULT_EMOTION_KEYS } from './keys'

describe('comboFor', () => {
  it('happy 映射为 Alt+I（VK 73）', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'happy')).toEqual({ mods: [18], key: 73 })
  })
  it('bubble_on 映射为 Alt+0（VK 48）', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'bubble_on')).toEqual({ mods: [18], key: 48 })
  })
  it('小写字母键也能识别', () => {
    expect(comboFor({ happy: 'i' }, 'happy')).toEqual({ mods: [18], key: 73 })
  })
  it('未知情绪名返回 null', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'banana')).toBeNull()
  })
  it('非法键字符返回 null', () => {
    expect(comboFor({ happy: '啊' }, 'happy')).toBeNull()
  })
})

describe('isValidComboChar（Task 9 minor⑦：设置页/applyView 前置校验）', () => {
  it('合法单字符（字母/数字/符号）返回 true', () => {
    expect(isValidComboChar('I')).toBe(true)
    expect(isValidComboChar('i')).toBe(true)
    expect(isValidComboChar('0')).toBe(true)
    expect(isValidComboChar('-')).toBe(true)
    expect(isValidComboChar('[')).toBe(true)
  })
  it('非法字符/多字符/空串返回 false', () => {
    expect(isValidComboChar('啊')).toBe(false)
    expect(isValidComboChar('AB')).toBe(false)
    expect(isValidComboChar('')).toBe(false)
  })
})
