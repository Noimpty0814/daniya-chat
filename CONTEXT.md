# CONTEXT.md — 项目词汇

## 运行时与进程

- **dsh / DeepSeek Harness**：`@deepseek-ai/dsh` 运行时子进程；agent 循环、流式、会话持久化、工具、联网搜索全在它里面（ADR-0001）。钉版 `0.1.6-alpha.2`。
- **daniya profile**：`harness/profile/` 的 profile 模板——sdk-minimal bundle 加 `cordis.patch.yml` 定制层（禁遥测与自带服务面、收紧沙箱、挂 bridge 与工具）。
- **daniya-bridge**：`packages/daniya-bridge` 自研 dsh 插件；在 harness 进程内独占 stdin/stdout 跑按行 JSON-RPC，把进程内事件面桥给 Electron 主进程，并向每个会话注入人设段。线契约唯一真相是其 `src/protocol.ts`（零导入纯类型文件，ADR-0003）。
- **harness bundle**：`build/harness-bundle/`——`scripts/prepare-harness.mjs` 物化的可分发 harness 树（launch.mjs + 裁剪后的 profile 依赖树 + `runtime/node.exe` + `.stamp`），经 `extraResources` 进安装包。
- **物化（materialization）**：packaged 首启把只读 `resources/harness` 落到可写 `<userData>/harness/app`；`.stamp` 版本戳判复用；填充走硬链接农场（逐文件 link），任一失败整树回退拷贝。
- **runtime/node.exe**：packaged 自带的真 Node 宿主——electron-as-node 在 ConPTY 下无控制台会让 pwsh 链静默死（B-7）。

## 会话与数据

- **会话登记簿 / ConversationRegistry**：主进程自持的 `userData/conversations.json`——conversationId↔sessionId 映射、显示序、标题覆盖。dsh 侧 session 是 append-only JSONL 事件日志、无删除 API（`session.delete` 只卸活 agent）。
- **settings.json**：userData 下的设置文件；API key 以 DPAPI 密文存 `apiKeyEncrypted`，运行时解密后经 env 注入子进程，不明文落盘。安装版与开发版 userData 不同：安装版随 productName 是 `%APPDATA%\达妮娅聊天`，开发版是 `%APPDATA%\daniya-chat`。
- **人设 / persona**：`src/main/settings.ts` 的 `DEFAULT_PERSONA` 为默认 `systemPrompt`（用户可在设置页改）；bridge 每轮重读该字段并追加 EMOTION_CONTRACT + FILE_CONTRACT 注入会话。
- **工作目录 / workspace-write 沙箱**：设置页 `file.workDir` 是写入围栏；模型唯一直写通道 `pwsh` 越界即拒。

## 模型契约

- **提案 / daniya-file 块**：模型改文件的唯一通道——fenced JSON 提案块，主进程剥离后经 diff 面板由用户确认才应用（ADR-0002）。
- **情绪标记 `{EMO:x}` / `{x}` 简写**：回复首个 token 的情绪指令，流式剥离后驱动桌宠表情，不进显示文本（`src/main/harness/emotion.ts`）。
- **模型可见工具**：恰好 `pwsh`（持久 PowerShell）、`web_search`、`web_fetch` 三个。

## 桌宠

- **桌宠 / pet**：外部 Bongo Cat 进程；联动经 `resources/pet-helper.ps1` 与 `%TEMP%/daniya-pet` 下 `events.jsonl`/`cmd.json` 文件通道；情绪键位映射在设置页 `emotionKeys`。

## 构建与流程

- **死依赖 blocklist**：`scripts/dead-deps.mjs` 的 `DEAD_DEPS`——不进 bundle 的 dsh 包名单（判定三重证据：激活面缺席、require 链不触达、删后冒烟 CLEAN）。
- **fairybox**：远程 Linux x64 执行主机（node 22）；`/dispatch` 的票在其上实现。约束见 AGENTS.md「Remote execution」。
- **票**：`work/specs/<name>.md` 工作单，配对 `feat/<name>` 分支；落地即删。
- **图**：`work/maps/<effort>.md` wayfinder 工作图；到达目的地即删。
- **B-x**：dsh 迁移验收轮的问题编号（如 B-7 ConPTY 宿主、B-8 物化冻结）；出处 spec 已删，语义由 ADR-0001 与各注释处自带解释承载。
