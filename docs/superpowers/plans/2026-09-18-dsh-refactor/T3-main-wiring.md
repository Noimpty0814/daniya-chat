# T-3 主进程接线（harness 客户端 + IPC 重写 + 设置迁移）

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md`（§5.2 协议、§5.3 事件映射、§6 改造清单、§7 设置迁移是本票主体）
- 参照仓库 `D:\Agents\deepseek-harness` **只读**（本票主要不依赖它，协议以 spec 为准）。
- 现行代码先读：`src/main/ipc.ts`（全部通道语义）、`src/shared/types.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/main/settings.ts`、`src/main/index.ts`、`src/main/files/*`（提案/附件链路保留）、`src/main/deepseek/emotion.ts`（parser 保留复用）。
- bridge 协议是固定契约（spec §5.2）：即使 T-2 未完成，本票按契约编码 + 用 mock 桥进程测试。

## 目标

主进程把现有 IPC 语义全部转接到 harness 后端：渲染层通道名与载荷语义基本不变（spec §5.3 映射），新增 tool 徽照搬事件，settings 完成迁移，`harness/` 三个新模块落地。

## 文件所有权

- `src/main/harness/**`（新建：process.ts、bridge.ts、conversations.ts、fixtures）
- `src/main/ipc.ts`、`src/main/index.ts`、`src/main/settings.ts`
- `src/shared/types.ts`、`src/shared/api.ts`
- `src/preload/index.ts`、`src/preload/index.d.ts`
- `src/main/*.test.ts` 中属本票范围者（settings.test.ts 调整；新建 harness 相关测试）

**禁止**：`src/renderer/**`、`src/main/pet/**`、`src/main/files/**`、`src/main/screenshot.ts`、`packages/**`、`harness/**`、docs/**；**不删旧模块**（`deepseek/`、`search/`、`storage/` 留给 T-4 删），但 ipc/index 中对它们的 import 必须清干净。

## 任务

1. **`src/main/harness/process.ts`**：
   - spawn 管理：读 `harness/README.md`（T-1 产物）的启动命令；若该文件尚缺，按 spec env 变量实现并标注 TODO 待对齐——`DEEPSEEK_API_KEY`（`getApiKey` 解密注入）、`DEEPSEEK_BASE_URL`、`DSH_HOME`（`userData/harness`）、`DANIYA_SETTINGS_FILE`、`DANIYA_WORKDIR`。
   - 生命周期：惰性启动（首次 startReply 前 ensure）、崩溃检测 → 重启一次 → 再败报"运行时不可用"；`shutdown` 请求 → 等待退出 → 超时升级（SIGTERM→SIGKILL 阶梯，参照 `packages/sdk/client/src/dispose.ts` 语义）。应用 `before-quit` 时排空。
   - stdio 接管：stdout=协议、stderr=日志前缀 `[harness]` 转发 console。
2. **`src/main/harness/bridge.ts`**：协议客户端——按行 JSON-RPC；`request(method,params)` Promise 化 + `onNotification` 分发；类型化错误（超时/协议错/传输死）。会话映射：conversationId ↔ sessionId。
3. **`src/main/harness/conversations.ts`**：会话登记簿 JSON（`userData/conversations.json`）：`{sessionId, titleOverride?, createdAt}` 列表顺序；rename/delete 维护；`chat:listConversations` 数据 = registry ⨝ bridge `session.list`（标题：override ?? dsh title ?? '新会话'）。
4. **`src/main/ipc.ts` 重写**：
   - `chat:startReply` → ensure harness → `session.create/resume`（按 conversationId 映射）→ 附件注入逻辑不变（`injectFilesIntoLastTurn` 照旧读文件拼接）→ `prompt {text, images}`；返回 `{ok, requestId, userMessage}` 语义不变（requestId 用 conversationId+递增或 messageId 映射）。
   - `chat:stopReply` → `cancel`。
   - 通知→渲染：`stream.chunk` → EmotionParser+FileProposalParser（从 `deepseek/emotion.ts`、`files/proposal.ts` 复用——**把 emotion.ts 移到 `src/main/harness/`或保留原路径引用，二选一写明理由**）→ `chat:stream{delta|emotion}`；`stream.end` → `chat:stream{done,message,aborted}`；`tool.call/result` → `chat:stream{tool}`（新 type）；`error` → `chat:stream{error}`（中文映射沿用现有 ApiError→中文习惯）。
   - 提案链路：`file:proposal` 事件与 `file:apply`/`file:reject`/`file:pick`/`file:register`/`file:pickDir` 通道不变（files/* 模块未动）。
   - 会话通道：`chat:listConversations`（registry）、`chat:createConversation`（建 registry 项；dsh session 惰性到首发消息时建）、`chat:renameConversation`、`chat:deleteConversation`（cancel + bridge session.delete + registry 删）、`chat:getMessages`（bridge session.history → ChatMessage[]）、`chat:search`（客户端侧标题过滤即可——registry 内搜索；**历史全文搜索降级为标题+已加载消息过滤，spec §13 之外不补**）。
   - `pet:*`、`screen:capture`、`shell:openExternal`、`window:hide` 通道不变。
   - 删除搜索分支全部代码（`searchBocha`/`buildSearchContext`/`getSearchKey` 引用）。
   - `settings:testConnection`：改为校验 harness initialize 或保留 `/models` fetch（用解密 key；语义不变）。
5. **`src/main/settings.ts`**：删 `search.*` 字段、`getSearchKey`、`setSearchKey`、`migrateBochaKey`；`textModel`/`visionModel` → 单 `model`（`DEFAULT_SETTINGS.model` 初值取 `deepseek-chat` 占位，**实测型号留 TODO 注释**）；`applyView`/`toView` 同步；`loadSettings` 加一次性迁移（旧字段清理）。`AppSettingsView` 相应变化。
6. **`src/shared/types.ts` + `api.ts` + preload**：
   - `ChatMessage`：`searched`/`searchError` 删，加 `tools?: {name:string; ok?:boolean}[]`；
   - `StreamEventMsg.type` 加 `'tool'`，载荷 `{name, callId, ok?, preview?}`；
   - `AppSettingsView` 删 `search` 区、`textModel`/`visionModel`→`model`；
   - preload 通道面与 api.ts 同步。
7. **测试**：
   - `src/main/harness/fixtures/fake-bridge.mjs`：mock 桥进程（node 脚本实现协议子集：initialize/session.*/prompt 回 messageId 然后推 scripted chunk/end/tool 通知）；
   - `bridge.test.ts`：分帧、请求超时、通知分发；
   - `ipc` 层测试（沿用现有测试风格）：mock 桥上 startReply→delta/emotion/done 全链、abort、proposal 透传、conversation CRUD；
   - `settings.test.ts`：迁移路径（旧 search 字段清除、双模型→单模型）。
8. `index.ts`：`app.whenReady` 不预拉 harness（惰性）；`before-quit` 加 `harness.shutdown()` 排空（与 pet.stop 协调顺序）。

## 验收标准

- [ ] `npm run typecheck` 绿；`npx vitest run` 绿（含新测试）
- [ ] mock 桥集成测试覆盖：发消息→delta→done、停止、提案事件、工具徽照搬、会话 CRUD、settings 迁移
- [ ] 无 `deepseek/`、`search/`、`storage/` 的 import 残留（grep 证明；文件本身留给 T-4）
- [ ] IPC 通道表与 spec §5.3 逐条对上；渲染层调用面除"删搜索字段+加 tool 事件"外不变
- [ ] 报告列出：deviation、mock 桥假设的协议细节（待 T-2 校准）、TODO 清单

## 备注

- 渲染层尚未改：测试期渲染层传 `searched` 字段会被忽略属预期。
- pet 协调接口（`pet().bubble/emotion`）调用点保持不变。
- `MAX_CONTEXT=40` 删除——上下文管理交给 harness compaction；`toTurn`/history 组装删除（历史由 harness 持有，附件注入仍走现有 `injectFilesIntoLastTurn` 于 prompt 文本）。
