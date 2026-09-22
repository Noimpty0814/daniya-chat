/**
 * FileProposalService 测试（file-proposal-service 票；原 attach/apply 两测试并入）。
 *
 * 授权语义钉死：Map<conversationId, Set<resolvedPath>> 按会话作用域——
 * 同会话附带→提案放行（含跨轮持续有效）；跨会话附带→拒绝（FILE_CONTRACT"本轮对话"收窄）；
 * 工作目录内恒通，不受会话作用域影响；closeConversation 回收授权+未决提案。
 * service.ts 传递依赖 electron（dialog），沿用 chat-runtime.test.ts 的 mock 形态。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileProposalService, stripFileContext, MAX_ATTACH_SIZE } from './service'

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }
}))

const CONV = 'conv-a'
const NO_FILE_SETTINGS = { workDir: '', autoApply: false }

let dir: string
let workDir: string
let files: FileProposalService
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-files-'))
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-work-'))
  files = new FileProposalService()
})

function write(name: string, content: string | Buffer): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

function writeAt(p: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** 从注入后的 turn.content 取出 [文件: name（...）] 块的正文 */
function injectedBody(content: string, name: string): string {
  const m = new RegExp(`\\[文件: ${name}（[^）]*）\\]\\n([\\s\\S]*?)\\n\\[/文件\\]`).exec(content)
  if (!m) throw new Error('注入块缺失：' + content)
  return m[1]
}

describe('register 附件登记', () => {
  it('正常文本文件：入该会话授权集并返回元数据', () => {
    const p = write('a.txt', '你好')
    const r = files.register(CONV, [p])
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([{ name: 'a.txt', path: p }])
    // 授权可观察面：injectTurn 能读出内容；同会话 createProposal 放行
    const turn = { role: 'user', content: '看看' }
    files.injectTurn(CONV, turn, r.files)
    expect(injectedBody(turn.content, 'a.txt')).toBe('你好')
    expect(files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS).ok).toBe(true)
  })

  it('不存在的文件：拒绝且不入集', () => {
    const missing = path.join(dir, 'nope.txt')
    const r = files.register(CONV, [missing])
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([])
    expect(r.error).toContain('nope.txt')
    expect(files.createProposal(CONV, missing, 'x', NO_FILE_SETTINGS).ok).toBe(false)
  })

  it('二进制文件（含 NUL）：拒绝', () => {
    const p = write('bin.dat', Buffer.from([0x01, 0x00, 0x02, 0x03]))
    const r = files.register(CONV, [p])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('二进制')
  })

  it('超过 512KB：拒绝', () => {
    const p = write('big.txt', 'a'.repeat(512 * 1024 + 1))
    const r = files.register(CONV, [p])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('512KB')
  })

  it('目录：拒绝', () => {
    const r = files.register(CONV, [dir])
    expect(r.ok).toBe(false)
  })

  it('部分成功：成功的入集并返回，失败列 error', () => {
    const good = write('good.txt', 'ok')
    const r = files.register(CONV, [good, path.join(dir, 'missing.txt')])
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([{ name: 'good.txt', path: good }])
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, r.files)
    expect(injectedBody(turn.content, 'good.txt')).toBe('ok')
  })

  it('无 conversationId：拒绝', () => {
    const p = write('a.txt', 'x')
    const r = files.register('', [p])
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([])
  })

  it('超过 3 个：前 3 个入集，超出报软上限（与 pick 通道同一兜底）', () => {
    const ps = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(n => write(n, n))
    const r = files.register(CONV, ps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('最多附加 3 个文件')
    expect(r.files).toHaveLength(3)
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, ps.map(p => ({ name: path.basename(p), path: p })))
    expect(injectedBody(turn.content, 'c.txt')).toBe('c.txt')
    // 第 4 个未入授权集：注入块在但正文读不出
    expect(injectedBody(turn.content, 'd.txt')).toBe('（读取失败，文件不存在或不可读）')
  })
})

describe('pick', () => {
  it('无 conversationId：不弹框直接拒绝', async () => {
    await expect(files.pick('')).resolves.toMatchObject({ files: [], error: '缺少会话 ID' })
  })
})

