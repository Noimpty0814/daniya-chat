# Report: first-boot-copy — 首启物化拷贝是否可省

> 研究票交付物（`work/specs/first-boot-copy.md`），不改生产代码。
> 实证环境：Linux x64（fairybox），node v22.23.2，`@deepseek-ai/*@0.1.6-alpha.2`。
> 体积基线统一用 win32-x64 物化树 **621MB / 26,482 文件**（`work/maps/slim-perf.md` 基线事实），
> 与 `dead-deps-scan` 报告同口径。本机 scratch 复测见 §3。

## 0. 结论速览

- **拷贝的全部硬性理由收敛为一个写点**：`runProfile`/`composeProfile` 每次启动向
  `profile.dir/cordis.yml` 无条件重写空根配置（`profile-boot-BNu17Y9U.js:207`），
  只读的 `resources/harness` 下该写直接 EACCES 崩 boot（§3-E2 实测）。其余数据面
  全部落 `DSH_HOME`，与 profile 树已完全分离（§2-W4，strace + `find -newer` 双实证）。
- **最小可写覆盖面 = 一个 223 字节文件**：整树置只读、仅 `cordis.yml` 可写时完整
  boot + 断言全绿（§3-E3）。目录级写只在 Loader 树回写（`cordis.yml.tmp`→rename）
  时需要，且该路径有 `readonly` 优雅降级（§2-W2）。
- **推荐**：短中期落地 **方案 C（硬链接农场物化）**——保留 `.stamp`/`.tmp-<pid>`/
  B-7 全部既有保证，首启 IO 25s→3.5s、双倍磁盘 621MB→~13MB（§3-M2）；
  终态推 **方案 E（dsh 上游条件写 + 包内带 cordis.yml）**，零拷贝零机制；
  **方案 D（junction 混合壳）** 已在 Linux 实证可行（§3-E4），作备选。

## 1. (a) 为什么拷 — 代码级证据链

打包形态下 `resources/harness` 位于安装目录（Program Files），对标准用户只读；
运行时却必须向 profile 目录写 `cordis.yml`——矛盾的两端各有实证：

**只读端（安装侧）**

| 断言 | 证据 |
|---|---|
| harness 树经 extraResources 进 `<install>/resources/harness` | `package.json:29-38`（`build/harness-bundle`→`harness`） |
| 暂存产物刻意不含 `cordis.yml`（运行时产物不进包） | `scripts/prepare-harness.mjs:20,74` |
| 包内零符号链接断言（V-7） | `scripts/prepare-harness.mjs:163` |
| 自带 `runtime/node.exe`（B-7：electron-as-node 无 ConPTY 控制台） | `scripts/prepare-harness.mjs:108-112`；`src/main/harness/process.ts:107-112` |

**写入端（运行时侧）**

| 断言 | 证据 |
|---|---|
| `launch.mjs` 就地解析 profile：`profile.dir = <harnessDir>/profile` | `harness/launch.mjs:24` |
| 模块解析锚在 profile 自身 `package.json`（`createRequire`）+ install 锚 `@deepseek-ai/dsh` | `harness/launch.mjs:32,39` |
| `cordis.yml` 被标注为 gitignored 的 loader 运行时产物 | `harness/README.md:88`（目录布局节） |
| boot 无条件写 `profile.dir/cordis.yml`（空根配置），`resolvedProfile` 路径在 `composeProfile` 内 | `…/dsh/lib/profile-boot-BNu17Y9U.js:207`（命名 profile 路径同款在 `:188`） |
| 该文件存在的理由：Loader 需要一个真实 include 根来把 `baseUrl` 锚在 profile 目录；且 Loader 树回写可能把组合结果烘进此文件，故每次 boot 重置为空 | `profile-boot-BNu17Y9U.js:171-178`（注释原文） |
| `rootConfig = join(profile.dir, 'cordis.yml')` 直接喂给 `boot()` → `ctx.baseUrl` 锚在 profile 目录 | `profile-boot-BNu17Y9U.js:261`；`dsh-app-boot/lib/index.js:2703` |

**拷贝机制本体**

- `src/main/index.ts:105`：`dshHome = <userData>/harness`；`:109-118` 惰性 spec 闭包；
  `:127` `runtime.prewarm()` 应用启动即后台物化（B-8）。
