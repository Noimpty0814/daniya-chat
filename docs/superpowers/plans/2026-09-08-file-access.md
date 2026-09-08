# 达妮娅文件读+改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把本地文件附进对话（读），并让达妮娅通过提案标记格式提出文件修改、经用户确认（或工作目录自动放行）后写入（改）。

**Architecture:** 渲染层只持文件元数据，内容一律由主进程读取；附件路径入主进程授权集。改文件 = 模型输出 ```daniya-file fenced block（流式剥离，照 EmotionParser 架构），主进程解析→权限校验（附件集 ∪ 工作目录）→生成行级 diff→渲染层确认面板→.bak 备份+原子写。

**Tech Stack:** Electron 44 + electron-vite 5 + React 19 + TypeScript + vitest 4（无新依赖，diff 自写行级 LCS）。

**Spec:** docs/superpowers/specs/2026-09-08-file-access-design.md

## Global Constraints

- 既有 124 个测试必须保持绿；`npm run typecheck` 绿；新增测试 TDD（RED 留证据再 GREEN）。
- 附件上限：每轮 3 个、单个 512KB（附件时超限拒绝，读取时截断兜底）；二进制（前 8KB 含 NUL）拒绝。
- 提案上限：content ≤ 64KB；目标文件 ≤ 64KB（diff 内存保护）；仅 UTF-8 文本。
- 渲染层永不直接读文件内容；主进程白名单式读写；写入前 .bak 覆盖式备份 + tmp/rename 原子写。
- 桌宠目录 `E:\迅雷下载\达妮娅-带表情版\` 绝对只读铁律不受影响（除非用户主动附件/设工作目录——尊重用户选择）。
- git 提交必须 `-c user.name="lenovo" -c user.email="lenovo@local"`；不要 npm install；实现者禁派子代理。
- 中文 UI 文案；沿用现有视觉（深色 #17151f / 紫 #8b5cf6）。
- 工作区：执行时从 main 开新 worktree 分支（superpowers:using-git-worktrees），勿直接在 main 开发。

---

## 文件结构

| 文件 | 任务 | 职责 |
|---|---|---|
| Create: `src/main/files/attach.ts` | 16a | 授权集、registerFiles/pickFiles 校验、readFileForContext、buildFileContext、injectFilesIntoLastTurn、isBinary |
| Create: `src/main/files/attach.test.ts` | 16a | 上述纯函数测试 |
| Modify: `src/shared/types.ts` | 16a/16b | FileAttachment、files 字段、DiffLine、FileProposalEvent |
| Modify: `src/shared/api.ts` | 16a/16b | Api 接口扩展 |
| Modify: `src/preload/index.ts` | 16a/16b | 新通道桥接 |
| Modify: `src/main/ipc.ts` | 16a/16b | file:* handlers、startReply 注入、proposal 事件流 |
| Modify: `src/renderer/src/components/Composer.tsx` | 16a | 选文件按钮、拖拽、chips |
| Modify: `src/renderer/src/App.tsx` | 16a/16b | files 载荷、proposal 订阅/应用/拒绝 |
| Modify: `src/renderer/src/state/chatStore.ts` | 16a/16b | RetryPayload.files、proposal state/action |
| Modify: `src/renderer/src/components/Message.tsx` | 16a | user 气泡文件 chips |
| Modify: `src/renderer/src/styles.css` | 16a/16b | chips/面板样式 |
| Create: `src/main/files/proposal.ts` | 16b | FileProposalParser 状态机 + ProposalResult |
| Create: `src/main/files/proposal.test.ts` | 16b | 状态机测试 |
| Create: `src/main/files/diff.ts` | 16b | 行级 LCS diff |
| Create: `src/main/files/diff.test.ts` | 16b | diff 测试 |
| Create: `src/main/files/apply.ts` | 16b | 提案权限校验、生命周期、.bak+原子写 |
| Create: `src/main/files/apply.test.ts` | 16b | 权限/写入测试 |
| Modify: `src/main/deepseek/client.ts` | 16b | FILE_CONTRACT、parser 接线、StreamEvent.proposal |
| Modify: `src/main/deepseek/client.test.ts` | 16b | 既有断言补 FILE_CONTRACT + 新用例 |
| Modify: `src/main/settings.ts` / `settings.test.ts` | 16b | file 设置字段 |
| Modify: `src/renderer/src/components/SettingsPage.tsx` | 16b | 文件区（工作目录+自动放行） |
| Create: `src/renderer/src/components/FileProposalPanel.tsx` | 16b | diff 确认面板 |
| Modify: `src/renderer/src/components/MessageArea.tsx` | 16b | 面板挂载 |

---

## Task 16a: 文件读取注入

**Files:**
- Create: `src/main/files/attach.ts`、`src/main/files/attach.test.ts`
- Modify: `src/shared/types.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/renderer/src/components/Composer.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/state/chatStore.ts`、`src/renderer/src/components/Message.tsx`、`src/renderer/src/styles.css`

**Interfaces:**
- Consumes: 既有 ChatMessage/StartReplyPayload/chatStore 结构；Composer onSend 两参调用点（App.tsx）
- Produces（16b 依赖）: `FileAttachment = { name: string; path: string }`；`isBinary(p): boolean`；`isAuthorized(p): boolean`；`readFileForContext(p): string`；`buildFileContext(files): string`

### Step 1: 扩展共享类型

- [ ] 修改 `src/shared/types.ts`，在文件末尾追加：

```ts
export interface FileAttachment { name: string; path: string }
```

并给 `ChatMessage` 增加 `files?: FileAttachment[]`，给 `StartReplyPayload` 增加 `files?: FileAttachment[]`（放在 `images?: string[]` 之后）。

- [ ] 验证：`npm run typecheck` 绿（无消费方，纯新增）。

### Step 2: attach.ts TDD（RED → GREEN）

- [ ] 写失败测试 `src/main/files/attach.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerFiles, buildFileContext, readFileForContext, isAuthorized, injectFilesIntoLastTurn } from './attach'

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
  it('注入格式：[文件: name] 包裹内容', () => {
    const p = write('a.txt', '文件内容')
    registerFiles([p])
    expect(buildFileContext([{ name: 'a.txt', path: p }])).toBe('[文件: a.txt]\n文件内容\n[/文件]')
  })

  it('多文件用空行分隔', () => {
    const p1 = write('a.txt', 'A'); const p2 = write('b.txt', 'B')
    registerFiles([p1, p2])
    expect(buildFileContext([{ name: 'a.txt', path: p1 }, { name: 'b.txt', path: p2 }]))
      .toBe('[文件: a.txt]\nA\n[/文件]\n\n[文件: b.txt]\nB\n[/文件]')
  })

  it('未授权读取：抛错', () => {
    const p = write('x.txt', 'secret')
    expect(() => readFileForContext(p)).toThrow('未授权')
  })

  it('读取失败（文件被删）：注入失败占位而非抛错', () => {
    const p = write('gone.txt', 'tmp')
    registerFiles([p])
    fs.rmSync(p)
    expect(buildFileContext([{ name: 'gone.txt', path: p }])).toBe('[文件: gone.txt]\n（读取失败，文件不存在或不可读）\n[/文件]')
  })

  it('读取超过 512KB：截断兜底', () => {
    const p = write('big.txt', 'b'.repeat(512 * 1024 + 100))
    registerFiles([p])
    expect(readFileForContext(p).length).toBe(512 * 1024)
  })
})

