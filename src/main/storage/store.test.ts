import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store'
import type { ChatMessage } from '../../shared/types'

let dir: string
let store: Store
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-store-')); store = new Store(dir) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function userMsg(content: string, id = Math.random().toString(36).slice(2)): ChatMessage {
  return { id, role: 'user', content, createdAt: Date.now() }
}

describe('Store', () => {
  it('创建会话并出现在列表首位', () => {
    const c = store.createConversation()
    expect(c.title).toBe('新对话')
    expect(store.listConversations().map(x => x.id)).toContain(c.id)
    expect(store.getMessages(c.id)).toEqual([])
  })

  it('追加消息后按原样读回', () => {
    const c = store.createConversation()
    const m = userMsg('你好')
    store.appendMessage(c.id, m)
    expect(store.getMessages(c.id)).toEqual([m])
  })

  it('持久化：新实例能读回旧数据', () => {
    const c = store.createConversation()
    store.appendMessage(c.id, userMsg('持久化测试'))
    const store2 = new Store(dir)
    expect(store2.getMessages(c.id)[0].content).toBe('持久化测试')
  })

  it('重命名与删除', () => {
    const c = store.createConversation()
    store.renameConversation(c.id, '测试标题')
    expect(store.listConversations()[0].title).toBe('测试标题')
    store.deleteConversation(c.id)
    expect(store.listConversations()).toEqual([])
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json'))).toBe(false)
  })

  it('列表按 updatedAt 降序排列', () => {
    const a = store.createConversation()
    const b = store.createConversation()
    store.appendMessage(a.id, userMsg('让 a 更新'))
    expect(store.listConversations()[0].id).toBe(a.id)
    void b
  })

  it('autoTitle 取第一条用户消息前 20 字，且仅当标题仍是"新对话"', () => {
    const c = store.createConversation()
    store.appendMessage(c.id, userMsg('今天天气怎么样呢我真的很想知道答案'))
    store.autoTitle(c.id)
    expect(store.listConversations()[0].title).toBe('今天天气怎么样呢我真的很想知道答案'.slice(0, 20))
    store.renameConversation(c.id, '手动标题')
    store.appendMessage(c.id, userMsg('第二条消息'))
    store.autoTitle(c.id)
    expect(store.listConversations()[0].title).toBe('手动标题')
  })

  it('search 命中返回片段并跳过多条中的未命中', () => {
    const c = store.createConversation()
    store.appendMessage(c.id, userMsg('前面内容'))
    store.appendMessage(c.id, userMsg('包含关键词DeepSeek的内容'))
    const hits = store.search('deepseek')
    expect(hits).toHaveLength(1)
    expect(hits[0].conversationId).toBe(c.id)
    expect(hits[0].snippet).toContain('DeepSeek')
    expect(store.search('不存在的词xyz')).toHaveLength(0)
  })
})
