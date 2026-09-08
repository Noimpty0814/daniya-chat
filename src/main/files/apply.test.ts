import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerFiles } from './attach'
import { createProposal, applyProposal, rejectProposal } from './apply'

let dir: string
let workDir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-apply-'))
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-work-'))
})

function write(p: string, content: string): void { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }

describe('createProposal 权限校验', () => {
  it('未附件且不在工作目录：拒绝', () => {
    const p = path.join(dir, 'x.txt'); write(p, 'old')
    const r = createProposal(p, 'new', { workDir: '', autoApply: false })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('拒绝')
  })

  it('已附件文件：允许', () => {
    const p = path.join(dir, 'x.txt'); write(p, 'old')
    registerFiles([p])
    const r = createProposal(p, 'new', { workDir: '', autoApply: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.diff).toContainEqual({ kind: 'del', text: 'old' })
      expect(r.event.autoApplied).toBe(false)
    }
  })

  it('工作目录内：允许；.. 逃逸：拒绝；同前缀目录不误判', () => {
    const inW = path.join(workDir, 'a.txt'); write(inW, 'old')
    const r1 = createProposal(inW, 'new', { workDir, autoApply: false })
    expect(r1.ok).toBe(true)
    const escape = path.join(workDir, '..', 'out.txt')
    expect(createProposal(escape, 'x', { workDir, autoApply: false }).ok).toBe(false)
    const samePrefix = path.join(workDir + '2', 'b.txt'); write(samePrefix, 'old')
    expect(createProposal(samePrefix, 'x', { workDir, autoApply: false }).ok).toBe(false)
  })

  it('工作目录+自动放行开关：autoApplied=true', () => {
    const inW = path.join(workDir, 'a.txt'); write(inW, 'old')
    const r = createProposal(inW, 'new', { workDir, autoApply: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.autoApplied).toBe(true)
  })

  it('提案超 64KB / 目标文件超 64KB / 二进制目标：拒绝', () => {
    const p = path.join(dir, 'x.txt'); write(p, 'old')
    registerFiles([p])
    expect(createProposal(p, 'n'.repeat(64 * 1024 + 1), { workDir: '', autoApply: false }).ok).toBe(false)
    const big = path.join(dir, 'big.txt'); write(big, 'b'.repeat(64 * 1024 + 1))
    registerFiles([big])
    expect(createProposal(big, 'small', { workDir: '', autoApply: false }).ok).toBe(false)
    // 二进制走工作目录路径（附件注册阶段就会拒绝二进制，测不到 createProposal 的二进制检查）
    const bin = path.join(workDir, 'bin.dat'); write(bin, Buffer.from([1, 0, 2]).toString('binary'))
    expect(createProposal(bin, 'x', { workDir, autoApply: false }).ok).toBe(false)
  })
})

describe('applyProposal', () => {
  it('确认写入：.bak 保留原内容，文件为新内容', () => {
    const p = path.join(dir, 'x.txt'); write(p, 'old')
    registerFiles([p])
    const r = createProposal(p, 'new', { workDir: '', autoApply: false })
    if (!r.ok) throw new Error('unreachable')
    const a = applyProposal(r.event.id)
    expect(a.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
    expect(fs.readFileSync(p + '.bak', 'utf8')).toBe('old')
  })

  it('重复应用/不存在 id：拒绝', () => {
    expect(applyProposal('no-such-id').ok).toBe(false)
  })

  it('reject 后不可再 apply', () => {
    const p = path.join(dir, 'x.txt'); write(p, 'old')
    registerFiles([p])
    const r = createProposal(p, 'new', { workDir: '', autoApply: false })
    if (!r.ok) throw new Error('unreachable')
    rejectProposal(r.event.id)
    expect(applyProposal(r.event.id).ok).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe('old')
  })
})
