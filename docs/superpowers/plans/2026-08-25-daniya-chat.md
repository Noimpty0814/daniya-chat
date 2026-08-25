# 达妮娅聊天（Daniya Chat）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Electron 桌面聊天应用，接入 DeepSeek API（流式对话、截屏视觉、历史保存），并与桌宠"达妮娅"联动（点击桌宠弹出聊天框、AI 情绪驱动桌宠表情）。

**Architecture:** Electron 主进程负责 API 调用（OpenAI 兼容 SSE 流式，fetch 实现）、JSON 本地存储、截屏、safeStorage 密钥加密；React 渲染进程负责聊天 UI；桌宠联动由一个隐藏的 PowerShell 助手进程承担（全局鼠标钩子 + 向桌宠窗口发送 Alt+组合键），与主进程通过临时目录下的 JSON 文件通信（命令文件 + 事件文件），避免原生 Node 模块与管道线程问题。

**Tech Stack:** Electron + electron-vite + React + TypeScript、vitest（自动化测试）、react-markdown + remark-gfm + rehype-highlight（Markdown/代码高亮）、PowerShell 5.1（联动助手，Windows 自带）、electron-builder（打包）。**无原生 Node 模块。**

**Spec:** `docs/superpowers/specs/2026-08-25-daniya-chat-design.md`（计划从 spec 论证，执行者两份都要读）

## Global Constraints

- **绝不修改桌宠目录（`E:\迅雷下载\达妮娅-带表情版\`）内任何文件**；联动只通过"向桌宠窗口发送按键"实现，与桌宠自带 `SetWindowPosition.ps1` 同款做法。
- API 调用全部在主进程；渲染进程永远接触不到明文 API Key（safeStorage 加密保存）。
- DeepSeek base URL 默认 `https://api.deepseek.com`；文本模型默认 `deepseek-chat`；视觉模型默认 `deepseek-v4-flash-vision-exp`；模型名可在设置页改。
- 历史存储于 `%APPDATA%/daniya-chat/`（Electron userData），JSON 纯文本。
- 情绪标记 `{EMO:<emotion>}` 必须是回复第一个字符；渲染与落盘内容中剔除该标记；emotion 取值：`happy|sad|sleepy|dismissive|shy|blush|angry|dark`。
- 模型路由：对话历史中任一消息含图片 → 视觉模型，否则 → 文本模型。
- 聊天主功能与桌宠联动完全解耦：助手未运行/桌宠未启动/联动关闭时，聊天、历史、截屏全部正常，只是跳过表情联动。
- Node ≥ 20（本机已装 v24.18.1）；全部依赖用 `npm install <pkg>@latest` 安装（不锁版本，由 npm 解析当前最新）。
- 每个任务以 vitest 测试先行（TDD），`npm test` 全绿后才提交；提交信息格式 `feat:` / `test:` 中文描述。
- 国内网络：若 `npm install electron` 下载失败，设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重试；electron-builder 二进制下载失败时设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

---

### Task 1: 项目脚手架（electron-vite + React + TS，空窗口可运行）

**Files:**
- Create: `package.json`、`electron.vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`.gitignore`
- Create: `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html`、`src/renderer/src/main.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`

**Interfaces:**
- Produces: 可运行的 dev 环境（`npm run dev` 打开窗口）、`npm test` 可跑（暂无测试）。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "daniya-chat",
  "version": "0.1.0",
  "private": true,
  "description": "达妮娅聊天 - 接入 DeepSeek 的桌宠聊天软件",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  }
}
```

- [ ] **Step 2: 写构建/TS 配置**

`electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react()] }
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
```

`tsconfig.json`:
```json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true, "module": "ESNext", "moduleResolution": "bundler",
    "target": "ES2022", "strict": true, "types": ["node"], "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["electron.vite.config.ts", "vitest.config.ts", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"]
}
```

`tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "composite": true, "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "target": "ES2022", "strict": true, "moduleResolution": "bundler", "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/renderer/**/*", "src/shared/**/*", "src/preload/index.d.ts"]
}
```

`.gitignore`:
```
node_modules/
out/
dist/
*.log
```

- [ ] **Step 3: 写主进程/预加载/渲染最小骨架**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960, height: 640, minWidth: 860, minHeight: 600,
    autoHideMenuBar: true, title: '达妮娅聊天', show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`src/preload/index.ts`:
```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {})
```

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>达妮娅聊天</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
```

`src/renderer/src/App.tsx`:
```tsx
export default function App(): React.JSX.Element {
  return <div className="app"><h1>达妮娅聊天</h1></div>
}
```

`src/renderer/src/styles.css`:
```css
:root { color-scheme: dark; }
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; background: #17151f; color: #e7e5f0; }
.app { height: 100vh; display: flex; align-items: center; justify-content: center; }
```

- [ ] **Step 4: 安装依赖**

Run: `npm install react react-dom react-markdown remark-gfm rehype-highlight highlight.js`
Run: `npm install -D electron electron-vite vite @vitejs/plugin-react typescript vitest @types/react @types/react-dom @types/node`
（若 electron 二进制下载失败：先 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再重装）

- [ ] **Step 5: 验证 dev 可运行**

Run: `npm run dev`
Expected: Electron 窗口打开，显示深色背景与"达妮娅聊天"文字；控制台无报错。关闭窗口后进程退出。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: electron-vite + React 项目脚手架，空窗口可运行"
```

---

### Task 2: 存储层 Store（会话/消息 JSON 文件 + 搜索 + 自动标题）

**Files:**
- Create: `src/main/storage/store.ts`
- Test: `src/main/storage/store.test.ts`

**Interfaces:**
- Produces: `class Store`（构造参数 `dir: string`，纯 Node 实现、不依赖 electron，可注入临时目录测试）：
  - `listConversations(): ConversationMeta[]`（按 updatedAt 降序）
  - `createConversation(): ConversationMeta`
  - `renameConversation(id: string, title: string): void`（不存在则抛错）
  - `deleteConversation(id: string): void`
  - `getMessages(id: string): ChatMessage[]`
  - `appendMessage(id: string, msg: ChatMessage): void`
  - `autoTitle(id: string): void`（标题为"新对话"时取第一条用户消息前 20 字）
  - `search(query: string): SearchHit[]`（大小写不敏感子串匹配，返回前后文片段）
  - 类型 `ConversationMeta` / `ChatMessage` / `ImagePart` / `SearchHit` 定义于 `src/shared/types.ts`（本任务创建，后续任务共用）

- [ ] **Step 1: 创建共享类型并写失败测试**

`src/shared/types.ts`:
```ts
export interface ConversationMeta { id: string; title: string; createdAt: number; updatedAt: number }
export interface ImagePart { id: string; dataUrl: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImagePart[]
  model?: string
  createdAt: number
}
export interface SearchHit { conversationId: string; messageId: string; role: 'user' | 'assistant'; snippet: string }
```

`src/main/storage/store.test.ts`:
```ts
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
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/storage/store.test.ts`
Expected: FAIL — `Cannot find module './store'`。

- [ ] **Step 3: 实现 Store**

`src/main/storage/store.ts`:
```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/storage/store.test.ts`
Expected: 8 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/main/storage/ && git commit -m "feat: 存储层 Store（会话/消息 JSON 文件、搜索、自动标题）"
```

---

### Task 3: SSE 流解析 parseSSE

**Files:**
- Create: `src/main/deepseek/stream.ts`
- Test: `src/main/deepseek/stream.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ delta: string; finishReason: string | null }>` —— 解析 OpenAI 兼容 SSE；忽略非 `data:` 行与解析失败的行（keepalive），`data: [DONE]` 结束。

- [ ] **Step 1: 写失败测试**

`src/main/deepseek/stream.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseSSE } from './stream'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    }
  })
}

async function collect(chunks: string[]) {
  const out: { delta: string; finishReason: string | null }[] = []
  for await (const d of parseSSE(streamOf(chunks))) out.push(d)
  return out
}

