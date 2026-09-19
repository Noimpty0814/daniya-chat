# 达妮娅聊天 — dsh 运行时重构设计规格

日期：2026-09-18
状态：已与用户逐节确认（需求映射 / 插件取舍 / 四项关键裁决）
依赖：deepseek-harness 仓库 `D:\Agents\deepseek-harness`（`@deepseek-ai/dsh` 0.1.6-alpha.2，pre-stable）

## 1. 目标

把自研聊天引擎（`src/main/deepseek/`、`search/`、`storage/`）整体替换为 DeepSeek Harness（dsh）运行时：dsh 负责 agent 循环、流式、会话持久化、工具与联网搜索；自研面收敛为 **Electron 前端 + 桌宠协调 + 一个薄桥插件（daniya-bridge）**。重构完成后才考虑新功能。

用户已拍板的 4+1 项决策：

1. 改文件机制 = **保留 ```daniya-file 提案约定**（模型走提案块，不走 write/edit 工具；文件读写统一走 shell）
2. 联网搜索 = **模型-facing `web_search` 工具**，复用 `DEEPSEEK_API_KEY`（博查与搜索 Key 删除；手动勾选框取消）
3. 工具范围 = **保留命令行**（持久 PowerShell）；subagent/todo/plan/goal/skill 不挂
4. 遥测 = **全禁**（`session-log-deepseek`、`session-telemetry-otel`、倾向含 `plugin-package-inventory-deepseek`）
5. 组成模式 = **sdk-minimal 式极简显式树**，模型可见工具 = `pwsh` + `web_search`（+`web_fetch`）

## 2. 范围

**在范围内**：

- `daniya` profile（基于 `dsh-sdk-minimal` bundle + patch 定制）与 `daniya-bridge` 自研插件
- 主进程改造：harness 生命周期管理、bridge 适配层、凭据 env 注入
- 渲染层最小改动：去搜索勾选框、新增工具活动徽章、设置页字段调整
- 打包分发：dsh 依赖树随安装包分发

**不在范围内**：

- 旧聊天记录迁移（放弃；dsh 会话是事件日志，不可逆平迁）
- 全文搜索对等物（`session-query-sqlite` 不挂，后续需要再补）
- subagent / todo / plan-mode / goal / skill / MCP 工具（后续启用均为 patch 一行）
- approval seam（`workspace-write` 下越界写入直接拒绝，无"申请放行"路径）
- 跨平台（仍 Windows only）

## 3. 整体架构

```
┌─ dsh 运行时子进程（ELECTRON_RUN_AS_NODE 或 node 启动 dsh launcher，加载 daniya profile）─┐
│  daniya profile = dsh-sdk-minimal bundle + cordis.patch.yml 定制                        │
│  ├─ 内核：llm-deepseek · session/persistence-jsonl · agent/agent-loop · system-prompt  │
│  ├─ 工具：persistent-pwsh（持久 PowerShell，唯一命令工具）· web_search · web_fetch        │
│  ├─ 沙箱：sandbox-policy mode=workspace-write，root=设置页工作目录                        │
│  └─ daniya-bridge（自研）：stdio JSON-RPC 双向桥                                         │
│       出: assistant-stream 逐 chunk · session/event · tool/call · agent.status          │
│       入: prompt(文本+图像) · cancel · 会话 CRUD · sandbox root 设定                     │
│       还做: 向 system-prompt 贡献人设段+情绪契约+文件契约（每轮读 settings，即改即生效）    │
├─ Electron 主进程 ────────────────────────────────────────────────────────────────────────┤
│  harness 进程生命周期 · bridge 协议客户端 · 现有 ipc.ts 接口面（渲染层语义不变）            │
│  DPAPI Key → 子进程 env 注入 · 桌宠协调（原样）· 截屏 · 托盘/窗口 · 附件校验注入           │
│  proposal/diff/apply + EmotionParser + FileProposalParser（原样保留）                    │
└─ 渲染进程：React UI，IPC 语义基本不变 ───────────────────────────────────────────────────┘
```

### 关键设计决定

- **不用 `dsh --profile sdk`**：其 `session.event` 只转发持久事件——无 token 级流、无取消、无审批回传（协议已知限制）。自研 bridge 直接消费进程内事件面（`agent/assistant-stream` 逐 chunk、`agent.cancel()`、session 事件），一处补全三个缺口。
- **bridge 独占 stdio**：自定义按行分帧 JSON-RPC，不挂 `sdk-jsonrpc-server`（stdout 纯净性同理）；stdin EOF → dispose 根上下文退出（复刻 sdk-app-startup 的 EOF 语义）。
- **凭据不明文落盘**：主进程 DPAPI 解密 → spawn env `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（中转）；`llm-deepseek` 与 `web-search-deepseek` 均按 `apiKeyEnv` 解析。不挂 `credentials-local`/`settings-file`。
- **人设热更新**：bridge 注册 prompt 段，每次组装读 settings.json 的 `systemPrompt` 字段 + 固定 EMOTION_CONTRACT + FILE_CONTRACT + 工作目录行——保持"改完下条消息生效"的现行语义（不依赖 `DSH_SYSTEM_PROMPT` 静态注入）。
- **沙箱即白名单**：`workspace-write` 把持久 pwsh 的写入围栏在工作目录（Windows ACL 受限令牌）；越界写直接拒，与"提案只审工作目录"语义对齐。附件内容仍由主进程校验后注入 prompt，模型无需读附件路径。
- **DSH_HOME 隔离**：`%APPDATA%/daniya-chat/harness`，不与用户自有 `~/.dsh` 共享。

