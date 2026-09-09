# 达妮娅联网搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在 Composer 勾选「联网搜索」后，主进程先调博查（Bocha）搜用户原文，结果拼成 `[搜索: <query>]` 块注入末轮 user 消息，达妮娅的回答基于实时网页信息。

**Architecture:** 渲染层只持一个布尔开关与徽章状态标记；搜索全程在主进程（照 Task 16 文件注入铁律：内容一律主进程处理）。发送时 startReply 载荷带 `search: true`，主进程 getSearchKey 解密博查 Key → fetch 博查 Web Search API（10s 超时）→ 失败降级（user 气泡徽章显示中文原因、照常回答）→ 成功把前 5 条（总预算 4096 字符）拼块追加到 history 末轮 user 消息（与 `injectFilesIntoLastTurn` 同构）。

**Tech Stack:** Electron 44 + electron-vite 5 + React 19 + TypeScript + vitest 4（无新依赖；博查走内置 fetch）。

**Spec:** docs/superpowers/specs/2026-09-09-web-search-design.md

## Global Constraints

- 既有 167 个测试必须保持绿；`npm run typecheck` 绿；新增测试 TDD（RED 留证据再 GREEN）。
- 博查 API：POST `https://api.bocha.cn/v1/web-search`，`Authorization: Bearer <key>`，body `{ query, count: 5 }`，`AbortSignal.timeout(10_000)`。查询词截 200 字符；title 截 120；snippet 截 300；总预算 4096 字符逐条累加、超预算即停。
- **搜索永不阻断聊天**：无 Key/Key 无效/额度不足/网络/超时/畸形响应 → 降级普通回答 + user 徽章「搜索失败：<中文原因>」。错误映射：401/403→`Key 无效`；429/402→`额度不足`；网络/超时→`网络错误`；其他（含 code 非 0）→`搜索服务错误`；无 Key→`未配置`。
- **渲染层永不见搜索结果内容与 Key 密文**：toView 只给 `search: { hasKey, enabledDefault }`；徽章文本是主进程映射的中文原因。
- **Key 纪律**：博查 Key 只经 safeStorage（DPAPI）密文存 settings；任何代码/报告/台账不得出现明文 Key。实现时可用真实 Key curl 校准响应字段，但明文 Key 不得写入任何文件。
- 搜索在 userMessage 落库**之前**完成（`searched`/`searchError` 随消息入库）；retry 时重搜（R26 同法）。
- 中文 UI 文案；沿用现有视觉（深色 #17151f / 紫 #8b5cf6）。
- I2 纪律：settings.search 不参与 pet 比较，不得触发桌宠协调器重建。
- git 提交必须 `-c user.name="lenovo" -c user.email="lenovo@local"`；不要 npm install；实现者禁派子代理。

---

## 文件结构

| 文件 | 任务 | 职责 |
|---|---|---|
| Create: `src/main/search/bocha.ts` | 17 | searchBocha（fetch/超时/错误映射/裁剪预算）、buildSearchContext、SearchResult |
| Create: `src/main/search/bocha.test.ts` | 17 | fetch mock 测试（成功/裁剪/预算/错误映射/畸形/无结果/格式） |
| Modify: `src/main/settings.ts` | 17 | search 字段、setSearchKey/getSearchKey、bocha-key.enc 懒迁移、toView/applyView |
| Modify: `src/main/settings.test.ts` | 17 | 新字段合并/迁移/Key 往返/白名单测试 |
| Modify: `src/shared/types.ts` | 17 | StartReplyPayload.search、ChatMessage.searched/searchError、AppSettingsView.search |
| Modify: `src/shared/api.ts` / `src/preload/index.ts` | 17 | setSearchKey 通道 |
| Modify: `src/main/ipc.ts` | 17 | startReply 搜索接线 + settings:setSearchKey handler |
| Modify: `src/renderer/src/state/chatStore.ts`+test | 17 | RetryPayload.search |
| Modify: `src/renderer/src/App.tsx` | 17 | search 载荷透传、searchDefault 初值 |
| Modify: `src/renderer/src/components/Composer.tsx` | 17 | 联网搜索开关 |
| Modify: `src/renderer/src/components/Message.tsx` | 17 | user 气泡搜索徽章 |
| Modify: `src/renderer/src/components/SettingsPage.tsx` | 17 | 搜索区（Key 输入 + 默认开关） |
| Modify: `src/renderer/src/styles.css` | 17 | 开关激活态/徽章样式 |

