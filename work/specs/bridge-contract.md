# Spec: bridge-contract — bridge 线协议契约承重化（单一类型真相 + 类型化门面）

依赖：`hygiene-sweep` 已合入 main（`session.event` 通知已删、`session.resume` 只回 `{ok:true}`、`StreamEventMsg` 死字段已清）。本票在其后的契约面上施工；派发前确认 feat/hygiene-sweep 已合并，分支从合并后的 main 切。

## Problem

`packages/daniya-bridge/src/protocol.ts` 声明了完整契约（9 请求、6 通知、BridgeResultMap）却只有 `BridgeTransportPeer` 被 import——契约不约束任何一侧。server 侧 `handleRequest` 收裸 `method: string` + `Record<string, unknown>`，通知载荷是行内字面量；main 侧 `bridge.ts` 重声明 `BridgeMessage`/`SessionSummary`（与 `history.ts` 的同名类型 optionality 已漂移）；`fake-bridge.mjs` 手写第三份实现。任何一侧改字段名，全仓 typecheck 照绿、运行时漂移。跨 stdio 接缝是这个架构里最贵的一类 bug 的藏身地。

## Outcome

线协议有唯一类型真相源，且两侧都在编译期被它约束：server 的请求分派表漏一个方法是编译错，`safeNotify` 写错字段名是编译错；main 侧 `bridge.request('session.create')` 的返回值类型自动推导、通知处理器 switch 里 `params` 按 method 收窄。ipc.ts 的 ~10 处手写方法字符串与 `str(params.x)` 取值全部消失。`fake-bridge.mjs` 的形状诚实由对账测试保证。协议字段改名从"运行时漂移"降级为"编译期爆炸"。

## User Stories

1. 作为协议维护者，我要改任何 wire 字段在双侧编译期暴露，使跨进程漂移不可能静默发生。
2. 作为 main 侧调用者，我要 `bridge.sessions.create()` / `bridge.prompt(...)` 这样不说方法名不标注返回值的调用，使 ipc/ChatRuntime 只见领域形状。
3. 作为 server 侧实现者，我要分派表穷尽性由编译器检查，使"声明了没实现/实现了没声明"不存在。
4. 作为测试维护者，我要 fixture 与契约的对账失败是显式测试失败，使假实现不再手工漂移。
5. 作为 slim-perf effort，我要契约机制零运行时体积、零新增依赖，使裁剪成果不被回流。

## Decisions