- `src/main/harness/process.ts:100-101`：packaged 时 `ensureHarnessMaterialized(
  resources/harness → <dshHome>/app)`；`:88-90` 注释给出动机（loader 写 cordis.yml、
  resources 只读）——**本报告实证该注释为唯一硬性动机**。
- `process.ts:143-147`：复用判定 = `launch.mjs` 存在 且 `.stamp` 一致；
  `:152-158`：`.tmp-<pid>` staging → `rm(target)` → `rename`（半途不留半成品）；
  `:136-141`：入口清扫遗留 staging。

**两点澄清**（判定"动机清单"时的边界）：

1. `.stamp` 升级重拷、`.tmp-<pid>` 原子 staging 是**拷贝方案自身的配套机制**，不是
   独立的拷贝理由——若不再拷贝，这两者随之失效而非被破坏。
2. "profile 必须与 launch.mjs 相邻、node_modules 必须可从 profile 锚定"是**布局约束**
   （launch.mjs:24,32），junction/硬链接同样满足，不构成对整树拷贝的论证。

## 2. (b) 运行时写点穷举

判定口径：**写点 = 运行时落在 `profile.dir` 树内的文件系统写**。DSH_HOME 侧与
tmpdir 侧单列以证明分离。实证列：✅=本轮 Linux 实测（§3），📄=纯静态断言。

| # | 写点 | 位置（file:line） | 触发条件 | 只读下行为 | 实证 |
|---|------|------------------|---------|-----------|------|
| W1 | `profile/cordis.yml` 截断重写 | `dsh/lib/profile-boot-BNu17Y9U.js:207`（resolvedProfile 路径）；命名路径 `:188` | **每次 boot 无条件** | **EACCES → boot 整体失败**（异常经 `runProfile` 的 try/catch 清理后重抛，无降级路径；§3-E2） | ✅ strace + `find -newer` 双捕获唯一 profile 内写；✅ chmod a-w 复现崩溃 |
| W2 | `profile/cordis.yml.tmp` + `rename` → `cordis.yml`（Loader 树回写） | `cordis-plugin-include/lib/index.js:243-255`（`_writeFile`） | 条件触发：entry create `:230` / remove `:237` / update `:266-267` / `internal/update` 非 noSave `:691-696` / 插件崩溃 bake `disabled:true` `:706-721`（均在 `cordis-plugin-loader`） | `checkAccess()` 探 W_OK→`readonly`（include:162-169）；写失败仅 warn（include:271-274），**不致命** | 📄 静态链；会话全流程 strace 中未触发 |
| W3 | `profile/node_modules` + `profile/.dsh-module-fallback/node_modules` 符号链接 | `dsh-app-boot/lib/index.js:786-817`（`healProfileModuleFallback`）；`:723-726`（isolated 入口 `healIsolatedProfileModuleFallback`）；`:252`（目录名常量） | **仅 `resolvedProfile !== void 0 && resolutionMode !== 'runtime'`**（`profile-boot:212`，即 link/dual）；命名 profile 的 link 模式另写 `$DSH_HOME/profiles/node_modules`（`dsh-app-boot:659-668`） | 只读下 `mkdirSync` 失败→boot 失败 | 📄 静态；daniya 恒为 `runtime`（launch.mjs:45）→ `materialize:false`（`dsh-app-boot:711-716`），✅ strace 确认未创建 `.dsh-module-fallback`（仅 ENOENT readlink 探针） |
| — | `profile/package.json` 重写 | `dsh-app-boot:869`（`writeProfileManifest`←`normalizeShippedProfile:853-871`） | 仅 `loadProfile`（按名解析，`:960`）且名字在 `INSTALLATION_OWNED_PROFILE_TUPLES`（`:361`，仅 `headless`） | — | 📄 daniya 走 `loadProfileDirectory`（`:916-938`，纯读），不触发 |

**W4 — DSH_HOME 数据面（与 profile 树分离的实证）**