---

## Task 17: 联网搜索

**Files:**
- Create: `src/main/search/bocha.ts`、`src/main/search/bocha.test.ts`
- Modify: `src/main/settings.ts`、`src/main/settings.test.ts`、`src/shared/types.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/renderer/src/state/chatStore.ts`、`src/renderer/src/state/chatStore.test.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/components/Composer.tsx`、`src/renderer/src/components/Message.tsx`、`src/renderer/src/components/SettingsPage.tsx`、`src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `AppSettings`/`AppSettingsView` 结构（settings.ts）；`injectFilesIntoLastTurn(turns, files)` 注入模式（files/attach.ts）；`StartReplyPayload`/`ChatMessage`（shared/types）；`RetryPayload`（chatStore）；`getConfig(s): DeepSeekConfig | null`（ipc 既有）。
- Produces: `searchBocha(query, apiKey): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }>`；`buildSearchContext(query, results): string`；`SearchResult = { title: string; snippet: string; url: string }`；`setSearchKey(file, key)`/`getSearchKey(s)`（settings）；IPC `settings:setSearchKey`。

### Step 1: types + settings（TDD）

- [ ] **1.1 修改 `src/shared/types.ts`**：

1. `ChatMessage` 的 `files?: FileAttachment[]` 之后加：

```ts
  /** 该轮是否勾选了联网搜索；搜索失败原因（主进程映射的中文） */
  searched?: boolean
  searchError?: string
```

2. `StartReplyPayload` 的 `files?: FileAttachment[]` 之后加：

```ts
  search?: boolean
```

3. `AppSettingsView` 的 `file: { workDir: string; autoApply: boolean }` 之后加：

```ts
  search: { hasKey: boolean; enabledDefault: boolean }
```

- [ ] **1.2 修改 `src/main/settings.ts`**：

1. import 增加 `import path from 'node:path'`（文件顶部，`fs` import 之后）。
2. `AppSettings` 接口加：

```ts
  search: { apiKeyEncrypted: string | null; enabledDefault: boolean }
```

3. `DEFAULT_SETTINGS` 加（`file` 行之后）：

```ts
  search: { apiKeyEncrypted: null, enabledDefault: false }
```

4. `loadSettings` 改为（合并加 search 子对象 + 懒迁移）：

```ts
export function loadSettings(file: string): AppSettings {
  let s: AppSettings = { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    s = { ...DEFAULT_SETTINGS, ...raw, pet: { ...DEFAULT_SETTINGS.pet, ...(raw.pet ?? {}) }, emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(raw.emotionKeys ?? {}) }, file: { ...DEFAULT_SETTINGS.file, ...(raw.file ?? {}) }, search: { ...DEFAULT_SETTINGS.search, ...(raw.search ?? {}) } }
  } catch { /* 损坏回退默认 */ }
  migrateBochaKey(file, s)
  return s
}

/** 一次性懒迁移：settings 无 search 密文且同目录 bocha-key.enc 存在 → 迁入并删除（迁移失败静默跳过） */
function migrateBochaKey(file: string, s: AppSettings): void {
  if (s.search.apiKeyEncrypted) return
  const encFile = path.join(path.dirname(file), 'bocha-key.enc')
  try {
    if (!fs.existsSync(encFile)) return
    const enc = fs.readFileSync(encFile, 'utf8').trim()
    if (!enc) return
    s.search.apiKeyEncrypted = enc
    saveSettings(file, s)
    fs.rmSync(encFile)
  } catch { /* 迁移失败不阻断加载 */ }
}
```

5. `toView` 返回值加一行（`file: { ...s.file },` 之后）：

```ts
    search: { hasKey: !!s.search.apiKeyEncrypted, enabledDefault: s.search.enabledDefault },
