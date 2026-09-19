/**
 * ConversationRegistry —— 会话登记簿（`userData/conversations.json`）。
 *
 * 职责（spec §6 / ticket T-3）：
 * - conversationId（渲染层可见 id）↔ sessionId（dsh 会话 id）映射；
 * - 显示顺序与标题覆盖自研侧维护：rename 写 titleOverride，
 *   listConversations 时以 `override ?? dsh title ?? '新会话'` 展示；
 * - 新建会话只登记 registry 项（sessionId 为空），dsh session 惰性到首发消息时建。
 *
 * 落盘格式 `{version:1, conversations: ConversationEntry[]}`，数组序即显示序（最新在前）。
 * 与旧 Store 的 `index.json` + `conversations/` 文件无冲突（spec §7：旧文件保留不读）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const NEW_CONVERSATION_TITLE = '新会话'

export interface ConversationEntry {
  /** 渲染层会话 id（registry 主键，≠ dsh sessionId） */
  id: string
  /** dsh 会话 id；首发消息 session.create 后回填 */
  sessionId?: string
  /** 用户改名（rename）；展示时优先于 dsh title */
  titleOverride?: string
  createdAt: number
  updatedAt: number
}

export class ConversationRegistry {
  private entries: ConversationEntry[] = []

  constructor(private readonly file: string) {
    this.entries = this.load()
  }

  private load(): ConversationEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { conversations?: unknown }
      if (!Array.isArray(parsed.conversations)) throw new Error('损坏的会话登记簿：conversations 不是数组')
      return parsed.conversations.filter((e): e is ConversationEntry =>
        !!e && typeof e === 'object' && typeof (e as ConversationEntry).id === 'string')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      // 文件存在但已损坏：改名备份保留现场，以空列表启动（沿用旧 Store 的容错习惯）
      try { fs.renameSync(this.file, this.file + '.bak') } catch { /* 备份失败不阻断启动 */ }
      return []
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, conversations: this.entries }, null, 2))
    fs.renameSync(tmp, this.file)
  }

  /** 显示序（最新在前）的只读快照 */
  list(): ConversationEntry[] {
    return [...this.entries]
  }

  get(id: string): ConversationEntry | undefined {
    return this.entries.find(e => e.id === id)
  }

  findBySessionId(sessionId: string): ConversationEntry | undefined {
    return this.entries.find(e => e.sessionId === sessionId)
  }

  /** 新建 registry 项（未落 sessionId）；置顶显示 */
  create(): ConversationEntry {
    const now = Date.now()
    const entry: ConversationEntry = { id: randomUUID(), createdAt: now, updatedAt: now }
    this.entries.unshift(entry)
    this.save()
    return entry
  }

  /** 取会话项；不存在则按给定 id 补建（容错：渲染层传入未登记 id 时不阻断发消息） */
  getOrCreate(id: string): ConversationEntry {
    const found = this.get(id)
    if (found) return found
    const now = Date.now()
    const entry: ConversationEntry = { id, createdAt: now, updatedAt: now }
    this.entries.unshift(entry)
    this.save()
    return entry
  }

  rename(id: string, title: string): void {
    const e = this.get(id)
    if (!e) throw new Error('会话不存在')
    e.titleOverride = title
    e.updatedAt = Date.now()
    this.save()
  }

  setSessionId(id: string, sessionId: string): void {
    const e = this.getOrCreate(id)
    e.sessionId = sessionId
    this.save()
  }

  /** 活动后置顶 + 刷新 updatedAt */
  touch(id: string): void {
    const idx = this.entries.findIndex(e => e.id === id)
    if (idx < 0) return
    const [e] = this.entries.splice(idx, 1)
    e.updatedAt = Date.now()
    this.entries.unshift(e)
    this.save()
  }

  remove(id: string): void {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length !== before) this.save()
  }
}
