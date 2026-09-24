# ADR 0001: 后端整体托管给 dsh 运行时（daniya profile + 自研 bridge 插件）

日期：2026-09-18　状态：已落地（验收通过，含 B-1~B-8 修复轮）

## 决策

删掉自研聊天引擎（`deepseek/`、`search/`、`storage/`），agent 循环、流式、会话持久化、工具、联网搜索全部由 DeepSeek Harness（`@deepseek-ai/dsh`，钉 0.1.6-alpha.2）承担。自研面收敛为：Electron 前端、桌宠协调、`packages/daniya-bridge` 薄桥插件。

不走 `dsh --profile sdk`：其 `session.event` 无 token 级流、无取消、无审批回传。bridge 插件在 harness 进程内消费进程事件面，独占 stdio 跑按行 JSON-RPC，一处补全三个缺口。

随迁移拍板的取舍：改文件保留 ```daniya-file 提案约定（见 ADR 0002）；联网搜索改为模型自主 `web_search`（博查客户端与手动开关删除）；工具面只挂 `pwsh`/`web_search`/`web_fetch`；遥测全禁；凭据不明文落盘（DPAPI → spawn env）；沙箱 `workspace-write` 围栏在设置页工作目录。

## 代价与后果

- 安装包需随带物化依赖树（经 dead-deps blocklist 裁剪后数百 MB 级）；首启/升级走 `.stamp` 判定，硬链接农场物化、失败整树回退拷贝（B-8）。
- harness 宿主必须是真 Node，不能是 electron-as-node（ConPTY 拿不到控制台，pwsh 链静默死——B-7）。packaged 自带 `runtime/node.exe`。
- bridge stdout 只能写协议帧，一切诊断走 stderr。
- 会话存储是 append-only JSONL：`session.delete` 删不掉磁盘日志（dsh 持久层无删除 API）。
- 旧会话文件不迁移；全文搜索、subagent、approval seam 明确不挂（需要时均为 patch 一行）。

细节看 `harness/README.md`（组成/启动/坑）与 `packages/daniya-bridge/README.md`（协议全表）。
