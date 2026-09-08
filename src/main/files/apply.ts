import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiffLine, FileProposalEvent } from '../../shared/types'
import { isAuthorized, isBinary } from './attach'
import { diffLines } from './diff'

export const MAX_PROPOSAL_SIZE = 64 * 1024

interface ProposalRecord {
  id: string
  path: string
  resolvedPath: string
  content: string
  diff: DiffLine[]
  autoApplied: boolean
}

const proposals = new Map<string, ProposalRecord>()

function inWorkDir(resolved: string, workDir: string): boolean {
  if (!workDir) return false
  const wd = path.resolve(workDir)
  return resolved.startsWith(wd + path.sep)
}

export function authorizeProposal(rawPath: string, workDir: string): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const resolved = path.resolve(rawPath)
  if (!isAuthorized(resolved) && !inWorkDir(resolved, workDir)) {
    return { ok: false, error: '拒绝：只能修改本轮对话附带或工作目录内的文件' }
  }
  return { ok: true, resolvedPath: resolved }
}

export function createProposal(rawPath: string, content: string, fileSettings: { workDir: string; autoApply: boolean }):
  { ok: true; event: FileProposalEvent } | { ok: false; error: string } {
  const auth = authorizeProposal(rawPath, fileSettings.workDir)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (content.length > MAX_PROPOSAL_SIZE) return { ok: false, error: '拒绝：提案超过 64KB' }
  let oldText: string
  try { oldText = fs.readFileSync(auth.resolvedPath, 'utf8') } catch { return { ok: false, error: '拒绝：无法读取目标文件' } }
  if (oldText.length > MAX_PROPOSAL_SIZE) return { ok: false, error: '拒绝：目标文件超过 64KB' }
  if (isBinary(auth.resolvedPath)) return { ok: false, error: '拒绝：二进制文件不可修改' }
  const id = randomUUID()
  const diff = diffLines(oldText, content)
  const autoApplied = fileSettings.autoApply && inWorkDir(auth.resolvedPath, fileSettings.workDir)
  proposals.set(id, { id, path: rawPath, resolvedPath: auth.resolvedPath, content, diff, autoApplied })
  return { ok: true, event: { id, path: rawPath, resolvedPath: auth.resolvedPath, diff, autoApplied } }
}

export function applyProposal(id: string): { ok: boolean; error?: string } {
  const rec = proposals.get(id)
  if (!rec) return { ok: false, error: '提案不存在或已处理' }
  proposals.delete(id)
  try {
    try { fs.renameSync(rec.resolvedPath, rec.resolvedPath + '.bak') } catch { /* 备份失败不阻断写入 */ }
    const tmp = rec.resolvedPath + '.tmp'
    fs.writeFileSync(tmp, rec.content, 'utf8')
    fs.renameSync(tmp, rec.resolvedPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}

export function rejectProposal(id: string): void { proposals.delete(id) }
