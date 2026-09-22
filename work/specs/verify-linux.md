# Spec: verify-linux —— verify-profile.mjs 断言平台化

属 effort `work/maps/slim-perf.md`。本票是 `slim-installer` 验收的前置：裁剪兜底工具必须先能在 Linux 给出真 pass/fail。

## Problem

`harness/verify-profile.mjs` 是 profile boot 冒烟的唯一自动门禁，但 4 处断言写死 Windows 期望：`persistent-pwsh` 必 ACTIVE、`terminal-bash`/`persistent-bash` 必不 ACTIVE、工具集必为 `[pwsh, web_fetch, web_search]`。Linux 上平台分支（`dsh-sdk-minimal/cordis.patch.yml` 的 `!!js process.platform !== 'win32'`）正确激活 bash 集，却被判为恰 4 项失败——脚本在 Linux 恒红，无法作为"删依赖后 boot 照过"的机械验收工具。

## Outcome

`node harness/verify-profile.mjs` 在 Linux 上对健康 profile 树 exit 0、failures 为空；同一脚本在 Windows 上仍断言 pwsh 集。脚本可被 `slim-installer` 复用于对 `build/harness-bundle` 暂存产物跑同一套门禁。

## User Stories

1. As a Linux 开发者/执行代理， I want `verify-profile.mjs` 按平台断言正确的激活面， so that 裁剪后的冒烟在 Linux 给出可信 pass/fail。
2. As a 复核者， I want 同一脚本可对暂存产物目录运行， so that 验收的是真正进包的那棵树而非开发树。
3. As a Windows 维护者， I want win32 断言不变弱， so that 平台化不是放松而是对称收紧。

## Decisions

1. 平台期望的唯一判定键 = `process.platform === 'win32'`，与 `dsh-sdk-minimal/cordis.patch.yml` 的 `!!js` 行同源：
   - win32 → ACTIVE 集含 `terminal-pwsh`、`persistent-pwsh`；`terminal-bash`、`persistent-bash` 不得 ACTIVE；工具集 `[pwsh, web_fetch, web_search]`。
   - 非 win32 → ACTIVE 集含 `terminal-bash`、`persistent-bash`；`terminal-pwsh`、`persistent-pwsh` 不得 ACTIVE；工具集 `[bash, web_fetch, web_search]`。
2. `persistent-pwsh` 从无条件 `mustBeActive` 移入平台集；同时把此前未断言的 `terminal-pwsh`/`terminal-bash` ACTIVE 侧补齐——双平台对称：每侧都是"两活两死+工具集"。
3. 脚本接受可选位置参数 = harness 根目录（默认 `harness/`），profile 目录取 `<arg>/profile`；`smoke-bridge.mjs` 同样接受该参数（本票或 slim-installer 落地均可，先到先改）。`DSH_HOME` 默认逻辑不变。
4. 仓库无 CI 设施，不新增 CI；门禁契约 = 非交互、exit 0/1、报告走 stderr、stdout 零输出（本脚本同时是 stdout 纯净探针，该职责保留）。
5. 其余断言（4 个 DISABLED 条目、sandbox-policy、services 解析、entries 报告）原样保留，不随平台分支。

## Testing

- Linux 本机：`node harness/verify-profile.mjs` → exit 0、`failures: []`、entries 中 bash 双条目 ACTIVE / pwsh 双条目 NO_FIBER、工具集 `[bash, web_fetch, web_search]`。
- 回归：`npm run typecheck` + `npm run test` 全绿（本票只动 .mjs 脚本，预期零回归）。
- win32 侧断言无法本地执行——对称性靠"与 patch 文件同一 `process.platform === 'win32'` 判定键"构造保证；Windows 复核清单含本脚本 win32 复跑。

## Out of Scope

- CI 流水线搭建（无 CI 设施可挂）。
- smoke-bridge.mjs 的其余改造（真实 LLM 冒烟与否由 env 决定，不在本票）。
- profile/patch 内容本身的任何改动。

## Open Questions

无。