```

6. `setApiKey`/`getApiKey` 之后加（逐字同构）：

```ts
export function setSearchKey(file: string, key: string): AppSettings {
  const s = loadSettings(file)
  s.search.apiKeyEncrypted = key ? safeStorage.encryptString(key).toString('base64') : null
  saveSettings(file, s)
  return s
}

export function getSearchKey(s: AppSettings): string | null {
  if (!s.search.apiKeyEncrypted) return null
  try { return safeStorage.decryptString(Buffer.from(s.search.apiKeyEncrypted, 'base64')) }
  catch { return null }
}
```

7. `applyView` 返回值加（`file: {...}` 块之后）：

```ts
    search: {
      enabledDefault: typeof v.search?.enabledDefault === 'boolean' ? v.search.enabledDefault : cur.search.enabledDefault
    },
```

- [ ] **1.3 修改 `src/main/settings.test.ts`**：

1. import 行增加 `setSearchKey, getSearchKey`（从 './settings'）与 `vi`（从 'vitest'）。
2. 文件顶部（import 之后）加 safeStorage mock：

```ts
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))
```

3. 既有用例「旧版本缺少字段时按默认补齐（含 pet/emotionKeys 子对象）」内加一行断言（`expect(s.file)` 行之后）：

```ts
    expect(s.search).toEqual(DEFAULT_SETTINGS.search)
