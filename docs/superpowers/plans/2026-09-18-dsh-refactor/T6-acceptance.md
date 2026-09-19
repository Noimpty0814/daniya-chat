# T-6 真实 GUI 验收（computer-use）

## 背景

- 规格：`docs/superpowers/specs/2026-09-18-dsh-refactor-design.md`（§10 验收标准、§13 验证点）
- **阻塞于 T-1~T-5 全部**：五票已完成并回收；协议级冒烟（`harness/smoke-bridge.mjs`）与打包冒烟（`scripts/smoke-packaged-harness.mjs`）已绿，单元测试 165 绿。
- **本票覆盖的是唯一未被证明的面**：真实 Electron GUI 里的人工等价路径——窗口、渲染、键鼠交互、桌宠联动、图像输入、设置 UX、安装包首启体验。这些无法被协议冒烟或单测替代。
- 执行方式：**computer-use agent 驱动真实桌面**（截图定位 + 键鼠操作），不是 mock、不是无头浏览器。

## 目标

按下方验收清单逐项驱动**真实运行的达妮娅聊天**，每项给出截图证据与结论（PASS / FAIL+现象 / N/A+原因），产出验收报告。这票是集成验收的最后一道门。

## 环境与前置

- 机器级 `DEEPSEEK_API_KEY` 已存在（`sk-a49…`，len=35）——harness 子进程经 `process.env` 继承可拿到。**但应用模型以 settings.json 的 DPAPI 加密 Key 为权威**：若 settings 里没存 Key，发消息应被"请先在设置中填写 API Key"拦截（这是要验的行为，不是 bug；已知 harness env 继承漏口记录在案，属单独修复项）。
- 需要凭据时：用设置页粘贴 Key 走 DPAPI 存储路径，**不要**把 key 写进任何文件/截图。
- 准备一个**独立测试工作目录**（如 `D:\tmp\daniya-acceptance\`），验收全程用它当 `file.workDir`——提案/沙箱验证别污染仓库。
- 桌宠 exe 存在与否决定桌宠条款走"实测"还是"降级验证"分支（见清单 P 项）。
- 截图证据一律落到报告同目录的 `shots/` 子目录，命名 `NN-项目名.png`。

## 文件所有权

- 可写：`docs/superpowers/plans/2026-09-18-dsh-refactor/T6-acceptance-report.md`（报告）+ 同目录 `shots/`、测试工作目录内的一切
- **禁止**：`src/**`、`packages/**`、`harness/**`、`scripts/**`、`package.json`、任何源码/配置——发现 bug 记入报告（编号 B-N），不修。settings.json 经设置页正常写不算违规。
- 测试工作目录验收后可整体删除；`.dev-dsh-home/` 可留（里面是验收期会话日志，佐证持久化）。

## 启动方式

```bash
npm run dev        # 主验收路径（electron-vite dev）
# 收尾附加项：dist\win-unpacked\达妮娅聊天.exe   # packaged 首启验证
```

注意 dev 启动后 Electron 窗口应出现在**光标附近**——操作前先把光标挪到屏幕中央便于截图定位。

## 验收清单

### A. 启动与壳

- [ ] A1 `npm run dev` 后窗口出现且无白屏/报错覆盖层；托盘图标存在；窗口位置在光标附近
- [ ] A2 主进程控制台无 `[harness]` 异常刷屏；渲染层 DevTools console 无红色错误（可截图记录既有 warning）

### B. 设置

- [ ] B1 设置页只有**一个模型字段**（无 textModel/visionModel 双字段）；**无博查/搜索 Key 区块**
- [ ] B2 填 workDir=测试目录、保存、重进设置页值仍在（持久化）
- [ ] B3 「测试连接」按钮返回成功（用 settings 存的 Key）
- [ ] B4 清空 API Key 保存 → 回主界面发消息 → 得"请先在设置中填写 API Key"提示而非生成 → 恢复 Key

### C. 对话主链路

- [ ] C1 发「你好」→ **逐字流式渲染**（截图捕捉流式中间态）→ 回复完整
- [ ] C2 气泡内**无 `{EMO:...}` 标记**（标记被剥除）；渲染层收到 emotion 事件（pet 未启用时无法直接观察，记为接口级验证）
- [ ] C3 长回复生成中点「停止」→ 流中断、已生成的残文保留在气泡
- [ ] C4 会话列表出现新会话且标题自动取自首条消息

### D. 工具徽照搬与联网

- [ ] D1 发「查一下今天的新闻」或等效触发 → 流式期间出现**「联网搜索」徽照搬**（pending→完成态），最终气泡保留徽照搬记录
- [ ] D2 发「用命令行列出我工作目录下的文件」→ **「执行命令」(pwsh) 徽照搬**出现
- [ ] D3 让模型往**工作目录外**写文件（如「在 C:\ 根目录建个文件」）→ 命令被沙箱拒绝（徽照搬失败态或模型报告无法执行）——workspace-write 生效证据

### E. 文件提案链路（自研保留面）

- [ ] E1 工作目录预置 `hello.txt`（内容 `v1`）→ 发「把 hello.txt 的内容改成 v2」→ 模型走 `daniya-file` 提案 → **提案面板弹 diff**（v1→v2）
- [ ] E2 点「应用」→ 文件内容变为 v2，且生成 `.bak` 备份
- [ ] E3 再来一轮提案点「拒绝」→ 文件不变
- [ ] E4 若模型直接走 pwsh 写文件而非提案（两种写路径都可能发生）——记录实际行为；这不必然 FAIL，但要在报告里写明模型选择了哪条路、人设契约的提案引导是否生效

### F. 附件与图像

- [ ] F1 附件按钮加 ≤3 个文本文件发送 → 模型回复显示已读到内容（注入生效）
- [ ] F2 截屏按钮 → 截屏缩略进 composer → 发送 → **模型描述了屏幕内容**（V-2 图像能力实测：`deepseek-chat` 若不支持图像输入，记录确切报错文本——这决定 settings.model 的选型修正）

### G. 会话管理与持久化

- [ ] G1 多建 2 个会话、各发一条 → 切换会话历史正确恢复（走 bridge `session.history` 投影）
- [ ] G2 改名/删除会话 UI 正常
- [ ] G3 **完全退出应用重启** → 会话列表与消息历史仍在（dsh JSONL 持久化生效，V-8 证据）
- [ ] G4 会话搜索框能命中标题/已加载消息（降级实现，如实记录覆盖面）

### P. 桌宠（条件分支）

- [ ] P1 **pet exe 存在且已配置**：发消息期间等待泡泡出现；回复含情绪时宠物表情切换（Alt+键模拟）；`pet:status` 显示 helperRunning/connected
- [ ] P2 **pet exe 缺失/未配置**：设置页关 pet 或指向不存在路径 → 应用不崩，聊天全流程正常，`pet:status` 如实报告未连接

### K. packaged 首启（收尾项）

- [ ] K1 运行 `dist\win-unpacked\达妮娅聊天.exe`（或装 NSIS）→ 首启等待 harness 物化（~550MB 拷贝，记录主观耗时）→ 完成一轮对话
- [ ] K2 检查 `userData` 下 harness 物化目录存在；`DSH_HOME` 会话日志在 packaged home 而非仓库 `.dev-dsh-home`

## 报告格式

`T6-acceptance-report.md`：

```
# T-6 验收报告（YYYY-MM-DD HH:MM）
环境：dev / win-unpacked / 安装包；pet 分支：实测|降级；模型：xxx
## 结果表
| 项 | 结果 | 证据（截图名）| 备注 |
## 发现的缺陷
| 编号 | 严重度 | 现象 | 复现 | 归属模块猜测 |
## 必须跟进的项
- V-2 图像模型选型结论
- harness env 继承漏口（delete env.DEEPSEEK_API_KEY when unset）
- …
## 总体结论：通过 / 有条件通过（列条件）/ 不通过
```

## 已知基线（不要当新发现重复报告）

- `session.delete` 不删磁盘日志（append-only，bridge README 已记）
- `.stamp` 升级刷新未接线（覆盖安装复用旧树）
- `chat:search` 是降级实现（标题+已加载消息）
- harness 首启物化 ~550MB 属预期体积
- `deepseek-chat` 图像输入能力是待验证项，不是既有缺陷

## 备注

- 每条 PASS 都要有截图；FAIL/N-A 要写明现象与下一步归属
- computer-use 驱动不了 Electron 时用其自带截图/辅功能手段亦可，证据形式不限
- 不追求一次全绿——如实记录比过审重要
