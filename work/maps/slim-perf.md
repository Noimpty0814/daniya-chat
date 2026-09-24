# Map: slim-perf（安装包瘦身 + 性能优化）

## Destination
一份 spec 集，落地后：物化树/安装包内不存在不服务当前产品面的冗余依赖（可机械验收：删掉后 profile boot 冒烟照过），且首启物化拷贝、冷启动、常驻占用三段性能建立基线并达到约定阈值（阈值随基线产出回填，不预先拍数）。

## Notes
- 产品使用仅 Windows（AGENTS.md），但**除视觉效果外的一切验证必须能在 Linux 跑通**——fairybox 即用户的 Ubuntu 远端服务器；含 harness boot、裁剪验证、基线测量
- 必读：docs/adr/0001（dsh 运行时、B-7 node.exe/B-8 .stamp 物化坑）、docs/adr/0002、 harness/README.md、scripts/prepare-harness.mjs
- 验证分工：Linux 侧（本地/fairybox）跑 typecheck+test+profile boot 冒烟；Windows 真机跑 pack/安装包/冷启动/pwsh/桌宠
- stdout 只许协议帧；harness 宿主必须是真 Node（非 electron-as-node）

## Decisions so far
- 方向定调：体积优化 + 性能优化，底线"零冗余" → 本 map（session 2026-09-22）
- 验收形状：零冗余为硬目标，性能阈值待基线回填（不预先钉数字）
- 性能面取舍：A 首启物化拷贝 + B 冷启动 + D 常驻占用进目标；C 首 token、E UI 渲染缓议
- 裁剪手段：post-install 按名单删目录 + boot 冒烟兜底（不动 lockfile/上游）；可顺手向 dsh 上游提拆包需求
- 测量策略：物化树体积 Linux 可代理测量（`npm install --os=win32 --cpu=x64` scratch 复现已验证可行）；Windows 安装包/冷启动走用户 checklist
- 基线事实（scratch 实测）：win32-x64 物化树 **621MB / 26,482 文件**；`libreoffice-kit-win32-x64` 独占 **330MB(53%)**，来自从不激活的 `dsh`→`dsh-web-app`→`dsh-office-to-pdf` 链；`@opentelemetry` 35MB（遥测已禁）、`openai` 17MB、`@google/genai` 14MB、`@anthropic-ai` 13MB（pi-ai 多供应商链，产品只用 DeepSeek）、`@octokit`/`@smithy`/`@aws-sdk` ~25MB
- 兼容性口径：开发/验证面兼容 Linux（非视觉验证全部可跑），产品保持 Windows-only；fairybox 即用户的 Ubuntu 远端服务器
- Linux boot 实测（wsl-local-0922）：**harness 在 Linux 完整 boot 成功**，35 entries ACTIVE、4 服务全解析、sandbox=workspace-write 生效、工具集 `[bash, web_fetch, web_search]`（cordis jsExpr 平台分支自动 pwsh↔bash 切换）；boot+断言+shutdown 全程 **0.51s** → harness boot 不是冷启动瓶颈，瓶颈在 Electron 侧与首启物化
- 首启物化拷贝判定（PR #4）：唯一硬写点=boot 重写 `cordis.yml`（223B），其余数据面全落 DSH_HOME；拷贝非唯一解——推荐 **C 硬链接农场**（首启 IO 25s→3.5s、双倍磁盘 643MB→~13MB，保 .stamp/.tmp/B-7 全部保证，EXDEV 回退拷贝）+ **E 上游条件写**终态；D junction 壳备选（Linux 已实证）；B 随裁剪缩水正交但文件数 bound 收益有限 → `work/maps/slim-perf/first-boot-copy.md`；Windows 复核项 WR-1~6
- 验证脚本缺口：`verify-profile.mjs` 断言 Windows 写死（persistent-pwsh 须 ACTIVE、bash 须不 ACTIVE、工具集含 pwsh）→ Linux 上正确行为被判失败，需平台化断言后才可作裁剪兜底
- 死依赖判定已交付（feat/dead-deps-scan，`work/maps/slim-perf/dead-deps.md`）：linux 树 475 包实测 **351 dead / 121 alive / 3 unknown**，7 组累积删后 verify 恰 4 平台失败 + smoke 11 PASS；blocklist 353 项（win32 可裁 ~548MB/643MB）；unknown = sharp-wasm32/emnapi/node-addon-api；win32 boot 复核为 follow-up。另实测 ACTIVE 条目为 **36**（非 35，`include` 行计入口径差异）
- 实现面全部落地（session devin-local）：verify-linux（PR #10）→ materialize-hardlink（PR #11）→ slim-installer（PR #12）。linux 侧机械验收达成：裁剪后暂存树 76.7MiB 上 verify-profile exit 0。**剩余均为 Windows 侧**：基线三段测量 + WR 复核，全部收编在 `windows-checklist.md`
- Windows 验收回填（eefe7fd，2026-09-24，main@93bd170）：**A–G 全项 PASS**。基线三段已建立——installer 149.2MB / 安装树 162.0MB/4058f / 物化表观 162.0MB（4058/4059 文件共享 inode，边际磁盘 ~KB）；物化窗口 copy 4.92s → hardlink **0.78s**；启动→窗口 0.70s、prompt→首 chunk 514ms（冷态分解：harness init 613–756ms + LLM TTFT ~0.5s ≈ 1.1–1.3s）；idle≥5min ≈**453MB WS**（Electron 四进程 378 + harness node.exe 75，CPU 近零）。353 项 blocklist win32 无误伤（chat/pwsh/sharp 实测）；link count 2/2/1、无 AV 告警；profile 源树 551.4MiB/26517f → 暂存 164.3MiB/4062f。验收暴露真 bug：`pkgKeyOf` 用 path.sep join 致 win32 @scoped 键永不命中、~200 包漏剪，已修（e3dfd4d，pruned 351/353，缺席 2 项为 linux-only 正常漂移）——暂存残留断言按设计立功。NSIS 压缩差值同时得答：149.2MB 安装包 vs 162MB 树（~8%）
- node.exe 瘦身裁决（2026-09-24 align）：**不做**。87.4MB 构成——V8+内建 ~45-50MB、full-icu ~26-30MB、OpenSSL ~6MB、其余 ~8MB；唯一 >10MB 杠杆是 ICU 裁剪（small-icu 磁盘 -27MB 但 zh Intl/排序退化，icudt zh+en filter -15MB），安装包端收益对折 ~12-15MB，代价是永久自建 MSVC Node 发布链+安全补丁跟进；UPX 只省磁盘且破 WR-6 无告警记录，SEA 实为 node.exe+blob 更大，换 runtime 撞 B-7/native ABI——ROI 不值，关账

