# Spec: first-boot-copy — 首启物化拷贝是否可省的判定与方案设计

Dispatched: daniya-chat@feat/first-boot-copy — 2026-09-22 — fairybox:spec-first-boot-copy

研究票：交付物是一份带代码级证据的判定与方案报告，不改生产代码。属于 effort `work/maps/slim-perf.md`（体积/性能优化）。

## Problem

packaged 形态首启要把 `<install>/resources/harness` 整棵树（621MB，裁剪前）经 `fs.promises.cp` 拷到 `<userData>/harness/app` 可写目录——双倍磁盘占用 + 首启 GB 级 IO（虽有 `prewarm()` 后台拷贝兜底）。已证实的直接原因写在 `src/main/harness/process.ts`（`defaultHarnessSpec` 注释）：**loader 会往 profile 目录写 `cordis.yml`，而安装目录 resources 只读**。但"运行时到底有几处写点""能否用更小的可写覆盖面替代整树拷贝"从未被系统回答。

## Outcome

`work/maps/slim-perf/first-boot-copy.md` 随本分支合回：完整回答三件事——(a) 为什么拷（代码级证据链，file:line 引用）；(b) 运行时写点穷举（除 cordis.yml 外还有什么写进 profile 树）；(c) 候选方案对比表（就地运行 / 可写覆盖 / junction 混合 / 保持拷贝但随裁剪缩水 / 其他自研方案）各自动用的文件、破坏或保住的既有保证、量级收益，外加一个推荐。复核者能按行号复核每个写点断言。

## User Stories

1. 作为 slim-perf effort，我要物化拷贝的完整动机清单，使方案评估不遗漏约束。
2. 作为实现者，我要每个候选方案列出"改哪些文件、破坏/保住哪些既有保证（.stamp 升级判定、.tmp-\<pid\> 原子 staging、V-7 包内零符号链接、B-7 node.exe 宿主）"，使后续 spec 直接采纳。
3. 作为复核者，我要区分"代码实证"与"推测"，推测处标明验证方法与待 Windows 复核点。

## Decisions

1. 交付物只有报告：`work/maps/slim-perf/first-boot-copy.md`，不改生产代码。
2. 已证实写点：loader 往 profile 目录写 `cordis.yml`（`src/main/harness/process.ts` 中 `defaultHarnessSpec` 注释 + `harness/README.md` 目录布局节）。其余写点由研究穷举——重点查：loader 是否还写别处；`resolutionMode: 'runtime'` 是否真零磁盘写入（launch.mjs 注释称 link/dual 会物化链接、runtime 不写）；DSH_HOME 数据面（sessions/附件/日志）是否已与 profile 目录完全分离。
3. 方案评估必须对照的既有保证：B-7（harness 宿主必须是真 node.exe）、`.stamp` 升级整树重拷语义、`.tmp-<pid>` staging 原子性、V-7（**安装包内**零符号链接——注意它约束的是包内；用户侧 userData 里建 junction 指向安装目录是独立设计点，按证据评估而非套用包内约束）。
4. 必须写明与 `dead-deps-scan` 的交互：裁剪若把树砍到 ~290MB，拷贝成本/方案收益需重新评估——两份报告口径要一致（都用 win32-x64 621MB 基线说话）。
5. 实证可在 Linux 做：`node harness/launch.mjs` 就地 boot 后对 `harness/profile/` 做写点扫描（boot 前后 `find -newer` / inotify），确认 linux 下运行时写点集合；win32 差异（如 Program Files 只读假定、junction 行为）标注为待 Windows 复核。
6. 顺带量级实测：linux 上 `fs.promises.cp` 621MB/26k 文件耗时数量级，写进报告作冷启动段输入。

## Testing

- 每个"写点"断言带 file:line 或运行时实证（写点扫描输出）。
- 环境前置（fresh clone 三步缺一不可）：root `npm install`；`npm --prefix packages/daniya-bridge install && npm --prefix packages/daniya-bridge run build`；`npm install --prefix harness/profile`。
- 完成后 root `npm run typecheck && npm run test` 须全绿（本 spec 不该有影响，防误伤）。

## Out of Scope

- 实施任何方案——归后续 spec。
- Windows 真机验证（junction、Program Files 只读、首启计时）——报告中标注为待复核项。
- Electron 侧冷启动分解（main 进程就绪到可发消息的耗时分布）——归后续基线 spec。

## Open Questions

（无——本票不阻塞于未决项。）