```

4. 文件末尾追加新用例（`applyView` describe 之后另开 `describe('search', ...)`）：

```ts
describe('search', () => {
  it('search 子对象合并：旧存档缺 search 字段按默认，部分字段按默认补齐', () => {
    fs.writeFileSync(file, JSON.stringify({ search: { enabledDefault: true } }))
    const s = loadSettings(file)
    expect(s.search.enabledDefault).toBe(true)
    expect(s.search.apiKeyEncrypted).toBeNull()
  })

  it('toView search 不暴露密文，hasKey 反映是否已保存', () => {
    const v = toView({ ...DEFAULT_SETTINGS, search: { apiKeyEncrypted: 'xxx', enabledDefault: true } })
    expect(v.search).toEqual({ hasKey: true, enabledDefault: true })
  })

  it('applyView search 白名单：非法类型回退现值', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS }
    const v: AppSettingsView = {
      ...toView(cur),
      search: { hasKey: false, enabledDefault: true }
    }
    const next = applyView(cur, v)
    expect(next.search.enabledDefault).toBe(true)
    const bad = applyView(cur, { ...v, search: { hasKey: false, enabledDefault: 'yes' as unknown as boolean } })
    expect(bad.search.enabledDefault).toBe(false)
  })

  it('setSearchKey/getSearchKey 往返：加密后读回原文，空值清除', () => {
    setSearchKey(file, 'sk-test-key')
    const s = loadSettings(file)
    expect(s.search.apiKeyEncrypted).toBe('enc:sk-test-key')
    expect(getSearchKey(s)).toBe('sk-test-key')
    setSearchKey(file, '')
    expect(getSearchKey(loadSettings(file))).toBeNull()
  })

  it('懒迁移：bocha-key.enc 存在且 search 密文为空 → 迁入并删除文件', () => {
    fs.writeFileSync(path.join(dir, 'bocha-key.enc'), 'enc-bocha')
    const s = loadSettings(file)
    expect(s.search.apiKeyEncrypted).toBe('enc-bocha')
    expect(fs.existsSync(path.join(dir, 'bocha-key.enc'))).toBe(false)
  })

  it('懒迁移：search 密文已存在 → 不迁移不动文件', () => {
    fs.writeFileSync(file, JSON.stringify({ search: { apiKeyEncrypted: 'existing' } }))
    fs.writeFileSync(path.join(dir, 'bocha-key.enc'), 'enc-bocha')
    const s = loadSettings(file)
    expect(s.search.apiKeyEncrypted).toBe('existing')
    expect(fs.existsSync(path.join(dir, 'bocha-key.enc'))).toBe(true)
  })
})
```

- [ ] **1.4 运行**：`npx vitest run src/main/settings.test.ts` —— 预期 6 个新用例先 RED（search 字段缺失）→ 按 1.1/1.2 实现后 GREEN（旧 9 用例保持绿）。
- [ ] **1.5 验证**：`npm run typecheck` 绿（AppSettingsView.search 已补，无消费方破坏）。
- [ ] **1.6 提交**：

```bash
git add src/shared/types.ts src/main/settings.ts src/main/settings.test.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 搜索设置字段与博查 Key 加密存取（17 设置层）"
```

### Step 2: bocha.ts TDD

- [ ] **2.1 写失败测试 `src/main/search/bocha.test.ts`**：

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { searchBocha, buildSearchContext } from './bocha'

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function item(name: string, snippet = 'snippet', url = 'https://example.com/a'): { name: string; snippet: string; url: string } {
  return { name, snippet, url }
}

describe('searchBocha', () => {
  it('成功：解析前 5 条 title/snippet/url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0,
      data: { webPages: { value: [
        item('t1'), item('t2'), item('t3'), item('t4'), item('t5'), item('t6')
      ] } }
    })))
    const r = await searchBocha('查询', 'sk-x')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.results).toHaveLength(5)
      expect(r.results[0]).toEqual({ title: 't1', snippet: 'snippet', url: 'https://example.com/a' })
    }
  })

  it('title/snippet 截断到 120/300 字符', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0,
      data: { webPages: { value: [item('长'.repeat(200), '短'.repeat(500))] } }
    })))
    const r = await searchBocha('q', 'sk-x')
    if (!r.ok) throw new Error('unreachable')
    expect(r.results[0].title).toHaveLength(120)
    expect(r.results[0].snippet).toHaveLength(300)
  })

  it('总预算 4096：超出预算的条目不入', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      code: 0,
      data: { webPages: { value: Array.from({ length: 6 }, (_, i) => item(`t${i}`, 'x'.repeat(1000))) } }
    })))
    const r = await searchBocha('q', 'sk-x')
    if (!r.ok) throw new Error('unreachable')
    expect(r.results).toHaveLength(4)
  })

  it('HTTP 错误映射：401→Key 无效、429→额度不足、500→搜索服务错误', async () => {
    for (const [status, err] of [[401, 'Key 无效'], [429, '额度不足'], [500, '搜索服务错误']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, status)))
      const r = await searchBocha('q', 'sk-x')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(err)
    }
  })

  it('fetch 抛错 → 网络错误；code 非 0 → 搜索服务错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r1 = await searchBocha('q', 'sk-x')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('网络错误')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 500, data: null })))
    const r2 = await searchBocha('q', 'sk-x')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('搜索服务错误')
  })

  it('畸形 JSON → 搜索服务错误；空 value → 空结果 ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { webPages: { value: '不是数组' } } })))
    const r1 = await searchBocha('q', 'sk-x')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('搜索服务错误')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 0, data: { webPages: { value: [] } } })))
    const r2 = await searchBocha('q', 'sk-x')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.results).toEqual([])
  })

  it('buildSearchContext：无结果与正常格式', () => {
    expect(buildSearchContext('今天天气', [])).toBe('[搜索: 今天天气]\n（未找到结果）[/搜索]')
    const block = buildSearchContext('今天天气', [
      { title: '晴', snippet: '白天晴转多云', url: 'https://example.com/1' },
      { title: '雨', snippet: '夜间有小雨', url: 'https://example.com/2' }
    ])
    expect(block).toBe('[搜索: 今天天气]\n1. 晴\n   白天晴转多云\n   https://example.com/1\n2. 雨\n   夜间有小雨\n   https://example.com/2\n[/搜索]')
  })
})
```

- [ ] **2.2 运行**：`npx vitest run src/main/search/bocha.test.ts`——预期 FAIL（模块不存在）。
- [ ] **2.3 实现 `src/main/search/bocha.ts`**：

