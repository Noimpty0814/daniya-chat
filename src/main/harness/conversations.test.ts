import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConversationRegistry } from './conversations'

let dir: string
let file: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-conv-')); file = path.join(dir, 'conversations.json') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('ConversationRegistry', () => {
  it('空文件起步；create 生成新会话并置顶', () => {
    const reg = new ConversationRegistry(file)
    expect(reg.list()).toEqual([])
    const a = reg.create()
    const b = reg.create()
    expect(reg.list().map(e => e.id)).toEqual([b.id, a.id])
    expect(a.sessionId).toBeUndefined()
    expect(a.titleOverride).toBeUndefined()
  })

  it('rename 写 titleOverride，remove 删除', () => {
    const reg = new ConversationRegistry(file)
    const a = reg.create()
    reg.rename(a.id, '改名后')
    expect(reg.get(a.id)?.titleOverride).toBe('改名后')
    expect(() => reg.rename('不存在', 'x')).toThrow()
    reg.remove(a.id)
    expect(reg.list()).toEqual([])
  })

  it('setSessionId 回填会话映射；findBySessionId 反查', () => {
    const reg = new ConversationRegistry(file)
    const a = reg.create()
    reg.setSessionId(a.id, 'sess-1')
    expect(reg.get(a.id)?.sessionId).toBe('sess-1')
    expect(reg.findBySessionId('sess-1')?.id).toBe(a.id)
  })

  it('getOrCreate：不存在则按给定 id 补建', () => {
    const reg = new ConversationRegistry(file)
    const e = reg.getOrCreate('external-id')
    expect(e.id).toBe('external-id')
    expect(reg.get('external-id')).toBe(e)
  })

  it('touch 置顶并刷新 updatedAt', async () => {
    const reg = new ConversationRegistry(file)
    const a = reg.create()
    const b = reg.create()
    const before = reg.get(a.id)!.updatedAt
    await new Promise(r => setTimeout(r, 5))
    reg.touch(a.id)
    expect(reg.list()[0].id).toBe(a.id)
    expect(reg.get(a.id)!.updatedAt).toBeGreaterThanOrEqual(before)
    expect(reg.list().map(e => e.id)).toEqual([a.id, b.id])
  })

  it('落盘后可由新实例读回（顺序与字段保持）', () => {
    const reg = new ConversationRegistry(file)
    const a = reg.create()
    reg.rename(a.id, 't')
    reg.setSessionId(a.id, 'sess-9')
    const reg2 = new ConversationRegistry(file)
    const e = reg2.get(a.id)
    expect(e?.titleOverride).toBe('t')
    expect(e?.sessionId).toBe('sess-9')
    expect(reg2.list()[0].id).toBe(a.id)
  })

  it('损坏文件改名备份后以空列表启动', () => {
    fs.writeFileSync(file, '{{{')
    const reg = new ConversationRegistry(file)
    expect(reg.list()).toEqual([])
    expect(fs.existsSync(file + '.bak')).toBe(true)
  })

  it('非法条目被过滤（缺 id 的项不进入列表）', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, conversations: [{ id: 'ok', createdAt: 1, updatedAt: 1 }, { noId: true }, null, 'x'] }))
    const reg = new ConversationRegistry(file)
    expect(reg.list().map(e => e.id)).toEqual(['ok'])
  })
})