## 4. daniya profile 组成

profile 以 `@deepseek-ai/dsh-sdk-minimal` bundle 为底（完整显式树），`cordis.patch.yml` 定制：

```yaml
# $DSH_HOME/profiles/daniya/cordis.patch.yml（示意；行 id 以 bundle 实际为准）

# ── 移除 ──
- id: sdk-jsonrpc-server
  disabled: true          # bridge 取代 stdio 通道
- id: sdk-app-startup
  disabled: true          # 其 EOF/启动语义由 bridge 复刻
- id: session-log-deepseek
  disabled: true          # 隐私：随请求上传会话日志
- id: plugin-package-inventory-deepseek
  disabled: true          # 隐私：待验证禁用后适配器功能是否完整（V-6）

# ── 调整 ──
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write            # danger-full-access → workspace-write
    workspaceRoot: !!js process.env.DANIYA_WORKDIR || process.cwd()

# ── 新增 ──
- insert:
    - id: daniya-bridge
      name: 'daniya-bridge'          # 自研包，profile 依赖解析
      inject: [agents, sessions, systemPrompt, attachments]
      config:
        settingsFile: !!js process.env.DANIYA_SETTINGS_FILE
    - id: attachment-local
      name: '@deepseek-ai/dsh-attachment-local'
    - id: web
      name: '@deepseek-ai/dsh-web'
      config:
        searchProvider: deepseek-official
        fetchProvider: http
    - id: web-search-deepseek
      name: '@deepseek-ai/dsh-web-search-deepseek'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
    - id: web-fetch-http
      name: '@deepseek-ai/dsh-web-fetch-http'
    - id: tool-web
      name: '@deepseek-ai/dsh-tool-web'
      config: { fetch: true, searchTimeoutMs: 60000 }
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
    - id: token-meter
      name: '@deepseek-ai/dsh-token-meter'
```

**模型可见工具**：`pwsh`（持久 PowerShell，300s 超时）、`web_search`、`web_fetch`。

**profile 依赖**：profile `package.json` 的 `dependencies` 列出上述 `@deepseek-ai/dsh-*` 包与 `daniya-bridge`（`file:` 链接到随包插件源码；打包时用 `--install-links` 物化为副本）。dsh launcher 经 profile 依赖图解析插件名（runtime resolution）。

## 5. daniya-bridge 设计

### 5.1 职责

