# Windows 基线 + 复核清单（slim-perf）

属 `work/maps/slim-perf.md`。在 Windows 真机执行；每项给出命令与要回填的数字。测完把结果贴回会话，由 Linux 侧收编进地图的基线事实。

## A. 安装包与物化树体积（pack 后）

```powershell
npm run pack
# 1. 安装包本体
Get-Item dist\*.exe | Select Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
# 2. 安装后 harness 树（默认安装到 %LOCALAPPDATA%\Programs\达妮娅聊天，按实际路径改）
$app = "$env:LOCALAPPDATA\Programs\达妮娅聊天"
(Get-ChildItem "$app\resources\harness" -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
(Get-ChildItem "$app\resources\harness" -Recurse -File).Count
# 3. 物化树（首启后生成）
$ud = "$env:APPDATA\达妮娅聊天\harness\app"   # userData 实际名以 electron appId/productName 为准，找不到就搜 %APPDATA% 下 harness\app
(Get-ChildItem "$ud" -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
```

回填：安装包 MB、harness 树 MB/文件数、物化树 MB（首启后）。**前后对比口径**：slim-installer 落地前后各测一次 1/2 项。

## B. 首启物化耗时（WR-1 复核 + 硬链接农场前后对比）

物化期间任务栏图标是不确定进度条（`onMaterialize` 回调驱动），**进度条出现→消失即物化窗口**。

```powershell
# 清掉物化产物模拟首启（应用关闭状态）
Remove-Item "$env:APPDATA\达妮娅聊天\harness\app" -Recurse -Force
# 启动应用，掐表：窗口出现 → 任务栏进度条消失
```

回填：首启物化秒数（复制方案基线）→ 硬链接农场落地后同法复测。跨卷场景（WR-2/EXDEV）：若装在非系统盘，确认物化仍成功（进度条消失、能发消息）。

## C. 冷启动分解

应用完全退出后启动，掐两段：① 双击→窗口可见；② 窗口可见→发一条消息收到首个 token。

回填：两秒数。目的：分解 Electron boot 段 vs harness/请求段（Fog 项"首 token 是否进目标"等这个数据裁决）。

## D. 常驻占用（idle ≥5 分钟，无会话活动）

```powershell
Get-Process | Where-Object { $_.Name -match 'daniya|达妮娅|electron|node|pwsh|powershell|pet' } |
  Select Name, Id, @{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB)}},
         @{n='CPU_s';e={[math]::Round($_.CPU,1)}} | Sort WS_MB -Desc
```

回填：进程清单 + 各 WS_MB/CPU。关注：harness `node.exe` 常驻内存、pet-helper 是否有轮询型 CPU、主进程基数。

## E. verify-profile win32 腿（verify-linux 落地后）

在 Windows 上的仓库 checkout（`npm install --prefix harness/profile` 后）：

```powershell
node harness\verify-profile.mjs
# 期望：exit 0；entries 中 terminal-pwsh/persistent-pwsh ACTIVE、terminal-bash/persistent-bash 非 ACTIVE；工具集 [pwsh, web_fetch, web_search]
```

## F. slim-installer win32 boot 复核（blocklist 落地后）

`npm run pack` → 安装 → 应用内实测：

1. 发一条消息收到正常回复（harness boot + LLM 回合）。
2. 让模型执行一条 pwsh 命令（如"看下当前目录"）确认 pwsh 工具链活——**优先复核项**：`dsh-tool-pwsh`/`dsh-pwsh-sandbox` 已裁，若 pwsh 实际调用有隐藏装载点，这里会第一个暴露。
3. 附件图片上传一次（sharp 真实调用点）。
4. `verify-profile` 对安装目录物化树复跑（可选，E 同款命令指 `%APPDATA%\...\harness\app` 需要脚本参数支持）。

任一失败 → blocklist 误伤，按失败点二分定位误删包。

## G. 硬链接农场复核（materialize-hardlink 落地后，WR-3/WR-6）

```powershell
# 物化完成后抽查：硬链接文件的 link count 应为 2
fsutil hardlink list "$env:APPDATA\达妮娅聊天\harness\app\runtime\node.exe"
fsutil hardlink list "$env:APPDATA\达妮娅聊天\harness\app\profile\node_modules\@deepseek-ai\dsh\package.json"
# .stamp 必须是独立拷贝（link count = 1）
fsutil hardlink list "$env:APPDATA\达妮娅聊天\harness\app\.stamp"
```

回填：link count 符合预期；Defender/企业杀软有无告警（WR-6）。若物化自动回退拷贝（跨卷 EPERM/EXDEV），表现为文件数全但 link count=1——属预期路径，确认功能正常即可。

## 汇总回填格式

```
A: installer=__MB, harness_tree=__MB/__files, materialized=__MB
B: materialize_s=__（copy 基线）→ __（hardlink, 若已落地）
C: launch_to_window=__s, window_to_token=__s
D: <进程表>
E: verify win32 = PASS/FAIL（附 failures）
F: chat=__, pwsh_tool=__, attach=__
G: hardlink_ok=__, av_noise=__
```
