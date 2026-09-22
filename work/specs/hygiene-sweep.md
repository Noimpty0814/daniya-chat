# Spec: hygiene-sweep — dsh 迁移残留与线协议死代码清扫

Dispatched: daniya-chat@feat/hygiene-sweep — 2026-09-22 — fairybox:spec-hygiene-sweep

清扫票：逐条删除已证实的死代码/投机通路、收窄线协议、修正漂移注释。不改任何行为语义（除 Decisions 中显式列出的协议收窄——两侧同仓同步改，无第三方消费者）。

## Problem

dsh 迁移（ADR-0001）落地后留了一层残留：`session.event` 通知被序列化推上 stdio 后无人消费；`titleCache` 缓存一个契约上恒为 `''` 的字段；`session.resume` 每次计算一份被调用方丢弃的完整历史投影；`ConversationRegistry.findBySessionId` 只有自己的测试在用；`StreamEventMsg` 带着渲染层从不读取的字段；多处注释仍指向已删除的 `src/main/deepseek/`。每一项单看都小，合起来让所有读者为噪音付出注意力，也让后续重构（协议契约化、ipc 拆分）的搜索面变大。

## Outcome

Decisions 列出的删除/收窄/注释修正全部落地；`npm run typecheck` 与 `npm run test` 全绿；除明确允许的线协议收窄外无可观察行为变化。复核者能对每条删除追到"无消费者/契约保证死分支"的证据。

## User Stories

1. 作为维护者，我要死代码被删掉而不是继续被阅读，使搜索与重构面收敛。
2. 作为复核者，我要每条删除对应一句"为什么它死"的证据，使验收是查证而非信任。
3. 作为协议维护者，我要 wire 形状与真实消费一致，使协议文件不再声明无人收的通知。
4. 作为后续重构者，我要注释与代码一致（指向存在的文件、描述真实行为），使注释恢复可信度。

## Decisions

允许的三处线协议收窄（producer/consumer 同仓同步改，daniya-bridge 无外部消费者）：

1. **停发 `session.event`**：`server.ts` 中 `session/event` 监听里"全部事件原样转 `session.event`"的 `safeNotify` 调用删除（`tool/call`/`tool/result`/`assistant/message`/`turn/end` 的定向翻译保留）；`ipc.ts` 的 `case 'session.event'` 分支随之删除；`protocol.ts` 通知联合类型中的 `'session.event'` 成员与其注释一并删除。理由：每个 session 事件（含完整 assistant 文本与工具参数）被 JSON 序列化推上 stdio 后，main 侧 `default: return` 直接丢弃——投机性通用，成本为每 turn 双份序列化。调试需要时由 git 历史恢复。
2. **`session.resume` 不再返回 `history`**：`server.ts` `sessionResume` 去掉 `readHistory`/`projectLiveSession` 调用，返回 `{ ok: true }`；`protocol.ts` 结果映射同步改为 `{ ok: true }`。理由：唯一调用方 `ipc.ts` `ensureLiveSession` 丢弃返回值，历史由 `chat:getMessages`→`session.history` 独立投影——resume 的投影是纯浪费。
3. **`StreamEventMsg` 删死字段**：`type` 联合中的 `'emotion'` 成员与 `emotion`/`aborted` 字段删除；`ipc.ts` 停止发送 `type:'emotion'` 事件、`done` 事件不再携带 `aborted`（`pet().emotion` 主进程侧调用保留）。理由：reducer 对两者均不消费（`chatStore.ts` `streamEvent` 分支无 emotion 处理、done 只读 `message`）。

纯删除/收窄项：

4. **`titleCache` 整体删除**（`ipc.ts` 声明、listConversations 中的写入、toMeta/search 中的读取）：bridge 契约保证 `title` 恒 `''`（`server.ts` sessionList 注释），`d?.title` 分支永远不会命中。
5. **`ConversationRegistry.findBySessionId` 删除**：生产代码无调用方（ipc 用 `activeBySession` 追踪）；`conversations.test.ts` 中对应断言删除、`setSessionId` 断言保留。
6. **提案授权语义注释修正**：`attach.ts` `authorized` 集合是进程级永不清空，与 `contracts.ts` FILE_CONTRACT"本轮对话附带文件"的承诺不一致——本票只把该事实写成 `attach.ts` 的注释（已知缺口，收窄归后续 FileProposalService 票），不改行为。
7. **附件数量上限单源化**：`Composer.tsx` 的两处 `3`/`最多附加 3 个文件`与 `attach.ts` `pickFiles` 的 `slice(0, 3)`+提示文案收敛为一个共享常量（如 `shared/types.ts` 或新 `shared/consts.ts` 的 `MAX_ATTACH_FILES = 3`），三处同引。
8. **漂移注释修正**（改字不改码）：`contracts.ts` 头注"逐字复制自 `src/main/deepseek/client.ts`"改写为不指向现存文件的表述（历史出处保留、删除"暂存"暗示）；`src/main/harness/emotion.ts:4-6` 头注删除——`deepseek/emotion.ts` 已不存在、`pet/coordinator.ts` 早已改指本文件；`src/main/harness/persona.ts` 与 `packages/daniya-bridge/src/persona.ts` 头注中指向 `deepseek/` 的表述核实修正。
9. **ADR-0002 措辞修正**："渲染层剥离该块"改为与实现一致（主进程 `FileProposalParser` 剥离、渲染层收 `file:proposal` 事件）；"契约原文在 `persona.ts`（FILE_CONTRACT）"改指 `contracts.ts`。
10. **IPC 面地图补全**：`ipc.ts` 头注的通道清单补一行说明 `pet:error` 由 `index.ts` 的 pet 装配处推送（push 通道地图不留缺口）。
11. **小模块并入（deletion test 通过）**：`src/main/pet/pet-settings.ts`（6 行）并入唯一调用点；`src/main/harness/persona.ts`（~18 行单常量）并入唯一消费方——两处都是"为可测性抽出的数据"，删除即集中。若实施中发现任一文件有第二个消费方，该条跳过并在 PR 说明。

## Testing

- 本票是纯删除/注释票，不新增测试；已删接口对应的断言同步删除（`findBySessionId` 断言、任何断言 `session.event` 透传或 resume `history` 字段的用例——`tests/` 下先搜后删）。
- 完成后 root `npm run typecheck && npm run test` 全绿是验收底线。
- 环境前置（fresh clone 三步缺一不可）：root `npm install`；`npm --prefix packages/daniya-bridge install && npm --prefix packages/daniya-bridge run build`；`npm install --prefix harness/profile`。
- 自查清单：grep 确认 `session.event`/`findBySessionId`/`titleCache`/`'emotion'` 事件发送点在 src/ 与 packages/ 下零残留引用（测试文件同步更新后）。

## Out of Scope

- `authorized` 授权集合收窄到"本轮/本会话"语义——归后续 FileProposalService 候选（本票只写注释）。
- `requestId` 哨兵值（`'__none__'`/`''`）统一为显式 action——归 chatController 候选。
- `TOOL_LABELS` 动态化——加一条"与 `harness/profile/cordis.patch.yml` 工具集对齐"的交叉引用注释即可，不重构。
- C1/C2 结构性重构（ipc 拆分、协议契约承重化）——独立 spec。
- `pipe-pet.ts` 模块级 `sessionToken`——单实例前提下无实害，不动。

## Open Questions

（无——全部为已核实死代码或注释修正，无阻塞项。）