describe('injectFilesIntoLastTurn', () => {
  it('末轮为 user 且带文件：content 追加注入段', () => {
    const p = write('a.txt', '内容')
    registerFiles([p])
    const turns = [{ role: 'user', content: '帮我看看' }]
    injectFilesIntoLastTurn(turns, [{ name: 'a.txt', path: p }])
    expect(turns[0].content).toBe('帮我看看\n\n[文件: a.txt]\n内容\n[/文件]')
  })

  it('无文件或末轮非 user：不动', () => {
    const turns = [{ role: 'assistant', content: '好的' }]
    injectFilesIntoLastTurn(turns, [])
    expect(turns[0].content).toBe('好的')
  })
})
```

- [ ] 运行：`npx vitest run src/main/files/attach.test.ts`——预期 FAIL（模块不存在）。
- [ ] 实现 `src/main/files/attach.ts`：

```ts
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
```

- [ ] 运行：`npx vitest run src/main/files/attach.test.ts`——预期 15/15 PASS。
- [ ] 提交：

```bash
git add src/main/files/attach.ts src/main/files/attach.test.ts src/shared/types.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 文件附件注册/授权集/上下文注入（16a 存储层）"
```

### Step 3: api.ts + preload 通道

- [ ] 修改 `src/shared/api.ts`：import 增加 `FileAttachment`；Api 接口增加（放 `captureScreen` 之后）：

```ts
  pickFiles(): Promise<FileAttachment[]>
  registerFiles(paths: string[]): Promise<{ ok: boolean; files: FileAttachment[]; error?: string }>
```

- [ ] 修改 `src/preload/index.ts`，api 对象增加：

```ts
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  registerFiles: (paths) => ipcRenderer.invoke('file:register', { paths }),
```

- [ ] 验证：`npm run typecheck` 绿。

### Step 4: ipc.ts 通道 + startReply 注入

- [ ] 修改 `src/main/ipc.ts`：

1. import 增加：`import { registerFiles, pickFiles, injectFilesIntoLastTurn } from './files/attach'`
2. `chat:startReply` 开头校验改为：

```ts
    if (!p.content.trim() && !(p.images && p.images.length > 0) && !(p.files && p.files.length > 0)) return { ok: false, error: '消息内容不能为空' }
```

3. userMessage 构造增加 `files: p.files,`（放在 `images` 行之后）。
4. 在 `const history = ...map(toTurn)` 之后加一行：

```ts
    injectFilesIntoLastTurn(history, p.files ?? [])
```

5. 文件末尾（`pet:status` 之后）增加两个 handler：

```ts
  ipcMain.handle('file:pick', () => pickFiles())
  ipcMain.handle('file:register', (_e, p: { paths?: string[] }) => registerFiles(p.paths ?? []))
```

- [ ] 验证：`npm run typecheck` 绿；`npm test` 全量 124 + 15 = 139 绿。

### Step 5: Composer 按钮/拖拽/chips

- [ ] 修改 `src/renderer/src/components/Composer.tsx`（整文件替换，注意 import 类型）：

```tsx
import { useRef, useState } from 'react'
import type { FileAttachment } from '../../../shared/types'

