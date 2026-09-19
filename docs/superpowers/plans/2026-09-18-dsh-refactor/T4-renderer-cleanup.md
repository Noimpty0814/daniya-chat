# T-4 渲染层调整 + 旧代码删除 + 文档

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md`（§8 渲染层改动、§6 删除清单是本票主体）
- **阻塞于 T-3**：`shared/types.ts` 与 preload 契约已定型后开工。
- 参照仓库 `D:\Agents\deepseek-harness` **只读**。

## 目标

渲染层适配新契约（删搜索、加工具徽照搬、设置页字段调整），旧自研引擎代码与过时文档全部移除，`npm run build` 干净通过。

## 文件所有权

- `src/renderer/**`
- `src/renderer/src/state/chatStore.ts`（含测试）
- 删除权：`src/main/deepseek/`、`src/main/search/`、`src/main/storage/` 整目录（含测试文件）
- `README.md`（重写）
- 删除权：`ARCHITECTURE-INDEX.md`、`MODULE-MAP.md`、`QUICK-NAV.md`、`VISUAL-MODULE-MAP.md`（旧架构自动导航文档，重构后全废）
- `package.json`（如 script/deps 需微调——react-markdown 等仍用；highlight.js 仍用）

**禁止**：`src/main/**`（除删除三个旧目录）、`src/shared/**`（T-3 已定，若要改回报 main 会话）、`packages/**`、`harness/**`、`docs/superpowers/**`。

## 任务

1. `Composer.tsx`：删"联网搜索"勾选框与 `search` 载荷字段；发送载荷与 `StartReplyPayload` 对齐。
2. 工具活动徽照搬：`chat:stream{type:'tool'}` 事件 → 消息气泡内轻量徽照搬（名称：pwsh→"执行命令"、web_search→"联网搜索"、web_fetch→"读取网页"；状态：进行中→成功/失败）。历史消息渲染 `ChatMessage.tools` 同款徽照搬。新增小组件或并入 `Message.tsx`，样式沿用深色 #17151f/紫 #8b5cf6。
3. `Message.tsx`/`MessageArea.tsx`：删 `searched`/`searchError` 徽照搬；user 气泡文件 chips 不变。
4. `chatStore.ts`：删 search 相关状态；新增 tool 活动状态（按 requestId/messageId 归并）；retry 逻辑适配（payload 不含 search）。
5. `SettingsPage.tsx`：删"搜索"区（Key 输入+默认开关）；`textModel`/`visionModel` 两框合并为 `model` 单框；其余区不变。
6. `App.tsx`：send/retry 载荷删 search；tool 事件订阅与归并；其余逻辑不变。
7. **删除**：`src/main/deepseek/`、`src/main/search/`、`src/main/storage/` 整目录；确认无 import 残留（此时 T-3 已清引用，删除应为净操作）；`git status` 复核。
8. **文档**：
   - `README.md` 重写：架构改为"Electron 前端 + dsh 运行时子进程 + daniya-bridge"；功能列表更新（联网搜索=模型自主 web_search、文件读写=shell+提案、无博查 Key）；快速开始加 `npm run dev:harness`（T-1 产物）；配置节更新（单 Key、单模型、无搜索 Key）。
   - 删 `ARCHITECTURE-INDEX.md`、`MODULE-MAP.md`、`QUICK-NAV.md`、`VISUAL-MODULE-MAP.md`（重构后由新文档替代，后续需要再生成）。
9. 全仓自检：`grep -r "bocha\|searchBocha\|deepseek/client\|storage/store"` 无残留（`llm-deepseek` 等 dsh 侧词除外）。

## 验收标准

- [ ] `npm run typecheck` 绿；`npx vitest run` 绿；`npm run build` 绿
- [ ] 渲染层无任何 search 相关代码与 UI
- [ ] 工具徽照搬：流式期间与历史渲染均正常
- [ ] 三个旧目录删除干净、无残留引用
- [ ] README 准确反映新架构与命令
- [ ] 报告列出：删改清单、UI 变更点、任何与 spec §8 的偏差
