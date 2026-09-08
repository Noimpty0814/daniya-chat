# 达妮娅聊天 — 本地文件读+改 设计规格

日期：2026-09-08
状态：已获用户批准（2026-09-08 设计评审通过）
依赖：15 任务计划已闭环（main @ ec098c8，124/124 测试绿）

## 1. 目标

让用户把本地文件"喂"给达妮娅（读），并允许达妮娅主动提出修改文件、经用户确认（或工作目录自动放行）后写入（改）。

用户已拍板的 4 项决策：

1. 改文件机制 = **提案标记格式**（fenced code block），不用 function calling
2. 文件入口 = Composer **按钮 + 拖拽**
3. 确认方式 = **工作目录 + 自动放行开关**（设置页）
4. 规模上限 = **每轮最多 3 个附件，单个 512KB**（截断），二进制跳过

## 2. 范围

**在范围内**：

- 附件选择（按钮/拖拽）、附件 chips、附件注入对话上下文（含 retry 重注入）
- 达妮娅文件修改提案协议（```daniya-file fence + JSON）、流式剥离、diff 预览、确认写入、自动放行
- .bak 备份、原子写、权限白名单（附件集 ∪ 工作目录）
- 设置页工作目录 + 自动放行开关

**不在范围内（明确延期）**：

- 文件夹整体注入（后续单独做）
- 片段级修改（patch/search-replace 协议）——v1 只做整文件替换
- 改文件动作的历史落库记录
- 已污染历史消息清洗
- 二进制文件编辑、编码转换（仅 UTF-8 文本）

## 3. 组件设计

### 3.1 主进程 `src/main/files/attach.ts`（附件与读取）

- `registerFiles(paths: string[]): { ok: boolean; files: FileAttachment[]; error?: string }`：渲染层拖拽后注册（`file:register` 载荷）。逐个校验：`fs.existsSync`；读前 8KB 探测 NUL 字节（二进制拒绝）；`fs.statSync.size > 512KB` 拒绝（**拒绝而非截断**——附件时文件太大直接报错，读取时截断仅作兜底）。全部通过才入**会话授权集**（Set<resolvedPath>）；任一失败返回 error 并列出失败文件，成功的照常入集。
- `pickFiles(): Promise<FileAttachment[]>`：系统 dialog（`dialog.showOpenDialog`，multiSelections，最多取前 3 个，超出截断）→ 每个走 registerFiles 同款校验 → 入授权集。
- `readFileForContext(path: string): string`：授权集内才读；`readFileSync utf8`；超 512KB 截断到 512KB（兜底）。返回内容或抛 `未授权文件`。
- 类型 `FileAttachment = { name: string; path: string }`（落库与载荷共用，只有元数据）。

### 3.2 上下文注入（`client.ts` / `ipc.ts`）

- `StartReplyPayload` 增加 `files?: FileAttachment[]`；`ChatMessage` 增加 `files?: FileAttachment[]`（落库只存元数据）。
- 每轮 startReply（**含 retry**，呼应 R26：重试必须重新注入）主进程按 payload.files 逐个 `readFileForContext`，拼接在 user 消息 content 之后：

```
<用户正文>

[文件: <name>]
<文件内容>
[/文件]
```

- 读取失败（文件被删等）：该附件注入 `[文件: <name>]\n（读取失败，文件不存在或不可读）`，不阻断发送。

### 3.3 提案协议（`src/main/files/proposal.ts`）

- FILE_CONTRACT 固定拼接在 system 消息末尾（与 EMOTION_CONTRACT 同法）：

```
### 文件修改提案格式（严格遵守）
需要修改文件时，不要描述修改，输出一个独立代码块，独占行：

```daniya-file
{"path": "<绝对路径>", "content": "<修改后的完整文件内容>"}
```

规则：
1. 只能修改本轮对话中用户附带的文件，或用户设置的工作目录内的文件
2. content 是修改后的完整文件内容
3. path 必须是绝对路径
4. 一次回复最多一个提案块
5. 其他回复内容照常输出，讲解代码可以用普通 ``` 代码块
```

