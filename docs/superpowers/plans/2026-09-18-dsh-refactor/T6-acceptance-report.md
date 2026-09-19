# T-6 验收报告（2026-09-19 13:58）

环境：dev（electron-vite，`npm run dev`）为主 + win-unpacked（`dist\win-unpacked\达妮娅聊天.exe`）收尾；pet 分支：**P2 降级**（桌宠 exe 缺失，默认配置即指向不存在路径）；模型：**deepseek-flash**（deepseek-chat 已被官方下线，见 B-2/V-2）；Key：settings.json DPAPI 存储（机器级 env Key 仅作 harness 兜底）。
执行方式：computer-use 驱动真实桌面（UIA 元素操作 + 全屏截图），辅以 harness 会话 JSONL、settings.json、文件系统核验。全部截图在本文同目录 `shots/`。

## 环境事实（影响判读）

- 该 Key 在官方 `/models` 只返回 **deepseek-flash / deepseek-v4-pro**，`deepseek-chat` 已 404（Model Not Exist）。验收中把 settings.model 改为 deepseek-flash。
- 打包版与 dev 共用 userData（`%APPDATA%\daniya-chat`：settings.json、conversations.json、harness/）。dist 产物为协议修复前的旧构建（详见 K1/B-2 备注）。

## 结果表

