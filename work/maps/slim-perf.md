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

## Frontier
- [ ] spawn spec `verify-linux`：verify-profile.mjs 断言按 process.platform 分支（win32→pwsh 集 / linux→bash 集），并纳入 CI 可跑面 —— 阻塞项：它是"死依赖裁剪"验收的兜底工具
- [~] 死依赖清单与可删性验证 — research `fairybox:spec-dead-deps-scan`：spec `work/specs/dead-deps-scan.md` 已派发，报告落 `work/maps/slim-perf/dead-deps.md`
- [x] 首启物化拷贝是否可省 — research 已验收合并（PR #4）：拷贝可省/可缩水，推荐硬链接农场 → `work/maps/slim-perf/first-boot-copy.md`
- [ ] spawn spec `materialize-hardlink`：硬链接农场物化落地（方案 C；Windows 复核 WR-3 硬链接语义可在 spec 内标注待复核，不阻塞 Linux 实现与单测）
- [ ] Windows 基线 checklist — task：给用户一份 pack 体积 + 冷启动 + 常驻内存测量步骤
- [ ] spawn spec slim-installer：死依赖裁剪落地（依赖"死依赖清单"结论）

## Fog
- 常驻内存/CPU 的可疑来源（harness 常驻进程、pet-helper 轮询、渲染层）——等基线
- 首 token 延迟是否进目标——等冷启动基线分解出 boot 段 vs 请求段占比
- node.exe 更瘦替代（SEA/裁剪构建）——大概率不值，先记
- NSIS 压缩后安装包 vs 物化树的差值——等 Windows 基线

## Out of scope
- UI 渲染层优化（~950 行 React，非瓶颈）——除非基线打脸
- 模型/供应商切换（DeepSeek 是产品锁定）
- 旧会话文件迁移（ADR 0001 已定不迁）
