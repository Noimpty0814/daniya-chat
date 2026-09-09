# 达妮娅聊天 — 联网搜索 设计规格

日期：2026-09-09
状态：已获用户批准（2026-09-09 设计评审通过，三节设计逐节点头）
依赖：Task 16 文件读+改已闭环合并 main（bc93e6a，167/167 绿）

## 1. 目标

让用户在 Composer 勾选「联网搜索」时，主进程先调博查（Bocha）搜索用户原文，把结果作为上下文注入，达妮娅的回答基于实时网页信息。

用户已拍板的 4 项决策：

1. 触发方式 = **手动开关**（AI 自动触发为二期）
2. 注入方式 = **拼在 user 消息后**（同文件注入模式）
3. 设置页 = **博查 Key 输入 + 默认开关**（Key 并入设置加密体系）
4. 架构 = **方案 A：主进程全程托管**（渲染层只持状态标记，碰不到搜索结果）

## 2. 范围

**在范围内**：

- 博查 Web Search API（通搜）集成：主进程 fetch、10s 超时、前 5 条、总预算 ~4KB
- Composer「联网搜索」开关（初始值 = 设置默认开关，发送后保持，流式期间禁用）
- 主进程搜索 + `[搜索: <query>]` 块注入末轮 user 消息（与 `injectFilesIntoLastTurn` 同构）
- user 气泡徽章：已联网搜索 / 搜索失败：<中文原因>
- 设置页搜索区：博查 Key（DPAPI 加密，同 DeepSeek Key 模式）+ 默认开关
- 既有 `bocha-key.enc` 懒迁移进 settings（一次性，零用户操作）

**不在范围内（明确延期）**：

- AI 自动触发搜索（函数调用，二期）
- 多搜索引擎 / 结果缓存 / 历史搜索 UI
- 搜索结果落库（只存 `searched` / `searchError` 状态标记）

## 3. 组件设计

### 3.1 主进程 `src/main/search/bocha.ts`（新建）

- `searchBocha(query: string, apiKey: string): Promise<{ ok: true; results: SearchResult[] } | { ok: false; error: string }>`
  - `SearchResult = { title: string; snippet: string; url: string }`
  - POST `https://api.bocha.cn/v1/web-search`，`Authorization: Bearer <apiKey>`，JSON body `{ query, count: 5 }`；`AbortSignal.timeout(10_000)`
  - 响应字段以博查官方文档为准（webPages.value 内取 name/snippet/url 等）；**实现时用真实 Key 实测校准一次**（主进程 getSearchKey 解密后 curl 同构请求即可，明文 Key 不得写入报告/台账）
  - HTTP 非 200 / 响应 code 非 0 / 畸形 JSON → error
- 错误映射（中文，给徽章用）：401/403 → `Key 无效`；429/402 → `额度不足`；网络/超时 → `网络错误`；其他 → `搜索服务错误`
- 结果裁剪：title 截 120 字符；snippet 截 300 字符；总预算 4096 字符逐条累加，超预算即停（保底不丢已入条的 URL）
- `buildSearchContext(query: string, results: SearchResult[]): string`：
  ```
  [搜索: <query>]
  1. <title>
     <snippet>
     <url>
  ...
  [/搜索]
  ```
  无结果 → `[搜索: <query>]\n（未找到结果）[/搜索]`
- 查询词 = 用户原文，截断 200 字符

### 3.2 设置（`settings.ts`）

- `AppSettings` 加 `search: { apiKeyEncrypted: string | null; enabledDefault: boolean }`
- `DEFAULT_SETTINGS.search = { apiKeyEncrypted: null, enabledDefault: false }`
- `loadSettings` 合并加 `search: { ...DEFAULT_SETTINGS.search, ...(raw.search ?? {}) }`（file 子对象同法）
- `setSearchKey(file, key: string | null)` / `getSearchKey(file): string | null` —— 与 `setApiKey`/`getApiKey` 逐字同构（safeStorage DPAPI，base64 存，空值清除）
- `toView` 加 `search: { hasKey: !!s.search.apiKeyEncrypted, enabledDefault: s.search.enabledDefault }`——**渲染层永不见密文**
- `applyView` 加 search 字段白名单：`enabledDefault` boolean 校验（非法回退现值）；`hasKey` 忽略
- **懒迁移**（`loadSettings` 内）：`search.apiKeyEncrypted` 为空且 `<settings 同目录>/bocha-key.enc` 存在 → 读其内容（base64 密文，格式与 safeStorage 输出一致）写入 `search.apiKeyEncrypted` → `saveSettings` → `fs.rmSync` 删 bocha-key.enc。迁移失败（读/写异常）→ 静默跳过，不阻断加载
- I2 纪律：search 字段不参与 pet 比较，不触发桌宠协调器重建（天然满足）

### 3.3 类型 / IPC / preload