| 项 | 结果 | 证据（shots/） | 备注 |
| --- | --- | --- | --- |
| A1 窗口出现/无白屏/报错覆盖层 | PASS | 01-A1-窗口初始状态-*.png | 空态、侧栏、composer 均正常渲染 |
| A1 托盘图标 | PASS | 02-A1-托盘溢出面板.png、02-A1-托盘图标特写.png | 紫色圆角方块图标在溢出区，点击可 toggle 窗口 |
| A1 窗口位置在光标附近 | **FAIL（B-1）** | — | 首启窗口固定屏幕居中 (560,284)，光标在 (2143,834)；showNearCursor 仅托盘 toggle 调用，且对最小化窗口恢复未生效 |
| A2 主进程控制台无 [harness] 异常 | PASS | —（dev 日志 3 次启动 tail 核验） | 仅 stderr 前缀转发，未见异常刷屏 |
| A2 渲染层 DevTools console | 未验证 | — | 自动化打开 DevTools 受前台策略限制，未完成；不判 PASS/FAIL |
| B1 仅一个模型字段、无搜索/博查 Key 区块 | PASS | 04-B1-设置页-API区-*.png、05 | 单字段「模型（文本与图像输入共用）」；区块：API/指引/人设/桌宠/文件/情绪按键；settings.json 亦无 legacy 字段 |
| B2 workDir 保存+重进仍在 | PASS | 05-B2-workDir持久化-*.png | 重进设置页与 settings.json 双重确认 `D:\tmp\daniya-acceptance` |
| B3 测试连接成功 | PASS | 06-B3-测试连接成功-*.png | 未保存 Key 时先正确提示「请先填写 API Key」；保存后「连接成功，API Key 有效」 |
| B4 无 Key 发消息被拦截 | PASS | 07-B4-无Key拦截-*.png | 红条「请先在设置中填写 API Key」+ 重试/关闭，不进生成；粘贴 Key 走 DPAPI（blob "v10" 前缀）恢复 |
| C1 逐字流式渲染 | 部分通过 | 08-C1-回复完整-*.png | 多轮最终回复完整；**流式中间态截图未能捕获**（flash 生成 2–6s 完成）；delta 通道存在（chatStore 'delta'）但人工证据缺失 |
| C2 气泡无 {EMO:} 标记 | PASS | 15-E1-提案diff面板-窗口特写.png | 日志原文含 `{EMO:happy}`，气泡显示已剥除；emotion 事件为接口级验证（pet 未运行不可视观察） |
| C3 生成中点停止 | 未验证成 | — | 停止按钮 UI 通道存在（本轮图像请求中已目击「停止」+「达妮娅思考中…」占位），但纯文本轮生成过快无法点击；且推理阶段无停止入口（见 B-4） |
| C4 会话标题自动取首条消息 | **FAIL（B-5）** | 08/22 各截图侧栏 | 标题恒为「新会话」；bridge `session.list` title 恒空、主进程未订阅 dsh session/title 事件 |
| D1 联网搜索徽章 | PASS（历史投影级） | 22-G3-重启后会话恢复-窗口特写.png | 日志：web_search×1（3 组查询）+ web_fetch×2 全 ok；重启后历史恢复出「已联网搜索」「已读取网页」徽章；**实时轮次中徽章与回复未上屏（B-6）** |
| D2 执行命令(pwsh) 徽章 | **FAIL（B-7）** | 22（「执行命令失败」×3 徽章 + pwsh 命令块） | pwsh 三次调用均 `Error: PTY shell exited during startup`；模型诚实报告终端起不来；徽章渲染本身正常 |
| D3 工作目录外写入被沙箱拒绝 | 受阻（B-7） | — | pwsh 不可用无法发起越界写；间接证据：sandbox root 传播正确（会话目录名 `--D-tmp-daniya-acceptance--`、pwsh 参数内 workdir 正确、patch `mode: workspace-write` 生效记录于 JSONL `sandbox/mode`） |
| E1 daniya-file 提案弹 diff | PASS | 15-E1-提案diff面板-*.png | 面板：路径、v1→v2 diff（-/+ 行）、「确认后原文件备份为 .bak」、应用/拒绝按钮 |
| E2 应用后 v2 + .bak | PASS | 17-E3（文件核验在报告文本） | hello.txt=v2，`hello.txt.bak` 存在；UI 显示「已应用修改：」 |
| E3 再提案点拒绝后不变 | PASS | 17-E3-拒绝后文件不变-*.png | v3 提案拒绝后文件仍为 v2；UI 显示「已拒绝修改：」 |
| E4 模型走提案还是 pwsh | PASS（提案路径） | —（会话 JSONL turn 6 原文含 ```daniya-file 块） | 人设契约的提案引导生效；pwsh 写路径未尝试（B-7 下也不可用） |
| F1 附件 ≤3 个注入生效 | PASS | 18-F1-附件内容引用.png | note-a/b/c 三文件原文被逐字引用；composer 显示 3 个附件 chip（带 × 移除） |
| F2 截屏→模型描述屏幕（V-2） | PASS | 19-F2-图像理解回复.png | 缩略图进 composer（可移除）；模型准确描述截屏（钓鱼游戏场景、$31、Tab 回溯提示、版本 1.0.12）→ **deepseek-flash 支持图像输入** |
| G1 多会话+切换恢复 | PASS | 20-G1-G2-会话列表多会话.png、22 | 两个会话各有多条消息，切换/重启后恢复正确（走 bridge `session.history` 投影） |
| G2 改名/删除 UI | 未验证 | — | 侧栏改名/删除为悬停控件，自动化未能触达；IPC 层由单测覆盖。不判 PASS/FAIL |
| G3 完全退出重启后仍在 | PASS | 22-G3-重启后会话恢复-*.png | kill 进程树后重启：会话列表+全部消息（含图、附件、徽章）从 dsh JSONL 恢复（V-8 证据） |
| G4 搜索框命中 | 未验证 | — | 键盘注入持续被前台策略拦截（本机有全屏游戏进程抢占焦点）；`chat:search` 为降级实现属已知基线 |
| P2 pet exe 缺失不崩、状态如实 | PASS | 04/05（右上「联动助手未运行」）、全部聊天截图 | 全程聊天正常、无崩溃；状态每 3s 刷新如实显示 helperRunning=false |
| K1 packaged 首启+一轮对话 | 有条件 PASS | 20/22（packaged 截图见 shots/ 最新两张） | 首启（13:50:10）约 25s 内窗口+历史就绪（主观：未见明显等待卡顿）；会话/历史/壳正常；**对话报「模型不存在」**——materialized 旧树复用（已知基线 .stamp 未接线）+ dist 陈旧，重打包后需复测 |
| K2 物化目录与会话日志位置 | PASS | —（文件系统核验） | `userData/harness/app` 608MB 已物化；会话 JSONL 在 `userData/harness/sessions`（2 份）；仓库 `.dev-dsh-home` 仅冒烟期 1 份、全程未新增 |

## 发现的缺陷

| 编号 | 严重度 | 现象 | 复现 | 归属模块猜测 |
| --- | --- | --- | --- | --- |
| B-1 | P3 | 首启与最小化恢复时窗口不落在光标附近，固定屏幕居中 (560,284)；R28 注释承诺「光标附近弹出」 | 启动应用 / 托盘恢复最小化窗口，对比光标位置 | `src/main/index.ts`：showNearCursor 仅在 toggleWindow 调用；且 setPosition 在窗口最小化状态下被恢复动作覆盖 |
| B-2 | P1（已修复） | llm-deepseek 适配器默认 `protocol=messages`（Anthropic 风格），主进程注入 `DEEPSEEK_BASE_URL=https://api.deepseek.com` 后打到 `/v1/messages` → 404「模型不存在」；适配器官方 messages 根实为 `…/anthropic` | 默认设置发任意消息必现（旧 bundle） | `harness/profile/cordis.patch.yml` 未覆盖 protocol + `src/main/harness/process.ts` env 注入 + dsh-llm-deepseek 默认值三方契约 |
| B-3 | P2 | 间歇性 turn 以 reasoning-only 完成（content 空，日志仅 reasoning 部件；无 text），UI 无回复无错误提示（done 空载荷被渲染层丢弃） | 长故事请求 2000 字等（本会话 turn 2、6、7 中 2 次） | dsh agent-loop/llm-deepseek 与工具定义、reasoning_effort=high 组合；渲染层对空消息静默 |
| B-4 | P3 UX | 首个 text chunk 到达前无任何流式指示/停止入口；「达妮娅思考中…」占位与「停止」仅在部分轮次出现 | 发送消息后观察 composer | chatStore streaming 仅在收到首 chunk/done 前后置位；与 B-6 相关 |
| B-5 | P2 | 会话标题不自动取首条消息，恒「新会话」 | 新建会话发消息 | bridge `session.list` title 恒空（server.ts:224 注释即如此）+ 主进程未消费 dsh session/title 事件 |
| B-6 | P1 | 实时事件路径间歇丢失：turn 在 harness 侧已完成（JSONL 有最终文本 579 字 + 工具调用 + ok 结果），渲染层无 delta/无徽章/无 done 效果，用户气泡悬空无反馈；**重启后从历史投影完整恢复（数据无损）** | 联网搜索轮必现一次；普通长轮次偶发 | daniya-bridge 事件转发（records 过滤 / agent 流帧监听在 resume/多步轮次下）或主进程 ActiveRequest 会话匹配 |
| B-7 | P1 | persistent pwsh 工具在 harness 子进程内 PTY 启动即退出（`Error: PTY shell exited during startup`），三次重试全败；命令工具在真实 GUI 完全不可用（协议冒烟未覆盖真实 PTY 启动） | 「用命令行列出我工作目录下的文件」必现 | dsh-pwsh-local/pwsh-sandbox 的 ConPTY 启动（ELECTRON_RUN_AS_NODE 子进程环境？）；与沙箱策略组合待查 |

