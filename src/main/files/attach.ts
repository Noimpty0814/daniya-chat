import fs from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import type { FileAttachment } from '../../shared/types'

export const MAX_ATTACH_SIZE = 512 * 1024

const authorized = new Set<string>()

/** 前 8KB 含 NUL 字节判为二进制 */
export function isBinary(p: string): boolean {
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, 8192, 0)
    return buf.subarray(0, n).includes(0)
  } finally { fs.closeSync(fd) }
}

export function registerFiles(paths: string[]): { ok: boolean; files: FileAttachment[]; error?: string } {
  const files: FileAttachment[] = []
  const failed: string[] = []
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) throw new Error('文件不存在')
      if (fs.statSync(p).isDirectory()) throw new Error('不支持文件夹')
      if (isBinary(p)) throw new Error('二进制文件')
      if (fs.statSync(p).size > MAX_ATTACH_SIZE) throw new Error('超过 512KB')
      authorized.add(path.resolve(p))
      files.push({ name: path.basename(p), path: p })
    } catch (e) {
      failed.push(path.basename(p) + (e instanceof Error ? `：${e.message}` : ''))
    }
  }
  if (failed.length > 0) return { ok: false, files, error: failed.join('；') }
  return { ok: true, files }
}

export async function pickFiles(): Promise<FileAttachment[]> {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  if (r.canceled || r.filePaths.length === 0) return []
  return registerFiles(r.filePaths.slice(0, 3)).files
}

export function isAuthorized(p: string): boolean {
  return authorized.has(path.resolve(p))
}

export function readFileForContext(p: string): string {
  if (!isAuthorized(p)) throw new Error(`未授权文件：${p}`)
  const raw = fs.readFileSync(p, 'utf8')
  return raw.length > MAX_ATTACH_SIZE ? raw.slice(0, MAX_ATTACH_SIZE) : raw
}

export function buildFileContext(files: FileAttachment[]): string {
  const parts: string[] = []
  for (const f of files) {
    let body: string
    try { body = readFileForContext(f.path) } catch { body = '（读取失败，文件不存在或不可读）' }
    parts.push(`[文件: ${f.name}]\n${body}\n[/文件]`)
  }
  return parts.join('\n\n')
}

/** 把本轮附件内容注入历史末轮 user 消息（retry 时 p.files 现读，R26 同法） */
export function injectFilesIntoLastTurn(turns: { role: string; content: string }[], files: FileAttachment[]): void {
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'user' || files.length === 0) return
  last.content = last.content + '\n\n' + buildFileContext(files)
}
