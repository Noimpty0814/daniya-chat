# Spec: slim-installer —— 死依赖裁剪落地进打包暂存

属 effort `work/maps/slim-perf.md`。判定证据与名单见 `work/maps/slim-perf/dead-deps.md`（PR #5）：351 dead + 2 win32-only 变体 = 353 项 blocklist，三重证据（激活面缺席 + require 闭包不触达 + linux 累积删后冒烟 CLEAN）。**前置：`verify-linux` 已落地**——本票验收用平台化后的 verify-profile 当兜底门禁。

## Problem

`prepare-harness.mjs` 把 `harness/profile/node_modules` 全量拷进暂存（win32-x64 实测 643MB / 26.5k 文件），其中 ~548MB（85%）是激活面与 require 闭包双缺席的死依赖——libreoffice-kit 330MB、otel 40MB、pi-ai 多供应商链 69MB、octokit/aws/mcp 42MB 等。产品只用 DeepSeek + web + bash/pwsh 工具面，这些字节随安装包发给每个用户。

## Outcome

`npm run prepare:harness` 产出的 `build/harness-bundle` 不再含 blocklist 目录；Linux 上对暂存产物跑 `verify-profile.mjs` exit 0 + `smoke-bridge.mjs` 全 PASS——即"删掉后 profile boot 冒烟照过"的机械验收达成。win32 boot 复核留 Windows 清单（spec 内写明步骤）。

## User Stories

1. As a 用户， I want 安装包不携带永不激活的依赖， so that 下载/安装/磁盘占用缩水 ~85%（harness 部分）。
2. As a 复核者， I want 裁剪结果以暂存产物实测 boot 验收， so that 判定基于进包的那棵树而非推断。
3. As a 维护者， I want blocklist 有出处注释且名单漂移只警告不炸构建， so that dsh 版本升级后构建不因名单陈旧而断。

## Decisions

1. blocklist 落 `scripts/dead-deps.mjs`：导出 `DEAD_DEPS: Set<string>`，353 项**逐字**取自 `dead-deps.md` §建议 blocklist 代码块，头注写清出处与三重证据口径。独立文件而非内嵌 prepare-harness——名单可 grep/diff/复用。
2. 裁剪点在 `prepare-harness.mjs` 的 `node_modules` cpSync filter：`path.relative(nodeModulesRoot, src)` 取包键（首段；`@scope` 开头则取前两段）命中 `DEAD_DEPS` 即跳过整目录。只判顶层包目录，不递归匹配嵌套 `node_modules`（报告落地提示原口径）。
3. 名单漂移容忍：blocklist 项在树中不存在 → 打 warn 日志列出，不 fail（lockfile 传递漂移正常）；存在且被裁 → 计数进统计。
4. 暂存断言新增：遍历 staging 的 `node_modules` 顶层包目录，**任何一个**命中 DEAD_DEPS 即 fail（防 filter 逻辑漏剪）；`mustExist`/零 symlink/dev 产物断言原样。
5. 验收门禁（不加进 prepare-harness 本体，构建保持快且确定性）：新增 npm script `verify:bundle` = `node harness/verify-profile.mjs build/harness-bundle && node harness/smoke-bridge.mjs build/harness-bundle`。两脚本的位置参数若 `verify-linux` 未带，本票补。
6. `.bin` shim、`.package-lock.json`、lockfile、profile `package.json` 全部不动（报告：残留 shim 指向已删包无害；npm 层依赖摘不掉也不摘）。
7. unknown 三包（`@img/sharp-wasm32`、`@emnapi/runtime`、`node-addon-api`）**不入** blocklist，随树照发。
8. 统计输出扩展：既有 files/size 行外，加一行 `pruned <n>/<total> dirs` 便于核账。
9. Windows 复核步骤（写进 PR 描述与 Windows checklist，不阻塞 Linux 合并）：win32 机器 `npm run pack` → 安装 → 跑 `node resources/harness/../... verify-profile`（或直接应用内发消息+bash/pwsh 工具调用）确认 boot 与 pwsh 工具链正常；优先复核 g5 注记标的 pwsh 家族近邻（`dsh-tool-pwsh`、`dsh-pwsh-sandbox` 已被裁——若 win32 实测有隐藏装载点，它们是首个嫌疑）。

## Testing

- Linux 本机顺序执行：`npm run prepare:harness` → `npm run verify:bundle`：verify exit 0、smoke 全 PASS。
- 暂存产物断言在脚本内自执行（决策 4）；人工复核点：`build/harness-bundle/profile/node_modules` 下 `openai`、`@deepseek-ai/dsh-web-app`、`@opentelemetry/api` 缺席，`sharp`、`node-pty`、`@deepseek-ai/dsh-tool-pwsh-persistent` 在场。
- 体积核账：暂存 `node_modules` 体积从 ~491MB（linux dev 树口径）降至 ~100MB 量级；日志行可核对。
- 门禁：`npm run typecheck` + `npm run test` 全绿（脚本改动预期零回归，照跑兜底）。

## Out of Scope

- 锁文件/package.json 依赖声明改动（npm 层摘不动，报告 §方法已论证）。
- dev 树 `harness/profile/node_modules` 裁剪（开发树保持 npm install 原样，裁剪只作用于进包暂存）。
- win32 实机 pack/install/boot——Windows 清单项。
- unknown 三包收口、向 dsh 上游提拆包/条件写需求。

## Open Questions

无。
