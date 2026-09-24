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

## 实测回填（2026-09-24，Windows 11 真机，main@93bd170）

```
A: installer=149.2MB, harness_tree=162.0MB/4058files, materialized=162.0MB/4059files(表观)
   裁剪前后：源 profile/node_modules 551.4MiB/26517f → 暂存 bundle 164.3MiB/4062f
   （其中 runtime/node.exe 87.4MiB、node_modules 76.5MiB/4056f）→ 安装树 162.0MiB/4058f
   物化树表观 162.0MiB，但 4058/4059 文件与安装树共享 inode——边际磁盘 ≈ .stamp+cordis.yml 两个真实拷贝（~KB 级）
B: materialize_s=4.92（copy 基线：同树同卷 fs.promises.cp 实测）→ 0.78（hardlink 农场，staging 窗口 80ms 轮询）
   启动→物化完成=1.48s；WR-2 跨卷：C:→D: fs.link 实测如期 EXDEV（本机同卷未走回退，回退路径由 process.test.ts EXDEV 用例覆盖）
C: launch_to_window=0.70s, window_to_token≈0.5s（harness 已热：prompt→首 chunk 实测 514ms）
   冷态分解：harness spawn→initialize 应答 613–756ms + LLM TTFT ~0.5s ≈ 1.1–1.3s
   （桥级直测；窗口可见后 renderer 的会话加载已触发 harness 预热，用户体感取热路径）
D: idle ≥5min（10:52:53 启动，10:58:47 快照，无会话活动）
     达妮娅聊天.exe ×4（main/GPU/renderer/utility）：146+108+75+49=378MB WS，累计 CPU≈4.9s
     node.exe（harness，物化树 runtime/）：75MB WS，CPU 0.8s
     无可归属本 app 的 pwsh/powershell 常驻（表中 powershell 均早于 app 或为测量进程）；
     pet-helper/Bongo Cat 未拉起（settings.pet.exePath 指向 E:\迅雷下载\...，当前不在场）
   合计 ≈453MB WS，idle CPU 近零
E: verify win32 = PASS ×3 处——仓库 harness/profile、build/harness-bundle、物化树 %APPDATA%\daniya-chat\harness\app
   均 exit 0：pwsh 对 ACTIVE / bash 对 NO_FIBER / 工具集 [pwsh,web_fetch,web_search] / sandbox workspace-write / 36 ACTIVE
F: chat=PASS（initialize 613ms，{EMO:sleepy} 人设生效，流式回复正常）
   pwsh_tool=PASS（模型自发 tool.call 'pwsh' Get-Location → tool.result ok=true，persistent-pwsh 沙箱链完好；
                  dsh-tool-pwsh/dsh-pwsh-sandbox 裁剪无误伤——真实装载点是 dsh-tool-pwsh-persistent/dsh-terminal-bash）
   attach=PASS（sharp-win32-x64 在场且可独立加载；合法 PNG 准入成功，模型描述了缩略图内容。
               注：首次测试因手写 PNG 不合法被拒 "Unsupported or malformed image data"——拒绝行为正确，非误伤）
   verify-profile 物化树复跑 = PASS
G: hardlink_ok=PASS——runtime/node.exe link count=2、profile/node_modules/@deepseek-ai/dsh/package.json=2、.stamp=1（独立拷贝）
   av_noise=无（Defender/杀软全程无告警，物化 0.78s 未被拦截减速）

附带修复（验收暴露的真 bug）：scripts/prepare-harness.mjs `pkgKeyOf` 用 path.sep join
@scope 键——win32 下产出反斜杠键永不命中 DEAD_DEPS（正斜杠），致全部 @scoped
blocklist 包漏剪；暂存断言正确捕获（残留 ~200 项）。已修为恒定 '/' join，
修后 pruned 351/353（缺席 2 项为 linux-only 包的正常漂移）。
```

结论：353 项 blocklist 在 win32 无误伤；硬链接农场 NTFS 语义成立；基线三段已建立。
剩余差距：真实安装跨卷（WR-2）未实地触发（仅有 EXDEV 语义证据 + 单测）；C② 为桥级测量非 UI 掐表。
