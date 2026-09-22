/**
 * FileProposalService —— 附件授权与文件提案生命周期的唯一所有者（file-proposal-service 票）。
 *
 * 收编原 attach.ts/apply.ts 两个模块级可变单例，文件域不再有模块级可变状态：
 * - authorized：Map<conversationId, Set<resolvedPath>>——授权按会话作用域存活，
 *   落实 FILE_CONTRACT"只能修改本轮对话中用户附带的文件"（按会话解读：同会话
 *   跨轮附带持续有效，跨会话无效）；工作目录内成员资格（inWorkDir）是独立的
 *   恒通授权路径，不受会话作用域影响。
 * - proposals：Map<proposalId, ProposalRecord>——提案记录挂 conversationId，
 *   deleteConversation 经 closeConversation 一并回收该会话的授权与未决提案。
 *
 * 校验/读取/备份/原子写为模块内私有函数或实例私有方法；FileProposalParser 与
 * diffLines 是无状态工具，留在各自模块原样不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import type { DiffLine, FileAttachment, FileProposalEvent } from '../../shared/types'
import { MAX_ATTACH_FILES } from '../../shared/consts'
import { diffLines } from './diff'

export const MAX_ATTACH_SIZE = 512 * 1024
export const MAX_PROPOSAL_SIZE = 64 * 1024

/** 未决提案：conversationId 挂账，供 closeConversation 随会话一并回收 */
interface ProposalRecord {
  id: string
  conversationId: string
  path: string
  resolvedPath: string
  content: string
  diff: DiffLine[]
  autoApplied: boolean
}

/** 前 8KB 含 NUL 字节判为二进制 */
function isBinary(p: string): boolean {
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, 8192, 0)
    return buf.subarray(0, n).includes(0)
  } finally { fs.closeSync(fd) }
}

function inWorkDir(resolved: string, workDir: string): boolean {
  if (!workDir) return false
  const wd = path.resolve(workDir)
  return resolved.startsWith(wd + path.sep)
}

/** 投影显示时剥离注入块（harness 历史里的 user 轮次含 [文件] 上下文，气泡不应显示） */
export function stripFileContext(content: string): string {
  return content.replace(/\n{0,2}\[文件: [^\]]*\]\n[\s\S]*?\[\/文件\]/g, '')
}

export class FileProposalService {
  /** 附件授权：conversationId → 该会话附带过的文件（resolve 后路径） */
  private readonly authorized = new Map<string, Set<string>>()
  private readonly proposals = new Map<string, ProposalRecord>()

  /** file:register：存在/非目录/非二进制/≤512KB/≤3 个校验，通过的记入该会话授权集 */
  register(conversationId: string, paths: string[]): { ok: boolean; files: FileAttachment[]; error?: string } {
    if (!conversationId) return { ok: false, files: [], error: '缺少会话 ID' }
    const over = paths.length > MAX_ATTACH_FILES ? `最多附加 ${MAX_ATTACH_FILES} 个文件` : undefined
    const set = this.authorized.get(conversationId) ?? new Set<string>()
    const files: FileAttachment[] = []
    const failed: string[] = []
    for (const p of paths.slice(0, MAX_ATTACH_FILES)) {
      try {
        if (!fs.existsSync(p)) throw new Error('文件不存在')
        if (fs.statSync(p).isDirectory()) throw new Error('不支持文件夹')
        if (isBinary(p)) throw new Error('二进制文件')
        if (fs.statSync(p).size > MAX_ATTACH_SIZE) throw new Error('超过 512KB')
        set.add(path.resolve(p))
        files.push({ name: path.basename(p), path: p })
      } catch (e) {
        failed.push(path.basename(p) + (e instanceof Error ? `：${e.message}` : ''))
      }
    }
    if (set.size > 0) this.authorized.set(conversationId, set)
    const inner = failed.length > 0 ? failed.join('；') : undefined
    const error = over && inner ? `${over}；${inner}` : (over ?? inner)
    if (error !== undefined) return { ok: false, files, error }
    return { ok: true, files }
  }

  /** file:pick：对话框选文件后走 register（数量软上限由 register 统一兜底） */
  async pick(conversationId: string): Promise<{ files: FileAttachment[]; error?: string }> {
    if (!conversationId) return { files: [], error: '缺少会话 ID' }
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (r.canceled || r.filePaths.length === 0) return { files: [] }
    const reg = this.register(conversationId, r.filePaths)
    return { files: reg.files, error: reg.error }
  }

