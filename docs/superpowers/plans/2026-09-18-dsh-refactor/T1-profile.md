# T-1 daniya profile 落地与启动验证

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md`（§4 是本票主体，§13 V-4/V-7/V-8 是预留验证点）
- 参照仓库 `D:\Agents\deepseek-harness` **只读**。关键文件：
  - `packages/bundle/sdk-minimal/cordis.patch.yml` —— daniya profile 的底（完整显式树）
  - `packages/boot/app-boot/README.zh.md` —— profile 结构、`loadProfileDirectory`、patch 语义
  - `apps/desktop-host/src/` —— dsh 自家桌面端如何用私有 host 加载自持 profile（我们的参照）
  - `apps/cli/` —— `dsh --profile`/`--dump-config` 的实现位置
- `packages/daniya-bridge` 骨架已由主会话建好（stub 插件，apply 为空函数）。profile 的 `file:` 依赖指向它。

## 目标

`dsh` 能以 `daniya` profile 启动：组合 = sdk-minimal 底 + spec §4 的 patch 定制；启动命令与 env 变量写成文档，供 T-3 spawn 与 T-5 打包使用。

## 文件所有权（只能改这些）

- `harness/**`（profile 项目、启动脚本、README）
- `.dev-dsh-home/**`（dev 用 Harness home，gitignore；如选择此方案）
- `.gitignore`（追加 harness 产物行）
- `package.json` 的 scripts 可追加 `dev:harness` 一条

**禁止**：`packages/daniya-bridge/src/**`、`src/**`、`docs/**`、`D:\Agents\deepseek-harness` 下任何文件。

## 任务

1. 补全 `harness/profile/package.json`：`dsh.profile.bundles: ["@deepseek-ai/dsh-sdk-minimal"]`；`dependencies` 列出 spec §4 新增行所需的全部 `@deepseek-ai/dsh-*` 包（attachment、web、web-search-deepseek、web-fetch-http、tool-web、compaction-basic、compaction-tool-result-pruner、token-meter）+ `@deepseek-ai/dsh-sdk-minimal` + `daniya-bridge: file:../../packages/daniya-bridge`。版本钉定：先 `npm view @deepseek-ai/dsh versions` 确认 npm 实际发布版本，优先与参照仓库 `0.1.6-alpha.2` 对齐；不一致时取 npm 最新发布并在报告中说明。
2. 补全 `harness/profile/cordis.patch.yml`：按 spec §4 实现禁用/调整/新增三层。patch 行 id 必须与 `packages/bundle/sdk-minimal/cordis.patch.yml` 中的实际 id 一致（逐个核对）；禁用语法（`- id: X / disabled: true` 还是整行替换）以 app-boot patch 语义为准——先写最小验证用例确认。
3. `npm install`（harness/profile 目录内）。`file:` 依赖若产生符号链接问题，用 `--install-links` 物化。bridge 的 `lib/` 不存在时先 `npm --prefix ../../packages/daniya-bridge run build`（骨架有 stub build）。
4. 确定启动方式并验证：
   - 候选 A：`node node_modules/@deepseek-ai/dsh/lib/bin.js --profile daniya`（先查 `@deepseek-ai/dsh` 的 `bin` 字段与 CLI 对 `--profile` 的解析——它是否只认 `$DSH_HOME/profiles/<name>`？）
   - 候选 B：`DSH_HOME=.dev-dsh-home` 下物化 `profiles/daniya`（复制或链接 `harness/profile`）
   - 候选 C：写 `harness/launch.mjs` 调 `@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory`（参照 `apps/desktop-host/src` 的用法）
   - 以实际可用者为准；命令必须可重复执行、stdin/stdout 归 bridge 协议独占。
5. 组合验证：
   - `--dump-config`（若 CLI 支持）或等价手段导出最终行集合；
   - 断言：模型可见工具 = `pwsh` + `web_search` + `web_fetch`；`sdk-jsonrpc-server`/`sdk-app-startup`/`session-log-deepseek`/`plugin-package-inventory-deepseek` 已禁用；`attachment-local`/`web`/`tool-web`/`daniya-bridge` 已挂载；
   - 无 `DEEPSEEK_API_KEY` 时启动不得因凭据缺失而崩（凭据按请求解析）。
6. 写 `harness/README.md`：dev 启动命令（含全部 env：`DSH_HOME`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DANIYA_SETTINGS_FILE`、`DANIYA_WORKDIR`）、目录布局、依赖更新方法、已知限制。
7. 追加 `package.json` script：`"dev:harness"` = 一键启动 dev profile（供 T-3 与手动联调用）。

## 验收标准

- [ ] `harness/profile` 下 `npm install` 干净通过（锁文件入库）
- [ ] 文档化的启动命令真实可用，进程拉起后保持存活（bridge stub 不退出则进程存活即可）
- [ ] 组合证据：最终行集合输出贴进报告，逐条对上 spec §4 意图
- [ ] `harness/README.md` 可让第三人零上下文复现启动
- [ ] `npm run dev:harness` 可用
- [ ] 报告列出：选用的 dsh 版本、启动方案（A/B/C）及理由、patch 语法实测结论、遗留问题

## 备注

- `sandbox-policy` 的 `workspaceRoot` 先用 `!!js process.env.DANIYA_WORKDIR || process.cwd()`；运行时按会话改写由 bridge 负责（T-2）。
- stdin/stdout 纯净性：profile 不得引入任何 stdout logger；启动器自身输出走 stderr 才合规。