describe('injectTurn 附件注入', () => {
  it('末轮 user 且带文件：content 追加注入段', () => {
    const p = write('a.txt', '内容')
    files.register(CONV, [p])
    const turn = { role: 'user', content: '帮我看看' }
    files.injectTurn(CONV, turn, [{ name: 'a.txt', path: p }])
    expect(turn.content).toBe(`帮我看看\n\n[文件: a.txt（${p}）]\n内容\n[/文件]`)
  })

  it('多文件用空行分隔', () => {
    const p1 = write('a.txt', 'A'); const p2 = write('b.txt', 'B')
    files.register(CONV, [p1, p2])
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'a.txt', path: p1 }, { name: 'b.txt', path: p2 }])
    expect(turn.content).toBe(`\n\n[文件: a.txt（${p1}）]\nA\n[/文件]\n\n[文件: b.txt（${p2}）]\nB\n[/文件]`)
  })

  it('未授权读取：落占位串不泄漏内容', () => {
    const p = write('x.txt', 'secret')
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'x.txt', path: p }])
    expect(injectedBody(turn.content, 'x.txt')).toBe('（读取失败，文件不存在或不可读）')
  })

  it('跨会话附件：injectTurn 读不到别的会话的授权', () => {
    const p = write('a.txt', 'A 的文件')
    files.register('conv-a', [p])
    const turn = { role: 'user', content: '' }
    files.injectTurn('conv-b', turn, [{ name: 'a.txt', path: p }])
    expect(injectedBody(turn.content, 'a.txt')).toBe('（读取失败，文件不存在或不可读）')
  })

  it('读取失败（文件被删）：注入失败占位而非抛错', () => {
    const p = write('gone.txt', 'tmp')
    files.register(CONV, [p])
    fs.rmSync(p)
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'gone.txt', path: p }])
    expect(injectedBody(turn.content, 'gone.txt')).toBe('（读取失败，文件不存在或不可读）')
  })

  it('读取超过 512KB：截断兜底', () => {
    // 注册时 ≤512KB 入授权集，注册后被写大（TOCTOU/retry 现读），读取时截断兜底
    const p = write('big.txt', 'b'.repeat(100))
    files.register(CONV, [p])
    fs.writeFileSync(p, 'b'.repeat(512 * 1024 + 100))
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'big.txt', path: p }])
    expect(Buffer.byteLength(injectedBody(turn.content, 'big.txt'), 'utf8')).toBe(MAX_ATTACH_SIZE)
  })

  it('中文内容按字节截断（字符数不超限但字节超限）', () => {
    // '好' 为 3 字节 UTF-8：175762 字符 < 512K 不触发旧字符截断，但 525286 字节 > 512KB
    const p = write('cjk.txt', '好'.repeat(100))
    files.register(CONV, [p])
    fs.writeFileSync(p, '好'.repeat(174_762) + 'b'.repeat(1000))
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'cjk.txt', path: p }])
    const out = injectedBody(turn.content, 'cjk.txt')
    expect(Buffer.byteLength(out, 'utf8')).toBe(MAX_ATTACH_SIZE)
    expect(out.length).toBe(174_764)
  })

  it('无文件或 turn 非 user：不动', () => {
    const turn = { role: 'assistant', content: '好的' }
    files.injectTurn(CONV, turn, [])
    expect(turn.content).toBe('好的')
  })
})

describe('stripFileContext', () => {
  it('剥离单个注入块并保留正文', () => {
    const content = '看看这个\n\n[文件: a.txt（C:/tmp/a.txt）]\n文件正文\n[/文件]'
    expect(stripFileContext(content)).toBe('看看这个')
  })

  it('剥离多个注入块', () => {
    const content = '你好\n\n[文件: a.txt（C:/tmp/a.txt）]\nA\n[/文件]\n\n[文件: b.txt（C:/tmp/b.txt）]\nB\n[/文件]'
    expect(stripFileContext(content)).toBe('你好')
  })

  it('无注入块：原样返回', () => {
    expect(stripFileContext('普通消息')).toBe('普通消息')
  })

  it('正文与注入块之间无空行也能剥离（retry 现读路径同样格式）', () => {
    const content = '开头[文件: x.txt（C:/tmp/x.txt）]\n内容\n[/文件]结尾'
    expect(stripFileContext(content)).toBe('开头结尾')
  })
})

