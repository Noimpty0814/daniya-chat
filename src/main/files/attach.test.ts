import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerFiles, buildFileContext, readFileForContext, isAuthorized, injectFilesIntoLastTurn, MAX_ATTACH_SIZE } from './attach'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-attach-')) })

function write(name: string, content: string | Buffer): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('registerFiles', () => {
  it('正常文本文件：入授权集并返回元数据', () => {
    const p = write('a.txt', '你好')
    const r = registerFiles([p])
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([{ name: 'a.txt', path: p }])
    expect(isAuthorized(p)).toBe(true)
  })

  it('不存在的文件：拒绝且不入集', () => {
    const r = registerFiles([path.join(dir, 'nope.txt')])
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([])
    expect(r.error).toContain('nope.txt')
  })

  it('二进制文件（含 NUL）：拒绝', () => {
    const p = write('bin.dat', Buffer.from([0x01, 0x00, 0x02, 0x03]))
    const r = registerFiles([p])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('二进制')
  })

  it('超过 512KB：拒绝', () => {
    const p = write('big.txt', 'a'.repeat(512 * 1024 + 1))
    const r = registerFiles([p])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('512KB')
  })

  it('目录：拒绝', () => {
    const r = registerFiles([dir])
    expect(r.ok).toBe(false)
  })

  it('部分成功：成功的入集并返回，失败列 error', () => {
    const good = write('good.txt', 'ok')
    const r = registerFiles([good, path.join(dir, 'missing.txt')])
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([{ name: 'good.txt', path: good }])
    expect(isAuthorized(good)).toBe(true)
  })
})

describe('buildFileContext / readFileForContext', () => {
  it('注入格式：[文件: name（path）] 包裹内容', () => {
    const p = write('a.txt', '文件内容')
    registerFiles([p])
    expect(buildFileContext([{ name: 'a.txt', path: p }])).toBe(`[文件: a.txt（${p}）]\n文件内容\n[/文件]`)
  })

  it('多文件用空行分隔', () => {
    const p1 = write('a.txt', 'A'); const p2 = write('b.txt', 'B')
    registerFiles([p1, p2])
    expect(buildFileContext([{ name: 'a.txt', path: p1 }, { name: 'b.txt', path: p2 }]))
      .toBe(`[文件: a.txt（${p1}）]\nA\n[/文件]\n\n[文件: b.txt（${p2}）]\nB\n[/文件]`)
  })

  it('未授权读取：抛错', () => {
    const p = write('x.txt', 'secret')
    expect(() => readFileForContext(p)).toThrow('未授权')
  })

  it('读取失败（文件被删）：注入失败占位而非抛错', () => {
    const p = write('gone.txt', 'tmp')
    registerFiles([p])
    fs.rmSync(p)
    expect(buildFileContext([{ name: 'gone.txt', path: p }])).toBe(`[文件: gone.txt（${p}）]\n（读取失败，文件不存在或不可读）\n[/文件]`)
  })

  it('读取超过 512KB：截断兜底', () => {
    // 注册时 ≤512KB 入授权集，注册后被写大（TOCTOU/retry 现读），读取时截断兜底
    const p = write('big.txt', 'b'.repeat(100))
    registerFiles([p])
    fs.writeFileSync(p, 'b'.repeat(512 * 1024 + 100))
    const out = readFileForContext(p)
    expect(Buffer.byteLength(out, 'utf8')).toBe(MAX_ATTACH_SIZE)
  })

  it('中文内容按字节截断（字符数不超限但字节超限）', () => {
    // '好' 为 3 字节 UTF-8：175762 字符 < 512K 不触发旧字符截断，但 525286 字节 > 512KB
    const p = write('cjk.txt', '好'.repeat(100))
    registerFiles([p])
    fs.writeFileSync(p, '好'.repeat(174_762) + 'b'.repeat(1000))
    const out = readFileForContext(p)
    expect(Buffer.byteLength(out, 'utf8')).toBe(MAX_ATTACH_SIZE)
    expect(out.length).toBe(174_764)
  })
})

describe('injectFilesIntoLastTurn', () => {
  it('末轮为 user 且带文件：content 追加注入段', () => {
    const p = write('a.txt', '内容')
    registerFiles([p])
    const turns = [{ role: 'user', content: '帮我看看' }]
    injectFilesIntoLastTurn(turns, [{ name: 'a.txt', path: p }])
    expect(turns[0].content).toBe(`帮我看看\n\n[文件: a.txt（${p}）]\n内容\n[/文件]`)
  })

  it('无文件或末轮非 user：不动', () => {
    const turns = [{ role: 'assistant', content: '好的' }]
    injectFilesIntoLastTurn(turns, [])
    expect(turns[0].content).toBe('好的')
  })
})
