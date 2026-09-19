# T-5 打包分发管线

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md`（§9 分发、§13 V-7 可搬性验证）
- **阻塞于 T-1 + T-2 + T-3**：需要 profile 安装布局定型、bridge `lib/` 产物、主进程 spawn 路径三者就绪。
- 参照仓库 `D:\Agents\deepseek-harness` **只读**。`apps/desktop/README.zh.md` 记录了 dsh 自家桌面端的同款模式（`ELECTRON_RUN_AS_NODE` + 随包 dsh 依赖树），可参考其思路但不要照抄其复杂度。
- 目标：个人应用、Windows only、不需要签名/自动更新——**比 dsh desktop 简单得多**。

## 目标

`npm run pack` 产出可用的 NSIS 安装包：安装后应用能拉起随包的 dsh 运行时并完成一轮对话（无系统 Node 依赖）。

## 文件所有权

- `package.json`（build 配置、scripts）
- `scripts/`（新建打包辅助脚本）
- `electron-builder` 相关配置（package.json `build` 节）
- `src/main/harness/process.ts` 的 spawn 路径逻辑（**仅此文件可动**，且只改"开发/打包两态路径解析"——其余逻辑属 T-3，改动须在报告单列）

**禁止**：`src/renderer/**`、`packages/daniya-bridge/src/**`、`docs/**`、`harness/profile/cordis.patch.yml`（组合属 T-1；若缺行先回报）。

## 任务

1. **pack 期 staging 脚本** `scripts/prepare-harness.mjs`：
   - 在 `harness/profile` 跑 `npm install --omit=dev --install-links`（`file:` 依赖物化为实体副本而非符号链接——V-7 验证点）；
   - `daniya-bridge` 先 `npm run build` 产出 `lib/`；
   - 产物归集到 `resources/harness/`（profile 目录含 `node_modules`、`cordis.patch.yml`、`package.json`）；
   - 输出体积与文件数统计到报告。
2. **electron-builder 配置**：`extraResources` 把 `resources/harness` 带进安装包（如 `resources/harness/**` → `resources/harness/`）；`asarUnpack` 视需要（spawn `node` 子进程读的文件必须在 asar 外）。
3. **首启物化 + spawn 路径**（`src/main/harness/process.ts` 内两态解析）：
   - dev：`harness/profile`（仓库内，已 npm install）；
   - packaged：`process.resourcesPath/harness` 为只读模板 → 首启复制到 `userData/harness/profile`（复制含 node_modules 整树；已存在且版本一致则复用——用 `resources/harness/.stamp` 记录版本戳判定）；
   - spawn：`ELECTRON_RUN_AS_NODE=1` 的 Electron 自身执行 dsh bin（`process.execPath` + env `ELECTRON_RUN_AS_NODE=1`），参数按 T-1 文档化命令；备选 `node` 若不可用。
   - `DSH_HOME` = `userData/harness/home`。
4. **验证**：
   - `npm run pack` 干净通过；
   - 解包/安装产物检查：`resources/harness/` 存在且含完整 node_modules；
   - 冒烟（无真 Key 可降级）：装后启动应用 → harness 进程拉起 → stderr 无 EADDRINUSE/模块缺失；（有 Key 时由集成验收跑完整对话）。
5. `package.json` scripts 串链：`pack` = `prepare-harness && electron-vite build && electron-builder --win`；`prepare:harness` 独立可调。

## 验收标准

- [ ] `npm run prepare:harness` 产出 `resources/harness`（含物化 node_modules，无符号链接残留——脚本内断言）
- [ ] `npm run pack` 绿；安装包内含 harness 树
- [ ] 安装后首启物化逻辑正确（新版本/重复启动两路径）
- [ ] spawn 路径 dev/packaged 两态均有证据（日志或手工）
- [ ] 报告列出：产物体积、首启物化耗时感受、对 T-3 process.ts 的改动 diff 摘要、遗留问题（如 AV 软件误报风险、体积）

## 备注

- 体积预期：dsh 依赖树可能 100-300MB——个人应用可接受，但报告中如实给数。
- 不做：代码签名、自动更新、多平台。