| 写点 | 位置 | 实证 |
|---|---|---|
| 会话 JSONL：`$DSH_HOME/sessions/<proj>/<sid>/session.v3.jsonl`、`session.lock`、`.tmp` staging | `dsh-sdk-minimal/cordis.patch.yml:157`（`root: !!js dshHomePath('sessions')`）；`dsh-session-persistence-jsonl:2955-3009` | ✅ strace 全量命中 `/tmp/dsh-home-scan2/...` |
| `.anonymous-user-id` | `dsh-anonymous-user-id/lib/index.js:51-68` | ✅ strace |
| 附件存储 | `dsh-attachment-local/lib/index.js:995`（`resolveDshHome(config.dshHome)`） | 📄 静态（本次冒烟未上传附件） |
| LLM 文件索引 `llm-deepseek/files-v3.json` | `dsh-llm-deepseek/lib/index.js:1667` | 📄 静态 |
| 家目录 patch 层 `$DSH_HOME/cordis.patch.yml` | `profile-boot:115-117` + `dsh-app-boot:1010`（**只读**，不写） | ✅ strace 无写 |

**其他（均不在 profile 树）**

- `dsh-subprocess-local`：shell 集成 rc 写 `os.tmpdir()/dsh-shell-*`
  （`lib/index.js:1167` `mkdtempSync(tmpdir())` + `:1173`/`:1207` `writeFileSync`）；
  `platform === "win32"` 时 `:1164` 提前 return（win32 不产生此写）。
- `daniya-bridge`：运行时零磁盘写（grep 全包仅 `tests/` 命中）。
- 无任何插件在 boot/会话中写 `node_modules` 内部或 profile 元文件（strace 佐证）。

**穷举结论**：profile 树内运行时写点 = **W1（必写、致命）+ W2（条件、可降级）**；
W3 仅 link/dual 模式（本产品不激活）；W4 数据面已实证完全分离。
即：**整棵树 621MB 的可写需求收敛到一个 223 字节文件 + 一个目录写能力。**

## 3. 实测数据（Linux，fairybox）

**环境前置**（按 spec Testing）：root `npm install`；`npm --prefix
packages/daniya-bridge install && run build`；`npm install --prefix harness/profile`。

| # | 实验 | 方法 | 结果 |
|---|------|------|------|
| E1 | 运行时写点扫描 | ①`strace -f -e trace=%file` 跑 `harness/smoke-bridge.mjs` 全生命周期（initialize→session.create/list/history→prompt 真实流式→resume→delete→shutdown），`DSH_HOME=/tmp/dsh-home-scan2`；②spec 字面方法 `find harness/profile -newer <marker>`（`node harness/launch.mjs` boot 前后对比） | ①profile 树内唯一写：`openat(.../profile/cordis.yml, O_WRONLY|O_CREAT|O_TRUNC)`；DSH_HOME 侧：`sessions/` 目录链、`.anonymous-user-id`、`session.lock`、`session.v3.jsonl(.tmp)`；其余零写。②`find -newer` 同样仅命中 `cordis.yml`，两法互证 |
| E2 | 只读 profile boot | `chmod -R a-w harness/profile` 后 `node harness/launch.mjs` | `EACCES .../profile/cordis.yml`，崩在 `profile-boot-BNu17Y9U.js:207`（composeProfile→writeFileSync），进程 exit 1 |
| E3 | 最小可写面 | 整树 a-w 仅 `chmod u+w cordis.yml` → `verify-profile.mjs` | boot 成功，42 entry 行（36 ACTIVE 含 include 根——map "35 entries ACTIVE" 为插件口径）、services 全解析；失败集=4 项已知 linux 平台断言（与可写树基线一致） |
| E4 | junction 混合壳冒烟 | `/tmp/thin-app/` = `launch.mjs` 拷贝 + `profile/{package.json,cordis.patch.yml}` 拷贝 + `profile/node_modules` **symlink 指向只读源树**（`chmod -R a-w` 源树）→ `verify-profile.mjs` | 同上基线：42 entry 行、4 项平台失败、零新增失败；`cordis.yml` 正常写入壳目录 |
| M1 | `fs.promises.cp` 耗时 | win32 scratch 树（`npm install --os=win32 --cpu=x64 --ignore-scripts`，去 `daniya-bridge` file: 依赖）：**643MiB blocks / 560MiB apparent / 26,506 文件 / 3,241 目录** | 25.2s / 24.8s（同盘 /tmp→/tmp，~1,060 文件/s——**瓶颈是文件创建/元数据而非字节**，字节带宽仅 ~26MB/s） |
| M2 | 硬链接农场物化 | 同树 `mkdir` 每目录 + `fs.promises.link` 每文件 | **3.5s**（3,241 dir + 26,506 link）；`df` 实测边际磁盘 **~13MB**（inode/dentry），vs 拷贝 643MB |