- `FileProposalParser` 流式状态机（照 EmotionParser 架构）：
  - `feed(chunk): { display: string; proposal?: { path: string; content: string } | { error: 'invalid-json' } }`
  - 状态：`text` / `inFence`（收集 fence 内行）。fence 起标记 = 行首 `` ```daniya-file ``；止标记 = 行首 ```。
  - fence 内内容**不进 display**（气泡不显示、不落库）。块收齐后 `JSON.parse` 校验 `{path: string, content: string}` 形状。
  - 非法 JSON / 形状错 → `{ error: 'invalid-json' }`（同样不落库）。
  - 流中断（abort/end 时 fence 未闭合）→ 丢弃，无提案。
  - 正文中出现行首 ```daniya-file 一律视为提案开始（合同已规定格式，误伤风险接受）。
- 接线：client.ts 流循环中 `parser.feed(delta)`，display 增量发渲染层、计入落库 full；提案产出后交主进程文件协调器处理。

### 3.4 权限与写入（`src/main/files/apply.ts` + `diff.ts`）

- **可改路径 = 会话附件集 ∪ 设置页工作目录内文件**。校验：`path.resolve`；附件集用全等比较；工作目录用 `resolvedPath === workDir 或 startsWith(workDir + path.sep)`；不满足 → 拒绝（`拒绝：只能修改本轮附带或工作目录内的文件`）。
- 提案大小上限：`content.length > 64KB` → 拒绝。
- `diff.ts`：自写行级 LCS diff（不引新依赖），输出 `{ lines: [{kind:'same'|'add'|'del', text}] }`。二进制文件在写入前再探测一次（NUL），拒绝。
- 写入：`renameSync(原文件, 原文件 + '.bak')`（覆盖式，保留上一版）→ `writeFileSync(tmp)` + `renameSync(tmp, 原文件)`（原子写，沿用 store 惯例）。写入失败（权限/占用）→ 错误提示，不崩。
- 提案生命周期：主进程生成 `proposalId`（randomUUID），持有 `{id, path, content, resolvedPath}` 状态表。渲染层确认 → `file:apply {id}` → 校验通过则写 + 发结果；拒绝 → `file:reject {id}` 清状态。
- **自动放行**：设置 `file.workDir` 非空且提案路径在工作目录内且 `file.autoApply === true` → 主进程直接写入，事件 `autoApplied: true`（渲染层显示"已自动应用修改：<path>"）。

### 3.5 设置（`settings.ts`）

- `AppSettings` 与 `AppSettingsView` 增加 `file: { workDir: string; autoApply: boolean }`。
- `DEFAULT_SETTINGS.file = { workDir: '', autoApply: false }`。
- `applyView` 白名单合并（渲染层不能注入密文同款纪律）：只取 `v.file.workDir`（string 校验）、`v.file.autoApply`（boolean 校验）。
- 设置页新增"文件"区：工作目录文本框 + [浏览] 按钮（`dialog.showOpenDialog({properties:['openDirectory']})` 新 IPC `file:pickDir`）+ 自动放行开关。I2 教训：**只改 file 字段不重建协调器**（applyPetSettings 的比较字段不含 file，天然满足）。

### 3.6 IPC / preload / 类型

新通道：

| 通道 | 方向 | 载荷 → 返回 |
|---|---|---|
| `file:pick` | invoke | 无 → `FileAttachment[]`（空数组=取消） |
| `file:pickDir` | invoke | 无 → `string`（空串=取消） |
| `file:register` | invoke | `string[]`（拖拽路径）→ `{ ok, files?, error? }` |
| `file:apply` | invoke | `{ id }` → `{ ok, error? }` |
| `file:reject` | invoke | `{ id }` → void |
| `file:proposal` | 主→渲染事件 | `{ id, path, resolvedPath, diff: DiffLine[], autoApplied: boolean, error?: 'invalid-json' \| string }` |

- `shared/types.ts`：`FileAttachment`、`DiffLine`、`FileProposalEvent`；`StartReplyPayload.files?`、`ChatMessage.files?`。
- `shared/api.ts` / preload：上述通道 + `onFileProposal(cb): () => void`。

### 3.7 渲染层

- `Composer.tsx`：附件 chips（名称+移除×）与截屏预览并列；[选文件] 按钮；拖拽：Composer 区 `onDragOver/onDrop`，`e.dataTransfer.files` 取 `.path`（Electron File.path）→ `file:register`。**上限 3 个**，超限提示。发送时 `onSend(content, images, files)`。
- `App.tsx`：send/retry 载荷带 files；`onFileProposal` 订阅 → 事件挂到当前会话消息区（提案显示在**本轮 AI 消息气泡下方**）；`file:apply`/`file:reject` 调用与状态更新。
- `Message.tsx`（或新组件 `FileProposalPanel.tsx`）：diff 红删绿增（`<pre>` 行渲染，样式类 diff-del/diff-add）；[应用修改] [拒绝] 按钮；已应用/已拒绝/已自动应用状态条；error:'invalid-json' → "达妮娅的修改提案格式无效，已忽略（可让她重试）"。
- 整轮 display 为空但有提案：气泡位置显示轻提示"达妮娅提议修改 <文件名>"（渲染层本地，不落库）。
- `SettingsPage.tsx`：文件区（工作目录 + 浏览 + 自动放行开关）。
- `styles.css`：chips、diff 面板、状态条样式（沿用现有深色 #17151f/紫 #8b5cf6 视觉）。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| 附件超 3 个 | 提示，只收前 3 个 |
| 附件 >512KB / 二进制 | 拒绝并提示原因 |
| 读取时文件被删 | 注入"读取失败"占位，不阻断发送 |
| 提案 JSON 非法 | 提示条，不写入不落库，可让 AI 重试 |
| 提案路径越权 | 事件 error:"拒绝：…"，不写入 |
| 提案 >64KB | 同越权处理 |
| 写入失败（权限/占用） | 事件 error，不崩 |
| 流中断 fence 未闭合 | 丢弃，无提案 |

## 5. 测试策略

- `proposal.test.ts`：完整块/跨块拆分/非法 JSON/形状错/未闭合丢弃/正文普通 fence（`` ```js ``）不误伤/display 剥离正确。
- `diff.test.ts`：增/删/改/全同/空文件。
- `attach.test.ts`：授权集校验、二进制拒绝、512KB 拒绝与截断、未授权读取抛错。
- `apply.test.ts`：工作目录内/外判定（含 `..` 逃逸与同前缀目录）、.bak 生成、原子写、64KB 上限、写入失败。
- 渲染层：chatStore/App 提案事件流测试（沿用 chatStore.test.ts 模式）。
- 端到端：真实文件附上发消息（真 Key）、真实提案确认写入、自动放行路径——控制器冒烟（CDP 9222 程序化）。

## 6. 实施计划建议

拆两个任务（每任务一次派发+审查+修复轮，沿用 SDD 8 步流程，从 main 开 worktree 分支）：

- **Task 16a（读）**：attach.ts + IPC/pick/register + types/api/preload + client.ts/ipc.ts 注入（含 retry）+ Composer 按钮/拖拽/chips + App 载荷。交付：3 个文件可附、注入正确、retry 带文件。
- **Task 16b（改）**：proposal.ts + diff.ts + apply.ts + FILE_CONTRACT + 设置页工作目录/自动放行 + diff 面板 + 事件链。交付：提案→确认→.bak+写入闭环、自动放行、越权拒绝。

## 7. 与既有裁决的关系

- R26（retry 载荷补图）：文件注入同法——retry 必重注入。
- I2（applyPetSettings 不重建协调器）：设置新增 file 字段不参与 pet 比较，无影响。
- 铁律：桌宠目录只读不受影响（本功能权限集不含桌宠目录，除非用户主动附件/设工作目录——尊重用户选择）。
- 安全：渲染层永不直接读文件内容；主进程白名单式读写；写入前 .bak。
