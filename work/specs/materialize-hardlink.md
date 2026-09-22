# Spec: materialize-hardlink —— 首启物化改硬链接农场

属 effort `work/maps/slim-perf.md`。方案与实测见 `work/maps/slim-perf/first-boot-copy.md`（PR #4，方案 C）。

## Problem

packaged 形态首启把 `resources/harness`（win32-x64 实测 621MB / 26,482 文件）整树拷到 `<userData>/harness/app`：Linux 实测 `fs.promises.cp` ~25s（瓶颈是文件创建/元数据而非字节），用户磁盘双倍占用。研究报告已实证唯一硬写点是 `profile/cordis.yml`（223B），整树可写需求收敛到单文件——硬链接农场用 inode 共享替代逐字节拷贝，实测 25s→3.5s、边际磁盘 643MB→~13MB。

## Outcome

`ensureHarnessMaterialized` 在同卷场景下以 mkdir+link 物化整树；跨卷/权限拒绝时自动退回既有整树拷贝，行为与今日完全一致。既有保证全部保留：`.stamp` 复用判定、`.tmp-<pid>` staging 原子换名、入口清扫、`onMaterialize` 回调、B-7（node.exe 硬链接同 inode 可执行）、B-8（全程 `fs.promises`，主线程不冻结）。单元测试在 Linux 可全部跑通。

## User Stories

1. As a Windows 用户， I want 首启/升级后 harness 秒级就绪， so that 首次发消息不等 ~25s 拷贝。
2. As a 装在非 C 盘的用户（`allowToChangeInstallationDirectory` 已开）， I want 跨卷场景仍能正常启动， so that D: 盘安装不崩。
3. As a 复核者， I want 链接失败静默回退拷贝而非新错误路径， so that 最坏情况 = 今日行为。

## Decisions

1. 改动面仅 `ensureHarnessMaterialized` 内部：staging 填充从 `fs.promises.cp(template, staging, {recursive:true})` 换成链接农场遍历——逐目录 `mkdir`、逐文件 `fs.promises.link`。遍历全程 `fs.promises` API（B-8），不用 `*Sync`。
2. `.stamp` 与 `cordis.yml`（若模板未来携带）**真实 `copyFile` 不链接**：`.stamp` 是"本次物化对应模板版本"的副本语义，不该与模板共享 inode；`cordis.yml` 是运行时必写点（报告 §2-W1），链接会让运行时截断写穿到只读模板 inode。
3. 链接农场内任一文件 link 失败（EXDEV 跨卷 / EPERM / EACCES / EMLINK 超链接上限）→ 放弃该 staging、整树 `fs.promises.cp` 重填，走原有 rm+rename。**整树回退，不做链接/拷贝混合树**——混合树没有可辩护的语义。
4. 复用判定、staging 命名与清扫、rename 换名、`onMaterialize` 回调时序全部不改；dev（非 packaged）路径不经过本函数，零影响。
5. 模板内符号链接当前不存在（V-7 断言包内零 symlink）；遍历遇到符号链接时按文件处理（link 其路径即共享 inode）——若未来模板含 symlink 需另议，本票在注释中标注该假设。
6. NTFS 细节（1023 链接上限、同卷约束、Defender 观感）属 Windows 复核项 WR-3/WR-6：不阻塞本票，但 spec 落地后须在 Windows checklist 中复跑首启计时。

## Testing

- `src/main/harness/process.test.ts` 扩 `ensureHarnessMaterialized` 组：
  - 链接农场产物文件与模板 `fs.stat().ino` 相同（真共享 inode）；目录结构完整可遍历。
  - `.stamp` 是独立 inode（真实拷贝），内容一致。
  - 既有用例全绿：同戳复用、异戳重拷、无戳模板旧行为、`.tmp-*` 清扫、`onMaterialize` 时序。
  - 回退路径：强制 link 抛 `EXDEV`（如 `vi.spyOn(fs.promises, 'link')`）→ 产物为真实拷贝、功能正常、无半成品 staging 残留。
- 判定标准：测外部行为（产物树的 inode 关系、复用语义、回退正确性），不测遍历实现细节。
- 门禁：`npm run typecheck`、`npm run test`、`npm run build`（动了 main 进程代码）。

## Out of Scope

- junction 壳（方案 D）、上游条件写（方案 E）、ACL 方案（F）——报告已定 C 先行、E 终态、D 备选。
- Windows 实测复核（WR-3/WR-6）——属 checklist，非本票验收。
- dev 形态、`prepare-harness.mjs`、安装包内容。

## Open Questions

无。
