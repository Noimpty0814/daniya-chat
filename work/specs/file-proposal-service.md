# Spec: file-proposal-service — 文件提案/附件授权归一为生命周期清晰的服务

依赖：`chat-runtime`（C1）已合入 main——`ChatRuntime`/`ReplyTurn` 存在，`handleProposal` 在 turn 内。

## Problem

文件提案管线的状态散在两个模块级可变单例里，且授权语义与产品契约不符：`attach.ts` 的 `authorized` 集合是进程级、登记后永不清空（"本进程任一轮附带过的文件"），而 FILE_CONTRACT 承诺"只能修改**本轮对话中**用户附带的文件"（contracts.ts:25）；`apply.ts` 的 `proposals` 表在 apply/reject 时清理，但渲染层永不回应或会话被删除时条目泄漏。授权边界的正确答案应该是"随会话生命周期"，今天没有任何所有者执行它。

## Outcome

- 授权与提案两张表有唯一所有者 `FileProposalService`，按会话作用域存活；删除会话即回收该会话的授权与未决提案。
- 模型只能对**当前会话附带过的文件**或工作目录内文件出提案——跨会话附件路径被拒。
- 渲染层协议变化仅限 `file:register`/`file:pick` 载荷新增 `conversationId`；`file:proposal` 事件、`file:apply`/`file:reject` 形状不变。
- 全部现有 files 测试语义保留（授权校验、大小/二进制拒绝、备份+原子写、reject 后不可 apply），新增作用域语义测试。

## User Stories

1. 作为用户，我在会话 A 附加文件后，模型在同会话提案修改该文件可被接受，以便完成"附带→修改"闭环。
2. 作为用户，模型在会话 B 提案修改只在会话 A 附带过的文件时被拒绝，以便附件授权不跨会话泄漏。
3. 作为用户，模型提案修改工作目录内文件始终被允许（无需附带），与既有行为一致。
4. 作为用户，我删除会话后其附件授权与未决提案即失效，以便授权边界不超出会话寿命。
5. 作为用户，提案面板我不操作时条目不泄漏堆积，以便长会话运行不积攒无主记录。
6. 作为开发者，文件写入的授权与提案生命周期能从 `FileProposalService` 一个接口读完，不必在 attach/apply/chat-runtime 三处拼凑。

## Decisions

1. 新模块 `src/main/files/service.ts` 导出 `class FileProposalService`；持有 `Map<conversationId, Set<resolvedPath>>`（附件授权）与 `Map<proposalId, ProposalRecord>`（未决提案）。进程内不再有任何文件域的模块级可变状态。
2. 授权作用域 = **会话**（契约"本轮对话中"按会话解读：同会话跨轮附带持续有效；跨会话无效）。工作目录内成员资格仍是独立的恒通路径（`inWorkDir`），不受会话作用域影响。
3. `file:register` 与 `file:pick` 的 IPC 载荷新增 `conversationId: string`（内部协议，preload `api.ts`/`index.ts` 与 `Composer.tsx` 同步改）。服务侧 `register(conversationId, paths)` 做原有校验（存在/非目录/非二进制/≤512KB/≤3 个）并把 resolve 后路径记入该会话授权集。
4. `ChatRuntime` 依赖新增 `files: FileProposalService`（由 `registerIpc`/`index.ts` 构造注入，测试注入内存实现）。`startReply` 的附件注入改走服务（`injectTurn(conversationId, turn, files)`——只读该会话授权内的附件）；`ReplyTurn.handleProposal` 的 `createProposal`/`applyProposal` 调用改为 `service.createProposal(conversationId, ...)`/`service.applyProposal(id)`。
5. `ChatRuntime.deleteConversation` 追加 `files.closeConversation(id)`：清该会话授权集 + 删除其未决提案。提案记录上挂 `conversationId` 字段支持回收。
6. `proposals` 表泄漏收窄为会话生命周期：条目随会话删除回收；跨会话长留但绑定可追踪。不引入 TTL/容量上限——YAGNI。
7. `attach.ts`/`apply.ts` 的校验/读写/原子写/备份纯逻辑迁入服务模块（可保留为模块内私有函数或同文件工具函数）；`FileProposalParser`（流式 parser）与 `diffLines` 原样不动——它们是无状态工具。
8. `file:apply`/`file:reject`/`file:pickDir` 通道形状不变；`file:apply` 内部经服务查表（提案记录自含 resolvedPath，无需再鉴权——授权已在 create 时发生）。
9. 渲染层可见行为唯一变化：跨会话附件提案从"放行"变"拒绝"（错误事件走既有 `file:proposal` error 通道，无新 UI）。

## Testing

- 接缝：`FileProposalService` 实例（内存注入 tmp 目录即可）+ `ChatRuntime` 经 stub 的端到端（复用 chat-runtime.test.ts 的 FakeRuntime/RecordingSender 形态）。
- 必测行为：同会话附带→提案放行；**跨会话附带→提案拒绝**（契约承诺的收窄）；workDir 内免附带放行；`closeConversation` 后该会话路径被拒且未决提案 apply 返回不存在；`file:register` 无 conversationId/未知会话的拒绝路径；reject 后 apply 失败；备份+原子写保留。
- `chat-runtime.test.ts` 既有提案透传用例改为经服务注入；`attach.test.ts`/`apply.test.ts` 迁移为服务测试（或保留薄壳——由实现按最小 diff 取舍，但授权作用域语义必须有测试钉住）。

## Out of Scope

- 片段级 patch 提案协议（ADR 0002 已记为延期项）。
- 提案 diff 面板 UI 变化、`file:proposal` 事件形状变化。
- 附件内容的缓存/索引（`readFileForContext` 现读现拼语义不变）。
- C5/C6 及其他渲染层重构。

## Open Questions

无——授权按会话收窄是契约文字的直接落实；若实现中发现"同会话跨轮"语义与产品预期不符（即应严格按单轮），以 Open Question 方式回到 PR 讨论而非自行改宽。
