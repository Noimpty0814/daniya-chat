import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ConversationMeta, SearchHit } from '../../shared/types'

const META_FILE = 'index.json'
const NEW_TITLE = '新对话'

export class Store {
  private meta: ConversationMeta[] = []
  private cache = new Map<string, ChatMessage[]>()

  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true })
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')).conversations
    } catch { this.meta = [] }
  }

  private get metaPath(): string { return path.join(this.dir, META_FILE) }
  private convPath(id: string): string { return path.join(this.dir, 'conversations', id + '.json') }
  private saveMeta(): void { fs.writeFileSync(this.metaPath, JSON.stringify({ version: 1, conversations: this.meta }, null, 2)) }

  private loadMessages(id: string): ChatMessage[] {
    if (!this.cache.has(id)) {
      try { this.cache.set(id, JSON.parse(fs.readFileSync(this.convPath(id), 'utf8')).messages ?? []) }
      catch { this.cache.set(id, []) }
    }
    return this.cache.get(id)!
  }

  private saveMessages(id: string): void {
    const tmp = this.convPath(id) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ messages: this.cache.get(id) ?? [] }, null, 2))
    fs.renameSync(tmp, this.convPath(id))
  }

  listConversations(): ConversationMeta[] {
    return [...this.meta].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  createConversation(): ConversationMeta {
    const meta: ConversationMeta = { id: randomUUID(), title: NEW_TITLE, createdAt: Date.now(), updatedAt: Date.now() }
    this.meta.push(meta)
    this.cache.set(meta.id, [])
    this.saveMeta()
    this.saveMessages(meta.id)
    return meta
  }

  renameConversation(id: string, title: string): void {
    const m = this.meta.find(x => x.id === id)
    if (!m) throw new Error('会话不存在')
    m.title = title
    m.updatedAt = Date.now()
    this.saveMeta()
  }

  deleteConversation(id: string): void {
    this.meta = this.meta.filter(x => x.id !== id)
    this.cache.delete(id)
    this.saveMeta()
    fs.rmSync(this.convPath(id), { force: true })
  }

  getMessages(id: string): ChatMessage[] { return [...this.loadMessages(id)] }

  appendMessage(id: string, msg: ChatMessage): void {
    this.loadMessages(id).push(msg)
    this.saveMessages(id)
    const m = this.meta.find(x => x.id === id)
    if (m) { m.updatedAt = Date.now(); this.saveMeta() }
  }

  autoTitle(id: string): void {
    const m = this.meta.find(x => x.id === id)
    if (!m || m.title !== NEW_TITLE) return
    const first = this.loadMessages(id).find(x => x.role === 'user')
    if (!first) return
    m.title = first.content.replace(/\s+/g, ' ').slice(0, 20)
    this.saveMeta()
  }

  search(query: string): SearchHit[] {
    const q = query.toLowerCase()
    const hits: SearchHit[] = []
    for (const c of this.meta) {
      for (const m of this.loadMessages(c.id)) {
        const i = m.content.toLowerCase().indexOf(q)
        if (i >= 0) hits.push({ conversationId: c.id, messageId: m.id, role: m.role, snippet: m.content.slice(Math.max(0, i - 20), i + 60) })
      }
    }
    return hits
  }
}
