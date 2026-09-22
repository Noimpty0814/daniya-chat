# ADR 0002: 文件修改走 ```daniya-file 提案契约，不走 write/edit 工具

日期：2026-09-08（dsh 迁移时确认保留）　状态：已落地

## 决策

模型改文件不直接写盘：人设契约要求它产出 ```` ```daniya-file ```` fenced 块（JSON 提案），主进程 `FileProposalParser` 在流式文本中剥离该块、经 `file:proposal` 事件交给渲染层弹 diff 面板，用户确认后主进程才应用（自动 `.bak` 备份、原子写、失败可重试）。dsh 的 write/edit 工具不挂；模型的直写通道只有 `pwsh`，且被 `workspace-write` 沙箱围栏在工作目录。

## 理由

- 提案先经人眼：diff 面板是这个产品文件写入的唯一审批面，和"沙箱越界写直接拒、无申请放行"的语义对齐。
- 契约是纯 prompt 约定，跨运行时移植零成本（从旧引擎带到 dsh 只改了注入位置）。

## 代价

- 依赖模型遵循格式约定（实测可靠，但见验收 E4：模型写文件永远走提案，`pwsh` 写路径要靠沙箱兜底）。
- v1 只支持整文件替换；片段级 patch 协议是已知延期项。

契约原文在 `packages/daniya-bridge/src/contracts.ts`（FILE_CONTRACT，每轮由 `persona.ts` 随人设段注入）。

## 补记（2026-09-22，file-proposal-service 票，PR #9）

规则 1"本轮对话中用户附带的文件"裁决为**按会话作用域**：附件授权存于 `FileProposalService` 的 `Map<conversationId, Set<path>>`，同会话跨轮持续有效、跨会话拒绝、删除会话即回收。工作目录内成员资格是独立的恒通路径，不受会话作用域影响。早期实现曾用进程级永不清空的集合——与该承诺不符，已修。