1. **契约位置：`protocol.ts` 自持化，留在 bridge 包**。把 `history.ts:22-57` 的 wire 类型（`BridgeImage`/`BridgeFile`/`BridgeToolCall`/`BridgeMessage`）上移进 `protocol.ts`，`history.ts` 回引；文件加头注"零导入铁律——本文件被根项目 typecheck，禁止任何 import"。`SessionSummary` 已在该文件，不动。选它的理由：type-only 相对路径导入对两侧 tsconfig 都零改造（bridge 侧本就包内）；`src/shared/` 方案被 bridge `rootDir:"src"` 否决（TS6059）；独立协议包对本票体量过重。
2. **main 侧消费方式**：`src/main/**` 内 `import type { … } from '../../../packages/daniya-bridge/src/protocol'`（bundler 解析、type-only 全擦除）；`tsconfig.node.json` 的 `include` 加 `"packages/daniya-bridge/src/protocol.ts"`（`composite:true` 的文件清单要求，缺了报 TS6307——响亮且自解释）。不新增任何 package.json 依赖条目。
3. **契约形状**：保留并扩展 protocol.ts——`BridgeParamsMap`（每方法 params）、既有 `BridgeResultMap`（按 hygiene 后形态：`session.resume` → `{ok:true}`）、`BridgeNotificationMap`（6 项）、`BridgeNotification` 判别联合（`{method:M, params:Map[M]}` 映射型）。无参方法 params 记 `undefined`。
4. **`BridgeTransportPeer.notify` 改泛型**：`notify<M extends BridgeNotificationMethod>(method: M, params: BridgeNotificationMap[M])`——现有 `JsonRpcLineTransport` 的 `(method: string, params?: object)` 签名逆变兼容，传输层零改动。
5. **新文件 `src/main/harness/client.ts`**：`class DaniyaBridge extends Bridge`——类型化 `request<M>` 重载在前、原始 `request<T>(method: string)` 逃生门在后；领域方法 `initialize(workdir, model)`/`shutdown()`/`prompt(sessionId, text, images?)`/`cancel(sessionId)`/`sessions.{create,resume,list,history,delete}`（`history` 直接解包 `{messages}` 信封）；`on<M>(method, fn)` 按方法订阅类型化通知。原则：1:1 协议客户端，不放 `liveSessions`/registry 编排（那是 ipc/C1 的地盘）；唯一破例是 history 解信封。
6. **server.ts 分派表化**：`switch` → `{ [M in BridgeRequestMethod]: (p) => Promise<BridgeResultMap[M]> }` 映射表 + `handleRequest` 查表分派（未知名仍抛 `method not found` 保 `-32603` 语义）；`safeNotify` 改泛型受 `BridgeNotificationMap` 约束；各 handler 保留现有 `typeof` 运行时防御（真实 wire 数据不可信，防御不删）。
7. **process.ts/ipc.ts 接线**：`HarnessRuntime` 构造 `DaniyaBridge` 并以其类型外发；`initialize`/`shutdown` 走门面方法；`HarnessLike` 字段 `Bridge`→`DaniyaBridge`；`handleNotification` 签名改 `(n: BridgeNotification)`，`str(params.x)` 取值改直接用类型化字段（编译器已保证存在性）；ipc.ts 从 `./harness/bridge` 的 wire 类型导入改为从 protocol 经 `client.ts`/`bridge.ts` re-export 或直接 import type——实施者选最简路径。
8. **fixture 对账**：`fake-bridge.mjs` 本体不动（保持零依赖 .mjs）；新增契约测试把它的预期帧字面量用 `satisfies BridgeNotificationMap[M]` / `satisfies BridgeResultMap[M]` 标注并 `toEqual` 对账——契约漂移编译错、fixture 漂移测试错，无需运行时校验器。
9. **明确不做**：运行时 schema 校验（schemastery 表）与版本握手不做——bridge 与 main 同一安装包同发布，不存在异版本对端；留作可选二期，maps 就位后补表成本低。`HarnessBackend` 端口抽象不做——归 C1 决策。
10. **`BridgeMessage` 双声明收敛**：以 `history.ts`（生产侧）的 optionality 为权威；`bridge.ts` 的本地声明删除，`SessionSummary` 同样收敛到 protocol.ts 版本（`title` 恒 `''` 的契约注释保留）。

## Testing

- 验收底线：root `npm run typecheck` 与 `npm run test` 全绿；`npm --prefix packages/daniya-bridge run build` 通过（lib/ 照常产出）。
- 既有测试适配：`bridge.test.ts` 的任意方法探针走逃生门重载继续可用；`process.test.ts`/`ipc.test.ts` 的调用点改门面后语义不变；`wire.spec.ts`/`server.spec.ts` 照常绿。
- 新增：`fake-bridge` 对账测试（Decision 8）；至少一个负向用例——构造契约外字段的通知帧验证 server 端运行时防御仍在（类型不替代校验）。
- 环境前置（fresh clone 三步缺一不可）：root `npm install`；`npm --prefix packages/daniya-bridge install && npm --prefix packages/daniya-bridge run build`；`npm install --prefix harness/profile`。

## Out of Scope

- C1 的 `ChatRuntime` 抽取与 `HarnessBackend` 端口抽象——独立票，本票只把协议面收拾干净。
- 运行时 schema 校验、协议版本握手、capabilities——同包同发布前提下是投机通用，不做。
- `harness/profile` 侧的 profile/patch 内容、`prepare-harness.mjs` 物化逻辑——零改动。
- 行为语义：除 hygiene 已定收窄外，线协议方法集与载荷语义不变。

## Open Questions

（无——设计已在本地评审收敛；实施中若 `composite` 项目边界出现预案外阻力（如 TS6307 连锁），回退备选是 `src/shared/` `.d.ts` 声明文件方案，须在 PR 说明中显式记录。）