基线对照：win32-x64 基线 621MB/26,482（map 实测）vs 本机 scratch 643MiB/26,506——
同量级；差异来自 du 口径（blocks vs apparent）、`daniya-bridge` 缺席（~1MB）与传递依赖漂移。
win32 侧 `libreoffice-kit-win32-x64` 实测 330MB/2,050 文件，与 map 一致。

**防误伤验证**（spec Testing）：root `npm run typecheck` 通过；`npm run test`
16 文件 / 186 用例全绿（本 spec 不动生产代码，结果如预期无回归）。

**待 Windows 复核**：NTFS 上 `fs.promises.cp`/硬链接耗时分布（Defender 实时扫描
26k 新建文件通常更慢，M1 是**下限**）； junction 语义（§4-D）；Program Files
只读假定（标准用户态）。

## 4. (c) 候选方案对比

对照保证：**B-7**（harness 宿主真 node.exe）、**`.stamp`**（升级整树重拷判定）、
**`.tmp-<pid>`**（staging 原子性）、**V-7**（安装包内零符号链接；按 spec 决策 3，
userData 侧 junction/硬链接是独立设计点，不套用包内约束）。

与 spec 候选清单的对照：**就地运行** = 方案 0（纯零改动，实证不可行）与 E/F（消写点
后的可行形态）；**可写覆盖** = C（文件级：硬链接农场）与 D（目录级：junction 壳）；
**junction 混合** = D；**保持拷贝但随裁剪缩水** = B；**其他自研方案** = E、F。

| 方案 | 动哪些文件 | B-7 | .stamp | .tmp staging | V-7 | 量级收益 | 主要风险 |
|------|-----------|-----|--------|--------------|-----|---------|---------|
| 0 纯就地运行（零改动直接跑 resources 树） | 无 | 保 | 不再需要 | 不再需要 | 保 | 首启 IO=0、磁盘 +0 | **W1 实证不可行**：`cordis.yml` 写不进即 boot 崩（E2）；V-7 禁包内符号链接，堵死"包内 cordis.yml 指出去"的绕行 |
| A 现状整树拷贝 | 无 | 保 | 保 | 保 | 保 | 基线：磁盘 ×2、首启 ~25s IO（M1，win 待复核） | — |
| B 拷贝+随裁剪缩水 | 无新增（复用 slim-installer 产出） | 保 | 保 | 保 | 保 | 字节 -53%（621→~290MB）；**但 cp 是文件数 bound**：仅 libreoffice 链只减 ~2k/26.5k 文件→耗时几乎不降；种子清单全砍（~15.4k 文件）才 ~-58% | 收益受裁剪名单深度限制；磁盘仍 ×2 |
| **C 硬链接农场** | `process.ts` 物化函数内部（walk+mkdir+link，`cordis.yml`/`.stamp` 真实拷贝；EXDEV 回退 `fs.promises.cp`） | 保（node.exe 硬链接同 inode 可执行） | 保（.stamp 真实拷贝，同语义） | 保（staging 目录换成链接农场，rename 不变） | 保（硬链接非符号链接；且在 userData 侧） | 25s→**3.5s**；磁盘 643MB→**~13MB**（M2） | ①跨卷 EXDEV→回退拷贝（`allowToChangeInstallationDirectory` 装 D: 盘场景）；②未来若有新写点落在被链接文件上会写穿到共享 inode——只读 ACL 下表现为 EACCES fail-loud（同今日语义）；③NTFS 硬链接行为待 Windows 复核 |
| **D junction 混合壳** | `launch.mjs`（profile 路径可注入/壳化）+ `process.ts` 物化函数换成"壳组装"；`node.exe` 直跑 resources 内副本 | 保（直接执行 resources/runtime/node.exe，零拷贝） | 改语义：壳 3 文件 diff 或包内 build id 比对即可，壳重建成本 ~0 | 退化为无关（壳组装无半成品风险窗口可言，仍可保留同名 staging） | 保（junction 在 userData；spec 决策 3 已放行） | 首启 IO **~10KB ≈ 0s**；磁盘 ~0；E4 已 linux 实证 | ①模块解析经 junction 落 realpath，resolution generation 的 profile 前缀判定待 win32 复核（linux symlink 实证通过）；②junction  freshness/卸载残留管理；③win32 junction vs symlink 语义差异 |
| E 上游条件写 + 包内带 `cordis.yml` | dsh 上游：`composeProfile` 写前比对内容（已等值则跳过）；本仓 `prepare-harness.mjs` 不再排除 `cordis.yml`（`:74`/`mustExist` 加回）；`process.ts` 物化路径删除 | 保 | 不再需要（无拷贝） | 不再需要 | 保 | **零拷贝零机制**，首启 IO=0、磁盘 +0 | 依赖 dsh 上游发布节奏；过渡期需 C/D 兜底；写穿语义变化需上游评审 |
| F 安装器 ACL 单文件可写 | NSIS 脚本（AccessControl 授 `cordis.yml` Users:M）+ `prepare-harness` 带 `cordis.yml` 进包 | 保 | 不再需要 | 不再需要 | 保 | 同 E（零拷贝）但不动上游 | ①Program Files 内可写文件的 AV/完整性观感；②W2 回写因目录仍只读→warn 降级（行为可接受但需在报告/验收中写明）；③重装/升级时 ACL 需每次重授 |

