import { describe, it, expect } from 'vitest'
import { DragCounter } from './dragCounter'

describe('DragCounter', () => {
  it('enter 一次即 active', () => {
    const c = new DragCounter()
    c.enter()
    expect(c.active).toBe(true)
  })

  it('enter/leave 配对后不 active', () => {
    const c = new DragCounter()
    c.enter()
    c.leave()
    expect(c.active).toBe(false)
  })

  it('多次 enter（跨子元素）需要等量 leave 才不 active', () => {
    const c = new DragCounter()
    c.enter()
    c.enter()
    c.enter()
    c.leave()
    expect(c.active).toBe(true)
    c.leave()
    c.leave()
    expect(c.active).toBe(false)
  })

  it('drop 后 reset 直接清零', () => {
    const c = new DragCounter()
    c.enter()
    c.enter()
    c.reset()
    expect(c.active).toBe(false)
  })

  it('异常多出的 leave 不会把计数打到负数', () => {
    const c = new DragCounter()
    c.leave()
    c.leave()
    c.enter()
    expect(c.active).toBe(true)
  })
})
