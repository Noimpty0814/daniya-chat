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

  it('损坏的 index.json：不抛错、空列表启动、原文件备份为 .bak', () => {
    const corrupt = '{{{ 这不是合法 JSON'
    fs.writeFileSync(path.join(dir, 'index.json'), corrupt)
    const s = new Store(dir)
    expect(s.listConversations()).toEqual([])
    const bakPath = path.join(dir, 'index.json.bak')
    expect(fs.existsSync(bakPath)).toBe(true)
    expect(fs.readFileSync(bakPath, 'utf8')).toBe(corrupt)
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(false)
  })

  it('I1 损坏的消息文件：不抛错、空消息启动、原文件备份为 .bak', () => {
    const c = store.createConversation()
    const corrupt = '{broken json'
    fs.writeFileSync(path.join(dir, 'conversations', c.id + '.json'), corrupt)
    const s = new Store(dir)
    expect(s.getMessages(c.id)).toEqual([])
    const bakPath = path.join(dir, 'conversations', c.id + '.json.bak')
    expect(fs.existsSync(bakPath)).toBe(true)
    expect(fs.readFileSync(bakPath, 'utf8')).toBe(corrupt)
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json'))).toBe(false)
  })

  it('I1 消息文件形状异常（messages 是 string）：备份为 .bak 且返回数组', () => {
    const c = store.createConversation()
    fs.writeFileSync(path.join(dir, 'conversations', c.id + '.json'), JSON.stringify({ messages: 'string' }))
    const s = new Store(dir)
    const msgs = s.getMessages(c.id)
    expect(msgs).toEqual([])
    expect(Array.isArray(msgs)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json.bak'))).toBe(true)
  })

  it('I1 消息文件形状异常（messages 是 null）：备份为 .bak 且返回数组', () => {
    const c = store.createConversation()
    fs.writeFileSync(path.join(dir, 'conversations', c.id + '.json'), JSON.stringify({ messages: null }))
    const s = new Store(dir)
    expect(s.getMessages(c.id)).toEqual([])
    expect(Array.isArray(s.getMessages(c.id))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json.bak'))).toBe(true)
  })

  it('I1 消息文件不存在（ENOENT）：返回空且不产生 .bak', () => {
    const c = store.createConversation()
    fs.rmSync(path.join(dir, 'conversations', c.id + '.json'))
    const s = new Store(dir)
    expect(s.getMessages(c.id)).toEqual([])
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json.bak'))).toBe(false)
  })

  it('I1 回归：正常消息文件加载不受影响', () => {
    const c = store.createConversation()
    store.appendMessage(c.id, userMsg('正常消息'))
    const s = new Store(dir)
    expect(s.getMessages(c.id)).toHaveLength(1)
    expect(s.getMessages(c.id)[0].content).toBe('正常消息')
    expect(fs.existsSync(path.join(dir, 'conversations', c.id + '.json.bak'))).toBe(false)
  })
})