describe('createProposal 权限校验', () => {
  it('未附件且不在工作目录：拒绝', () => {
    const p = write('x.txt', 'old')
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('拒绝')
  })

  it('同会话附带文件：允许', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.diff).toContainEqual({ kind: 'del', text: 'old' })
      expect(r.event.autoApplied).toBe(false)
    }
  })

  it('跨会话附带：拒绝（FILE_CONTRACT 本轮对话收窄）', () => {
    const p = write('x.txt', 'old')
    files.register('conv-a', [p])
    const r = files.createProposal('conv-b', p, 'new', NO_FILE_SETTINGS)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('拒绝')
  })

  it('工作目录内：允许；.. 逃逸：拒绝；同前缀目录不误判', () => {
    const inW = path.join(workDir, 'a.txt'); writeAt(inW, 'old')
    const r1 = files.createProposal(CONV, inW, 'new', { workDir, autoApply: false })
    expect(r1.ok).toBe(true)
    const escape = path.join(workDir, '..', 'out.txt')
    expect(files.createProposal(CONV, escape, 'x', { workDir, autoApply: false }).ok).toBe(false)
    const samePrefix = path.join(workDir + '2', 'b.txt'); writeAt(samePrefix, 'old')
    expect(files.createProposal(CONV, samePrefix, 'x', { workDir, autoApply: false }).ok).toBe(false)
  })

  it('工作目录成员资格恒通：未经任何会话附带也放行', () => {
    const inW = path.join(workDir, 'a.txt'); writeAt(inW, 'old')
    // 未注册任何会话的 conversationId 也放行——inWorkDir 不受会话作用域影响
    const r = files.createProposal('never-seen', inW, 'new', { workDir, autoApply: false })
    expect(r.ok).toBe(true)
  })

  it('工作目录+自动放行开关：autoApplied=true', () => {
    const inW = path.join(workDir, 'a.txt'); writeAt(inW, 'old')
    const r = files.createProposal(CONV, inW, 'new', { workDir, autoApply: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.autoApplied).toBe(true)
  })

  it('提案超 64KB / 目标文件超 64KB / 二进制目标：拒绝', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    expect(files.createProposal(CONV, p, 'n'.repeat(64 * 1024 + 1), NO_FILE_SETTINGS).ok).toBe(false)
    const big = write('big.txt', 'b'.repeat(64 * 1024 + 1))
    files.register(CONV, [big])
    expect(files.createProposal(CONV, big, 'small', NO_FILE_SETTINGS).ok).toBe(false)
    // 二进制走工作目录路径（附件注册阶段就会拒绝二进制，测不到 createProposal 的二进制检查）
    const bin = path.join(workDir, 'bin.dat'); writeAt(bin, Buffer.from([1, 0, 2]).toString('binary'))
    expect(files.createProposal(CONV, bin, 'x', { workDir, autoApply: false }).ok).toBe(false)
  })
})

describe('applyProposal / rejectProposal', () => {
  it('确认写入：.bak 保留原内容，文件为新内容', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    if (!r.ok) throw new Error('unreachable')
    const a = files.applyProposal(r.event.id)
    expect(a.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
    expect(fs.readFileSync(p + '.bak', 'utf8')).toBe('old')
  })

  it('重复应用/不存在 id：拒绝', () => {
    expect(files.applyProposal('no-such-id').ok).toBe(false)
  })

  it('写入失败后可重试：目标被目录占位时失败，恢复后同 id 再应用成功', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    if (!r.ok) throw new Error('unreachable')
    fs.rmSync(p)
    fs.mkdirSync(p)
    const a1 = files.applyProposal(r.event.id)
    expect(a1.ok).toBe(false)
    fs.rmSync(p, { recursive: true })
    const a2 = files.applyProposal(r.event.id)
    expect(a2.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
  })

  it('reject 后不可再 apply', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    if (!r.ok) throw new Error('unreachable')
    files.rejectProposal(r.event.id)
    expect(files.applyProposal(r.event.id).ok).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe('old')
  })
})

describe('closeConversation 生命周期回收', () => {
  it('回收后该会话附件授权失效', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    files.closeConversation(CONV)
    expect(files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS).ok).toBe(false)
    const turn = { role: 'user', content: '' }
    files.injectTurn(CONV, turn, [{ name: 'x.txt', path: p }])
    expect(injectedBody(turn.content, 'x.txt')).toBe('（读取失败，文件不存在或不可读）')
  })

  it('回收后该会话未决提案 apply 返回不存在', () => {
    const p = write('x.txt', 'old')
    files.register(CONV, [p])
    const r = files.createProposal(CONV, p, 'new', NO_FILE_SETTINGS)
    if (!r.ok) throw new Error('unreachable')
    files.closeConversation(CONV)
    expect(files.applyProposal(r.event.id).ok).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe('old') // 未写入
  })

  it('只回收目标会话：其他会话授权与未决提案不受影响', () => {
    const pa = write('a.txt', 'old-a')
    const pb = write('b.txt', 'old-b')
    files.register('conv-a', [pa])
    files.register('conv-b', [pb])
    const ra = files.createProposal('conv-a', pa, 'new-a', NO_FILE_SETTINGS)
    const rb = files.createProposal('conv-b', pb, 'new-b', NO_FILE_SETTINGS)
    if (!ra.ok || !rb.ok) throw new Error('unreachable')
    files.closeConversation('conv-a')
    expect(files.applyProposal(ra.event.id).ok).toBe(false)
    expect(files.createProposal('conv-a', pa, 'x', NO_FILE_SETTINGS).ok).toBe(false)
    expect(files.applyProposal(rb.event.id).ok).toBe(true)
    expect(fs.readFileSync(pb, 'utf8')).toBe('new-b')
  })
})