| 方向 | 能力 | dsh 机制 |
|---|---|---|
| 出（harness→main） | token 级流式帧 | `ctx.on('agent/assistant-stream')`，Scoped\<Agent\> 过滤本会话 |
| 出 | 持久事件（user/assistant/tool 消息、approval 审计等） | `session/event` |
| 出 | agent running/idle | `agent.status` 事件 |
| 出 | 错误 | `agent/error`、`agent/request-error` |
| 入（main→harness） | 发 prompt（文本 + 图像块） | `agent.steer()` / inbox 投递；图像先经 `ctx.attachments` 提交为持久附件 |
| 入 | 停止 | `agent.cancel(cause)` |
| 入 | 会话 CRUD | `ctx.agents.create` / `resumeSessionId` / `ctx.sessions` stat/list |
| 入 | 历史读取 | 从 session 日志 `deriveMessages` 投影为 ChatMessage 形状 |
| 入 | 设沙箱 root | `sandbox/mode` 会话级写入（agent 创建时、首个 spawn 前；进行中会话被拒则报错/提示重启） |
| 内部 | 人设段 | `ctx.systemPrompt` 注册段：每次组装读 `settingsFile` → `systemPrompt` + EMOTION_CONTRACT + FILE_CONTRACT + workdir 行 |

### 5.2 协议词汇（stdio，按行 JSON-RPC 2.0）

请求（main→bridge）：

| 方法 | 载荷 → 结果 |
|---|---|
| `initialize` | `{ workdir, model }` → `{ ok }`；校验路由与附件存储就绪 |
| `session.create` | `{}` → `{ sessionId }` |
| `session.resume` | `{ sessionId }` → `{ ok, history }` |
| `session.list` | `{}` → `[{ sessionId, title, updatedAt }]` |
| `session.history` | `{ sessionId }` → `{ messages: BridgeMessage[] }` |
| `session.delete` | `{ sessionId }` → `{ ok }` |
| `prompt` | `{ sessionId, text, images?: [{data,mimeType}] }` → `{ messageId }`（入队回执即返回） |
| `cancel` | `{ sessionId }` → `{ ok }` |
| `shutdown` | `{}` → dispose 根上下文退出 |

通知（bridge→main）：

| 方法 | 载荷 |
|---|---|
| `stream.chunk` | `{ sessionId, turn, text }`（assistant-stream chunk 原文） |
| `stream.end` | `{ sessionId, turn, aborted? }` |
| `tool.call` | `{ sessionId, callId, tool, argsPreview }`（如 `pwsh`/`web_search` 徽照搬） |
| `tool.result` | `{ sessionId, callId, ok, preview }` |
| `session.event` | `{ sessionId, event }`（持久事件透传，备用） |
| `agent.status` | `{ sessionId, status: 'running'\|'idle' }` |
| `error` | `{ sessionId, message }` |

### 5.3 事件 → 现行 IPC 的映射（渲染层零协议改动）

| bridge 通知 | 主进程处理 → 渲染层事件 |
|---|---|
| `stream.chunk` | `EmotionParser.feed` → 情绪→`pet.emotion`+`chat:stream{emotion}`；display→`FileProposalParser.feed` → `chat:stream{delta}` / `file:proposal` |
| `stream.end` | parser.end() 收尾 → `chat:stream{done, message}` |
| `tool.call`/`tool.result` | → `chat:stream{tool}`（新事件类型，UI 徽照搬） |
| `error` | 中文错误映射 → `chat:stream{error}` |
| `agent.status` idle | `pet.bubble(false)`；流终态兜底 |

取消：`chat:stopReply` → `cancel` → bridge `agent.cancel` → `stream.end{aborted:true}`（UI 保留已显示残文；**注意：abort 的残文进 assistant/attempt 不进历史投影，刷新后消失——与现状"残文落库"有差异，接受**）。

## 6. 主进程改造清单

### 保留（不动或微改）

| 文件 | 处理 |
|---|---|
| `pet/*`（coordinator/pipe-pet/keys/pet-settings） | 原样 |
| `screenshot.ts` | 原样（dataUrl → bridge 图像块） |
| `files/proposal.ts` `diff.ts` `apply.ts` `attach.ts` | 原样（提案约定 + 附件校验注入不变） |
| `deepseek/emotion.ts` | 移到通用位置或保留原路径，parser 复用 |
| `settings.ts` | 删 `search.*` 字段与 `getSearchKey`/`migrateBochaKey`；`textModel`/`visionModel` 合并为单 `model`；其余不动 |
| 托盘/窗口/`index.ts` | 微改：启动时拉起 harness 子进程，退出时 `shutdown` |

### 重写

