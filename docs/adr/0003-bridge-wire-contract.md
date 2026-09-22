# ADR 0003: bridge 线协议契约以纯类型文件承重（零导入 + 跨 tsconfig include）

日期：2026-09-22　状态：已落地（bridge-contract 票，PR #7）

## 决策

daniya-bridge 与 Electron 主进程之间的按行 JSON-RPC 协议，契约真相是 `packages/daniya-bridge/src/protocol.ts` 一个**零导入的纯类型文件**：`BridgeParamsMap`/`BridgeResultMap`/`BridgeNotificationMap` 三张索引 + `BridgeNotification` 判别联合。server 侧分派表与 main 侧 `DaniyaBridge` 门面都编译期受它约束；main 侧经 type-only 相对路径引用，`tsconfig.node.json` 把该文件 include 进根项目编译面。运行时校验仍靠 server handler 的 `typeof` 防御，不引入 schema 校验器或版本握手。

## 理由

- 两包无共享编译面：根项目与 daniya-bridge 各有 tsconfig，且根包**不依赖** bridge 包——`file:` devDep 会把约 1.1GB 的 dsh 依赖树拖进根 node_modules，与 slim-perf 裁剪方向冲突。type-only 相对路径 import + include 是不产生运行时依赖的最小共享机制。
- 契约文件一旦 import 任何模块，被引文件会被牵连进根项目 include 清单（TS6307 连锁报错）——零导入是这个机制成立的前提，故以文件头注固化为铁律。
- 声明式契约（类型表 + 判别联合）比运行时 schema 便宜：协议两侧同仓同发布，帧信任契约构造；漂移的防线是"改字段即编译错"+ fixture `satisfies`/`toEqual` 对账测试，而不是线上校验。

## 代价与后果

- `protocol.ts` 永不得有 import 或运行时语句；新增线方法/字段要同步三张映射表，漏一侧即编译错——这是特性不是负担。
- `fake-bridge.mjs` 保持零依赖 `.mjs` 不能被类型直接约束，由 `src/main/harness/fake-bridge.test.ts` 形状断言对账。
- main 侧消费线类型统一从 `src/main/harness/client.ts` re-export 进入，不各自回指包内路径。