```ts
export interface SearchResult { title: string; snippet: string; url: string }

const BOCHA_URL = 'https://api.bocha.cn/v1/web-search'
const MAX_TITLE = 120
const MAX_SNIPPET = 300
const MAX_BUDGET = 4096
const MAX_QUERY = 200
const MAX_COUNT = 5

function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'Key 无效'
  if (status === 402 || status === 429) return '额度不足'
  return '搜索服务错误'
}

/** 博查 Web Search API（通搜）。响应形状以官方文档为准，实现时已用真实 Key 校准（code/data.webPages.value 的 name/snippet/url） */
export async function searchBocha(query: string, apiKey: string):
  Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(BOCHA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: query.slice(0, MAX_QUERY), count: MAX_COUNT }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch { return { ok: false, error: '网络错误' } }
  if (!res.ok) return { ok: false, error: mapHttpError(res.status) }
  try {
    const j = await res.json() as {
      code?: number
      data?: { webPages?: { value?: { name?: string; url?: string; snippet?: string }[] } }
    }
    if (typeof j.code === 'number' && j.code !== 0) return { ok: false, error: '搜索服务错误' }
    const value = j.data?.webPages?.value
    if (!Array.isArray(value)) return { ok: false, error: '搜索服务错误' }
    const results: SearchResult[] = []
    let budget = 0
    for (const item of value) {
      const title = (item.name ?? '').slice(0, MAX_TITLE)
      const snippet = (item.snippet ?? '').slice(0, MAX_SNIPPET)
      const url = item.url ?? ''
      if (!title && !url) continue
      const cost = title.length + snippet.length + url.length
      if (budget + cost > MAX_BUDGET) break
      budget += cost
      results.push({ title, snippet, url })
      if (results.length >= MAX_COUNT) break
    }
    return { ok: true, results }
  } catch { return { ok: false, error: '搜索服务错误' } }
}

export function buildSearchContext(query: string, results: SearchResult[]): string {
  const head = `[搜索: ${query.slice(0, MAX_QUERY)}]`
  if (results.length === 0) return `${head}\n（未找到结果）[/搜索]`
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
  return `${head}\n${lines.join('\n')}\n[/搜索]`
}
```

- [ ] **2.4 运行**：`npx vitest run src/main/search/bocha.test.ts`——8/8 PASS。
- [ ] **2.5 提交**：

```bash
git add src/main/search/bocha.ts src/main/search/bocha.test.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 博查搜索客户端与结果上下文格式化（17 搜索层）"
```

### Step 3: ipc 接线 + api/preload

- [ ] **3.1 修改 `src/shared/api.ts`**：Api 接口 `setApiKey(key: string): Promise<void>` 之后加：

```ts
  setSearchKey(key: string): Promise<void>
```

- [ ] **3.2 修改 `src/preload/index.ts`**：`setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', { key }),` 之后加：

```ts
  setSearchKey: (key) => ipcRenderer.invoke('settings:setSearchKey', { key }),
```

- [ ] **3.3 修改 `src/main/ipc.ts`**：

1. import 增加（`files/apply` import 之后）：

```ts
import { searchBocha, buildSearchContext } from './search/bocha'
```

2. settings import 行改为：

```ts
import { loadSettings, saveSettings, toView, setApiKey, getSearchKey, setSearchKey, applyView, type AppSettings } from './settings'
```

3. `chat:startReply` 内、`if (settings.file.workDir) cfg.systemPrompt += ...` 行之后、`const userMessage` 之前插入（搜索永不阻断聊天）：

```ts
    let searchBlock: string | undefined
    let searchError: string | undefined
    if (p.search) {
      const key = getSearchKey(settings)
      if (!key) searchError = '未配置'
      else {
        const r = await searchBocha(p.content, key)
        if (r.ok) searchBlock = buildSearchContext(p.content, r.results)
        else searchError = r.error
      }
    }
```

4. `userMessage` 构造加两行（`files: p.files,` 之后）：

```ts
      searched: p.search === true,
      searchError,
```

5. `injectFilesIntoLastTurn(history, p.files ?? [])` 行之后加：

```ts
    if (searchBlock) {
      const last = history[history.length - 1]
      if (last && last.role === 'user') last.content = last.content + '\n\n' + searchBlock
    }
```

6. `settings:setApiKey` handler 之后加：