| 文件 | 处理 |
|---|---|
| `ipc.ts` | `chat:startReply` → bridge `prompt`（附件注入逻辑不变）；`chat:stopReply` → `cancel`；会话 CRUD → bridge `session.*`；新增 `tool` 事件转发；删除搜索分支 |
| `shared/types.ts` | `ChatMessage.searched/searchError` 改为 `tools?: {name,ok}[]`（徽照搬）；`AppSettingsView` 删 search 区、双模型合单模型 |
| `shared/api.ts` / `preload` | 通道调整同上；`onStreamEvent` 载荷加 tool 类 |

### 删除

`deepseek/client.ts` `stream.ts` `router.ts`、`search/bocha.ts`、`storage/store.ts`（及对应测试文件）。

### 新增

| 文件 | 职责 |
|---|---|
| `harness/profile/`（仓库内） | profile 目录模板：`package.json`（deps + `dsh.profile.bundles: ["@deepseek-ai/dsh-sdk-minimal"]`）+ `cordis.patch.yml` |
| `packages/daniya-bridge/`（仓库内） | 自研 dsh 插件（见 §5） |
| `src/main/harness/process.ts` | spawn 管理：env 注入（`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`/`DSH_HOME`/`DANIYA_SETTINGS_FILE`/`DANIYA_WORKDIR`）、stdio 管道、崩溃重启、退出排空 |
| `src/main/harness/bridge.ts` | 协议客户端：请求/通知分发、会话↔conversationId 映射、history 投影为 ChatMessage |
| `src/main/harness/conversations.ts` | 会话登记簿（小 JSON）：sessionId ↔ 显示顺序、标题覆盖（rename 自研侧实现） |

## 7. 设置与数据迁移

- `settings.json` 一次性迁移：删 `search.apiKeyEncrypted`、`search.enabledDefault`、`bocha-key.enc` 残留；`textModel`+`visionModel` → `model`（默认值取支持图像的型号，**实测选定**，见 V-2）。
- 旧会话 JSON 不迁移；`Store` 类删除，`%APPDATA%/daniya-chat/` 下旧 `conversations*` 文件保留不读（用户可自行删除）。
- `DSH_HOME` = `userData/harness`；profile 首次运行由应用从随包模板物化到 `profiles/daniya`（含预装 `node_modules`）。

## 8. 渲染层改动

- `Composer.tsx`：删除"联网搜索"勾选框与相关状态。
- `Message.tsx`/`MessageArea.tsx`：新增工具活动徽章（"正在执行命令…"→"已执行命令"、"联网搜索…"）；`searched` 徽照搬删除。
- `SettingsPage.tsx`：删搜索区；`textModel`/`visionModel` 两框合一（`model`）。
- `chatStore.ts`：`searchError` 状态移除；新增 tool 活动状态。
- 其余（气泡、提案面板、截屏、附件 chips、会话列表）不动。

## 9. 分发

| 场景 | 方式 |
|---|---|
| dev | 仓库内 `harness/profile` 作为 npm 项目 `npm install`（`@deepseek-ai/dsh-*` 为普通依赖，`daniya-bridge` 为 `file:` 链接）；主进程 spawn `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile <dir>` 或经 app-boot `loadProfileDirectory`（**V-4：以实际 API 为准**） |
| pack | 构建期把 profile 目录连 `node_modules` 打入 `resources/`；首 run 物化到 `userData/harness/profiles/daniya`；`ELECTRON_RUN_AS_NODE=1` spawn dsh（dsh 自家 desktop 同款模式） |
| 不可行项 | dsh 单文件 exe（封闭插件集，挂不了 bridge）——已排除 |

## 10. 错误处理

| 场景 | 行为 |
|---|---|
| harness 进程崩溃/未就绪 | `chat:startReply` 返回错误条；主进程重启一次，仍败→"运行时不可用，请重启应用" |
| bridge 协议超时（initialize 10s） | 同上 |
| 模型路由失败（key 无效/模型不存在） | initialize/prompt 错误 → 中文错误条（401→"Key 无效"沿用现有映射） |
| `web_search` 失败 | 模型收到工具错误，UI 徽照搬显示失败态（替代原 searchError 徽章） |
| pwsh 越界写 | 沙箱拒绝→工具错误，模型自行解释给用户 |
| cancel 后残文 | UI 保留显示；不落历史（见 §5.3） |
| sandbox root 变更被拒（会话开着终端） | bridge 报错→主进程提示"工作目录将在新会话生效"或提示重启 |
| 提案非法/越权/超 64KB | 完全沿用现状 |