  /** startReply 附件注入：只读该会话授权内的附件（retry 时现读，R26 同法）；未授权/读取失败落占位串 */
  injectTurn(conversationId: string, turn: { role: string; content: string }, files: FileAttachment[]): void {
    if (turn.role !== 'user' || files.length === 0) return
    const parts: string[] = []
    for (const f of files) {
      let body: string
      try { body = this.readFileForContext(conversationId, f.path) } catch { body = '（读取失败，文件不存在或不可读）' }
      parts.push(`[文件: ${f.name}（${f.path}）]\n${body}\n[/文件]`)
    }
    turn.content = turn.content + '\n\n' + parts.join('\n\n')
  }

  createProposal(conversationId: string, rawPath: string, content: string, fileSettings: { workDir: string; autoApply: boolean }):
    { ok: true; event: FileProposalEvent } | { ok: false; error: string } {
    const auth = this.authorizeProposal(conversationId, rawPath, fileSettings.workDir)
    if (!auth.ok) return { ok: false, error: auth.error }
    if (content.length > MAX_PROPOSAL_SIZE) return { ok: false, error: '拒绝：提案超过 64KB' }
    let oldText: string
    try {
      const st = fs.statSync(auth.resolvedPath)
      if (st.size > MAX_PROPOSAL_SIZE) return { ok: false, error: '拒绝：目标文件超过 64KB' }
      oldText = fs.readFileSync(auth.resolvedPath, 'utf8')
    } catch { return { ok: false, error: '拒绝：无法读取目标文件' } }
    if (isBinary(auth.resolvedPath)) return { ok: false, error: '拒绝：二进制文件不可修改' }
    const id = randomUUID()
    const diff = diffLines(oldText, content)
    const autoApplied = fileSettings.autoApply && inWorkDir(auth.resolvedPath, fileSettings.workDir)
    this.proposals.set(id, { id, conversationId, path: rawPath, resolvedPath: auth.resolvedPath, content, diff, autoApplied })
    return { ok: true, event: { id, path: rawPath, resolvedPath: auth.resolvedPath, diff, autoApplied } }
  }

  applyProposal(id: string): { ok: boolean; error?: string } {
    const rec = this.proposals.get(id)
    if (!rec) return { ok: false, error: '提案不存在或已处理' }
    try {
      try { fs.copyFileSync(rec.resolvedPath, rec.resolvedPath + '.bak') } catch { /* 备份失败不阻断写入 */ }
      const tmp = rec.resolvedPath + '.tmp'
      fs.writeFileSync(tmp, rec.content, 'utf8')
      fs.renameSync(tmp, rec.resolvedPath)
      this.proposals.delete(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
    }
  }

  rejectProposal(id: string): void { this.proposals.delete(id) }

  /** 会话删除回收：清该会话附件授权 + 删除其未决提案 */
  closeConversation(conversationId: string): void {
    this.authorized.delete(conversationId)
    for (const [id, rec] of this.proposals) {
      if (rec.conversationId === conversationId) this.proposals.delete(id)
    }
  }

  /** 授权 = 该会话附带过（resolve 后精确匹配）或工作目录内（恒通路径） */
  private authorizeProposal(conversationId: string, rawPath: string, workDir: string): { ok: true; resolvedPath: string } | { ok: false; error: string } {
    const resolved = path.resolve(rawPath)
    if (!this.authorized.get(conversationId)?.has(resolved) && !inWorkDir(resolved, workDir)) {
      return { ok: false, error: '拒绝：只能修改本轮对话附带或工作目录内的文件' }
    }
    return { ok: true, resolvedPath: resolved }
  }

  private readFileForContext(conversationId: string, p: string): string {
    if (this.authorized.get(conversationId)?.has(path.resolve(p)) !== true) throw new Error(`未授权文件：${p}`)
    const st = fs.statSync(p)
    if (st.size <= MAX_ATTACH_SIZE) return fs.readFileSync(p, 'utf8')
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(MAX_ATTACH_SIZE)
      fs.readSync(fd, buf, 0, MAX_ATTACH_SIZE, 0)
      const out = buf.toString('utf8')
      // 末尾可能切在多字节字符中间 → toString 产出 U+FFFD 替换符，剥掉
      return out.endsWith('\uFFFD') ? out.slice(0, -1) : out
    } finally { fs.closeSync(fd) }
  }
}