```ts
  ipcMain.handle('settings:setSearchKey', (_e, p: { key: string }) => { setSearchKey(settingsFile, p.key ?? '') })
```

- [ ] **3.4 验证**：`npm run typecheck` 绿；`npm test` 全量绿（预期 167 + 6 + 8 = 181）。
- [ ] **3.5 提交**：

```bash
git add src/shared/api.ts src/preload/index.ts src/main/ipc.ts
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 搜索注入接线与 settings:setSearchKey 通道（17 ipc）"
```

### Step 4: 渲染层（chatStore/App/Composer/Message/SettingsPage/styles）

- [ ] **4.1 修改 `src/renderer/src/state/chatStore.ts`**：`RetryPayload` 的 `files?: FileAttachment[]` 之后加：

```ts
  search?: boolean
```

- [ ] **4.2 修改 `src/renderer/src/state/chatStore.test.ts`**：既有 `it('error 事件的 retry 载荷透传 files 字段', ...)` 用例之后加：

```ts
  it('error 事件的 retry 载荷透传 search 字段', () => {
    const s = reducer(initialState, { type: 'startStream', requestId: 'r1' })
    const next = reducer(s, {
      type: 'streamEvent',
      e: { requestId: 'r1', type: 'error', error: '网络错误' },
      retry: { content: 'x', search: true, userVisible: false }
    })
    expect(next.errorRetry).toEqual({ content: 'x', search: true, userVisible: false })
  })
```

- [ ] **4.3 修改 `src/renderer/src/components/Composer.tsx`**（整文件替换）：

```tsx
import { useRef, useState } from 'react'
import type { FileAttachment } from '../../../shared/types'

export function Composer(props: {
  streaming: boolean
  initialSearch: boolean
  onSend(content: string, images: string[], files: FileAttachment[], search: boolean): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [search, setSearch] = useState(props.initialSearch)
  const [shotMsg, setShotMsg] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if ((!t && images.length === 0 && files.length === 0) || props.streaming) return
    props.onSend(t, images, files, search)
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
    const { files: picked, error } = await window.api.pickFiles()
    if (picked.length) {
      if (files.length + picked.length > 3) setShotMsg('最多附加 3 个文件')
      setFiles([...files, ...picked].slice(0, 3))
    }
    if (error) setShotMsg(error)
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
          .map(f => window.api.getPathForFile(f))
          .filter(Boolean)
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
            <div key={`${f.path}-${i}`} className="file-chip">
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
        <button className={`shot-btn search-btn${search ? ' active' : ''}`} onClick={() => setSearch(!search)} disabled={props.streaming}>联网搜索</button>
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

- [ ] **4.4 修改 `src/renderer/src/App.tsx`**：

1. import 行加 `useState`：`import { useCallback, useEffect, useReducer, useState } from 'react'`。
2. 组件内加（`const [state, dispatch]` 之后）：

```ts
  const [searchDefault, setSearchDefault] = useState(false)
```

3. `useEffect` 内、`listConversations` 调用之前加：

```ts
    void window.api.getSettings().then(s => { if (!disposed) setSearchDefault(s.search.enabledDefault) })
```

4. `send` 回调改为（签名加 search、载荷透传、error retry 带 search）：

```ts
  const send = useCallback(async (content: string, images: string[], files: FileAttachment[], search: boolean) => {
    if (!state.activeId) return
    const r = await window.api.startReply({ conversationId: state.activeId, content, images, files, search })
    if (!r.ok) {
      dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error }, retry: { content, images, files, search, userVisible: false } })
      return
    }
    if (r.requestId && r.userMessage) {
      dispatch({ type: 'appendUser', message: r.userMessage })
      dispatch({ type: 'startStream', requestId: r.requestId })
    }
  }, [state.activeId])
```

5. `retry` 内回退行改为（回退自 last 时带 search）：

```ts
    const p = state.errorRetry ?? (last ? { content: last.content, images: last.images?.map(i => i.dataUrl), files: last.files, search: last.searched === true } : null)