## 11. 测试策略

- **保留**：`pet/*`、`files/*`（proposal/diff/apply/attach）、`settings`（迁移后调整）、`emotion`、`chatStore` 测试。
- **删除**：`deepseek/*`、`bocha`、`store` 测试。
- **新增**：
  - `daniya-bridge` 包内单测：协议分帧、事件转发（assistant-stream→chunk、cancel→agent.cancel）、人设段组装（settings 读取+契约拼接）。
  - `harness/bridge.ts` 主进程侧：通知→IPC 映射、会话映射、错误中文化。
  - 集成冒烟（真实 dsh profile，mock 或无 key 场景）：profile 加载、工具清单正确、prompt→chunk→done 全链。
  - 端到端（真 Key，手动）：发消息→流式→情绪→桌宠；截图→图像块；提案→diff→应用；web_search 徽照搬；pwsh 命令徽照搬；工作目录外写入被拒。

## 12. 实施步骤建议

拆四个任务（沿用 SDD 流程）：

1. **T-1 profile 落地**：`harness/profile` + patch 全文 + dev 启动脚本（spawn dsh + env 注入）+ `--dump-config` 验证工具清单与禁用项。交付：`dsh --profile daniya` 可启动、组合正确。
2. **T-2 bridge 插件**：协议面 + 事件转发 + persona 段 + 会话 CRUD + cancel。交付：bridge 单测 + 命令行级联调（echo 客户端走一遍 prompt→chunk→done）。
3. **T-3 主进程接线**：`harness/process.ts`+`bridge.ts`+`conversations.ts` + ipc.ts 重写 + settings 迁移。交付：现有 IPC 语义在 harness 后端上跑通（渲染层未动时即可测）。
4. **T-4 渲染层 + 收尾**：搜索框删除、工具徽照搬、设置页、打包管线、旧代码删除、README/ARCHITECTURE 文档更新。

## 13. 验证点（实现期必须实测确认）

| # | 事项 | 依据/风险 |
|---|---|---|
| V-1 | `agent/assistant-stream` frame 的 text 字段形状 | 已确认事件存在（runtime-types.ts:363），chunk→text 取法实现时定 |
| V-2 | 图像输入的模型要求与选定默认型号 | `read_image` 文档显示路由须声明 image input；现行 `deepseek-v4-flash-vision-exp`/`deepseek-chat` 实际能力以真 Key 实测 |
| V-3 | `sandbox/mode` 会话级写入的确切 API 与 workspaceRoot 可写时机 | terminal-bash README 证明 mode 写入存在且进行中会话拒绝；确切调用面实现时读 `dsh-sandbox-policy` 源码 |
| V-4 | 应用自持 profile 目录的加载 API | `loadProfileDirectory` 见 app-boot README；CLI 直启路径以源码为准 |
| V-5 | 图像块进 prompt 的调用面 | 参照 sdk-server 对 `SdkEncodedImageBlock`→`ctx.attachments` 的处理路径复刻 |
| V-6 | `plugin-package-inventory-deepseek` 禁用后 llm-deepseek 功能完整性 | 若依赖其提供扩展字段则回退为保留 |
| V-7 | `npm install --install-links` 物化 `file:` 依赖的可搬性 | 打包时验证 node_modules 树复制后可启动 |
| V-8 | profile patch 对 sdk-minimal 行的禁用语法（disabled vs 删除行） | patch 只能 disabled；完整定制或需 fork bundle 为 daniya 自有 patch 文档 |

## 14. 与既有裁决的关系

- R-1~R-11 需求清单（见本会话需求分析）：R1/R2/R3/R6/R7 由 harness+bridge 承接；R4/R5 自研保留；R9/R10/R11 自研不变；R8 缩减（搜索 Key/双模型字段移除）。
- 原 file-access 规格：提案协议、diff、.bak、白名单语义全部保留；白名单执行面从"附件集∪工作目录"变为"附件注入照旧 + shell 写入围栏工作目录"。
- 原 web-search 规格：博查集成整体退役；手动勾选→注入语义由"模型自主调用 web_search + 徽照搬"替代（原规格的"二期自动触发"提前实现）。
- 安全红线沿用：渲染层永不接触明文 Key 与文件内容；桌宠目录只读。