export function Composer(props: {
  streaming: boolean
  onSend(content: string, images: string[], files: FileAttachment[]): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [shotMsg, setShotMsg] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if ((!t && images.length === 0 && files.length === 0) || props.streaming) return
    props.onSend(t, images, files)
    setText(''); setImages([]); setFiles([])
  }

  const capture = async (): Promise<void> => {
    setShotMsg('截屏中…')
    const r = await window.api.captureScreen()
    setShotMsg('')
    if (r.ok && r.dataUrl) setImages([...images, r.dataUrl])
    else setShotMsg(r.error ?? '截屏失败')
  }

  const pick = async (): Promise<void> => {
    const picked = await window.api.pickFiles()
    if (picked.length) {
      if (files.length + picked.length > 3) setShotMsg('最多附加 3 个文件')
      setFiles([...files, ...picked].slice(0, 3))
    }
  }

  const register = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const r = await window.api.registerFiles(paths)
    if (r.files.length) {
      if (files.length + r.files.length > 3) setShotMsg('最多附加 3 个文件')
      setFiles([...files, ...r.files].slice(0, 3))
    }
    if (!r.ok && r.error) setShotMsg(r.error)
  }

  const removeFile = (i: number): void => setFiles(files.filter((_, j) => j !== i))

  return (
    <div className="composer"
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        const paths = Array.from(e.dataTransfer.files)
          .map(f => (f as File & { path?: string }).path)
          .filter((p): p is string => !!p)
        void register(paths)
      }}>
      {(images.length > 0 || files.length > 0) && (
        <div className="shot-previews">
          {images.map((u, i) => (
            <div key={`img-${i}`} className="shot-preview">
              <img src={u} alt="待发送截图" />
              <button className="shot-remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {files.map((f, i) => (
            <div key={f.path} className="file-chip">
              <span title={f.path}>{f.name}</span>
              <button className="shot-remove" onClick={() => removeFile(i)}>×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行，可拖入文件）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
      />
      <div className="composer-actions">
        <span className="composer-hint">{shotMsg || 'Esc 收起窗口'}</span>
        <button className="shot-btn" onClick={() => void pick()} disabled={props.streaming}>选文件</button>
        <button className="shot-btn" onClick={() => void capture()} disabled={props.streaming}>截屏</button>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim() && images.length === 0 && files.length === 0} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
```

- [ ] 验证：`npm run typecheck` 绿（App.tsx 的 onSend 调用还未改——先改 Step 6 再跑）。

### Step 6: App/chatStore/Message 接线

- [ ] 修改 `src/renderer/src/state/chatStore.ts`：import 增加 `FileAttachment`；`RetryPayload` 增加 `files?: FileAttachment[]`（放 `images` 之后）。
- [ ] 修改 `src/renderer/src/App.tsx`：

1. import 增加 `import type { FileAttachment } from '../../shared/types'`
2. `send` 回调签名改 `(content: string, images: string[], files: FileAttachment[])`；`startReply` 载荷加 `files`；失败 error 事件 retry 载荷加 `files`：

```ts
  const send = useCallback(async (content: string, images: string[], files: FileAttachment[]) => {
    if (!state.activeId) return
    const r = await window.api.startReply({ conversationId: state.activeId, content, images, files })
    if (!r.ok) {
      dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error }, retry: { content, images, files, userVisible: false } })
      return
    }
    ...
```

3. `retry` 回调：空消息判定放宽（顺带修终审 M7：纯图/纯文件消息重试失效）与载荷透传：

```ts
  const retry = useCallback(() => {
    if (!state.activeId) return
    const last = [...state.messages].reverse().find(m => m.role === 'user')
    const p = state.errorRetry ?? (last ? { content: last.content, images: last.images?.map(i => i.dataUrl), files: last.files } : null)
    if (!p || (!p.content && !(p.images && p.images.length > 0) && !(p.files && p.files.length > 0))) return
    const userVisible = state.errorRetry ? state.errorRetry.userVisible === true : true
    void window.api.startReply({
      conversationId: state.activeId, content: p.content, images: p.images, files: p.files,
      skipUserAppend: userVisible
    }).then(r => {
      ...
```

4. Composer 调用点：`onSend={(content, images, files) => void send(content, images, files)}`。

- [ ] 修改 `src/renderer/src/components/Message.tsx`：`msg-bubble` 之前（`msg-images` 块之后）增加 user 消息文件 chips：

```tsx
      {msg.files && msg.files.length > 0 && (
        <div className="msg-files">
          {msg.files.map(f => <span key={f.path} className="file-chip" title={f.path}>{f.name}</span>)}
        </div>
      )}
```

- [ ] 修改 `src/renderer/src/styles.css`，追加：

```css
.msg-files { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; justify-content: flex-end; }
.file-chip { position: relative; display: inline-flex; align-items: center; gap: 6px; background: var(--accent-soft); color: #c4b5fd; border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; font-size: 12px; max-width: 220px; }
.file-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] 修改 `src/renderer/src/state/chatStore.test.ts`：新增一个 it 块验证 retry 载荷 files 透传（错误后 errorRetry 含 files）：

```ts
  it('error 事件的 retry 载荷透传 files 字段', () => {
    const s = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    const next = reducer(s, {
      type: 'streamEvent',
      e: { requestId: 'r1', type: 'error', error: '网络错误' },
      retry: { content: 'x', files: [{ name: 'a.txt', path: 'C:/a.txt' }], userVisible: false }
    })
    expect(next.errorRetry).toEqual({ content: 'x', files: [{ name: 'a.txt', path: 'C:/a.txt' }], userVisible: false })
  })
```

（放到既有 describe 块内、贴既有 error 测试之后。）

- [ ] 验证：`npm run typecheck` 绿；`npm test` 全量 140 绿。
- [ ] 提交：

```bash
git add src/shared/api.ts src/preload/index.ts src/main/ipc.ts src/renderer/src/components/Composer.tsx src/renderer/src/App.tsx src/renderer/src/state/chatStore.ts src/renderer/src/state/chatStore.test.ts src/renderer/src/components/Message.tsx src/renderer/src/styles.css
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 文件附件 UI/通道/注入接线（16a 完成）"
```

---

## Task 16b: 文件修改提案

**Files:**
- Create: `src/main/files/proposal.ts`+test、`src/main/files/diff.ts`+test、`src/main/files/apply.ts`+test、`src/renderer/src/components/FileProposalPanel.tsx`
- Modify: `src/shared/types.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/main/deepseek/client.ts`+test、`src/main/settings.ts`+test、`src/renderer/src/App.tsx`、`src/renderer/src/state/chatStore.ts`、`src/renderer/src/components/MessageArea.tsx`、`src/renderer/src/components/SettingsPage.tsx`、`src/renderer/src/styles.css`

**Interfaces:**
- Consumes（16a）: `FileAttachment`、`isBinary`、`isAuthorized`
- Produces: `FileProposalParser`、`ProposalResult`、`diffLines`、`createProposal/applyProposal/rejectProposal`、`FILE_CONTRACT`、IPC `file:proposal` 事件与 `file:apply/file:reject/file:pickDir` 通道

### Step 1: 类型 + settings.file 字段（TDD）

- [ ] 修改 `src/shared/types.ts` 追加：

```ts
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface FileProposalEvent {
  id: string
  path: string
  resolvedPath: string
  diff: DiffLine[]
  autoApplied: boolean
  error?: string
  /** 渲染层本地状态（主进程事件不携带） */
  status?: 'applied' | 'apply-failed' | 'rejected'
}
```

- [ ] 修改 `src/main/settings.ts`：

1. `AppSettings` 增加 `file: { workDir: string; autoApply: boolean }`。
2. `DEFAULT_SETTINGS` 增加 `file: { workDir: '', autoApply: false }`。
3. `loadSettings` 合并改为（file 子对象按 pet 同法）：

```ts
    return { ...DEFAULT_SETTINGS, ...raw, pet: { ...DEFAULT_SETTINGS.pet, ...(raw.pet ?? {}) }, emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(raw.emotionKeys ?? {}) }, file: { ...DEFAULT_SETTINGS.file, ...(raw.file ?? {}) } }
```

4. `toView` 增加 `file: { ...s.file },`（放 pet 行之后）。
5. `applyView` 返回值增加（运行时防御照 sanitize 纪律）：

```ts
    file: {
      workDir: typeof v.file?.workDir === 'string' ? v.file.workDir : cur.file.workDir,
      autoApply: typeof v.file?.autoApply === 'boolean' ? v.file.autoApply : cur.file.autoApply
    },
```

- [ ] 修改 `src/main/settings.test.ts`：

1. "旧版本缺少字段时按默认补齐" 用例加一行 `expect(s.file).toEqual(DEFAULT_SETTINGS.file)`。
2. 新增用例：

```ts
  it('file 子对象合并：旧存档缺 file 字段按默认，部分字段按默认补齐', () => {
    fs.writeFileSync(file, JSON.stringify({ file: { workDir: 'C:/work' } }))
    const s = loadSettings(file)
    expect(s.file.workDir).toBe('C:/work')
    expect(s.file.autoApply).toBe(false)
  })

  it('applyView file 字段白名单：非法类型回退现值', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS }
    const v: AppSettingsView = {
      ...toView(cur),
      file: { workDir: 'D:/proj', autoApply: true }
    }
    const next = applyView(cur, v)
    expect(next.file).toEqual({ workDir: 'D:/proj', autoApply: true })
    const bad = applyView(cur, { ...v, file: { workDir: 123 as unknown as string, autoApply: 'yes' as unknown as boolean } })
    expect(bad.file).toEqual(cur.file)
  })
```

- [ ] 运行：`npx vitest run src/main/settings.test.ts`——RED（字段缺失）→ 实现 → GREEN。

### Step 2: proposal.ts 流式状态机（TDD）

- [ ] 写失败测试 `src/main/files/proposal.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { FileProposalParser } from './proposal'

function run(chunks: string[]) {
  const p = new FileProposalParser()
  let display = ''
  const proposals: unknown[] = []
  for (const c of chunks) {
    const r = p.feed(c)
    display += r.display
    if (r.proposal) proposals.push(r.proposal)
  }
  const e = p.end()
  display += e.display
  if (e.proposal) proposals.push(e.proposal)
  return { display, proposals }
}

describe('FileProposalParser', () => {
  it('单块完整提案：fence 剥离、JSON 解析、正文保留', () => {
    const r = run(['我帮你改一下。\n```daniya-file\n{"path": "C:/a.txt", "content": "新内容"}\n```\n改好了。'])
    expect(r.display).toBe('我帮你改一下。\n\n改好了。')
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: '新内容' }])
  })

  it('提案跨块拆分（标记/JSON/闭合各切开）', () => {
    const r = run(['正文\n```dani', 'ya-file\n{"path": "C:/a.txt", "cont', 'ent": "新内容"}\n```\n后续'])
    expect(r.display).toBe('正文\n\n后续')
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: '新内容' }])
  })

  it('非法 JSON：invalid 且不落 display', () => {
    const r = run(['```daniya-file\n不是JSON\n```\n正文'])
    expect(r.proposals).toEqual([{ kind: 'invalid' }])
    expect(r.display).toBe('\n正文')
  })

  it('JSON 形状错（缺 content）：invalid', () => {
    const r = run(['```daniya-file\n{"path": "C:/a.txt"}\n```'])
    expect(r.proposals).toEqual([{ kind: 'invalid' }])
  })

  it('未闭合 fence（流中断）：丢弃，无提案无残留', () => {
    const r = run(['正文\n```daniya-file\n{"path": "C:/a.txt"'])
    expect(r.display).toBe('正文\n')
    expect(r.proposals).toEqual([])
  })

  it('正文普通 fence 不误伤：原样显示', () => {
    const r = run(['看这个：\n```js\nconst x = 1\n```\n结束'])
    expect(r.display).toBe('看这个：\n```js\nconst x = 1\n```\n结束')
    expect(r.proposals).toEqual([])
  })

  it('非行首 daniya-file 字样不触发（代码示例内）', () => {
    const r = run(['例： x ```daniya-file 不是行首\n正文'])
    expect(r.display).toBe('例： x ```daniya-file 不是行首\n正文')
    expect(r.proposals).toEqual([])
  })

  it('content 内含转义换行：JSON 解析后保留', () => {
    const r = run(['```daniya-file\n{"path": "C:/a.txt", "content": "a\\nb"}\n```'])
    expect(r.proposals).toEqual([{ kind: 'proposal', path: 'C:/a.txt', content: 'a\nb' }])
  })
})
```

- [ ] 运行：预期 FAIL（模块不存在）→ 实现 `src/main/files/proposal.ts`：

```ts
export type ProposalResult =
  | { kind: 'proposal'; path: string; content: string }
  | { kind: 'invalid' }

const OPEN = '```daniya-file'

export class FileProposalParser {
  private inFence = false
  private pending = ''
  private fenceLines: string[] = []

  feed(chunk: string): { display: string; proposal?: ProposalResult } {
    this.pending += chunk
    let display = ''
    for (;;) {
      if (!this.inFence) {
        const idx = this.findOpen()
        if (idx === null) {
          const keep = this.holdLen(OPEN)
          display += this.pending.slice(0, this.pending.length - keep)
          this.pending = this.pending.slice(this.pending.length - keep)
          return { display }
        }
        display += this.pending.slice(0, idx)
        this.pending = this.pending.slice(idx + OPEN.length)
        this.inFence = true
        this.fenceLines = []
      } else {
        const close = this.findClose()
        if (close === null) {
          const keep = this.holdLen('```')
          this.fenceLines.push(this.pending.slice(0, this.pending.length - keep))
          this.pending = this.pending.slice(this.pending.length - keep)
          return { display }
        }
        this.fenceLines.push(this.pending.slice(0, close.bodyEnd))
        this.pending = this.pending.slice(close.next)
        this.inFence = false
        const proposal = this.parseBody(this.fenceLines.join('\n'))
        this.fenceLines = []
        return { display, proposal }
      }
    }
  }

  end(): { display: string; proposal?: ProposalResult } {
    if (this.inFence) {
      this.inFence = false
      this.pending = ''
      this.fenceLines = []
      return { display: '' }
    }
    const display = this.pending
    this.pending = ''
    return { display }
  }

  /** 找行首 OPEN（流首或 \n 之后）；返回标记首字符位置或 null */
  private findOpen(): number | null {
    for (let i = 0; i <= this.pending.length - OPEN.length; i++) {
      if (this.pending.startsWith(OPEN, i) && (i === 0 || this.pending[i - 1] === '\n')) return i
    }
    return null
  }

  /** 找闭合行：行首 ``` 后跟 \n 或 EOF（前导 \n 可能已在上个 chunk 进 fenceLines）；bodyEnd 不含闭合行前导换行 */
  private findClose(): { bodyEnd: number; next: number } | null {
    const m = /(?:^|\n)```(?=\n|$)/.exec(this.pending)
    if (!m) return null
    const bodyEnd = m.index + (m[0].startsWith('\n') ? 1 : 0)
    return { bodyEnd, next: m.index + m[0].length }
  }

  /** 尾部保留：最后一个 \n 之后的部分若是 needle 的前缀，则连同其前内容整体保留（防标记跨 chunk 被切开） */
  private holdLen(needle: string): number {
    const nl = this.pending.lastIndexOf('\n')
    const tail = this.pending.slice(nl + 1)
    for (let k = Math.min(tail.length, needle.length - 1); k >= 1; k--) {
      if (needle.startsWith(tail.slice(tail.length - k))) return nl + 1 + (tail.length - k)
    }
    return 0
  }

  private parseBody(body: string): ProposalResult {
    try {
      const j = JSON.parse(body) as { path?: unknown; content?: unknown }
      if (typeof j.path === 'string' && j.path.length > 0 && typeof j.content === 'string') {
        return { kind: 'proposal', path: j.path, content: j.content }
      }
    } catch { /* 落 invalid */ }
    return { kind: 'invalid' }
  }
}
```

- [ ] 运行：`npx vitest run src/main/files/proposal.test.ts`——8/8 PASS。
- [ ] 提交：

```bash
git add src/main/files/proposal.ts src/main/files/proposal.test.ts src/main/settings.ts src/main/settings.test.ts src/shared/types.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 提案流式解析器 + 文件设置字段（16b 协议层）"
```

### Step 3: diff.ts 行级 LCS（TDD）

- [ ] 写失败测试 `src/main/files/diff.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { diffLines } from './diff'

describe('diffLines', () => {
  it('无变化：全 same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }
    ])
  })

  it('增加一行', () => {
    expect(diffLines('a', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'add', text: 'b' }
    ])
  })

  it('删除一行', () => {
    expect(diffLines('a\nb', 'b')).toEqual([
      { kind: 'del', text: 'a' }, { kind: 'same', text: 'b' }
    ])
  })

  it('改一行 = 删旧+增新', () => {
    expect(diffLines('旧行', '新行')).toEqual([
      { kind: 'del', text: '旧行' }, { kind: 'add', text: '新行' }
    ])
  })

  it('空 → 全文：全 add；全文 → 空：全 del', () => {
    expect(diffLines('', 'x\ny')).toEqual([{ kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }])
    expect(diffLines('x\ny', '')).toEqual([{ kind: 'del', text: 'x' }, { kind: 'del', text: 'y' }])
  })

  it('超限退化：大输入退化为整文件替换（全 del + 全 add）', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line${i}`).join('\n')
    const r = diffLines(big, big + '\nextra')
    expect(r.length).toBe(4001 + 4000)
    expect(r[0].kind).toBe('del')
    expect(r[4000].kind).toBe('add')
    expect(r[4000].text).toBe('extra')
  })
})
```

- [ ] 运行：预期 FAIL → 实现 `src/main/files/diff.ts`：

```ts
import type { DiffLine } from '../../shared/types'

/** 行级 LCS diff；a*b 超 900 万格时退化为整文件替换（内存保护） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length * b.length > 9_000_000) {
    return [
      ...a.map(text => ({ kind: 'del' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text }))
    ]
  }
  const m = a.length
  const n = b.length
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ kind: 'add', text: b[j] }); j++ }
    else { out.push({ kind: 'del', text: a[i] }); i++ }
  }
  return out
}
```

- [ ] 运行：6/6 PASS。
- [ ] 提交：

```bash
git add src/main/files/diff.ts src/main/files/diff.test.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 行级 LCS diff（16b）"
```

### Step 4: apply.ts 权限与写入（TDD）

- [ ] 写失败测试 `src/main/files/apply.test.ts`：

```ts
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
```

- [ ] 运行：预期 FAIL → 实现 `src/main/files/apply.ts`：

```ts
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
```

- [ ] 运行：10/10 PASS。
- [ ] 提交：

```bash
git add src/main/files/apply.ts src/main/files/apply.test.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 提案权限校验与 .bak 写入（16b 写入层）"
```

### Step 5: client.ts FILE_CONTRACT + parser 接线

- [ ] 修改 `src/main/deepseek/client.ts`：

1. import 增加：`import { FileProposalParser, type ProposalResult } from '../files/proposal'`
2. `EMOTION_CONTRACT` 之后新增常量：

```ts
export const FILE_CONTRACT = [
  '### 文件修改提案格式（严格遵守）',
  '需要修改文件时，不要描述修改，输出一个独立代码块，独占行：',
  '',
  '```daniya-file',
  '{"path": "<绝对路径>", "content": "<修改后的完整文件内容>"}',
  '```',
  '',
  '规则：',
  '1. 只能修改本轮对话中用户附带的文件，或用户设置的工作目录内的文件',
  '2. content 是修改后的完整文件内容',
  '3. path 必须是绝对路径',
  '4. 一次回复最多一个提案块',
  '5. 其他回复内容照常输出，讲解代码可以用普通 ``` 代码块'
].join('\n')
```

3. `StreamEvent` 增加：`| { type: 'proposal'; proposal: ProposalResult }`
4. system 消息拼接改为：

```ts
    { role: 'system', content: cfg.systemPrompt + '\n\n' + EMOTION_CONTRACT + '\n\n' + FILE_CONTRACT },
```

5. 流循环改为：

```ts
    const parser = new EmotionParser()
    const fileParser = new FileProposalParser()
    for await (const d of parseSSE(body)) {
      const { display, emotion } = parser.feed(d.delta)
      if (emotion) yield { type: 'emotion', emotion }
      if (display) {
        const r = fileParser.feed(display)
        if (r.display) yield { type: 'delta', delta: r.display }
        if (r.proposal) yield { type: 'proposal', proposal: r.proposal }
      }
      if (d.finishReason) break
    }
    const end = parser.end()
    const fEnd = fileParser.end()
    if (end.emotion) yield { type: 'emotion', emotion: end.emotion }
    if (end.display) {
      const r = fileParser.feed(end.display)
      if (r.display) yield { type: 'delta', delta: r.display }
      if (r.proposal) yield { type: 'proposal', proposal: r.proposal }
    }
    if (fEnd.display) yield { type: 'delta', delta: fEnd.display }
    yield { type: 'done', model }
```

- [ ] 修改 `src/main/deepseek/client.test.ts`：

1. import 增加 `FILE_CONTRACT`。
2. 既有断言更新（两处 system 内容相等断言）：`content: DEFAULT_PERSONA + '\n\n' + EMOTION_CONTRACT` → `content: DEFAULT_PERSONA + '\n\n' + EMOTION_CONTRACT + '\n\n' + FILE_CONTRACT`；`endsWith(EMOTION_CONTRACT)` → `endsWith(FILE_CONTRACT)`。
3. 新增用例（贴现有 describe 内）：

```ts
  it('提案 fence：从显示流剥离并产出 proposal 事件', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"{EMO:happy}好，我改一下。\\n```dani"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ya-file\\n{\\"path\\": \\"C:/a.txt\\", \\"content\\": \\"新内容\\"}\\n```\\n改好了"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: '改一下' }]))
    expect(out).toEqual([
      { type: 'emotion', emotion: 'happy' },
      { type: 'delta', delta: '好，我改一下。\n\n改好了' },
      { type: 'proposal', proposal: { kind: 'proposal', path: 'C:/a.txt', content: '新内容' } },
      { type: 'done', model: 'deepseek-chat' }
    ])
  })

  it('非法提案 JSON：产出 invalid 且不落 display', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"{EMO:happy}```daniya-file\\n坏掉的JSON\\n```\\n正文"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: 'hi' }]))
    expect(out).toEqual([
      { type: 'emotion', emotion: 'happy' },
      { type: 'delta', delta: '\n正文' },
      { type: 'proposal', proposal: { kind: 'invalid' } },
      { type: 'done', model: 'deepseek-chat' }
    ])
  })
```

注意：SSE 行内 JSON 的换行必须写成 `\\n`（JSON 字符串转义），`\"` 同理——上例已按此书写，逐字照抄。

- [ ] 运行：`npx vitest run src/main/deepseek/client.test.ts`——全绿（6 旧 + 2 新）。
- [ ] 提交：

```bash
git add src/main/deepseek/client.ts src/main/deepseek/client.test.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: FILE_CONTRACT 与提案流接线（16b 客户端）"
```

### Step 6: ipc.ts 提案协调器 + api/preload 通道

- [ ] 修改 `src/main/ipc.ts`：

1. electron import 增加 `dialog`：`import { ipcMain, BrowserWindow, shell, dialog, type IpcMainInvokeEvent } from 'electron'`
2. import 增加：`import { createProposal, applyProposal, rejectProposal } from './files/apply'`；types import 增加 `FileProposalEvent`。
3. `chat:startReply` 内、`send` 定义之后增加：

```ts
    const sendFile = (f: FileProposalEvent): void => { if (!e.sender.isDestroyed()) e.sender.send('file:proposal', f) }
```

4. 流循环 `for await` 内、`else if (ev.type === 'done')` 之前插入分支：

```ts
          else if (ev.type === 'proposal') {
            if (ev.proposal.kind === 'invalid') {
              sendFile({ id: '', path: '', resolvedPath: '', diff: [], autoApplied: false, error: '达妮娅的修改提案格式无效，已忽略（可让她重试）' })
            } else {
              const r = createProposal(ev.proposal.path, ev.proposal.content, settings.file)
              if (!r.ok) {
                sendFile({ id: '', path: ev.proposal.path, resolvedPath: '', diff: [], autoApplied: false, error: r.error })
              } else {
                sendFile(r.event)
                if (r.event.autoApplied) {
                  const applied = applyProposal(r.event.id)
                  if (!applied.ok) sendFile({ ...r.event, error: '自动应用失败：' + (applied.error ?? '未知错误') })
                }
              }
            }
          }
```

5. 文件末尾新增 handler：

```ts
  ipcMain.handle('file:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0]
  })
  ipcMain.handle('file:apply', (_e, p: { id: string }) => applyProposal(p.id))
  ipcMain.handle('file:reject', (_e, p: { id: string }) => { rejectProposal(p.id) })
```

- [ ] 修改 `src/shared/api.ts` import 增加 `FileProposalEvent`；Api 接口增加：

```ts
  pickWorkDir(): Promise<string>
  applyProposal(id: string): Promise<{ ok: boolean; error?: string }>
  rejectProposal(id: string): Promise<void>
  onFileProposal(cb: (e: FileProposalEvent) => void): () => void
```

- [ ] 修改 `src/preload/index.ts`，import 增加 `FileProposalEvent` 类型，api 增加：

```ts
  pickWorkDir: () => ipcRenderer.invoke('file:pickDir'),
  applyProposal: (id) => ipcRenderer.invoke('file:apply', { id }),
  rejectProposal: (id) => ipcRenderer.invoke('file:reject', { id }),
  onFileProposal: (cb) => {
    const h = (_e: unknown, data: FileProposalEvent): void => cb(data)
    ipcRenderer.on('file:proposal', h)
    return () => ipcRenderer.removeListener('file:proposal', h)
  },
```

- [ ] 验证：`npm run typecheck` 绿；`npm test` 全量绿。

### Step 7: 渲染层提案面板

- [ ] 新建 `src/renderer/src/components/FileProposalPanel.tsx`：

```tsx
import type { FileProposalEvent } from '../../../shared/types'

export function FileProposalPanel(props: {
  ev: FileProposalEvent
  onApply: (id: string) => void
  onReject: (id: string) => void
}): React.JSX.Element {
  const { ev } = props
  if (ev.error) return <div className="proposal-panel"><span className="proposal-note">{ev.error}</span></div>
  if (ev.status === 'applied') return <div className="proposal-panel"><span className="proposal-note">已应用修改：{ev.path}</span></div>
  if (ev.status === 'apply-failed') return <div className="proposal-panel"><span className="proposal-note">应用失败，文件未改动：{ev.path}</span></div>
  if (ev.status === 'rejected') return <div className="proposal-panel"><span className="proposal-note">已拒绝修改：{ev.path}</span></div>
  if (ev.autoApplied) return <div className="proposal-panel"><span className="proposal-note">已自动应用修改：{ev.path}</span></div>
  return (
    <div className="proposal-panel">
      <div className="proposal-head">
        <span>达妮娅提议修改 {ev.path}</span>
        <span className="proposal-note">确认后原文件备份为 .bak</span>
      </div>
      <div className="proposal-diff">
        {ev.diff.map((l, i) => (
          <div key={i} className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}>
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}{l.text}
          </div>
        ))}
      </div>
      <div className="proposal-actions">
        <button className="apply" onClick={() => props.onApply(ev.id)}>应用修改</button>
        <button onClick={() => props.onReject(ev.id)}>拒绝</button>
      </div>
    </div>
  )
}
```

- [ ] 修改 `src/renderer/src/state/chatStore.ts`：import 增加 `FileProposalEvent`；`State` 增加 `proposal: FileProposalEvent | null`；`initialState` 增加 `proposal: null`；`Action` 增加 `| { type: 'fileProposal'; e: FileProposalEvent }`；reducer 增加：

```ts
    case 'fileProposal':
      return { ...state, proposal: a.e }
```

并在 `select`/`newConversation`/`remove`/`startStream` 返回对象中加 `proposal: null`；`streamEvent` 的 error 分支返回对象中加 `proposal: null`（done 分支**不加**，提案面板要等用户操作）。

- [ ] 修改 `src/renderer/src/components/MessageArea.tsx`：

1. import 增加：`import type { FileProposalEvent } from '../../../shared/types'` 与 `import { FileProposalPanel } from './FileProposalPanel'`
2. props 增加 `proposal: FileProposalEvent | null`、`onApplyProposal: (id: string) => void`、`onRejectProposal: (id: string) => void`
3. error banner 之后渲染：

```tsx
      {props.proposal && (
        <FileProposalPanel ev={props.proposal} onApply={props.onApplyProposal} onReject={props.onRejectProposal} />
      )}
```

- [ ] 修改 `src/renderer/src/App.tsx`：

1. import 增加 `FileProposalEvent` 类型。
2. useEffect 中、offPetError 之后增加订阅：

```ts
    const offFileProposal = window.api.onFileProposal(e => dispatch({ type: 'fileProposal', e }))
```

返回清理处增加 `offFileProposal()`。
3. 新增两个回调（retry 之后）：

```ts
  const applyProposal = useCallback(async (id: string) => {
    if (!state.proposal) return
    const r = await window.api.applyProposal(id)
    dispatch({ type: 'fileProposal', e: { ...state.proposal, status: r.ok ? 'applied' : 'apply-failed' } })
  }, [state.proposal])

  const rejectProposal = useCallback(() => {
    if (!state.proposal) return
    void window.api.rejectProposal(state.proposal.id)
    dispatch({ type: 'fileProposal', e: { ...state.proposal, status: 'rejected' } })
  }, [state.proposal])
```

4. MessageArea 调用点增加三个 prop：

```tsx
            <MessageArea messages={state.messages} streaming={state.streaming} error={state.error}
              proposal={state.proposal} onApplyProposal={id => void applyProposal(id)} onRejectProposal={() => rejectProposal()}
              onRetry={retry} onDismissError={() => dispatch({ type: 'clearError' })} />
```

- [ ] 修改 `src/renderer/src/components/SettingsPage.tsx`：在"桌宠联动" section 之后新增：

```tsx
        <section>
          <h2>文件</h2>
          <label>工作目录（达妮娅可直接修改的目录；留空 = 只能修改本轮附带的文件）
            <input value={form.file.workDir} placeholder="例如 C:\Users\lenovo\projects\xxx"
              onChange={e => set({ file: { ...form.file, workDir: e.target.value } })} />
          </label>
          <div className="settings-actions">
            <button onClick={() => {
              void window.api.pickWorkDir().then(d => { if (d) set({ file: { ...form.file, workDir: d } }) })
            }}>浏览…</button>
          </div>
          <label className="checkbox"><input type="checkbox" checked={form.file.autoApply}
            onChange={e => set({ file: { ...form.file, autoApply: e.target.checked } })} /> 工作目录内的修改自动放行（跳过确认）</label>
          <p className="field-hint">修改前原文件会备份为同名 .bak；只能修改文本文件（≤64KB）。</p>
        </section>
```

- [ ] 修改 `src/renderer/src/styles.css` 追加：

```css
.proposal-panel { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
.proposal-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; color: var(--text); margin-bottom: 8px; }
.proposal-note { color: var(--text-dim); font-size: 12px; }
.proposal-diff { max-height: 240px; overflow-y: auto; background: #0f0e14; border-radius: 8px; padding: 8px 10px; font-family: Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; }
.diff-add { background: #1e3524; color: #8be3a4; }
.diff-del { background: #3a1f28; color: #ffb3c0; }
.proposal-actions { display: flex; gap: 8px; margin-top: 8px; }
.proposal-actions button { background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 14px; font-size: 12px; }
.proposal-actions button.apply { background: var(--accent); border: 0; color: #fff; }
.proposal-actions button:hover { border-color: var(--accent); }
```

- [ ] 修改 `src/renderer/src/state/chatStore.test.ts`：新增用例（贴既有 describe 内）：

```ts
  it('fileProposal 事件：进入 proposal 状态，startStream 时清空', () => {
    const ev = { id: 'p1', path: 'C:/a.txt', resolvedPath: 'C:/a.txt', diff: [], autoApplied: false }
    const s1 = reducer(initialState, { type: 'fileProposal', e: ev })
    expect(s1.proposal).toEqual(ev)
    const s2 = reducer(s1, { type: 'startStream', requestId: 'r1' })
    expect(s2.proposal).toBeNull()
  })
```

- [ ] 验证：`npm run typecheck` 绿；`npm test` 全量绿（预期 124 + 15 + 4 + 6 + 10 + 2 + 1 = 162）。
- [ ] 提交：

```bash
git add src/main/ipc.ts src/shared/api.ts src/preload/index.ts src/renderer/src/components/FileProposalPanel.tsx src/renderer/src/components/MessageArea.tsx src/renderer/src/components/SettingsPage.tsx src/renderer/src/App.tsx src/renderer/src/state/chatStore.ts src/renderer/src/state/chatStore.test.ts src/renderer/src/styles.css
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 提案协调器与 diff 确认面板（16b 完成）"
```

---

## 验收（两任务完成后，控制器执行）

1. `npm run typecheck` + `npm test` 全量绿（162 个）。
2. 审查：16a/16b 各自 review-package + 审查者 + 修复轮（照 SDD 流程）。
3. 冒烟（控制器，CDP 9222）：
   - 拖入/选择 3 个文本文件 → chips 显示 → 发送 → user 气泡带文件 chips → 真实回复（真 Key）确认达妮娅读到了内容（让它复述文件要点）。
   - 让达妮娅改一个附件文件 → diff 面板出现 → 点应用 → 文件变新内容、.bak 存在；拒绝路径不写。
   - 设置工作目录 + 开自动放行 → 工作目录内文件提案 → 直接写入 + "已自动应用"提示。
   - 越权提案（模型报非附件路径）→ "拒绝：只能修改…"提示。
4. 用户手动验证安装包（桌面）与桌宠表情肉眼确认仍挂账。