```

6. `retry` 内 `startReply` 载荷加 `search: p.search === true,`（`files: p.files,` 之后）。
7. Composer 调用点改为：

```tsx
            <Composer streaming={!!state.streaming} initialSearch={searchDefault}
              onSend={(content, images, files, search) => void send(content, images, files, search)}
              onStop={() => { if (state.streaming) void window.api.stopReply(state.streaming.requestId) }} />
```

- [ ] **4.5 修改 `src/renderer/src/components/Message.tsx`**：`msg-files` 块之后、`msg.content` 块之前加：

```tsx
      {msg.searched && (
        <div className="search-badge">{msg.searchError ? `搜索失败：${msg.searchError}` : '已联网搜索'}</div>
      )}
```

- [ ] **4.6 修改 `src/renderer/src/components/SettingsPage.tsx`**：

1. 状态区加（`const [apiKey, setApiKey] = useState('')` 之后）：

```ts
  const [searchKey, setSearchKey] = useState('')
```

2. `save` 函数内、`if (apiKey) {...}` 之后加：

```ts
      if (searchKey) { await window.api.setSearchKey(searchKey); setSearchKey('') }
```

3. 「文件」section 之后、「情绪 → 桌宠按键」section 之前加：

```tsx
        <section>
          <h2>搜索</h2>
          <label>博查 API Key（联网搜索用）
            <input type="password" value={searchKey} placeholder={form.search.hasKey ? '已保存（输入新值可覆盖，留空不变）' : '粘贴博查 API Key'}
              onChange={e => setSearchKey(e.target.value)} />
          </label>
          <label className="checkbox"><input type="checkbox" checked={form.search.enabledDefault}
            onChange={e => set({ search: { ...form.search, enabledDefault: e.target.checked } })} /> 默认开启联网搜索（每次发送前开关的初始状态）</label>
          <p className="field-hint">在 open.bochaai.com 注册后可领取免费调用额度（购买 0 元试用资源包 + 兑换口令「博查搜索」）。</p>
        </section>
```

- [ ] **4.7 修改 `src/renderer/src/styles.css`** 追加：

```css
.search-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.search-badge { align-self: center; margin: 0 8px 6px 0; display: inline-flex; align-items: center; background: var(--accent-soft); color: #c4b5fd; border: 1px solid var(--border); border-radius: 8px; padding: 2px 8px; font-size: 11px; }
```

- [ ] **4.8 验证**：`npm run typecheck` 绿；`npm test` 全量绿（预期 182 = 167 + 6 settings + 8 bocha + 1 chatStore）。
- [ ] **4.9 提交**：

```bash
git add src/renderer/src/state/chatStore.ts src/renderer/src/state/chatStore.test.ts src/renderer/src/App.tsx src/renderer/src/components/Composer.tsx src/renderer/src/components/Message.tsx src/renderer/src/components/SettingsPage.tsx src/renderer/src/styles.css
git -c user.name="lenovo" -c user.email="lenovo@local" commit -m "feat: 联网搜索开关/徽章/设置页搜索区（17 完成）"
```

---

## 验收（控制器执行）

1. `npm run typecheck` + `npm test` 全量绿（182 个）。
2. 审查：review-package + 审查者 + 修复轮（照 SDD 流程）。
3. 冒烟（CDP 9222，真实博查 Key——已 DPAPI 存于 %APPDATA%/daniya-chat/settings.json，启动 dev 后由懒迁移自动并入 search 字段，bocha-key.enc 应消失）：
   - 勾选「联网搜索」问一个实时问题（如"今天北京天气怎么样"）→ user 气泡徽章「已联网搜索」→ 达妮娅回答引用搜索结果内容。
   - 不勾开关 → 无徽章、正常回答。
   - 设置页搜索区显示 hasKey 状态；改错 Key（临时）→ 徽章「搜索失败：Key 无效」、回答照常。
   - 断网（改 baseUrl 不影响博查；可用防火墙或改 BOCHA_URL 变量模拟——实现者冒烟时视环境定）→ 徽章「搜索失败：网络错误」。
   - 重试路径：搜索失败后的消息点重试 → 重搜（徽章更新）。
4. 用户手动验证安装包（重新打包后）与桌宠表情肉眼确认仍挂账。