## 必须跟进的项

- **V-2 图像模型选型结论**：`deepseek-flash` 实测支持图像输入（截图描述细节准确）。`DEFAULT_SETTINGS.model='deepseek-chat'` 占位必须替换（该型号官方已 404）；建议同步考虑把 `/models` 结果用于「测试连接」校验 model 可用性（当前 B3 只验 Key，model 错误要到首条消息才暴露为「模型不存在」）。
- **B-2 回归与构建链**：本票已按用户指示在 `harness/profile/cordis.patch.yml` 显式钉 `protocol: chat-completions`（超出了票面对 harness/** 的所有权禁令，系用户当场授权；patch 内 config 整组替换，已携带 bundle 原有 apiKeyEnv/defaultContextWindow/streamIdleTimeoutMs）。需要：① 把该 patch 修正纳入正常构建/物化流程（pack 产出的 resources/harness 与 DSH_HOME/app 物化树都要带上）；② 决策是否给「测试连接」增加 model 维度校验。
- **B-7 pwsh PTY**：单独诊断（怀疑 ELECTRON_RUN_AS_NODE/ConPTY 环境）；这是「执行命令」自研保留面的硬阻塞，也连带 D3 沙箱拒绝无法做端到端 GUI 证明。
- **B-6 实时流丢失**：以「搜索轮 + 重启对比」复现成本最低；修复前用户会周期性遇到「发了消息没有任何回应」。
- **B-5 标题**：bridge 需把 dsh session/title（fallback 已生成首条消息标题）透出，或主进程订阅 session.event 更新 titleCache。
- **harness env 继承漏口**（票面既有）：settings 无 Key 时子进程仍继承机器级 `DEEPSEEK_API_KEY`；`process.ts:194` 仅在 ctx.apiKey 存在时注入、但未 delete 继承值，建议 `delete env.DEEPSEEK_API_KEY` when unset。
- **dist 陈旧**：打包版 composer 出现 dev 版已删除的「联网搜索」手动按钮（旧渲染层 bundle）；发版前必须 `npm run pack` 重打包，并复核 .stamp 刷新（K1 的「模型不存在」即旧树复用现场）。
- AOCI 缺口：本仓库 AOCI 索引缺失（Entries 0，baseline 未建），按规则未在验收任务中擅自整仓建模；建议另行安排 repository-setup。

## 总体结论：**有条件通过**

通过面：设置页重构（B1/B2/B3/B4）、对话主链路（C1 最终态/C2）、文件提案自研保留面（E1/E2/E3/E4）、附件注入（F1）、图像输入与 V-2 选型（F2）、会话持久化（G1/G3、V-8）、桌宠降级（P2）、packaged 壳与物化（K1 有条件/K2）、错误文案映射（无 Key/模型不存在）。

条件（放行前必须闭环）：
1. B-2 的协议修复随构建链固化并重打包后，packaged 端复测一轮对话通过（K1 补齐）。
2. B-7 pwsh PTY 修复或明确降级公告（命令工具当前不可用）。
3. B-6 实时流丢失修复或给出用户可见的兜底（失败/空回复必须给提示，不得静默）。
4. settings 默认 model 更换为实测可用型号（deepseek-flash / deepseek-v4-pro）。

非阻塞跟进：B-1、B-4、B-5、env 漏口、dist 陈旧清理、G2/G4 的补充人工验证（本票自动化受限项）。

——验收证据：`shots/01…22`（22 组 PNG）；会话日志：`%APPDATA%\daniya-chat\harness\sessions\--D-tmp-daniya-acceptance--\`（两份 JSONL）；测试工作目录 `D:\tmp\daniya-acceptance\` 可整体删除；`.dev-dsh-home/` 留存（冒烟期佐证）。

---

# 复测轮（2026-09-19 18:05–18:25，修复轮后）

环境：修复轮新构建 `dist/win-unpacked/达妮娅聊天.exe`（与新 Setup 0.1.0 同批 pack，模板 `.stamp` builtAt `2026-09-19T08:41:13Z`）；设置沿用（deepseek-flash / https://api.deepseek.com / workDir `D:\tmp\daniya-acceptance`）；computer-use 驱动真实 GUI。构建链核验：`protocol: chat-completions` 已进 dist 模板 patch、`runtime/node.exe` 已随包物化、`DEFAULT_SETTINGS.model='deepseek-flash'`（settings.ts:22）。安装器（Setup）未在本轮重复端到端安装，其物化判定逻辑已由 smoke-packaged-harness 断言；本轮 GUI 复测以同构建 win-unpacked 直接运行。

## 复测结果（四点全 PASS）

| 复测点 | 结果 | 证据（shots/） | 实测 |
| --- | --- | --- | --- |
| ① 首窗落光标附近（B-1） | **PASS** | 23-复测1-首窗光标.png | 受控重测：光标定于物理 (1280,900) 后启动，GetWindowRect 实测窗口 L=560 T=420（与 boundsNearCursor 理论预测逐像素一致），窗口中心 (1282,902)≈光标。托盘 toggle 路径未重复验证 |
| ② 联网搜索徽章与答复实时可见（B-6） | **PASS** | 24-复测2-流式中间态-01/03.png | 流式中途截图：部分文本带光标渐进上屏、工具徽章（已联网搜索×3/已执行命令×1/已读取网页×4）已实时出现、右下角红色「停止」；完成后回复完整（全新内容），工具轮中间消息与终帧均未丢失 |
| ③ 模型跑 pwsh 命令（B-7） | **PASS** | 26-复测3-pwsh命令-06/10/完成.png | 「用 PowerShell 命令列出 D:\tmp\daniya-acceptance」→ 已执行命令×2 → 真实输出：11 个条目，并点名列出 set-cursor.ps1 / snap.ps1 / crop.ps1 / tray-crop.png 与两个日志（均为本轮验收现场刚生成的真实文件）；PTY 即退不再复现 |
| ④ 会话标题自动出现（B-5） | **PASS** | 27-复测4-自动标题-侧栏特写.png、24-…-03 | 新会话首个成功 prompt 后标题自动取提示词前 20 字「用联网搜索查一下今天有什么科技新...」；存量旧会话（修复前创建）保持「新会话」未被改写，语义正确 |

## 新缺陷 B-8（P1）：packaged 升级首启在主线程同步物化 ~1.1GB，冻结 2.5 分钟

- **现象**：`.stamp` 不一致（升级/重打包后首启）时，`ensureHarnessMaterialized` 的 `fs.cpSync`（`src/main/harness/process.ts:136`）在**主线程同步**执行 resources/harness → userData/harness/app 的整树拷贝（实测 ~1.14GB，D:→C: 耗时约 2.5 分钟，18:09 启动 → 18:11:44 完成）。期间窗口白屏且标题栏标「未响应」，托盘/IPC 全部无响应；若 renderer 在 ready-to-show 前发起 getMessages→ensure()，窗口甚至完全不出现（本轮 launch#1 即「进程在、无窗」）。
- **证据**：userData/harness 下 `app` 目录 mtime=18:11:44（整树重写完成时刻）；被中止的首次启动残留 staging `app.tmp-32012`（~1.1GB 垃圾——杀进程即泄漏，应用不清理陈旧 `app.tmp-*` 目录）。
- **对照**：干净启动（戳一致走复用路径）7 秒内窗口就绪且历史恢复，K 项 .stamp 复用逻辑本身正常；主线程冻结现场里出生的窗口曾出现 (+157,+74) 定位偏移，干净启动实测逐像素精确（见①），偏移仅伴随 B-8 现场出现。
- **建议**：拷贝移出主线程（worker_threads / 异步 fs.cp），物化期间窗口给「正在准备运行时…」可见状态，启动时清理陈旧 `app.tmp-*`。

## 其他现场记录

- 流式间隙：工具执行阶段（中间 stream.end 与工具结果返回之间）composer 按钮短暂回到「发送」，流式指示不连续——与 B-4 同族，非本轮四点范围。
- 桌宠本轮实际运行（屏幕左下出现宠物形象）：本机当前 pet exePath 有效，P2 降级场景未复核。
- 上一轮自动化受限项（A2 DevTools、G2/G4）本轮未重复。

## 结论更新

四个复测点全部 PASS，原「有条件通过」的四项放行条件全部闭环：① B-2 协议修复已固化进构建链（dist 模板核验）且 packaged 真实 GUI 对话通过（K1 补齐）；② B-7 pwsh 真实执行通过（连带 D3 沙箱阻塞解除——本轮命令在 workdir 内正常执行）；③ B-6 实时面（徽章+答复实时上屏）通过；④ 默认模型已换 deepseek-flash。

**总体结论：通过（附新缺陷 B-8 待修）。** B-8 不影响功能正确性，但构成每次发版升级路径上的可用性硬伤（首启必冻结 2.5 分钟，期间易被用户误杀并泄漏 1.1GB staging），建议 P1 尽快修复后随下版发布。

——复测证据：`shots/23…27`；本轮 harness 物化核验：`%APPDATA%\daniya-chat\harness\app\.stamp` 与模板一致（appVersion 0.1.0 / builtAt 2026-09-19T08:41:13.143Z）；遗留 `app.tmp-32012`（~1.1GB）为 B-8 现场证据，报告归档后可删。

---

# B-8 修复复测（2026-09-19 18:40–18:55）

**重要前置说明**：修复轮声称「新安装包已含全部修复」，但复测开始时磁盘上的 dist 仍是修复前产物（app.asar/exe/Setup mtime 停在 16:44–16:49，asar 内无 prewarm 字样）——B-8 修复当时只在源码里。复测先执行 `npm run pack` 重建（仅构建产物，未触碰任何源码文件），新模板 `.stamp` builtAt `2026-09-19T10:38:12Z`（=18:38 本地）。以下复测均基于该重建包；修复轮如需交付，请以这次（或更新的）pack 产物为准。

复现前提全部成立：userData `harness/app/.stamp` 仍为旧值 08:41:13Z（stamp 错开 → 必走重拷路径）；遗留 staging `app.tmp-32012`（474M）在位；旧实例与孤儿 harness node 已清。

## B-8 三根支柱逐项验证

| 支柱 | 结果 | 实测 |
| --- | --- | --- |
| 拷贝移出主线程（fs.promises + spec 异步化） | **PASS** | 启动 4 秒后主进程 Responding=True、窗口完整渲染（旧版此刻已白屏冻结）；物化进行中打开设置页（119 个元素全可读）并「← 返回聊天」成功往返——1.1GB 后台拷贝期间 UI 全程可操作 |
| 启动即后台物化 + spec 缓存共享 | **PASS（观测一致）** | 拷贝在后台完成（约 2–3 分钟，688M D:→C:），完成后 `app/.stamp` 换新为 10:38:12Z、harness 子进程（node launch.mjs）自动拉起；全程仅出现一次 staging 并整树换名，与「prewarm/ensure 共享同一物化、杜绝并发双拷」一致 |
| 入口无条件清扫陈渣 | **PASS** | `app.tmp-32012`（474M，上轮 B-8 现场遗留）在本次启动后消失，无需手动删 |

## 收尾功能验证

- 任务栏进度：物化期间全屏截图中应用任务栏图标下沿有蓝色条，但截图分辨率不足以确凿区分进度填充与活动指示——**该项未能取得确凿视觉证据**，如实记录；不影响核心验收目标（UI 不冻结）。
- 物化完成后消息 + 工具调用：发「用 PowerShell 命令看看 app-stderr.log 和 set-cursor.ps1 在不在」→「已执行命令」徽章 + 真实结果「两个 Test-Path 都返回 True」——PASS（29-复测B8-物化后消息工具正常.png）。
- 会话与历史跨物化轮换完好：上一轮的会话列表、标题、消息（含文件列表回复）全部保留——sessions 存放于 `harness/sessions`、不受 `app/` 整树换名影响，与设计一致。

## B-8 最终结论

**PASS，缺陷关闭。** 证据：`shots/28-复测B8-物化期间设置页可交互.png`、`shots/29-复测B8-物化后消息工具正常.png`。发版前提醒：dist 现产物即本次复测所用重建包（Setup 0.1.0，stamp 10:38:12Z）；后续如再动源码，务必重跑 `npm run pack` 并确认 `.stamp` 更新（.stamp 接线已保证 userData 侧自动跟进）。
