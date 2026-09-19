# dsh 重构实施票（2026-09-18）

> **状态：全部完成，T-6 验收"有条件通过"后修复轮已收口**（2026-09-19）。
> 真实链路证据：`harness/smoke-bridge.mjs` 全绿（initialize→session→prompt→真实流式 `{EMO:happy}…`→CRUD→shutdown）；
> `scripts/smoke-packaged-harness.mjs` 对 `dist/win-unpacked/resources/harness` 全绿；
> `npm run typecheck` / `vitest`（174）/ `npm run build` / `npm run pack`（NSIS 270.7MB）全过。
>
> **T-6 缺陷修复轮**（验收报告 B-1～B-7 + K 项）：
> - B-7（pwsh PTY 即退）：根因 = electron-as-node 是 GUI 子系统，在 ConPTY 下拿不到
>   控制台，windows-acl runner 以 `process.execPath` 为宿主整条沙箱链静默死。
>   修法 = 宿主换真 Node：packaged 自带 `runtime/node.exe`（prepare-harness.mjs 复制
>   构建机 process.execPath），dev 回退 PATH `node`。已验证：物化 bundle + bundled
>   node.exe 跑 `pwsh echo` → `ok:true "HELLO-DANIYA"`。
> - B-6（实时事件丢失）：`stream.end` 是"单条 assistant 消息"边界而非请求终态——
>   多步 turn 为 中间消息→tool.*→终帧 多 end 序列。修法 = 仅 `aborted` 终帧直接收尾，
>   正常终态由 `agent.status→idle` 落地（`maintenance` 相也映射 idle 且仅从 idle 进入，
>   不产生中段误发——已核实）。fake-bridge 加 `[toolturn]` 剧本回归。
> - B-5：首消息自动标题（沿用旧约定：空白折叠取 20 字，`titleOverride` 只在未手动
>   改名时写入）。
> - B-1：窗口出生时即以光标附近坐标创建（`boundsNearCursor` 进构造参数）。
> - K：`.stamp` 接入物化判定（模板有戳→戳不一致整树重拷，先落 `.tmp` 再换名）；
>   `npm run pack` 已重出含新 UI/profile 的安装包。
> - env 封堵：settings 无 key 时删除继承的 `DEEPSEEK_API_KEY`/`BASE_URL`/`DANIYA_WORKDIR`；
>   不再向子进程转发 `ELECTRON_RUN_AS_NODE`。
> - 默认模型 → `deepseek-flash`（验收实测：图像输入可用；`deepseek-chat` 官方已下线）。
>
> **复测通过后的 B-8 修复**（升级首启主线程冻结 2.5min）：
> - 根因：`.stamp` 不一致 → `fs.cpSync` 在主线程同步拷 1.14GB，托盘/IPC 全死；
>   被杀后还泄漏 `app.tmp-<pid>` staging。
> - 修法：物化全程 `fs.promises`（拷贝走线程池）；函数源 spec 支持 Promise 并缓存
>   （prewarm 与 ensure 共享同一物化，不双拷）；`whenReady` 即 `runtime.prewarm()`
>   后台开拷（进程仍惰性拉起）；物化期间任务栏不确定进度作可见状态；入口无条件
>   清扫遗留 `app.tmp-*`。
> - 回归：stamp/清扫/回调用例全绿；B-1 冻结现场的定位偏移归因于冻结本身，已随本修复消解。
> 已知遗留：session.delete 不删磁盘日志（append-only，bridge README 已记）；
> AOCI 索引缺失（另行 repository-setup）。

规格：[../specs/2026-09-18-dsh-refactor-design.md](../../specs/2026-09-18-dsh-refactor-design.md)（所有票的第一必读）

## 依赖图

```
T-0 骨架（主会话已完成，非子代理票）
 ├─ T-1 daniya profile 落地与启动验证   ─┐
 ├─ T-2 daniya-bridge 插件实现          ─┤ 三者文件集不相交，全并行
 └─ T-3 主进程接线（harness 客户端+IPC）─┘
        │
        ├─ T-4 渲染层调整 + 旧代码删除 + 文档  （依赖 T-3 的 shared/types 与 preload 定型）
        └─ T-5 打包分发管线                    （依赖 T-1 profile 布局 + T-2 构建产物 + T-3 spawn 逻辑）
             │
             └─ T-6 真实 GUI 验收（computer-use 驱动，见 T6-acceptance.md）

集成验收：T-1~T-5 由主会话完成（协议/打包冒烟全绿）；T-6 为人工等价路径最后一道门
```

## 阻塞关系

| 票 | 阻塞于 | 原因 |
|---|---|---|
| T-1 | T-0 | profile 依赖 `file:../../packages/daniya-bridge` 需骨架存在 |
| T-2 | T-0 | 在骨架包内实现 |
| T-3 | T-0（仅名义） | 按 spec §5.2 协议编码；真实联调等 T-1/T-2 落地后由集成阶段完成 |
| T-4 | T-3 | renderer 消费 shared/types + preload 契约 |
| T-5 | T-1, T-2, T-3 | 需要 profile 安装布局、bridge lib 产物、spawn 路径三方定型 |

## 通用约束（每张票都携带，此处备份）

- 项目：`D:\Agents\daniya-chat`（Electron + React + TS，npm；Windows only）
- 参照仓库：`D:\Agents\deepseek-harness`——**只读**，不得修改其中任何文件；其 `packages/`、`docs/` 是 API 事实来源
- 只改本票"文件所有权"列出的路径；不提交 git、不建分支/PR、不动范围外文件
- `dsh` 版本钉定：与参照仓库对齐 `0.1.6-alpha.2`（以 npm 实际发布为准，记录选用版本与理由）
- 测试：`npx vitest run`；类型检查 `npm run typecheck`
- 完成报告格式：**做了什么 / 证据（关键命令输出）/ 与 spec 的偏差 / 未解决的验证点 / 风险**