## Frontier
- [x] spawn spec `verify-linux` — 已落地（PR #10）：verify-profile.mjs 断言平台化（win32→pwsh 集 / 非 win32→bash 集对称断言），verify/smoke 均支持可选 harness-root 参数（可对 `build/harness-bundle` 跑同一门禁）；Linux 实测 exit 0。win32 腿复跑在 windows-checklist.md §E
- [x] 死依赖清单与可删性验证 — research 已验收合并（PR #5）→ `work/maps/slim-perf/dead-deps.md`：351 dead / 121 alive / 3 unknown，blocklist 353 项可直接贴入 prepare-harness.mjs；**裁剪名单须保住 Linux boot 面**已落实（node-pty/koffi/node-addon-system-linux 等全部判 alive 不入列）
- [x] 首启物化拷贝是否可省 — research 已验收合并（PR #4）：拷贝可省/可缩水，推荐硬链接农场 → `work/maps/slim-perf/first-boot-copy.md`
- [x] spawn spec `materialize-hardlink` — 已落地（PR #11）：`fillStagingByLinks` 链接农场（mkdir+link、.stamp/cordis.yml 真实拷贝、任一 link 失败整树回退 cp），process.test.ts 21/21 含 inode 共享/写穿/EXDEV 回退用例；win32 NTFS 语义复核在 windows-checklist.md §G
- [x] Windows 基线 checklist — 已交付 `work/maps/slim-perf/windows-checklist.md`（A 体积 / B 首启物化 / C 冷启动分解 / D 常驻 / E verify win32 腿 / F slim win32 复核 / G 硬链接复核，含回填格式）；执行属用户 Windows 侧
- [x] spawn spec slim-installer — 已落地（PR #12）：`scripts/dead-deps.mjs` 353 项名单 + prepare-harness 顶层包过滤 + 漏剪断言 + `verify:bundle` 门禁；linux 暂存树 491MB→**76.7MiB / 4047 文件**，bundle 上 verify exit 0；win32 boot 复核在 checklist §F（已 PASS）
- [ ] 阈值裁决与 map 收官 — 三段基线已建立（见 Decisions），约定阈值待用户拍板回填；零冗余硬目标已达成（win32 实测无误伤）。收官后按生命周期删本图与 windows-checklist.md

## Fog
- pet-helper 常驻画像未测——验收时 exePath 指向不在场路径未拉起；主占用已定位为 Electron 378MB + harness node 75MB
- 首 token 延迟是否进目标——冷态分解已出（harness init ~0.6–0.75s + TTFT ~0.5s），数据齐，待裁决
- ~~node.exe 更瘦替代~~ —— 已裁决不做，见 Decisions
- 真实安装跨卷（WR-2）未实地触发——仅有 C:→D: fs.link EXDEV 语义证据 + process.test.ts 回退用例；C② 系桥级测量非 UI 掐表

## Out of scope
- UI 渲染层优化（~950 行 React，非瓶颈）——除非基线打脸
- 模型/供应商切换（DeepSeek 是产品锁定）
- 旧会话文件迁移（ADR 0001 已定不迁）