- `shared/types.ts`：`StartReplyPayload.search?: boolean`；`ChatMessage.searched?: boolean; searchError?: string`
- `shared/api.ts` + preload：新增 `setSearchKey(key: string | null): Promise<void>`（通道 `settings:setSearchKey`，照 `setApiKey` 现有通道模式）；`StartReplyPayload` 载荷透传 search
- `ipc.ts` `chat:startReply` 流程（搜索永不阻断聊天；**搜索在 userMessage 落库之前完成**，徽章字段随消息入库）：
  1. `p.search === true` 时：`getSearchKey(settingsFile)` → 无 Key → `searchError = '未配置'`，跳过搜索
  2. 有 Key → `await searchBocha(用户原文, key)`（上限 10s）→ 成功 → 拼 `buildSearchContext` 追加到 history 末轮 user 消息（在 `injectFilesIntoLastTurn` 之后）；失败 → `searchError = error`
  3. `userMessage` 构造时带 `searched: p.search === true`、`searchError`，随后落库（搜索结果本身不落库）
  4. retry（`skipUserAppend`）路径：搜索照做，结果注入 history（末轮 user 消息就是库中原消息）

### 3.4 渲染层

- `Composer.tsx`：`onSend(content, images, files, search: boolean)`；「联网搜索」切换钮（`.search-btn` + `.active` 高亮），**流式期间禁用**（同截屏/选文件）；勾选状态发送后保持；`initialSearch` prop（App 启动 getSettings 传 `search.enabledDefault`）
- `App.tsx`：send/retry 载荷带 `search`；错误事件 retry 载荷带 `search`（RetryPayload 加 `search?: boolean`，files 同款透传）；retry 回退：errorRetry 无 search 时取 `last.searched === true`
- `Message.tsx`：user 气泡 msg-files 之后加徽章——`searched && !searchError` → 「已联网搜索」；`searchError` → 「搜索失败：<原因>」
- `SettingsPage.tsx`：新增「搜索」section——博查 Key 输入（`type="password"`，placeholder 依 `form.search.hasKey` 显示"已保存（输入新值可覆盖，留空不变）"/"粘贴博查 API Key"，保存时非空才调 `setSearchKey`，照 API Key 框同款）+「默认开启联网搜索」checkbox
- `styles.css`：`.search-btn.active`、搜索徽章样式（沿用深色 #17151f / 紫 #8b5cf6 视觉）

### 3.5 与截屏/视觉模型兼容

- 搜索块是纯文本追加，带图走视觉模型天然兼容，无需特殊处理

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| 没配博查 Key | 降级普通回答，徽章「搜索失败：未配置」 |
| Key 无效 / 额度不足 / 网络错误 / 超时 10s | 降级普通回答，徽章「搜索失败：<对应中文原因>」 |
| 搜索无结果 | 注入（未找到结果），照常回答 |
| 响应畸形 / code 非 0 | 降级，徽章「搜索失败：搜索服务错误」 |

## 5. 测试策略

- `src/main/search/bocha.test.ts`：fetch mock（vi.stubGlobal）——成功解析、5 条裁剪与 4KB 预算、title/snippet 截断、HTTP 错误映射（401/429/网络/超时）、畸形响应、无结果 buildSearchContext
- `settings.test.ts`：search 字段合并（旧存档缺字段补默认）、setSearchKey/getSearchKey 往返（沿用既有 apiKey 测试的 safeStorage mock 模式）、懒迁移（造假 bocha-key.enc → loadSettings 迁移 → 文件被删、settings 有密文；密文已存在时不迁移）
- `chatStore.test.ts`：error retry 载荷 search 透传
- 冒烟（控制器，CDP 9222，真实 Key）：勾选搜索发消息 → 达妮娅引用实时内容 + user 徽章；关开关不搜；断网/错 Key 降级路径；设置页存 Key 后 hasKey 状态
- 既有 167 测试保持绿；`npm run typecheck` 绿；新增测试 TDD（RED 留证据）

## 6. 实施计划建议

单任务 **Task 17**（实现者 sonnet，简报控制器新写；规模与 16a 相当）：

- Step 1: types + settings（search 字段/Key 函数/懒迁移）TDD
- Step 2: bocha.ts TDD
- Step 3: ipc 接线 + api/preload
- Step 4: Composer 开关 + App/Message/SettingsPage/styles
- 冒烟 + 审查 + 收尾照 SDD 流程（worktree 分支，同 Task 16 全流程）

## 7. 与既有裁决的关系

- I2（applyPetSettings 不重建协调器）：search 字段不参与 pet 比较，无影响
- R26（retry 重注入）：搜索同法——retry 时重搜
- Key 纪律：博查 Key 只以 DPAPI 密文落盘；任何台账/报告/派发提示词不得出现明文 Key
- 铁律：桌宠目录只读、绝不杀用户桌宠进程，本功能不触及
- 渲染层安全：搜索结果内容只在主进程处理，渲染层只收 searched/searchError 布尔与字符串标记（徽章文本由主进程映射的中文原因提供，非原始 API 响应）