describe('parseSSE', () => {
  it('解析多个 data 行并累积 delta', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['你', '好'])
  })

  it('单个 chunk 含多行时逐行产出', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['a', 'b'])
  })

  it('[DONE] 后结束，不产出额外事件', async () => {
    const out = await collect([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"y"}}]}\n\n'
    ])
    expect(out.map(x => x.delta)).toEqual(['x'])
  })

  it('忽略注释行与空 delta，透传 finish_reason', async () => {
    const out = await collect([
      ': keepalive\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    ])
    expect(out).toEqual([{ delta: '', finishReason: 'stop' }])
  })

  it('忽略解析失败的 data 行', async () => {
    const out = await collect(['data: 不是JSON\n\n', 'data: {"choices":[{"delta":{"content":"z"}}]}\n\n'])
    expect(out.map(x => x.delta)).toEqual(['z'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/deepseek/stream.test.ts`
Expected: FAIL — `Cannot find module './stream'`。

- [ ] **Step 3: 实现 parseSSE**

`src/main/deepseek/stream.ts`:
```ts
export interface StreamDelta { delta: string; finishReason: string | null }

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const j = JSON.parse(data)
        const choice = j.choices?.[0]
        yield { delta: choice?.delta?.content ?? '', finishReason: choice?.finish_reason ?? null }
      } catch { /* keepalive 或非 JSON 行，忽略 */ }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/deepseek/stream.test.ts`
Expected: 5 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/deepseek/ && git commit -m "feat: OpenAI 兼容 SSE 流解析 parseSSE"
```

---

### Task 4: 情绪标记解析 EmotionParser

**Files:**
- Create: `src/main/deepseek/emotion.ts`
- Test: `src/main/deepseek/emotion.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Emotion = 'happy' | 'sad' | 'sleepy' | 'dismissive' | 'shy' | 'blush' | 'angry' | 'dark'`
  - `class EmotionParser`：`feed(chunk: string): { display: string; emotion?: Emotion }`（流式增量喂入；标记在流首时暂缓 display，解析成功后标记剔除、后续直通）、`end(): { display: string; emotion?: Emotion }`（流结束时冲刷未决缓冲）。

- [ ] **Step 1: 写失败测试**

`src/main/deepseek/emotion.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { EmotionParser } from './emotion'

function run(chunks: string[]): { displays: string[]; emotion: string | undefined; final: string } {
  const p = new EmotionParser()
  const displays: string[] = []
  let emotion: string | undefined
  for (const c of chunks) {
    const r = p.feed(c)
    if (r.display) displays.push(r.display)
    if (r.emotion) emotion = r.emotion
  }
  const e = p.end()
  if (e.display) displays.push(e.display)
  if (e.emotion) emotion = e.emotion
  return { displays, emotion, final: displays.join('') }
}

describe('EmotionParser', () => {
  it('完整标记单块到达：剔除标记，正文直通', () => {
    const r = run(['{EMO:happy}你好呀！'])
    expect(r.emotion).toBe('happy')
    expect(r.final).toBe('你好呀！')
  })

  it('标记跨块拆分：拆到每个字符', () => {
    const r = run(['{', 'EM', 'O:sad', '}', '难过'])
    expect(r.emotion).toBe('sad')
    expect(r.final).toBe('难过')
  })

  it('无标记：全部按原样显示', () => {
    const r = run(['直接说话'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('直接说话')
  })

  it('标记前有空白也可识别', () => {
    const r = run(['\n {EMO:blush}嘿嘿'])
    expect(r.emotion).toBe('blush')
    expect(r.final).toBe('嘿嘿')
  })

  it('非法 emotion 值：标记剔除但无情绪，正文正常', () => {
    const r = run(['{EMO:banana}哈喽'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('哈喽')
  })

  it('形似标记但不是标记的文本：原样显示', () => {
    const r = run(['{EMO 不是标记}正文'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('{EMO 不是标记}正文')
  })

  it('流结束仍有未决缓冲：end() 冲刷', () => {
    const r = run(['{EMO:sleep'])
    expect(r.emotion).toBeUndefined()
    expect(r.final).toBe('{EMO:sleep')
  })

  it('标记后再出现标记形状文本不再解析（直通）', () => {
    const r = run(['{EMO:happy}提到 {EMO:sad} 字面量'])
    expect(r.emotion).toBe('happy')
    expect(r.final).toBe('提到 {EMO:sad} 字面量')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/deepseek/emotion.test.ts`
Expected: FAIL — `Cannot find module './emotion'`。

- [ ] **Step 3: 实现 EmotionParser**

`src/main/deepseek/emotion.ts`:
```ts
export type Emotion = 'happy' | 'sad' | 'sleepy' | 'dismissive' | 'shy' | 'blush' | 'angry' | 'dark'
const EMOTIONS: readonly Emotion[] = ['happy', 'sad', 'sleepy', 'dismissive', 'shy', 'blush', 'angry', 'dark']
const PREFIX = '{EMO:'

function isEmotion(s: string): s is Emotion { return (EMOTIONS as readonly string[]).includes(s) }

export class EmotionParser {
  private buf = ''
  private state: 'matching' | 'done' = 'matching'

  feed(chunk: string): { display: string; emotion?: Emotion } {
    if (this.state === 'done') return { display: chunk }
    this.buf += chunk
    const ws = this.buf.match(/^\s*/)?.[0].length ?? 0
    const body = this.buf.slice(ws)
    if (body.startsWith(PREFIX)) {
      const close = body.indexOf('}')
      if (close >= 0) {
        const token = body.slice(0, close + 1)
        const m = token.match(/^\{EMO:([a-z]+)\}$/)
        const emotion = m && isEmotion(m[1]) ? m[1] : undefined
        const display = this.buf.slice(ws + close + 1)
        this.buf = ''
        this.state = 'done'
        return { display, emotion }
      }
      return { display: '' }
    }
    if (body.length < PREFIX.length && PREFIX.startsWith(body)) return { display: '' }
    this.state = 'done'
    const out = this.buf
    this.buf = ''
    return { display: out }
  }

  end(): { display: string; emotion?: Emotion } {
    const out = this.buf
    this.buf = ''
    this.state = 'done'
    return { display: out }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/deepseek/emotion.test.ts`
Expected: 8 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/deepseek/emotion.ts src/main/deepseek/emotion.test.ts && git commit -m "feat: 情绪标记流式解析 EmotionParser（{EMO:x} 前缀剥离）"
```

---

### Task 5: 模型路由 pickModel

**Files:**
- Create: `src/main/deepseek/router.ts`
- Test: `src/main/deepseek/router.test.ts`

**Interfaces:**
- Consumes: `ChatTurn` 类型（Task 6 定义于 `client.ts`；本任务先用本地结构类型 `{ images?: string[] }` 表达，Task 6 建立正式类型后本文件改为导入 —— 见 Step 3 注释）
- Produces: `pickModel(textModel: string, visionModel: string, turns: Array<{ images?: string[] }>): string`

- [ ] **Step 1: 写失败测试**

`src/main/deepseek/router.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pickModel } from './router'

const T = 'deepseek-chat'
const V = 'deepseek-v4-flash-vision-exp'

describe('pickModel', () => {
  it('无图片 → 文本模型', () => {
    expect(pickModel(T, V, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }])).toBe(T)
  })

  it('任一消息含图片 → 视觉模型', () => {
    expect(pickModel(T, V, [{ role: 'user', content: '看', images: ['data:image/png;base64,xx'] }])).toBe(V)
  })

  it('空 images 数组不算含图', () => {
    expect(pickModel(T, V, [{ role: 'user', content: 'hi', images: [] }])).toBe(T)
  })

  it('历史中的图片也触发视觉模型', () => {
    expect(pickModel(T, V, [
      { role: 'user', content: '旧图', images: ['data:image/png;base64,old'] },
      { role: 'assistant', content: '看到了' },
      { role: 'user', content: '再聊聊' }
    ])).toBe(V)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/deepseek/router.test.ts`
Expected: FAIL — `Cannot find module './router'`。

- [ ] **Step 3: 实现 pickModel**

`src/main/deepseek/router.ts`:
```ts
// ChatTurn 正式类型由 Task 6 在 client.ts 定义；此处用最小结构，任务 6 后改为
// import type { ChatTurn } from './client' 并使用 ChatTurn[]（签名不变，测试不受影响）
export interface TurnLike { images?: string[] }

export function pickModel(textModel: string, visionModel: string, turns: TurnLike[]): string {
  return turns.some(t => t.images && t.images.length > 0) ? visionModel : textModel
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/deepseek/router.test.ts`
Expected: 4 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/deepseek/router.ts src/main/deepseek/router.test.ts && git commit -m "feat: 模型路由 pickModel（含图→视觉模型）"
```

---

### Task 6: DeepSeek 客户端 streamChat（mock fetch 测试）

**Files:**
- Create: `src/main/deepseek/client.ts`
- Test: `src/main/deepseek/client.test.ts`

**Interfaces:**
- Consumes: `parseSSE`（Task 3）、`EmotionParser`（Task 4）、`pickModel`（Task 5）
- Produces:
  - `interface ChatTurn { role: 'user' | 'assistant'; content: string; images?: string[] }`
  - `interface DeepSeekConfig { apiKey: string; baseUrl: string; textModel: string; visionModel: string; systemPrompt: string }`
  - `type StreamEvent = { type: 'delta'; delta: string } | { type: 'emotion'; emotion: Emotion } | { type: 'done'; model: string }`
  - `class ApiError extends Error { status: number }`
  - `SYSTEM_PROMPT: string`（达妮娅人设 + 情绪标记指令，标记必须为回复第一个字符）
  - `streamChat(cfg: DeepSeekConfig, turns: ChatTurn[], signal?: AbortSignal): Promise<AsyncGenerator<StreamEvent>>` —— 请求体按 OpenAI 格式（含图消息用 `content` 数组 + `image_url` 块）；非 2xx 抛出 ApiError（错误信息取响应体 `error.message`）

- [ ] **Step 1: 写失败测试**

`src/main/deepseek/client.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamChat, ApiError, SYSTEM_PROMPT, type DeepSeekConfig } from './client'

const cfg: DeepSeekConfig = {
  apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
  textModel: 'deepseek-chat', visionModel: 'deepseek-v4-flash-vision-exp',
  systemPrompt: SYSTEM_PROMPT
}

function sseResponse(lines: string[], status = 200): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() }
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

async function collect(gen: AsyncGenerator<{ type: string; delta?: string; emotion?: string; model?: string }>) {
  const out: { type: string; delta?: string; emotion?: string; model?: string }[] = []
  for await (const e of gen) out.push(e)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('纯文本：POST 正确地址与头，请求体含 system 与消息，事件序列 delta→emotion→done', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('deepseek-chat')
      expect(body.stream).toBe(true)
      expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
      expect(body.messages[1]).toEqual({ role: 'user', content: '你好' })
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"{EMO:"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"happy}今天"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"开心"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: '你好' }]))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(out).toEqual([
      { type: 'emotion', emotion: 'happy' },
      { type: 'delta', delta: '今天' },
      { type: 'delta', delta: '开心' },
      { type: 'done', model: 'deepseek-chat' }
    ])
  })

  it('含图消息：路由到视觉模型，content 为数组含 image_url 块', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('deepseek-v4-flash-vision-exp')
      expect(body.messages[1].content).toEqual([
        { type: 'text', text: '看看屏幕' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
      ])
      return sseResponse(['data: {"choices":[{"delta":{"content":"看到啦"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'])
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(await streamChat(cfg, [{ role: 'user', content: '看看屏幕', images: ['data:image/png;base64,abc'] }]))
    expect(out.map(e => e.type)).toEqual(['delta', 'done'])
  })

  it('HTTP 401：抛出 ApiError 且信息来自响应体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401 }
    )))
    await expect(streamChat(cfg, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 401, message: 'Authentication Fails' })
  })

  it('HTTP 400：同样转为 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'This model does not support image' } }), { status: 400 })))
    const err = await streamChat(cfg, [{ role: 'user', content: 'hi', images: ['data:image/png;base64,x'] }]).then(
      () => null, (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/deepseek/client.test.ts`
Expected: FAIL — `Cannot find module './client'`。

- [ ] **Step 3: 实现 client.ts**

`src/main/deepseek/client.ts`:
```ts
import { parseSSE } from './stream'
import { EmotionParser, type Emotion } from './emotion'
import { pickModel } from './router'

export interface ChatTurn { role: 'user' | 'assistant'; content: string; images?: string[] }
export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
}
export type StreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'emotion'; emotion: Emotion }
  | { type: 'done'; model: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
}

export const SYSTEM_PROMPT = [
  '你是达妮娅（Daniya），一个可爱的桌面桌宠 AI 助手，性格活泼温柔，偶尔调皮。',
  '回答使用中文（用户用其他语言时跟随用户语言），简洁自然，像朋友聊天。',
  '每次回复的正文必须以一个情绪标记开头，且标记必须是回复的第一个字符（标记前不要有任何空格或换行）：{EMO:emotion}',
  'emotion 取值：happy（开心）、sad（难过）、sleepy（困倦）、dismissive（不屑）、shy（害羞）、blush（脸红）、angry（生气）、dark（黑化）。',
  '没有明显情绪时可以不写标记。标记后直接接正文，不要空格不要换行。'
].join('\n')

export async function streamChat(cfg: DeepSeekConfig, turns: ChatTurn[], signal?: AbortSignal): Promise<AsyncGenerator<StreamEvent>> {
  const model = pickModel(cfg.textModel, cfg.visionModel, turns)
  const messages = [
    { role: 'system', content: cfg.systemPrompt },
    ...turns.map(t => t.images && t.images.length > 0
      ? { role: t.role, content: [{ type: 'text', text: t.content }, ...t.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] }
      : { role: t.role, content: t.content })
  ]
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 })
  })
  if (!res.ok || !res.body) {
    let msg = `请求失败 (HTTP ${res.status})`
    try { const j = await res.json(); msg = j?.error?.message ?? msg } catch { /* 响应体非 JSON 时用默认信息 */ }
    throw new ApiError(res.status, msg)
  }
  const body: ReadableStream<Uint8Array> = res.body
  return (async function* () {
    const parser = new EmotionParser()
    for await (const d of parseSSE(body)) {
      const { display, emotion } = parser.feed(d.delta)
      if (emotion) yield { type: 'emotion', emotion }
      if (display) yield { type: 'delta', delta: display }
      if (d.finishReason) break
    }
    const { display, emotion } = parser.end()
    if (emotion) yield { type: 'emotion', emotion }
    if (display) yield { type: 'delta', delta: display }
    yield { type: 'done', model }
  })()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/deepseek/client.test.ts && npx vitest run`
Expected: client 4 个测试 PASS；全仓测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/main/deepseek/client.ts src/main/deepseek/client.test.ts && git commit -m "feat: DeepSeek 客户端 streamChat（SSE 流式+情绪解析+视觉路由+错误转换）"
```

---

### Task 7: IPC 层 + preload API + Null 桌宠协调器

**Files:**
- Modify: `src/shared/types.ts`（补充 API 相关类型）
- Create: `src/main/deepseek/config.ts`（settings → DeepSeekConfig 装配）
- Create: `src/main/pet/coordinator.ts`（PetCoordinator 接口 + Null 实现）
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`（接入 Store/settings/registerIpc）
- Modify: `src/preload/index.ts`（暴露完整 api）
- Create: `src/preload/index.d.ts`（Window.api 类型声明）

**Interfaces:**
- Consumes: `Store`（Task 2）、`streamChat/ApiError/Emotion`（Task 6）
- Produces（渲染进程依赖的完整契约，后续 UI 任务全部基于此）:
  - IPC 通道：`chat:listConversations` / `chat:createConversation` / `chat:renameConversation` / `chat:deleteConversation` / `chat:getMessages` / `chat:search` / `chat:startReply` / `chat:stopReply` / `settings:get` / `settings:save` / `settings:setApiKey` / `screen:capture` / `window:hide` / `pet:status`
  - 流事件通道：`chat:stream` 推送 `StreamEventMsg`
  - `PetCoordinator` 接口：`start()/stop()/onPetClick(cb)/bubble(on: boolean)/emotion(e: Emotion | null)/status()`；本任务提供 `createNullPet()` 空实现（所有方法 no-op，status 返回全 false）；Task 12 提供真实实现
  - `getDeepSeekConfig(settings: AppSettings): DeepSeekConfig | null`（无 Key 返回 null）
  - `registerIpc` 以 **getter 形态**接收桌宠协调器：`pet: () => PetCoordinator`（设置变化时主进程会替换协调器实例，getter 保证 IPC 始终调用最新实例，Task 12 起生效）
  - `registerIpc` 可选参数 `onSettingsChanged?: (s: AppSettings) => void`（Task 9 起用于设置保存后应用变更）

- [ ] **Step 1: 扩展共享类型**

`src/shared/types.ts` 追加（保留原四个类型）:
```ts
export interface PetSettings { enabled: boolean; exePath: string; exeName: string }
export interface AppSettingsView {
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
  pet: PetSettings
  emotionKeys: Record<string, string>
  hasApiKey: boolean
}
export interface StreamEventMsg {
  requestId: string
  type: 'delta' | 'emotion' | 'done' | 'error'
  delta?: string
  emotion?: string
  message?: ChatMessage
  error?: string
  aborted?: boolean
}
export interface StartReplyPayload { conversationId: string; content: string; images?: string[] }
export interface StartReplyResult { ok: boolean; error?: string; requestId?: string; userMessage?: ChatMessage }
export interface PetStatus { helperRunning: boolean; connected: boolean; petWindowFound: boolean }
```

- [ ] **Step 2: 写协调器接口与 Null 实现**

`src/main/pet/coordinator.ts`:
```ts
import type { Emotion } from '../deepseek/emotion'
import type { PetStatus } from '../../shared/types'

export interface PetCoordinator {
  start(): void
  stop(): void
  onPetClick(cb: () => void): void
  bubble(on: boolean): void
  emotion(e: Emotion | null): void
  status(): PetStatus
}

export function createNullPet(): PetCoordinator {
  return {
    start() {}, stop() {},
    onPetClick() {},
    bubble() {}, emotion() {},
    status() { return { helperRunning: false, connected: false, petWindowFound: false } }
  }
}
```

- [ ] **Step 3: 写 settings 类型与装配（settings 模块 Task 9 完善，本任务先建最小版）**

`src/main/settings.ts`:
```ts
import fs from 'node:fs'
import { SYSTEM_PROMPT } from './deepseek/client'
import { DEFAULT_EMOTION_KEYS } from './pet/keys'

export interface AppSettings {
  apiKeyEncrypted: string | null
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
  pet: { enabled: boolean; exePath: string; exeName: string }
  emotionKeys: Record<string, string>
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeyEncrypted: null,
  baseUrl: 'https://api.deepseek.com',
  textModel: 'deepseek-chat',
  visionModel: 'deepseek-v4-flash-vision-exp',
  systemPrompt: SYSTEM_PROMPT,
  pet: { enabled: true, exePath: 'E:\\迅雷下载\\达妮娅-带表情版\\A-达妮娅\\Bongo Cat Mver.exe', exeName: 'Bongo Cat Mver.exe' },
  emotionKeys: { ...DEFAULT_EMOTION_KEYS }
}

export function loadSettings(file: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...raw, pet: { ...DEFAULT_SETTINGS.pet, ...(raw.pet ?? {}) }, emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(raw.emotionKeys ?? {}) } }
  } catch { return { ...DEFAULT_SETTINGS } }
}

export function saveSettings(file: string, s: AppSettings): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, file)
}

export function toView(s: AppSettings): import('./shared/types').AppSettingsView {
  return {
    baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel,
    systemPrompt: s.systemPrompt, pet: { ...s.pet },
    emotionKeys: { ...s.emotionKeys }, hasApiKey: !!s.apiKeyEncrypted
  }
}
```

`src/main/pet/keys.ts`（本任务先提供 DEFAULT_EMOTION_KEYS，Task 13 补 VK 表与 comboFor）:
```ts
export const DEFAULT_EMOTION_KEYS: Record<string, string> = {
  default: 'D', bubble_on: '0', bubble_off: '-',
  happy: 'I', sad: 'O', sleepy: 'P', dismissive: 'U', shy: 'Y', blush: 'Y', angry: '1', dark: '1'
}
```

- [ ] **Step 4: 写 IPC 层**

`src/main/ipc.ts`:
```ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from './storage/store'
import type { ChatMessage, StreamEventMsg, StartReplyPayload, StartReplyResult } from '../shared/types'
import { streamChat, ApiError, type ChatTurn, type Emotion } from './deepseek/client'
import type { DeepSeekConfig } from './deepseek/client'
import { loadSettings, saveSettings, toView, type AppSettings } from './settings'
import type { PetCoordinator } from './pet/coordinator'

interface StreamHandle { abort: AbortController; conversationId: string }
const MAX_CONTEXT = 40

function toTurn(m: ChatMessage): ChatTurn {
  return { role: m.role, content: m.content, images: m.images?.map(i => i.dataUrl) }
}

export interface RegisterIpcOpts {
  store: Store
  settingsFile: string
  pet: () => PetCoordinator
  getConfig: (s: AppSettings) => DeepSeekConfig | null
  onSettingsChanged?: (s: AppSettings) => void
}

export function registerIpc(opts: RegisterIpcOpts): void {
  const { store, settingsFile, pet, getConfig } = opts
  const streams = new Map<string, StreamHandle>()

  ipcMain.handle('chat:listConversations', () => store.listConversations())
  ipcMain.handle('chat:createConversation', () => store.createConversation())
  ipcMain.handle('chat:renameConversation', (_e, p: { id: string; title: string }) => { store.renameConversation(p.id, p.title) })
  ipcMain.handle('chat:deleteConversation', (_e, p: { id: string }) => {
    for (const [rid, h] of streams) if (h.conversationId === p.id) { h.abort.abort(); streams.delete(rid) }
    store.deleteConversation(p.id)
  })
  ipcMain.handle('chat:getMessages', (_e, p: { id: string }) => store.getMessages(p.id))
  ipcMain.handle('chat:search', (_e, p: { q: string }) => store.search(p.q))

  ipcMain.handle('chat:startReply', async (e: IpcMainInvokeEvent, p: StartReplyPayload): Promise<StartReplyResult> => {
    if (!p.content.trim() && !(p.images && p.images.length > 0)) return { ok: false, error: '消息内容不能为空' }
    if ([...streams.values()].some(h => h.conversationId === p.conversationId)) return { ok: false, error: '该会话正在生成回复中' }
    const settings = loadSettings(settingsFile)
    const cfg = getConfig(settings)
    if (!cfg) return { ok: false, error: '请先在设置中填写 API Key' }

    const userMessage: ChatMessage = {
      id: randomUUID(), role: 'user', content: p.content,
      images: p.images?.map(u => ({ id: randomUUID(), dataUrl: u })),
      createdAt: Date.now()
    }
    store.appendMessage(p.conversationId, userMessage)
    store.autoTitle(p.conversationId)

    const requestId = randomUUID()
    const history = store.getMessages(p.conversationId).slice(-MAX_CONTEXT).map(toTurn)
    const ac = new AbortController()
    streams.set(requestId, { abort: ac, conversationId: p.conversationId })
    const send = (msg: Omit<StreamEventMsg, 'requestId'>) => { if (!e.sender.isDestroyed()) e.sender.send('chat:stream', { requestId, ...msg }) }

    pet().bubble(true)
    void (async () => {
      let full = ''
      let emotion: Emotion | null = null
      let modelUsed = ''
      try {
        const gen = await streamChat(cfg, history, ac.signal)
        for await (const ev of gen) {
          if (ev.type === 'delta') { full += ev.delta; send({ type: 'delta', delta: ev.delta }) }
          else if (ev.type === 'emotion') { emotion = ev.emotion; pet().emotion(emotion); send({ type: 'emotion', emotion }) }
          else if (ev.type === 'done') { modelUsed = ev.model; break }
        }
      } catch (err) {
        if (ac.signal.aborted) {
          const partial: ChatMessage = { id: randomUUID(), role: 'assistant', content: full, model: modelUsed, createdAt: Date.now() }
          if (full.trim()) store.appendMessage(p.conversationId, partial)
          send({ type: 'done', message: partial, aborted: true })
        } else {
          const msg = err instanceof ApiError ? err.message : '网络错误，请重试'
          send({ type: 'error', error: msg })
        }
        return
      } finally {
        streams.delete(requestId)
        pet().bubble(false)
      }
      if (emotion === null) pet().emotion(null)
      const assistantMessage: ChatMessage = { id: randomUUID(), role: 'assistant', content: full, model: modelUsed, createdAt: Date.now() }
      store.appendMessage(p.conversationId, assistantMessage)
      send({ type: 'done', message: assistantMessage, emotion: emotion ?? undefined })
    })()

    return { ok: true, requestId, userMessage }
  })

  ipcMain.handle('chat:stopReply', (_e, p: { requestId: string }) => { streams.get(p.requestId)?.abort.abort() })

  ipcMain.handle('settings:get', () => toView(loadSettings(settingsFile)))
  ipcMain.handle('settings:save', (_e, v: import('../shared/types').AppSettingsView) => {
    const cur = loadSettings(settingsFile)
    const next: AppSettings = { ...cur, ...v, pet: { ...cur.pet, ...v.pet }, emotionKeys: v.emotionKeys }
    saveSettings(settingsFile, next)
    opts.onSettingsChanged?.(next)
  })
  ipcMain.handle('settings:setApiKey', () => { throw new Error('Task 9 实现') })
  ipcMain.handle('screen:capture', () => { throw new Error('Task 10 实现') })
  ipcMain.handle('window:hide', (e) => { BrowserWindow.fromWebContents(e.sender)?.hide() })
  ipcMain.handle('pet:status', () => pet().status())
}
```

（`settings:setApiKey` 与 `screen:capture` 两个 throw 是**计划内的阶段性占位**，分别在 Task 9 / Task 10 替换为真实实现。）

- [ ] **Step 5: 主进程接入**

`src/main/index.ts` 替换为:
```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { Store } from './storage/store'
import { registerIpc } from './ipc'
import { loadSettings, type AppSettings } from './settings'
import { createNullPet } from './pet/coordinator'
import type { DeepSeekConfig } from './deepseek/client'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 960, height: 640, minWidth: 860, minHeight: 600,
    autoHideMenuBar: true, title: '达妮娅聊天', show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function getConfig(s: AppSettings): DeepSeekConfig | null {
  if (!s.apiKeyEncrypted) return null
  return {
    apiKey: 'PLACEHOLDER-TASK9',
    baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, systemPrompt: s.systemPrompt
  }
}

app.whenReady().then(() => {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json')
  const store = new Store(app.getPath('userData'))
  registerIpc({ store, settingsFile, pet: () => createNullPet(), getConfig })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 6: preload 暴露 API + 类型声明**

`src/preload/index.ts` 替换为:
```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { Api, StreamEventMsg } from '../shared/api'

const api: Api = {
  listConversations: () => ipcRenderer.invoke('chat:listConversations'),
  createConversation: () => ipcRenderer.invoke('chat:createConversation'),
  renameConversation: (id, title) => ipcRenderer.invoke('chat:renameConversation', { id, title }),
  deleteConversation: (id) => ipcRenderer.invoke('chat:deleteConversation', { id }),
  getMessages: (id) => ipcRenderer.invoke('chat:getMessages', { id }),
  search: (q) => ipcRenderer.invoke('chat:search', { q }),
  startReply: (p) => ipcRenderer.invoke('chat:startReply', p),
  stopReply: (requestId) => ipcRenderer.invoke('chat:stopReply', { requestId }),
  onStream: (cb) => {
    const h = (_e: unknown, data: StreamEventMsg): void => cb(data)
    ipcRenderer.on('chat:stream', h)
    return () => ipcRenderer.removeListener('chat:stream', h)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', { key }),
  testConnection: () => ipcRenderer.invoke('settings:testConnection'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getPetStatus: () => ipcRenderer.invoke('pet:status')
}
contextBridge.exposeInMainWorld('api', api)
```

`src/shared/api.ts`:
```ts
import type { AppSettingsView, ChatMessage, ConversationMeta, PetStatus, SearchHit, StartReplyPayload, StartReplyResult, StreamEventMsg } from './types'

export interface Api {
  listConversations(): Promise<ConversationMeta[]>
  createConversation(): Promise<ConversationMeta>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  getMessages(id: string): Promise<ChatMessage[]>
  search(q: string): Promise<SearchHit[]>
  startReply(p: StartReplyPayload): Promise<StartReplyResult>
  stopReply(requestId: string): Promise<void>
  onStream(cb: (e: StreamEventMsg) => void): () => void
  getSettings(): Promise<AppSettingsView>
  saveSettings(s: AppSettingsView): Promise<void>
  setApiKey(key: string): Promise<void>
  testConnection(): Promise<{ ok: boolean; message: string }>
  captureScreen(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  hideWindow(): Promise<void>
  getPetStatus(): Promise<PetStatus>
}
```

`src/preload/index.d.ts`:
```ts
import type { Api } from '../shared/api'
declare global { interface Window { api: Api } }
export {}
```

- [ ] **Step 7: 验证**

Run: `npm run typecheck && npx vitest run`
Expected: 类型检查通过、已有测试全绿。
Run: `npm run dev`
Expected: 窗口正常打开（IPC 已注册但 UI 未使用，无报错）。

- [ ] **Step 8: 提交**

```bash
git add src/ && git commit -m "feat: IPC 层与 preload API 契约、Null 桌宠协调器、设置骨架"
```

---

### Task 8: 渲染层聊天 UI（列表/消息/输入/流式/搜索/Markdown）

> 样式设计时先调用 `frontend-design` 技能获取视觉方向，再按其指引实现本任务 CSS。

**Files:**
- Create: `src/renderer/src/state/chatStore.ts`
- Create: `src/renderer/src/components/ConversationList.tsx`
- Create: `src/renderer/src/components/MessageArea.tsx`
- Create: `src/renderer/src/components/Message.tsx`
- Create: `src/renderer/src/components/Composer.tsx`
- Create: `src/renderer/src/components/SettingsPage.tsx`（占位：设置入口按钮 + "设置页在下一步实现"文案）
- Modify: `src/renderer/src/App.tsx`、`src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `window.api`（Task 7 契约）、`src/shared/types.ts`
- Produces: 完整聊天 UI（除设置页与截屏按钮外）；`chatStore.ts` 导出 `reducer/initialState/State/Action` 供后续任务扩展

- [ ] **Step 1: 写状态 store**

`src/renderer/src/state/chatStore.ts`:
```ts
import type { ChatMessage, ConversationMeta, SearchHit, StreamEventMsg } from '../../../shared/types'

export type View = 'chat' | 'settings'

export interface Streaming { requestId: string; text: string }

export interface State {
  view: View
  conversations: ConversationMeta[]
  activeId: string | null
  messages: ChatMessage[]
  streaming: Streaming | null
  error: string | null
  searchQuery: string
  searchHits: SearchHit[] | null
}

export type Action =
  | { type: 'init'; conversations: ConversationMeta[] }
  | { type: 'setView'; view: View }
  | { type: 'select'; id: string; messages: ChatMessage[] }
  | { type: 'newConversation'; meta: ConversationMeta }
  | { type: 'rename'; id: string; title: string }
  | { type: 'remove'; id: string }
  | { type: 'appendUser'; message: ChatMessage }
  | { type: 'startStream'; requestId: string }
  | { type: 'streamEvent'; e: StreamEventMsg }
  | { type: 'clearError' }
  | { type: 'setSearch'; query: string; hits: SearchHit[] | null }

export const initialState: State = {
  view: 'chat', conversations: [], activeId: null, messages: [],
  streaming: null, error: null, searchQuery: '', searchHits: null
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'init':
      return { ...state, conversations: a.conversations }
    case 'setView':
      return { ...state, view: a.view }
    case 'select':
      return { ...state, activeId: a.id, messages: a.messages, streaming: null, error: null }
    case 'newConversation':
      return { ...state, conversations: [a.meta, ...state.conversations], activeId: a.meta.id, messages: [], streaming: null, error: null }
    case 'rename':
      return { ...state, conversations: state.conversations.map(c => c.id === a.id ? { ...c, title: a.title } : c) }
    case 'remove': {
      const conversations = state.conversations.filter(c => c.id !== a.id)
      return { ...state, conversations, activeId: state.activeId === a.id ? (conversations[0]?.id ?? null) : state.activeId, messages: state.activeId === a.id ? [] : state.messages }
    }
    case 'appendUser':
      return { ...state, messages: [...state.messages, a.message] }
    case 'startStream':
      return { ...state, streaming: { requestId: a.requestId, text: '' }, error: null }
    case 'streamEvent': {
      const e = a.e
      if (!state.streaming || e.requestId !== state.streaming.requestId) return state
      if (e.type === 'delta') return { ...state, streaming: { ...state.streaming, text: state.streaming.text + (e.delta ?? '') } }
      if (e.type === 'done') {
        const messages = e.message && e.message.content.trim() ? [...state.messages, e.message] : state.messages
        return { ...state, streaming: null, messages, error: null }
      }
      if (e.type === 'error') return { ...state, streaming: null, error: e.error ?? '未知错误' }
      return state
    }
    case 'clearError':
      return { ...state, error: null }
    case 'setSearch':
      return { ...state, searchQuery: a.query, searchHits: a.hits }
    default:
      return state
  }
}
```

- [ ] **Step 2: 写消息渲染组件（Markdown + 代码高亮 + 复制）**

`src/renderer/src/components/Message.tsx`:
```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../../../shared/types'
import 'highlight.js/styles/github-dark.css'

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  const match = /language-(\w+)/.exec(className ?? '')
  const text = String(children).replace(/\n$/, '')
  const copy = (): void => { void navigator.clipboard.writeText(text) }
  if (match) {
    return (
      <div className="codeblock">
        <div className="codeblock-head">
          <span>{match[1]}</span>
          <button className="copy-btn" onClick={copy}>复制</button>
        </div>
        <pre><code className={className}>{text}</code></pre>
      </div>
    )
  }
  return <code className="inline-code">{children}</code>
}

export function Message({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }): React.JSX.Element {
  return (
    <div className={`msg msg-${msg.role}${streaming ? ' streaming' : ''}`}>
      {msg.images && msg.images.length > 0 && (
        <div className="msg-images">
          {msg.images.map(i => <img key={i.id} src={i.dataUrl} alt="截图" />)}
        </div>
      )}
      {msg.content && (
        <div className="msg-bubble">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
            components={{ code: CodeBlock }}>
            {msg.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 写消息区/会话列表/输入框**

`src/renderer/src/components/MessageArea.tsx`:
```tsx
import type { ChatMessage } from '../../../shared/types'
import type { Streaming } from '../state/chatStore'
import { Message } from './Message'

export function MessageArea(props: {
  messages: ChatMessage[]
  streaming: Streaming | null
  error: string | null
  onRetry: () => void
  onDismissError: () => void
}): React.JSX.Element {
  return (
    <div className="messages">
      {props.messages.map(m => <Message key={m.id} msg={m} />)}
      {props.streaming && props.streaming.text.length === 0 && <div className="thinking">达妮娅思考中…</div>}
      {props.streaming && props.streaming.text.length > 0 && (
        <Message msg={{ id: '__streaming__', role: 'assistant', content: props.streaming.text, createdAt: Date.now() }} streaming />
      )}
      {props.error && (
        <div className="error-banner">
          <span>{props.error}</span>
          <button onClick={props.onRetry}>重试</button>
          <button onClick={props.onDismissError}>关闭</button>
        </div>
      )}
    </div>
  )
}
```

`src/renderer/src/components/ConversationList.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import type { ConversationMeta, SearchHit } from '../../../shared/types'

export function ConversationList(props: {
  conversations: ConversationMeta[]
  activeId: string | null
  searchQuery: string
  searchHits: SearchHit[] | null
  onNew(): void
  onSelect(id: string): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
  onSearchInput(v: string): void
  onSearch(query: string): void
  setViewSettings(): void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const debounceRef = useRef<number>()

  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    const q = props.searchQuery.trim()
    if (!q) return
    debounceRef.current = window.setTimeout(() => props.onSearch(q), 250)
  }, [props.searchQuery])

  const finishEdit = (id: string): void => {
    if (editText.trim()) props.onRename(id, editText.trim())
    setEditingId(null)
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="app-title">达妮娅聊天</span>
        <button className="new-btn" onClick={props.onNew} title="新建对话">＋</button>
      </div>
      <input
        className="search-input" placeholder="搜索历史消息…" value={props.searchQuery}
        onChange={e => props.onSearchInput(e.target.value)}
      />
      <div className="conv-list">
        {props.searchQuery.trim() && props.searchHits ? (
          props.searchHits.length === 0 ? <div className="empty-tip">没有匹配的消息</div> :
          props.searchHits.map((h, i) => (
            <button key={i} className="search-hit" onClick={() => props.onSelect(h.conversationId)}>
              <span className="hit-role">{h.role === 'user' ? '我' : '达妮娅'}</span>
              <span className="hit-snippet">{h.snippet}</span>
            </button>
          ))
        ) : (
          props.conversations.map(c => (
            <div key={c.id} className={`conv-item${c.id === props.activeId ? ' active' : ''}`} onClick={() => props.onSelect(c.id)}>
              {editingId === c.id ? (
                <input autoFocus value={editText}
                  onChange={e => setEditText(e.target.value)}
                  onBlur={() => finishEdit(c.id)}
                  onKeyDown={e => { if (e.key === 'Enter') finishEdit(c.id); if (e.key === 'Escape') setEditingId(null) }} />
              ) : (
                <span className="conv-title" onDoubleClick={() => { setEditingId(c.id); setEditText(c.title) }}>{c.title}</span>
              )}
              <span className="conv-actions" onClick={e => e.stopPropagation()}>
                {confirmDeleteId === c.id ? (
                  <button className="danger" onClick={() => { props.onDelete(c.id); setConfirmDeleteId(null) }}>确认删除</button>
                ) : (
                  <button onClick={() => setConfirmDeleteId(c.id)}>删除</button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="sidebar-foot">
        <button onClick={props.setViewSettings}>设置</button>
      </div>
    </div>
  )
}
```

`src/renderer/src/components/Composer.tsx`:
```tsx
import { useRef, useState } from 'react'

export function Composer(props: {
  streaming: boolean
  onSend(content: string): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if (!t || props.streaming) return
    props.onSend(t)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">Esc 收起窗口</span>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim()} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 组装 App**

`src/renderer/src/App.tsx` 替换为:
```tsx
import { useCallback, useEffect, useReducer } from 'react'
import { initialState, reducer } from './state/chatStore'
import { ConversationList } from './components/ConversationList'
import { MessageArea } from './components/MessageArea'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/SettingsPage'

export default function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)

  const select = useCallback(async (id: string) => {
    const messages = await window.api.getMessages(id)
    dispatch({ type: 'select', id, messages })
  }, [])

  useEffect(() => {
    let disposed = false
    void window.api.listConversations().then(cs => {
      if (disposed) return
      dispatch({ type: 'init', conversations: cs })
      if (cs[0]) void select(cs[0].id)
    })
    const offStream = window.api.onStream(e => dispatch({ type: 'streamEvent', e }))
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') void window.api.hideWindow() }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; offStream(); window.removeEventListener('keydown', onKey) }
  }, [select])

  const send = useCallback(async (content: string) => {
    if (!state.activeId) return
    const r = await window.api.startReply({ conversationId: state.activeId, content })
    if (!r.ok) {
      dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error } })
      return
    }
    if (r.requestId && r.userMessage) {
      dispatch({ type: 'appendUser', message: r.userMessage })
      dispatch({ type: 'startStream', requestId: r.requestId })
    }
  }, [state.activeId])

  const retry = useCallback(() => {
    const last = [...state.messages].reverse().find(m => m.role === 'user')
    if (last && state.activeId) {
      void window.api.startReply({
        conversationId: state.activeId, content: last.content,
        images: last.images?.map(i => i.dataUrl)
      }).then(r => {
        if (!r.ok) {
          if (r.error) dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error } })
        } else if (r.requestId) {
          dispatch({ type: 'startStream', requestId: r.requestId })
        }
      })
    }
  }, [state.messages, state.activeId])

  if (state.view === 'settings') {
    return <SettingsPage onBack={() => dispatch({ type: 'setView', view: 'chat' })} />
  }

  return (
    <div className="app">
      <ConversationList
        conversations={state.conversations}
        activeId={state.activeId}
        searchQuery={state.searchQuery}
        searchHits={state.searchHits}
        onNew={() => void window.api.createConversation().then(m => dispatch({ type: 'newConversation', meta: m }))}
        onSelect={id => { void select(id) }}
        onRename={(id, title) => { void window.api.renameConversation(id, title); dispatch({ type: 'rename', id, title }) }}
        onDelete={id => { void window.api.deleteConversation(id); dispatch({ type: 'remove', id }) }}
        onSearchInput={v => dispatch({ type: 'setSearch', query: v, hits: null })}
        onSearch={q => { void window.api.search(q).then(hits => dispatch({ type: 'setSearch', query: q, hits })) }}
        setViewSettings={() => dispatch({ type: 'setView', view: 'settings' })}
      />
      <div className="main">
        {state.activeId ? (
          <>
            <MessageArea messages={state.messages} streaming={state.streaming} error={state.error}
              onRetry={retry} onDismissError={() => dispatch({ type: 'clearError' })} />
            <Composer streaming={!!state.streaming}
              onSend={content => void send(content)}
              onStop={() => { if (state.streaming) void window.api.stopReply(state.streaming.requestId) }} />
          </>
        ) : (
          <div className="empty">点击左侧 ＋ 新建对话开始</div>
        )}
      </div>
    </div>
  )
}
```

`src/renderer/src/components/SettingsPage.tsx`（本任务占位，Task 9 重写）:
```tsx
export function SettingsPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <div className="settings">
      <button onClick={onBack}>← 返回聊天</button>
      <p>设置页将在下一步实现</p>
    </div>
  )
}
```

- [ ] **Step 5: 写完整样式（前端设计方向：深色聊天应用、紫色主色、圆角气泡）**

`src/renderer/src/styles.css` 替换为:
```css
:root {
  color-scheme: dark;
  --bg: #17151f; --panel: #1e1b29; --panel-2: #262233; --border: #322c44;
  --text: #e7e5f0; --text-dim: #9b95b0; --accent: #8b5cf6; --accent-soft: #2a2440;
  --danger: #f2607a; --radius: 10px;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, 'Microsoft YaHei', sans-serif; background: var(--bg); color: var(--text); }
button { font-family: inherit; cursor: pointer; }
.app { display: flex; height: 100vh; }

.sidebar { width: 260px; min-width: 260px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.sidebar-head { display: flex; align-items: center; justify-content: space-between; padding: 14px; }
.app-title { font-weight: 700; font-size: 15px; }
.new-btn { background: var(--accent); color: #fff; border: 0; border-radius: 8px; width: 28px; height: 28px; font-size: 16px; }
.search-input { margin: 0 12px 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); outline: none; }
.search-input:focus { border-color: var(--accent); }
.conv-list { flex: 1; overflow-y: auto; padding: 0 8px; }
.conv-item { display: flex; align-items: center; justify-content: space-between; padding: 9px 10px; border-radius: 8px; cursor: pointer; gap: 6px; }
.conv-item:hover { background: var(--panel-2); }
.conv-item.active { background: var(--accent-soft); }
.conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.conv-actions { display: none; }
.conv-item:hover .conv-actions { display: inline-flex; gap: 4px; }
.conv-actions button { background: transparent; border: 0; color: var(--text-dim); font-size: 12px; padding: 2px 4px; border-radius: 4px; }
.conv-actions button:hover { color: var(--text); background: var(--panel); }
.conv-actions button.danger { color: var(--danger); }
.search-hit { display: flex; gap: 8px; width: 100%; text-align: left; padding: 8px 10px; background: transparent; border: 0; border-radius: 8px; color: var(--text); font-size: 12px; }
.search-hit:hover { background: var(--panel-2); }
.hit-role { color: var(--accent); flex-shrink: 0; }
.hit-snippet { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
.empty-tip { color: var(--text-dim); font-size: 13px; padding: 12px; text-align: center; }
.sidebar-foot { padding: 10px; border-top: 1px solid var(--border); }
.sidebar-foot button { width: 100%; background: transparent; border: 1px solid var(--border); color: var(--text-dim); padding: 7px; border-radius: 8px; }
.sidebar-foot button:hover { color: var(--text); border-color: var(--accent); }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.messages { flex: 1; overflow-y: auto; padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }
.msg { display: flex; }
.msg-user { justify-content: flex-end; }
.msg-bubble { max-width: 72%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.65; overflow-wrap: break-word; }
.msg-user .msg-bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg-assistant .msg-bubble { background: var(--panel-2); border-bottom-left-radius: 4px; }
.msg-bubble p { margin: 0 0 8px; } .msg-bubble p:last-child { margin-bottom: 0; }
.msg-bubble ul, .msg-bubble ol { margin: 4px 0; padding-left: 20px; }
.msg-bubble a { color: #b9a3ff; }
.msg-bubble table { border-collapse: collapse; margin: 6px 0; }
.msg-bubble th, .msg-bubble td { border: 1px solid var(--border); padding: 4px 10px; font-size: 13px; }
.msg-images { display: flex; gap: 8px; flex-wrap: wrap; }
.msg-images img { max-width: 260px; max-height: 200px; border-radius: 10px; border: 1px solid var(--border); }
.codeblock { margin: 8px 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
.codeblock-head { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; background: #0f0e14; color: var(--text-dim); font-size: 12px; }
.copy-btn { background: transparent; border: 0; color: var(--text-dim); font-size: 12px; }
.copy-btn:hover { color: var(--text); }
.codeblock pre { margin: 0; padding: 10px 14px; background: #0f0e14; overflow-x: auto; font-size: 13px; }
.inline-code { background: #2b2539; padding: 1px 6px; border-radius: 5px; font-size: 13px; }
.thinking { color: var(--text-dim); font-size: 13px; padding-left: 4px; }
.streaming .msg-bubble::after { content: '▍'; animation: blink 1s steps(2) infinite; color: var(--accent); }
@keyframes blink { 50% { opacity: 0; } }
.error-banner { display: flex; align-items: center; gap: 10px; background: #3a1f28; border: 1px solid var(--danger); color: #ffb3c0; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.error-banner button { background: transparent; border: 1px solid var(--danger); color: #ffb3c0; border-radius: 6px; padding: 3px 10px; font-size: 12px; }
.composer { border-top: 1px solid var(--border); padding: 12px 18px; background: var(--panel); }
.composer textarea { width: 100%; resize: none; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; color: var(--text); padding: 10px 12px; font-family: inherit; font-size: 14px; outline: none; }
.composer textarea:focus { border-color: var(--accent); }
.composer-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 8px; }
.composer-hint { color: var(--text-dim); font-size: 12px; margin-right: auto; }
.send-btn { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 7px 22px; font-size: 14px; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.stop-btn { background: var(--panel-2); color: var(--danger); border: 1px solid var(--danger); border-radius: 8px; padding: 7px 22px; font-size: 14px; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
```

- [ ] **Step 6: 验证**

Run: `npm run typecheck`
Expected: 通过。运行 `npm run dev`：会话新建/切换/重命名/删除、发消息（无 Key 时报"请先在设置中填写 API Key"错误条）、搜索历史，界面与交互正常。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/ && git commit -m "feat: 聊天界面（会话列表/流式消息/Markdown/搜索/错误重试）"
```

---

### Task 9: 设置层（safeStorage 密钥 + 设置页 + Key 申请指引 + 连接测试）

**Files:**
- Modify: `src/main/settings.ts`（setApiKey/getApiKey/fromView 合并逻辑）
- Modify: `src/main/ipc.ts`（settings:setApiKey / settings:testConnection / settings:save 处理 pet 配置变更后的协调器重启钩子）
- Modify: `src/main/index.ts`（getConfig 用真实 Key；settings:save 后应用变更）
- Modify: `src/main/pet/keys.ts`（补 VK 码表与 comboFor，Task 13 联动用）
- Rewrite: `src/renderer/src/components/SettingsPage.tsx`
- Create: `src/renderer/src/components/SettingsPage.test.tsx`？—— 不需要（渲染层测试成本高，本任务以类型检查+手动验证为准）
- Test: `src/main/settings.test.ts`（loadSettings 合并/损坏文件回退/toView）

**Interfaces:**
- Consumes: `AppSettingsView`（Task 7）、`safeStorage`（electron，仅手动验证）
- Produces:
  - `setApiKey(file: string, key: string): AppSettings`（空串=清除；用 safeStorage.encryptString，base64 存储）
  - `getApiKey(s: AppSettings): string | null`
  - `VK` 码表与 `comboFor(mapping: Record<string,string>, name: string): { mods: number[]; key: number } | null`
  - 设置页完整 UI：Key 输入（占位显示"已保存，输入新值覆盖"）、模型选择、Base URL、桌宠开关/路径、情绪按键编辑、测试连接、申请指引（platform.deepseek.com 链接经 shell.openExternal 打开）

- [ ] **Step 1: 写失败测试（settings 纯函数部分）**

`src/main/settings.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, toView, DEFAULT_SETTINGS } from './settings'

let dir: string
let file: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-settings-')); file = path.join(dir, 'settings.json') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('settings', () => {
  it('无文件时返回默认值', () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('保存后可读回，且与默认合并', () => {
    saveSettings(file, { ...DEFAULT_SETTINGS, textModel: 'custom-model' })
    expect(loadSettings(file).textModel).toBe('custom-model')
    expect(loadSettings(file).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('文件损坏时回退默认值', () => {
    fs.writeFileSync(file, '不是JSON{{{')
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('旧版本缺少字段时按默认补齐（含 pet/emotionKeys 子对象）', () => {
    fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://example.com' }))
    const s = loadSettings(file)
    expect(s.baseUrl).toBe('https://example.com')
    expect(s.pet).toEqual(DEFAULT_SETTINGS.pet)
    expect(s.emotionKeys.happy).toBe(DEFAULT_SETTINGS.emotionKeys.happy)
  })

  it('toView 不暴露密文，hasApiKey 反映是否已保存', () => {
    const v = toView({ ...DEFAULT_SETTINGS, apiKeyEncrypted: 'xxx' })
    expect(v.hasApiKey).toBe(true)
    expect('apiKeyEncrypted' in v).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`（settings.ts 存在但缺 toView 导出外的断言项会报错；实际首个失败为 toView 已存在——允许直接 PASS 的分项除外，整体以新增行为为准）。

- [ ] **Step 3: 完善 settings.ts 与 keys.ts**

`src/main/settings.ts` 追加:
```ts
import { safeStorage } from 'electron'

export function setApiKey(file: string, key: string): AppSettings {
  const s = loadSettings(file)
  s.apiKeyEncrypted = key ? safeStorage.encryptString(key).toString('base64') : null
  saveSettings(file, s)
  return s
}

export function getApiKey(s: AppSettings): string | null {
  if (!s.apiKeyEncrypted) return null
  try { return safeStorage.decryptString(Buffer.from(s.apiKeyEncrypted, 'base64')) }
  catch { return null }
}

export function applyView(cur: AppSettings, v: AppSettingsView): AppSettings {
  return { ...cur, baseUrl: v.baseUrl, textModel: v.textModel, visionModel: v.visionModel, systemPrompt: v.systemPrompt, pet: { ...cur.pet, ...v.pet }, emotionKeys: { ...v.emotionKeys } }
}
```
（`toView`/`loadSettings`/`saveSettings`/`DEFAULT_SETTINGS` 已在 Task 7 建好。）

`src/main/pet/keys.ts` 替换为:
```ts
export const DEFAULT_EMOTION_KEYS: Record<string, string> = {
  default: 'D', bubble_on: '0', bubble_off: '-',
  happy: 'I', sad: 'O', sleepy: 'P', dismissive: 'U', shy: 'Y', blush: 'Y', angry: '1', dark: '1'
}

const VK: Record<string, number> = {}
for (let i = 65; i <= 90; i++) VK[String.fromCharCode(i)] = i           // A-Z
for (let i = 0; i <= 9; i++) VK[String(i)] = 48 + i                     // 0-9
VK['-'] = 189; VK['='] = 187; VK['['] = 219; VK[']'] = 221

export const VK_MENU = 18 // Alt

export function comboFor(mapping: Record<string, string>, name: string): { mods: number[]; key: number } | null {
  const letter = mapping[name]
  if (!letter) return null
  const vk = VK[letter.toUpperCase()]
  if (!vk) return null
  return { mods: [VK_MENU], key: vk }
}

export const EMOTION_LABELS: Record<string, string> = {
  happy: '开心-彩虹脸', sad: '难过-哭泣脸', sleepy: '困倦-瞌睡脸', dismissive: '不屑-不屑脸',
  shy: '害羞-鼻血脸', blush: '脸红-鼻血脸', angry: '生气-黑化', dark: '黑化-黑化',
  default: '默认表情', bubble_on: '等待中泡泡', bubble_off: '泡泡消失'
}
```

- [ ] **Step 4: 更新 IPC 与主进程**

`src/main/ipc.ts` 中：顶部追加 `import { setApiKey, applyView } from './settings'`；把 `settings:setApiKey` 的 throw 占位替换为:
```ts
  ipcMain.handle('settings:setApiKey', (_e, p: { key: string }) => { setApiKey(settingsFile, p.key ?? '') })
```
并把 `settings:save` 处理器改为用 `applyView` 合并（避免渲染层字段直接展开覆盖）:
```ts
  ipcMain.handle('settings:save', (_e, v: AppSettingsView) => {
    const next = applyView(loadSettings(settingsFile), v)
    saveSettings(settingsFile, next)
    opts.onSettingsChanged?.(next)
  })
```
追加测试连接处理器:
```ts
  ipcMain.handle('settings:testConnection', async () => {
    const s = loadSettings(settingsFile)
    const cfg = getConfig(s)
    if (!cfg) return { ok: false, message: '请先填写 API Key' }
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: `Bearer ${cfg.apiKey}` }
      })
      return res.ok
        ? { ok: true, message: '连接成功，API Key 有效' }
        : { ok: false, message: `连接失败 (HTTP ${res.status})，请检查 Key 与 Base URL` }
    } catch {
      return { ok: false, message: '网络错误，无法连接到 Base URL' }
    }
  })
```
（`onSettingsChanged` 已在 Task 7 的 `RegisterIpcOpts` 中声明，无需改动；`screen:capture` 占位留到 Task 10 替换。）

`src/main/index.ts` 中 `getConfig` 替换为:
```ts
import { getApiKey } from './settings'

function getConfig(s: AppSettings): DeepSeekConfig | null {
  const apiKey = getApiKey(s)
  if (!apiKey) return null
  return { apiKey, baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, systemPrompt: s.systemPrompt }
}
```

- [ ] **Step 5: 重写设置页**

`src/renderer/src/components/SettingsPage.tsx` 替换为:
```tsx
import { useEffect, useState } from 'react'
import type { AppSettingsView } from '../../../shared/types'
import { EMOTION_LABELS } from '../../../../main/pet/keys'

const EMOTION_ORDER = ['happy', 'sad', 'sleepy', 'dismissive', 'shy', 'blush', 'angry', 'dark', 'default', 'bubble_on', 'bubble_off']

export function SettingsPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [form, setForm] = useState<AppSettingsView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const [petStatus, setPetStatus] = useState('')

  useEffect(() => {
    void window.api.getSettings().then(s => setForm(s))
    const t = window.setInterval(() => {
      void window.api.getPetStatus().then(p => setPetStatus(p.helperRunning ? '联动助手运行中' : '联动助手未运行'))
    }, 3000)
    return () => window.clearInterval(t)
  }, [])

  if (!form) return <div className="settings"><p>加载中…</p></div>

  const set = (patch: Partial<AppSettingsView>): void => setForm({ ...form, ...patch })
  const save = async (): Promise<void> => {
    await window.api.saveSettings(form)
    if (apiKey) { await window.api.setApiKey(apiKey); setApiKey('') }
    setSaved('已保存')
    window.setTimeout(() => setSaved(''), 2000)
  }
  const test = async (): Promise<void> => {
    const r = await window.api.testConnection()
    setTestMsg(r.message)
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <button onClick={onBack}>← 返回聊天</button>
        <h1>设置</h1>
        <span className="pet-status">{petStatus}</span>
      </div>
      <div className="settings-body">
        <section>
          <h2>API</h2>
          <label>API Key
            <input type="password" value={apiKey} placeholder={form.hasApiKey ? '已保存（输入新值可覆盖，留空不变）' : '粘贴 DeepSeek API Key'}
              onChange={e => setApiKey(e.target.value)} />
          </label>
          <label>Base URL
            <input value={form.baseUrl} onChange={e => set({ baseUrl: e.target.value })} />
          </label>
          <label>文本模型
            <input value={form.textModel} onChange={e => set({ textModel: e.target.value })} />
          </label>
          <label>视觉模型（截屏消息使用）
            <input value={form.visionModel} onChange={e => set({ visionModel: e.target.value })} />
          </label>
          <div className="settings-actions">
            <button onClick={() => void test()}>测试连接</button>
            {testMsg && <span className="test-msg">{testMsg}</span>}
          </div>
        </section>

        <section>
          <h2>Key 申请指引</h2>
          <ol className="guide">
            <li>打开 <a href="#" onClick={e => { e.preventDefault(); void window.api.openExternal('https://platform.deepseek.com') }}>platform.deepseek.com</a> 注册并登录</li>
            <li>在左侧菜单进入「API Keys」页面</li>
            <li>点击「创建 API Key」，命名后复制生成的 Key（Key 只显示一次，请立即粘贴到本应用）</li>
            <li>需先在平台充值（按量计费，费用很低）；视觉模型为实验版，随 Key 自动可用</li>
          </ol>
        </section>

        <section>
          <h2>桌宠联动</h2>
          <label className="checkbox"><input type="checkbox" checked={form.pet.enabled} onChange={e => set({ pet: { ...form.pet, enabled: e.target.checked } })} /> 启用桌宠联动（点击桌宠弹出聊天框、AI 情绪驱动表情）</label>
          <label>桌宠程序路径
            <input value={form.pet.exePath} onChange={e => set({ pet: { ...form.pet, exePath: e.target.value } })} />
          </label>
          <label>进程名（用于定位桌宠窗口）
            <input value={form.pet.exeName} onChange={e => set({ pet: { ...form.pet, exeName: e.target.value } })} />
          </label>
        </section>

        <section>
          <h2>情绪 → 桌宠按键（Alt+该键）</h2>
          <div className="emotion-grid">
            {EMOTION_ORDER.map(name => (
              <label key={name}>{EMOTION_LABELS[name] ?? name}
                <input maxLength={1} value={form.emotionKeys[name] ?? ''}
                  onChange={e => set({ emotionKeys: { ...form.emotionKeys, [name]: e.target.value.toUpperCase() } })} />
              </label>
            ))}
          </div>
        </section>

        <div className="settings-actions">
          <button className="primary" onClick={() => void save()}>保存</button>
          {saved && <span className="test-msg">{saved}</span>}
        </div>
      </div>
    </div>
  )
}
```

对应 CSS 追加到 `styles.css`:
```css
.settings { height: 100vh; display: flex; flex-direction: column; }
.settings-head { display: flex; align-items: center; gap: 16px; padding: 14px 22px; border-bottom: 1px solid var(--border); }
.settings-head h1 { font-size: 17px; margin: 0; }
.pet-status { margin-left: auto; color: var(--text-dim); font-size: 12px; }
.settings-head button { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 14px; }
.settings-body { flex: 1; overflow-y: auto; padding: 20px 26px; max-width: 720px; }
.settings-body section { margin-bottom: 26px; }
.settings-body h2 { font-size: 14px; color: var(--accent); margin: 0 0 12px; }
.settings-body label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 10px; }
.settings-body label.checkbox { color: var(--text); }
.settings-body input[type='text'], .settings-body input[type='password'] { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); outline: none; }
.settings-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.settings-actions button { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 18px; }
.settings-actions button.primary { background: var(--accent); border: 0; color: #fff; }
.test-msg { color: var(--text-dim); font-size: 13px; }
.guide li { margin-bottom: 6px; font-size: 13px; }
.guide a { color: #b9a3ff; }
.emotion-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; }
.emotion-grid input { display: inline-block; width: 42px; margin-left: 8px; padding: 4px 6px; text-align: center; border-radius: 6px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); }
```

- [ ] **Step 6: preload 增加 openExternal**

`src/preload/index.ts` api 增加一项: `openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url })`；`src/shared/api.ts` 的 Api 接口同步增加 `openExternal(url: string): Promise<void>`。ipc.ts 注册: `ipcMain.handle('shell:openExternal', (_e, p: { url: string }) => { if (/^https?:\/\//.test(p.url)) return shell.openExternal(p.url) })`（顶部 import `{ shell }`）。

- [ ] **Step 7: 验证**

Run: `npm run typecheck && npx vitest run`
Expected: 通过。`npm run dev` 手动验证：设置页保存 Key（填真实 DeepSeek Key）→ 测试连接显示"连接成功"；重启应用 Key 仍在（占位显示"已保存"）；发送消息得到真实流式回复。

- [ ] **Step 8: 提交**

```bash
git add src/ && git commit -m "feat: 设置层（safeStorage 密钥、设置页、Key 申请指引、连接测试）"
```

---

### Task 10: 截屏发送（desktopCapturer + 输入框预览 + 视觉路由）

**Files:**
- Create: `src/main/screenshot.ts`
- Modify: `src/main/ipc.ts`（注册 screen:capture，替换 Task 7 占位）
- Modify: `src/renderer/src/components/Composer.tsx`（截屏按钮 + 预览 chips）
- Modify: `src/renderer/src/App.tsx`（send 携带 images）
- Modify: `src/shared/types.ts`（StartReplyPayload 已有 images；无需改）

**Interfaces:**
- Consumes: `desktopCapturer`（electron）、`StartReplyPayload.images`
- Produces: `capturePrimaryScreen(): Promise<string>`（返回 PNG dataURL；失败抛错，IPC 层转 `{ ok:false, error }`）

- [ ] **Step 1: 实现截屏模块**

`src/main/screenshot.ts`:
```ts
import { desktopCapturer, screen } from 'electron'

export async function capturePrimaryScreen(): Promise<string> {
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: primary.size.width, height: primary.size.height }
  })
  const source = sources.find(s => s.display_id === String(primary.id)) ?? sources[0]
  if (!source) throw new Error('未找到屏幕源')
  const image = source.thumbnail
  if (image.isEmpty()) throw new Error('截屏失败：图像为空')
  let dataUrl = image.toDataURL()
  if (dataUrl.length > 12_000_000) {
    const resized = image.resize({ width: 1920 })
    dataUrl = resized.toDataURL()
  }
  return dataUrl
}
```

- [ ] **Step 2: 注册 IPC**

`src/main/ipc.ts` 顶部 import `{ capturePrimaryScreen } from './screenshot'`，替换 `screen:capture` 占位:
```ts
  ipcMain.handle('screen:capture', async (): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => {
    try { return { ok: true, dataUrl: await capturePrimaryScreen() } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : '截屏失败' } }
  })
```

- [ ] **Step 3: Composer 加截屏按钮与预览**

`src/renderer/src/components/Composer.tsx` 替换为:
```tsx
import { useRef, useState } from 'react'

export function Composer(props: {
  streaming: boolean
  onSend(content: string, images: string[]): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [shotMsg, setShotMsg] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if ((!t && images.length === 0) || props.streaming) return
    props.onSend(t, images)
    setText(''); setImages([])
  }

  const capture = async (): Promise<void> => {
    setShotMsg('截屏中…')
    const r = await window.api.captureScreen()
    setShotMsg('')
    if (r.ok && r.dataUrl) setImages([...images, r.dataUrl])
    else setShotMsg(r.error ?? '截屏失败')
  }

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="shot-previews">
          {images.map((u, i) => (
            <div key={i} className="shot-preview">
              <img src={u} alt="待发送截图" />
              <button className="shot-remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
      />
      <div className="composer-actions">
        <span className="composer-hint">{shotMsg || 'Esc 收起窗口'}</span>
        <button className="shot-btn" onClick={() => void capture()} disabled={props.streaming}>截屏</button>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim() && images.length === 0} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
```

CSS 追加:
```css
.shot-previews { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.shot-preview { position: relative; }
.shot-preview img { max-width: 180px; max-height: 120px; border-radius: 8px; border: 1px solid var(--border); }
.shot-remove { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; border: 0; background: var(--danger); color: #fff; line-height: 1; }
.shot-btn { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 14px; font-size: 13px; }
.shot-btn:hover { border-color: var(--accent); }
```

- [ ] **Step 4: App 的 send 传递 images**

`src/renderer/src/App.tsx` 中 `send` 签名改为 `send(content: string, images: string[])`，`startReply` 调用体改为 `window.api.startReply({ conversationId: state.activeId, content, images })`；Composer 的 `onSend` 改传 `(content, images) => void send(content, images)`。`retry` 保持不变（已带 images）。

- [ ] **Step 5: 验证**

Run: `npm run typecheck && npx vitest run`
Expected: 通过。`npm run dev` 手动：点"截屏"→ 输入框出现屏幕缩略图 → 发送 → 回复正常（模型路由到视觉模型，可在回复消息的 `model` 字段/开发日志确认）；不填 Key 时截屏仍可用（预览阶段不依赖 Key）。

- [ ] **Step 6: 提交**

```bash
git add src/ && git commit -m "feat: 截屏发送（desktopCapturer + 预览 + 视觉模型路由）"
```

---

### Task 11: 桌宠联动助手脚本 pet-helper.ps1（最高风险，先独立冒烟）

> 本任务不写自动化测试（PowerShell 依赖真实窗口环境），以真实桌宠上的冒烟验证为准。**冒烟必须先于 Task 12 集成**，这是全项目最大风险点（spec 风险表第 1、2 行）。

**Files:**
- Create: `resources/pet-helper.ps1`

**Interfaces:**
- Consumes: 桌宠进程 `Bongo Cat Mver.exe`（名称可参数化）
- Produces:
  - 参数：`-ExeName "Bongo Cat Mver.exe"`（可选 `-Dir "路径"` 默认 `$env:TEMP\daniya-pet`）
  - 事件文件 `<Dir>/events.jsonl`（UTF-8 追加，每行 JSON）：`{type:'ready'}` / `{type:'pong'}` / `{type:'pet-click',x,y}` / `{type:'window',rect:{x,y,w,h}}` / `{type:'stopped'}`
  - 命令文件 `<Dir>/cmd.json`（Electron 写入，脚本读后删除）：`{cmd:'ping'}` / `{cmd:'keys',mods:[18],key:73}` / `{cmd:'shutdown'}`
  - 提权策略：检测桌宠进程是否管理员运行；若是且自身未提权 → VBS 弹一次 UAC 重启自身后退出

- [ ] **Step 1: 写脚本**

`resources/pet-helper.ps1`:
```powershell
param(
  [string]$ExeName = 'Bongo Cat Mver.exe',
  [string]$Dir = (Join-Path $env:TEMP 'daniya-pet')
)
$ErrorActionPreference = 'Stop'
$ProcName = $ExeName -replace '\.exe$', ''

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$EventsPath = Join-Path $Dir 'events.jsonl'
$CmdPath = Join-Path $Dir 'cmd.json'

function Append-Event($obj) {
  try { Add-Content -Path $EventsPath -Value ($obj | ConvertTo-Json -Compress) -Encoding UTF8 } catch { }
}

function Get-PetHwnd {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $p.Refresh(); return $p.MainWindowHandle }
  return [IntPtr]::Zero
}

# ---- Win32 互操作（钩子回调全部为纯 C#，不回调 PowerShell，避免 runspace 问题）----
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class PetHook {
  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);

  public static IntPtr TargetHwnd = IntPtr.Zero;
  public static string EventsPath = "";
  public static long LastClickTick = 0;

  public static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    try {
      if (nCode >= 0 && wParam == (IntPtr)0x0201 && TargetHwnd != IntPtr.Zero) {
        RECT r;
        if (GetWindowRect(TargetHwnd, out r)) {
          MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
          if (s.pt.x >= r.Left && s.pt.x < r.Right && s.pt.y >= r.Top && s.pt.y < r.Bottom) {
            long now = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
            if (now - LastClickTick > 800) {
              LastClickTick = now;
              File.AppendAllText(EventsPath, "{\"type\":\"pet-click\",\"x\":" + s.pt.x + ",\"y\":" + s.pt.y + "}\n");
            }
          }
        }
      }
    } catch { }
    return CallNextHookEx(hHook, nCode, wParam, lParam);
  }
  public static IntPtr hHook = IntPtr.Zero;
}
"@

# ---- 提权检测与自举 ----
$selfElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Test-PetElevated {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return $false }
  try {
    $h = [PetHook]::OpenProcess(0x0400, $false, $p.Id)
    if ($h -eq [IntPtr]::Zero) { return $false }
    $tok = [IntPtr]::Zero
    [PetHook]::OpenProcessToken($h, 0x0008, [ref]$tok) | Out-Null
    [PetHook]::CloseHandle($h)
    return ($tok -ne [IntPtr]::Zero)
  } catch { return $false }
}

if ((Test-PetElevated) -and -not $selfElevated) {
  $vbs = Join-Path $env:TEMP 'daniya-pet-elevate.vbs'
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -ExeName `"$ExeName`" -Dir `"$Dir`""
  $vbsContent = "Set UAC = CreateObject(`"Shell.Application`")`nUAC.ShellExecute `"powershell.exe`", `"$argLine`", `"`", `"runas`", 0"
  Set-Content -Path $vbs -Value $vbsContent -Encoding Default
  & wscript.exe $vbs
  Remove-Item $vbs -ErrorAction SilentlyContinue
  exit 0
}

# ---- 初始化 C# 钩子状态 ----
[PetHook]::EventsPath = $EventsPath
[PetHook]::LastClickTick = 0

Add-Type -AssemblyName System.Windows.Forms
$delegate = [PetHook+HookProc][PetHook]::MouseCallback   # 保持引用，防 GC
$hook = [PetHook]::SetWindowsHookEx(14, $delegate, [IntPtr]::Zero, 0)
if ($hook -eq [IntPtr]::Zero) { Append-Event @{ type='error'; error='hook install failed' }; exit 1 }
[PetHook]::hHook = $hook

function Send-PetKeys([int[]]$Mods, [int]$Key) {
  $hwnd = Get-PetHwnd
  if ($hwnd -eq [IntPtr]::Zero) { return }
  [PetHook]::ShowWindow($hwnd, 5) | Out-Null          # SW_SHOW
  [PetHook]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 100
  foreach ($m in $Mods) { [PetHook]::keybd_event($m, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 50
  [PetHook]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [PetHook]::keybd_event($Key, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  foreach ($m in $Mods) { [PetHook]::keybd_event($m, 0, 2, [UIntPtr]::Zero) }
}

$lastHwnd = [IntPtr]::Zero

# 定时器1：每 2 秒刷新桌宠窗口句柄并向主进程报告
$t1 = New-Object System.Windows.Forms.Timer
$t1.Interval = 2000
$t1.Add_Tick({
  $hwnd = Get-PetHwnd
  if ($hwnd -ne [PetHook]::TargetHwnd) {
    [PetHook]::TargetHwnd = $hwnd
    if ($hwnd -ne [IntPtr]::Zero) {
      $r = New-Object PetHook+RECT
      if ([PetHook]::GetWindowRect($hwnd, [ref]$r)) {
        Append-Event @{ type='window'; rect=@{ x=$r.Left; y=$r.Top; w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) } }
      }
    } else {
      Append-Event @{ type='window'; gone=$true }
    }
  }
})

# 定时器2：每 100ms 轮询命令文件（避免管道线程问题）
$t2 = New-Object System.Windows.Forms.Timer
$t2.Interval = 100
$t2.Add_Tick({
  try {
    if (Test-Path $CmdPath) {
      $cmd = Get-Content $CmdPath -Raw -Encoding UTF8 | ConvertFrom-Json
      Remove-Item $CmdPath -Force -ErrorAction SilentlyContinue
      switch ($cmd.cmd) {
        'ping'   { Append-Event @{ type='pong' } }
        'keys'   { Send-PetKeys @($cmd.mods) ([int]$cmd.key) }
        'shutdown' {
          Append-Event @{ type='stopped' }
          [PetHook]::UnhookWindowsHookEx($hook) | Out-Null
          $t1.Stop(); $t2.Stop()
          [System.Windows.Forms.Application]::Exit()
        }
      }
    }
  } catch { }
})

$t1.Start(); $t2.Start()
Append-Event @{ type='ready' }
[System.Windows.Forms.Application]::Run()
```

- [ ] **Step 2: 冒烟验证 A —— 启动桌宠后运行助手**

Run（先以普通方式启动桌宠，例如双击 `E:\迅雷下载\达妮娅-带表情版\A-达妮娅\Bongo Cat Mver.exe`）:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File resources/pet-helper.ps1 -ExeName "Bongo Cat Mver.exe"
```
Expected: 无报错；`%TEMP%\daniya-pet\events.jsonl` 出现 `{"type":"ready"}`，随后出现 `{"type":"window",...}`（rect 与桌宠窗口位置一致）。**若桌宠经 CatC.bat（管理员）启动，此步会弹一次 UAC，接受后同样出现上述事件。**

- [ ] **Step 3: 冒烟验证 B —— 发送表情按键**

Run（另开终端，写命令文件）:
```bash
mkdir -p "$TEMP/daniya-pet" && printf '{"cmd":"keys","mods":[18],"key":73}' > "$TEMP/daniya-pet/cmd.json"
```
Expected: 桌宠出现**彩虹脸**（Alt+I）。再验证哭泣脸（key=79）、黑化（key=49）、泡泡（key=48）、默认（key=68）各一次；**桌宠全程不崩溃**。若表情无反应：先手动对桌宠窗口按 Alt+I 确认表情本身可用；若手动有效而脚本无效，检查桌宠是否以管理员运行、助手是否已提权（该情况属于脚本提权分支未生效，修复 VBS 自举段）。

- [ ] **Step 4: 冒烟验证 C —— 点击检测**

Expected: 单击桌宠窗口内任意位置，`events.jsonl` 追加 `{"type":"pet-click","x":..,"y":..}`（800ms 去抖，连点只记一次）；点击桌宠窗口外不产生事件。注意：桌宠 1000x1000 的透明窗口区域很大，点击"桌宠附近空白"也算命中——这是预期行为（矩形判定）。

- [ ] **Step 5: 冒烟验证 D —— shutdown 与退出**

Run: `printf '{"cmd":"shutdown"}' > "$TEMP/daniya-pet/cmd.json"`
Expected: events.jsonl 出现 `{"type":"stopped"}`，powershell 进程退出，桌宠不受任何影响。

- [ ] **Step 6: 提交**

```bash
git add resources/pet-helper.ps1 && git commit -m "feat: 桌宠联动助手 pet-helper.ps1（全局鼠标钩子+Alt按键+提权自举，冒烟通过）"
```

---

### Task 12: 主进程桌宠集成（PipePet 协调器 + 点击弹窗 + 托盘 + 窗口定位）

**Files:**
- Create: `src/main/pet/pipe-pet.ts`（真实 PetCoordinator）
- Create: `scripts/gen-icon.js`（生成 resources/icon.png，纯 Node PNG 写入）
- Test: `scripts/gen-icon.test.ts`（PNG 结构校验）
- Modify: `src/main/index.ts`（托盘、显示/隐藏逻辑、窗口定位、按设置启用协调器）
- Modify: `package.json`（gen-icon 脚本）

**Interfaces:**
- Consumes: `PetCoordinator` 接口（Task 7）、`pet-helper.ps1`（Task 11）、settings
- Produces: `createPipePet(opts: { exeName: string; helperPath: string }): PetCoordinator`；主进程行为：点击桌宠 → 窗口可见则隐藏、隐藏则显示并定位到桌宠旁；托盘图标（单击切换显示，右键菜单：显示/隐藏、退出）；`helperScriptPath()` 工具（dev 用 `resources/`，打包后用 `process.resourcesPath`）

- [ ] **Step 1: 写图标生成脚本与测试**

`scripts/gen-icon.js`:
```js
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const W = 256, H = 256
function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([t, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const px = Buffer.alloc(W * H * 4)
const R = 56
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const inSquare = x >= 6 && x < W - 6 && y >= 6 && y < H - 6
    const cx = x < 6 + R ? 6 + R : x > W - 6 - R ? W - 6 - R : x
    const cy = y < 6 + R ? 6 + R : y > H - 6 - R ? H - 6 - R : y
    const dx = x - cx, dy = y - cy
    const inside = inSquare && (dx * dx + dy * dy <= R * R || (x >= 6 + R && x < W - 6 - R) || (y >= 6 + R && y < H - 6 - R))
    if (!inside) continue
    px[i] = 139; px[i + 1] = 92; px[i + 2] = 246; px[i + 3] = 255
    // 白色对话气泡三点（聊天符号）
    for (const [bx, by] of [[88, 118], [128, 118], [168, 118]]) {
      const ddx = x - bx, ddy = y - by
      if (ddx * ddx + ddy * ddy <= 18 * 18) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255 }
    }
    // 尾巴
    if (x >= 100 && x <= 156 && y >= 142 && y <= 152 && x - 100 <= (152 - y) * 2.5 && x - 100 >= (152 - y) * 1.2) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255 }
  }
}

const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4) }
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
])
const out = path.join(__dirname, '..', 'resources', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('icon.png written:', png.length, 'bytes ->', out)
```

`scripts/gen-icon.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

describe('gen-icon', () => {
  it('生成合法 256x256 PNG（签名/IHDR/IDAT 可解压）', () => {
    const script = path.join(__dirname, 'gen-icon.js')
    execFileSync(process.execPath, [script])
    const file = path.join(__dirname, '..', 'resources', 'icon.png')
    const buf = fs.readFileSync(file)
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    expect(buf.readUInt32BE(16)).toBe(256)
    expect(buf.readUInt32BE(20)).toBe(256)
    const idat = buf.subarray(41, buf.length - 12)
    const inflated = zlib.inflateSync(idat)
    expect(inflated.length).toBe(256 * (256 * 4 + 1))
    const r = inflated[1 + 128 * (256 * 4 + 1) + 128 * 4]
    const g = inflated[1 + 128 * (256 * 4 + 1) + 128 * 4 + 1]
    expect([r, g]).toEqual([139, 92])   // 中心像素为紫色圆角方块
  })
})
```

`package.json` scripts 增加: `"gen-icon": "node scripts/gen-icon.js"`。

- [ ] **Step 2: 运行图标测试确认失败后实现（脚本先写后测亦可）**

Run: `npx vitest run scripts/gen-icon.test.ts`
Expected: 通过（生成 icon.png 并校验结构）。

- [ ] **Step 3: 实现 PipePet 协调器**

`src/main/pet/pipe-pet.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Emotion } from '../deepseek/emotion'
import type { PetStatus } from '../../shared/types'
import type { PetCoordinator } from './coordinator'
import { comboFor } from './keys'

interface Rect { x: number; y: number; w: number; h: number }
type PetEvent =
  | { type: 'ready' } | { type: 'pong' } | { type: 'stopped' }
  | { type: 'pet-click'; x: number; y: number }
  | { type: 'window'; rect?: Rect; gone?: boolean }

export interface PipePetOpts { exeName: string; helperPath: string }

export function createPipePet(opts: PipePetOpts): PetCoordinator {
  const dir = path.join(os.tmpdir(), 'daniya-pet')
  const eventsPath = path.join(dir, 'events.jsonl')
  const cmdPath = path.join(dir, 'cmd.json')
  fs.mkdirSync(dir, { recursive: true })

  let child: ChildProcess | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let connected = false
  let lastPong = 0
  let helperStartAt = 0
  let restarts = 0
  let stopped = false
  let windowRect: Rect | null = null
  let petWindowFound = false
  let lastEmotion: Emotion | null = null
  let lastSent: string | null = null
  const clickHandlers = new Set<() => void>()
  const windowHandlers = new Set<(r: Rect | null) => void>()

  function appendEvent(e: PetEvent): void {
    if (e.type === 'ready' || e.type === 'pong') { connected = true; lastPong = Date.now() }
    if (e.type === 'stopped') { connected = false; petWindowFound = false }
    if (e.type === 'pet-click') clickHandlers.forEach(cb => cb())
    if (e.type === 'window') { petWindowFound = !e.gone; windowRect = e.rect ?? null; windowHandlers.forEach(cb => cb(windowRect)) }
  }

  function startHelper(): void {
    if (stopped) return
    if (child) { try { child.kill() } catch { /* 已退出 */ } child = null }
    try { fs.writeFileSync(eventsPath, '') } catch { /* 目录不存在时忽略 */ }
    offset = 0
    helperStartAt = Date.now()
    child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', opts.helperPath, '-ExeName', opts.exeName
    ], { windowsHide: true, stdio: 'ignore' })
    child.on('exit', () => { child = null; connected = false; if (!stopped && restarts < 3) { restarts++; startHelper() } })
  }

  function sendCmd(cmd: Record<string, unknown>): void {
    try {
      const tmp = cmdPath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cmd))
      fs.renameSync(tmp, cmdPath)
    } catch { /* 助手未运行时静默 */ }
  }

  let mapping: Record<string, string> = {}

  function sendCombo(name: string): void {
    const combo = comboFor(mapping, name)
    if (combo) sendCmd({ cmd: 'keys', mods: combo.mods, key: combo.key })
  }

  const coordinator: PetCoordinator = {
    start(): void {
      stopped = false
      startHelper()
      pollTimer = setInterval(() => {
        try {
          const size = fs.statSync(eventsPath).size
          if (size < offset) offset = 0
          if (size > offset) {
            const fd = fs.openSync(eventsPath, 'r')
            const buf = Buffer.alloc(size - offset)
            fs.readSync(fd, buf, 0, buf.length, offset)
            fs.closeSync(fd)
            offset = size
            for (const line of buf.toString('utf8').split('\n')) {
              if (!line.trim()) continue
              try { appendEvent(JSON.parse(line) as PetEvent) } catch { /* 半行或坏行忽略 */ }
            }
          }
        } catch { /* 事件文件暂不存在 */ }
      }, 300)
      heartbeat = setInterval(() => {
        if ((!connected && Date.now() - helperStartAt > 15000) || (connected && Date.now() - lastPong > 15000)) {
          restarts = 0
          startHelper()
        } else {
          sendCmd({ cmd: 'ping' })
        }
      }, 5000)
    },
    stop(): void {
      stopped = true
      sendCmd({ cmd: 'shutdown' })
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeat) clearInterval(heartbeat)
      if (child) { try { child.kill() } catch { /* 已退出 */ } child = null }
    },
    onPetClick(cb: () => void): void { clickHandlers.add(cb) },
    bubble(on: boolean): void { sendCombo(on ? 'bubble_on' : 'bubble_off') },
    emotion(e: Emotion | null): void {
      if (e === null) {
        if (lastSent !== null && lastSent !== 'default') { sendCombo('default'); lastSent = 'default' }
        lastEmotion = null
        return
      }
      if (e === lastEmotion) return
      if (lastEmotion !== null && lastEmotion !== e) sendCombo(lastEmotion)   // 先关旧表情（开关式切换）
      sendCombo(e)
      lastEmotion = e
      lastSent = e
    },
    status(): PetStatus { return { helperRunning: !!child, connected, petWindowFound } }
  }

  // mapping 注入（供 index.ts 在设置变化时更新）
  ;(coordinator as PetCoordinator & { setMapping(m: Record<string, string>): void }).setMapping = (m: Record<string, string>) => { mapping = m }
  ;(coordinator as PetCoordinator & { getWindowRect(): Rect | null }).getWindowRect = () => windowRect
  ;(coordinator as PetCoordinator & { onWindow(cb: (r: Rect | null) => void): void }).onWindow = (cb) => { windowHandlers.add(cb) }

  return coordinator
}
```

- [ ] **Step 4: 主进程接入托盘与显示/隐藏**

`src/main/index.ts` 替换为:
```ts
import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron'
import path from 'node:path'
import { Store } from './storage/store'
import { registerIpc } from './ipc'
import { loadSettings, getApiKey, type AppSettings } from './settings'
import { createNullPet, type PetCoordinator } from './pet/coordinator'
import { createPipePet } from './pet/pipe-pet'
import type { DeepSeekConfig } from './deepseek/client'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let pet: PetCoordinator = createNullPet()

function helperScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'pet-helper.ps1')
    : path.join(__dirname, '../../resources/pet-helper.ps1')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 960, height: 640, minWidth: 860, minHeight: 600,
    autoHideMenuBar: true, title: '达妮娅聊天', show: false,
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide() } })
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function showNearPet(): void {
  if (!win) return
  const petRect = (pet as PetCoordinator & { getWindowRect(): { x: number; y: number; w: number; h: number } | null }).getWindowRect?.()
  const display = screen.getDisplayMatching(petRect ?? { x: 0, y: 0, width: 1, height: 1 })
  const area = display.workArea
  const [w, h] = win.getSize()
  let x: number, y: number
  if (petRect) {
    x = Math.min(petRect.x, area.x + area.width - w - 12)
    x = Math.max(x, area.x + 12)
    y = Math.max(area.y + 12, Math.min(petRect.y + petRect.h - h, area.y + area.height - h - 12))
    if (x + w > petRect.x + 40) x = Math.max(area.x + 12, petRect.x - w - 16)   // 放不下时放桌宠左侧
  } else {
    x = area.x + Math.round((area.width - w) / 2)
    y = area.y + Math.round((area.height - h) / 2)
  }
  win.setPosition(x, y)
}

function toggleWindow(): void {
  if (!win) return
  if (win.isVisible() && win.isFocused()) { win.hide() }
  else { showNearPet(); win.show(); win.focus() }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../resources/icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('达妮娅聊天')
  tray.on('click', toggleWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏', click: toggleWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
}

function applyPetSettings(s: AppSettings): void {
  pet.stop()
  pet = s.pet.enabled ? createPipePet({ exeName: s.pet.exeName, helperPath: helperScriptPath() }) : createNullPet()
  const ext = pet as PetCoordinator & { setMapping(m: Record<string, string>): void }
  ext.setMapping?.(s.emotionKeys)
  pet.onPetClick(toggleWindow)
  pet.start()
}

function getConfig(s: AppSettings): DeepSeekConfig | null {
  const apiKey = getApiKey(s)
  if (!apiKey) return null
  return { apiKey, baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, systemPrompt: s.systemPrompt }
}

app.whenReady().then(() => {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json')
  const store = new Store(app.getPath('userData'))
  registerIpc({ store, settingsFile, pet: () => pet, getConfig, onSettingsChanged: applyPetSettings })
  createWindow()
  createTray()
  applyPetSettings(loadSettings(settingsFile))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

说明：`registerIpc` 接收的 `pet: () => pet` 是 getter（Task 7 已定型），`applyPetSettings` 重赋值模块级 `pet` 变量后，IPC 内调用自动指向最新实例，无需 Proxy。

- [ ] **Step 5: 验证**

Run: `npm run typecheck && npx vitest run`
Expected: 通过。`npm run dev` 手动：桌面右下角托盘出现图标；点击桌宠 → 聊天窗在桌宠旁弹出；再点桌宠/托盘/窗口内 Esc → 收起；托盘右键"退出"正常退出；任务管理器确认退出后无残留 powershell 子进程（helper 已 shutdown）。

- [ ] **Step 6: 提交**

```bash
git add src/main/pet/pipe-pet.ts src/main/index.ts scripts/ package.json && git commit -m "feat: 桌宠联动集成（点击弹窗/托盘/窗口定位/协调器生命周期）"
```

---

### Task 13: 情绪联动打通 + 桌宠状态暴露

**Files:**
- Modify: `src/main/ipc.ts`（pet 参数改为 getter 形态；chat:startReply 中已调用 pet.bubble/emotion —— 核对与 Task 7 代码一致）
- Modify: `src/main/pet/keys.ts`（无改动，Task 9 已含 comboFor）
- Test: `src/main/pet/keys.test.ts`（comboFor 映射与非法输入）

**Interfaces:**
- Consumes: `comboFor`（Task 9）、`PetCoordinator.bubble/emotion`（Task 7/12）
- Produces: 端到端情绪链路：回复开始→泡泡；流中情绪→表情（含开关式切换策略）；结束无情绪→默认表情；设置页保存后 mapping 实时生效

- [ ] **Step 1: 写 keys 单元测试（先失败）**

`src/main/pet/keys.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { comboFor, DEFAULT_EMOTION_KEYS } from './keys'

describe('comboFor', () => {
  it('happy 映射为 Alt+I（VK 73）', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'happy')).toEqual({ mods: [18], key: 73 })
  })
  it('bubble_on 映射为 Alt+0（VK 48）', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'bubble_on')).toEqual({ mods: [18], key: 48 })
  })
  it('小写字母键也能识别', () => {
    expect(comboFor({ happy: 'i' }, 'happy')).toEqual({ mods: [18], key: 73 })
  })
  it('未知情绪名返回 null', () => {
    expect(comboFor(DEFAULT_EMOTION_KEYS, 'banana')).toBeNull()
  })
  it('非法键字符返回 null', () => {
    expect(comboFor({ happy: '啊' }, 'happy')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/pet/keys.test.ts`
Expected: FAIL —— `keys.ts` 尚无 `comboFor`（若 Task 9 已实现则此测试直接 PASS，属正常）。

- [ ] **Step 3: 核对 IPC 情绪链路**

核对 `src/main/ipc.ts`（Task 7 已按最终形态写好，含 getter 与情绪调用）满足以下序列，缺则补：
- `chat:startReply` 成功路径第一句 `pet().bubble(true)`（在 async IIFE 之前）
- 流事件 `emotion` → `pet().emotion(emotion)` 在 `send({type:'emotion'})` 之前调用
- `finally` 中 `pet().bubble(false)`
- 正常 done 分支（未 abort）之前：若 `emotion === null` → `pet().emotion(null)`（触发默认表情，仅当此前发过表情时才有实际按键，见 pipe-pet 逻辑）
- `registerIpc` 的 `pet: () => PetCoordinator` getter 形态（Task 7 已定型），`src/main/index.ts` 传入 `pet: () => pet`

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npx vitest run`
Expected: 全绿。`npm run dev` 手动（需真实 Key + 桌宠运行）：
- 发消息"讲个笑话" → 等待期间桌宠出现泡泡，回复出现后泡泡消失
- 发消息"我今天好难过" → 回复时桌宠出现哭泣脸
- 发消息"好开心" → 彩虹脸；再发"好开心" → 表情保持（不重复触发）
- 设置页把 happy 改为 O 并保存 → 发"好开心" → 哭泣脸出现（映射实时生效）
- 关闭联动开关并保存 → 桌宠无任何表情响应，聊天正常

- [ ] **Step 5: 提交**

```bash
git add src/ && git commit -m "feat: 情绪联动打通（泡泡/表情开关策略/实时映射）"
```

---

### Task 14: 端到端手动验证清单

**Files:** 无代码改动（仅验证；发现问题按 systematic-debugging 处理并修复）

**Interfaces:** 无新增

- [ ] **Step 1: 基础聊天全流程（真实 Key）**

1. 全新用户数据启动（`npm run dev`）→ 设置页按指引填写真实 DeepSeek Key → 测试连接成功
2. 新建对话 → 发送"你好" → 流式逐字回复、Markdown 正常（让 AI 输出表格/代码块验证高亮与复制按钮）
3. 停止按钮：发一条长问题 → 中途点"停止" → 已显示部分保留为一条消息
4. 多会话：新建 3 个会话分别聊天 → 切换正常、标题自动取首句、重命名/删除正常
5. 搜索：输入关键词 → 命中列表 → 点击跳转到对应会话
6. 重启应用 → 会话与历史完整（存储持久化）、Key 仍有效（safeStorage）
7. 错误路径：设置里改成错误 Key → 发消息 → 红色错误条与"重试"；改回正确 Key → 重试成功

- [ ] **Step 2: 截屏 + 视觉模型**

1. 点"截屏" → 预览出现 → 可移除 → 附文字"看看我屏幕上有什么"发送
2. 回复正常且能描述屏幕内容（视觉模型生效）；该会话后续纯文字消息仍走视觉模型（历史含图）
3. 新建纯文字会话 → 回复消息不带图且走文本模型（可在开发日志或消息 model 字段核对）

- [ ] **Step 3: 桌宠联动（真实桌宠）**

1. 启动桌宠（CatC.bat 或直接 exe，两种启动方式各测一遍）→ 启动聊天应用 → 接受一次 UAC（若桌宠为管理员）
2. 点击桌宠 → 聊天框在桌宠旁弹出；再点 → 收起；Esc → 收起；托盘点击 → 切换
3. 情绪全映射抽查：happy/sad/sleepy/dismissive/angry 各触发一次，桌宠表情正确切换
4. **桌宠稳定性**：连续 20 条消息 + 反复点击桌宠 + 关闭应用再开，桌宠全程不崩溃、不闪退、表情功能仍可用
5. 联动关闭开关 → 全部联动静默，聊天正常；重新打开 → 恢复

- [ ] **Step 4: 异常降级**

1. 不启动桌宠直接聊天 → 一切正常，仅无表情
2. 杀掉 powershell 助手进程 → 聊天正常；15 秒内助手自动重启（最多 3 次）
3. 桌面环境多显示器（如有）：桌宠在主屏/副屏各测一次弹窗位置

- [ ] **Step 5: 记录结果并提交（如有修复）**

修复过程中每次改动遵循 TDD（纯逻辑部分补测试）；全部通过后:
```bash
git add -A && git commit -m "fix: 端到端验证中发现的问题修复" # 仅当有修复时
```

---

### Task 15: 打包 Windows 安装包（electron-builder）

**Files:**
- Modify: `package.json`（build 配置 + pack 脚本）
- Create: `resources/README-打包说明.md`？—— 不需要，说明写在任务内

**Interfaces:**
- Consumes: Task 1-14 全部产物
- Produces: `dist/达妮娅聊天 Setup *.exe`（NSIS 安装包），安装后可从开始菜单/桌面启动，含 pet-helper.ps1（extraResources）

- [ ] **Step 1: 配置打包**

`package.json` 增加:
```json
  "scripts": {
    "pack": "npm run build && electron-builder --win"
  },
  "build": {
    "appId": "com.daniya.chat",
    "productName": "达妮娅聊天",
    "directories": { "output": "dist" },
    "files": ["out/**", "resources/**", "package.json"],
    "extraResources": [{ "from": "resources/pet-helper.ps1", "to": "pet-helper.ps1" }],
    "win": { "target": ["nsis"], "icon": "resources/icon.png" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "shortcutName": "达妮娅聊天" }
  }
```
Run: `npm install -D electron-builder`
（下载 winCodeSign/nsis 失败时：`export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 重试）

- [ ] **Step 2: 打包**

Run: `npm run pack`
Expected: `dist/` 下生成 NSIS 安装包。

- [ ] **Step 3: 安装验证**

1. 运行安装包安装到默认目录 → 桌面/开始菜单出现"达妮娅聊天"快捷方式（图标为紫色方块）
2. 启动 → 填写 Key → 聊天/截屏正常
3. 桌宠联动：点击桌宠弹出窗口正常；`pet-helper.ps1` 从 `process.resourcesPath` 加载正常（打包路径分支）
4. 卸载功能正常（控制面板）

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json && git commit -m "build: electron-builder NSIS 打包配置"
```

---

## 自审记录

- **Spec 覆盖**：spec 第 3 节架构（Task 1/7/12）、第 4 节 DeepSeek 集成与情绪标记（Task 3/4/5/6/9/13）、第 5 节界面功能（Task 8/9/10）、第 6 节存储（Task 2）、第 7 节错误处理（Task 6/7/8/14）、第 8 节测试策略（各任务 vitest + Task 11/14 手动）、第 10 节风险表（Task 11 提前冒烟 ✓、提权 ✓、模型可配置 ✓、情绪解析失败降级 ✓）、M1-M5 里程碑（Task 1-8 / 9 / 10 / 11-13 / 15 + Task 14 验证）。
- **占位符扫描**：Task 7 的 `settings:setApiKey`/`screen:capture` throw 是**计划内的阶段性占位**（该任务交付物不含这两个功能，占位保证 IPC 注册完整不崩溃），分别由 Task 9/10 替换，已在代码块下方标注；其余任务无 TBD/待补。
- **类型一致性**：`PetCoordinator` 接口 Task 7 定义 → Task 12 实现签名一致（bubble/emotion/onPetClick/status/start/stop）；`registerIpc` 的 `pet: () => PetCoordinator` getter 形态在 Task 7 定型，Task 12 传入 `() => pet` 支持实例热替换，Task 13 无需再改签名；`chatStore` 的 `appendUser`/`startStream`/`streamEvent` 动作与 Task 8 App 调用点一一对应；`ConversationList` 的 `onSearchInput`/`onSearch` 双 prop 与 App 传参一致；`StreamEventMsg`/`ChatMessage` 等自 `src/shared/types.ts` 单点定义；`AppSettingsView`（渲染层可见）与 `AppSettings`（主进程含密文）分离，Task 9 的 `applyView` 保证渲染层无法写入密文字段；pipe-pet 的 `mapping` 声明在 `sendCombo` 之前、`helperStartAt` 参与心跳判断，无使用前未声明。