### 推荐

1. **落地 C（硬链接农场）** 作为 slim-installer 同期的首启优化：自包含、无上游依赖、
   保留全部既有保证，EXDEV 自动退回今日路径，风险面最小、收益已实测（M2）。
2. **同时向上游提 E**（写前内容比对）：把 `cordis.yml` 写点本身消掉是终态——届时
   C/D/F 全部退役，`resources/harness` 直接可跑。上游未接前 E 不单独可行。
3. **D 留作备选**：若硬链接在 win32 实测翻车（跨卷/AV/企业策略），junction 壳是同等
   量级的替代；其 Linux 可行性已实证（E4），win32 junction 复核成本低。
4. **B 与以上正交**：裁剪砍安装包体积是独立收益，照常推进；但"缩小拷贝"不能替代
   "消除拷贝"——文件数 bound 意味着 ~290MB 树的首启 IO 仍在秒级-十秒级（§4-B 行）。

## 5. 与 dead-deps-scan 的交互（spec 决策 4）

- 口径一致：双方同用 win32-x64 **621MB/26,482** 基线；本报告 M1 scratch
  643MiB/26,506 与之同量级互证。
- 裁剪对本票结论的修正点**只在量级不在结构**：写点穷举与"cordis.yml 是唯一硬约束"
  与树大小无关；方案 C/D/E/F 的收益对树大小不敏感（IO≈0）。
- 量级联动：~290MB 裁剪目标≈libreoffice 链（330MB）出树——字节 -53% 但文件数仅
  -8%（2,050/26,506），**cp 耗时几乎不变**（M1 显示瓶颈是文件创建）；若种子清单
  全砍（本机实测 ~15.4k 文件/~466MB），拷贝耗时 ~-58% 至 ~10s，磁盘占用 -73%。
  两报告对"裁剪能省多少首启时间"的说法须保持这个口径：**省字节多、省文件少时首启
  IO 收益有限**。

## 6. 待 Windows 复核清单

| 项 | 复核内容 | 关联 |
|----|---------|------|
| WR-1 | NTFS + Defender 下 `fs.promises.cp` 26.5k 文件真实耗时（Linux 25s 是 warm-cache 下限） | M1 |
| WR-2 | Program Files 只读假定（标准用户）+ `%APPDATA%` 与安装盘同卷/跨卷概率 | C-EXDEV |
| WR-3 | win32 `fs.promises.link` 硬链接行为、每文件 1023 链接上限、同卷约束 | C |
| WR-4 | win32 junction 替代 linux symlink 后 verify-profile 等价冒烟（E4 复跑） | D |
| WR-5 | NSIS AccessControl 插件对 `resources/harness/profile/cordis.yml` 授 Users:M 的持久性（升级覆盖安装后 ACL 是否需重授） | F |
| WR-6 | junction/硬链接物化树对杀毒软件/企业完整性工具的观感 | C/D/F |

## 7. 复核指引

- 写点断言按 §2 表 file:line 逐条复核；实证断言按 §3 方法列复跑
  （strace/chmod/scratch+c bench 命令均可在本仓直接重放）。
- "实证" vs "推测"已在 §2 实证列逐行标注（✅=实测命中，📄=静态断言）；
  Windows 相关一律入 §6 清单。
