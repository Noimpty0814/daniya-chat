# dead-deps-scan — dsh 物化依赖树死依赖判定清单

研究票交付物。属 effort `work/maps/slim-perf.md`。只产判定报告，未改 `src/`、`scripts/`、任何 package.json。

执行环境：fairybox（Linux x64, node 22, npm 10），repo `daniya-chat` @ `feat/dead-deps-scan`。
测量日：2026-09-22。

## 结论

- linux 物化树实测 **475 包 / 500MB**；win32 scratch 树实测 **470 包 / 643MB**（`npm install --os=win32 --cpu=x64 --ignore-scripts`，无 lockfile，体积与地图记的 621MB 差 ~3%，来自传递依赖漂移与 du 粒度）。
- **dead = 351 包**：激活面缺席 + require 链不触达 + 分组删后冒烟无新增失败，三重证据齐。
- **alive = 121 包**（含 2 个按路径加载、扫描不可见的原生组件包）。
- **unknown = 3 包**（`@img/sharp-wasm32`、`@emnapi/runtime`、`node-addon-api`：静态 require 边存在但所挂分支桌面平台不执行/非运行时入口，详见 §unknown）。
- 建议 blocklist 可裁体积：**win32 ≈ 548MB / 643MB（85%）**，linux dev 树 ≈ 403MB / 500MB。外加 unknown 待定 ~9.5MB。

## 方法与事实源

### 激活面（证据腿 1）

事实源 = `harness/profile/cordis.patch.yml` 叠加 `@deepseek-ai/dsh-sdk-minimal` bundle 的 cordis 树；运行实证 = `node harness/verify-profile.mjs` 的 `entries` 列表。

实测 **42 entries**：linux 上 **36 ACTIVE**（地图/spec 记 35，差异在 `include` 行计入口径——本表以实测为准）、4 DISABLED（`sdk-app-startup` / `sdk-jsonrpc-server` / `session-log-deepseek` / `plugin-package-inventory-deepseek`）、2 NO_FIBER（`terminal-pwsh` / `persistent-pwsh`，平台 jsExpr 在 linux 求值为关）。win32 上 ACTIVE 集合同数替换：`terminal-pwsh`(`@deepseek-ai/dsh-terminal-bash`)、`persistent-pwsh`(`@deepseek-ai/dsh-tool-pwsh-persistent`) 替下 bash 两行。

36 ACTIVE 包名（linux 激活面全集）：`cordis:include`（builtin）+ dsh-deepseek-llm-api-extensions, dsh-llm-deepseek, dsh-sandbox-local, dsh-session-projection, dsh-sandbox-policy, dsh-subprocess-local, dsh-terminal, dsh-terminal-bash, cordis-plugin-timer, dsh-llm, dsh-session, dsh-session-title, dsh-system-prompt, dsh-tools, dsh-mcp-resources, dsh-agent, dsh-llm-retry, dsh-jobs-local, dsh-invariants, dsh-session/invariant, dsh-agent/invariant, dsh-scope/invariant, dsh-agent-loop/invariant, dsh-agent-loop, dsh-tool-bash-persistent, dsh-session-persistence-jsonl, daniya-bridge, dsh-attachment-local, dsh-web, dsh-web-search-deepseek, dsh-web-fetch-http, dsh-tool-web, dsh-compaction-basic, dsh-compaction-tool-result-pruner, dsh-token-meter。

### require 链（证据腿 2）

判定「require 链不触达」= 包不在以下闭包内：以全部 ACTIVE 条目包 + win32-only ACTIVE 包（`dsh-tool-pwsh-persistent`）+ boot 设施（`@deepseek-ai/dsh`、`dsh-app-boot`、`dsh-sdk-minimal`）为根，沿 shipped `.js/.cjs/.mjs` 中字面 specifier（`require()` / `import` / `import()` / `from` / `createLazyRequire()`）做 BFS。实测闭包 = **122 包**。

已知扫描盲区已逐点审计（可达代码内 34 处非字面 specifier 全部人工核对）：
- cordis loader 的 `import(options.name)` —— 按条目名装插件，条目集合即边界（可达包全部在根集合内）。
- `createLazyRequire(specifier)` —— 已并入扫描字面量；全部 8 处调用点已枚举：可达包内 6 处（attachment-local→`sharp`、subprocess-local→`node-pty`/`koffi`、terminal-bash→`@xterm/headless`、win32-process→`koffi`），不可达包内 2 处（`dsh-api-terminal-controller`→`@xterm/headless`/`@xterm/addon-serialize`）——宿主包已判 dead，其 lazy 目标不因此转 alive，故 `@xterm/addon-serialize` 在 g1 内判 dead。
- 计算式平台包名（`node-addon-system-${platform}-${arch}`、`@koromix/koffi-*` 二进制解析）—— 按路径装载，静态不可见，单独处理（见 §alive 注记）。
- worker / 测试 / CLI 文件内的动态装载 —— 与运行路径无关。

注意：package.json 声明闭包不可用——optionalDependencies 把 473→471 全连通，`dsh` 对 `dsh-web-app`/`dsh-base` 等的硬依赖在 npm 层摘不掉（spec Problem 节所述），只能按运行时代码路径判。

### 删后冒烟（证据腿 3）

协议（spec Testing 节）：`harness/profile/node_modules` 内按组 `mv` 移出 → `node harness/verify-profile.mjs` + `node harness/smoke-bridge.mjs` → 累积删除，组序即下表。全部跑完后 `npm install --prefix harness/profile` 恢复并复测基线。

**linux 基线**（spec 已定）：verify 恰 4 个平台断言失败——`persistent-pwsh` NO_FIBER、`terminal-bash`/`persistent-bash` ACTIVE、工具集 `[bash, web_fetch, web_search]` 而非 pwsh。删后判定线 = 失败集不超出这 4 项。smoke-bridge 基线 = 11 PASS / 0 FAIL（本机 `DEEPSEEK_API_KEY` 有效，冒烟走真实 LLM 回合，覆盖 llm-deepseek 适配器与流式路径，强于 keyless 错误路径）。

| 组 | 内容 | 包数 | verify 新增失败 | smoke FAIL | 结论 |
|---|---|---|---|---|---|
| g1 | web/office/libreoffice 簇 + 其独占 vendor 库 | 135 | 0 | 0 | CLEAN |
| g2 | OpenTelemetry + protobufjs | 24 | 0 | 0 | CLEAN |
| g3 | pi-ai 多供应商 LLM 链 | 27 | 0 | 0 | CLEAN |
| g4 | webhook/octokit/smithy/aws + mcp/acp | 58 | 0 | 0 | CLEAN |
| g5 | dsh-base 长尾未激活插件（含 4 个 DISABLED 条目包） | 90 | 0 | 0 | CLEAN |
| g6 | 剩余 vendor 尾（types/构建期工具/ripgrep 等） | 17 | 0 | 0 | CLEAN |
| g7 | 专项：sharp-wasm32 / @emnapi/runtime / node-addon-api | 3 | 0 | 0 | CLEAN |

恢复后复测：42 entries、恰 4 项平台失败、smoke 11 PASS——与基线一致。

**最终门禁**（spec Testing）：root `npm run typecheck` + `npm run test` 全绿（vitest 16 文件 / 186 测试）。

**三条重要实证推论**：
1. DISABLED/NO_FIBER 条目的包目录删除后 compose+boot 不受影响 → loader 不在组合期解析禁用条目的模块名。
2. `@deepseek-ai/cordis-plugin-include` 删除后无影响 → `dsh-app-boot` 内联的 `applyEntryPatches` 与 `cordis:include` builtin 是 vendor 化实现，该包运行时从不被 import。
3. 激活面不变式成立：35→36 条目全集与 require 闭包在三轮独立扫描中稳定（一次瞬时报错造成过 musl 变体漏计，复扫已校正——见 §局限）。

## 逐包判定表（候选种子 ∪ 双树 ≥2MB）

判定列：激活面 = 是否 ACTIVE 条目包；require = 是否落在闭包内；冒烟 = 删除组及结果。dead 须三项齐（缺席/不触达/CLEAN）。

| 包 | 判定 | linux MB | win32 MB | 激活面 | require | 冒烟 | 平台覆盖 |
|---|---|---|---|---|---|---|---|
| @deepseek-ai/libreoffice-kit-win32-x64 | dead† | — | 329.8 | 缺席 | 不触达 | 父链 g1 CLEAN | win32-only 变体·随父链 |
| @deepseek-ai/libreoffice-kit-wasm | dead | 185.6 | — | 缺席 | 不触达 | g1 CLEAN | linux 删测（无 win32 变体） |
| node-pty | alive | 25.8 | 25.8 | 可达 | 可达（lazy） | 未删 | — |
| openai | dead | 16.7 | 16.7 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @google/genai | dead | 13.8 | 13.8 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @anthropic-ai/sdk | dead | 13.2 | 13.2 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/semantic-conventions | dead | 11.8 | 11.8 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @img/sharp-win32-x64 | alive | — | 18.5 | 可达 | 可达（sharp 平台分支） | — | — |
| @img/sharp-libvips-linuxmusl-x64 | alive | 18.0 | — | 可达 | 可达（sharp 平台分支） | — | linux-only |
| @img/sharp-libvips-linux-x64 | alive | 17.8 | — | 可达 | 可达（sharp 平台分支） | — | linux-only |
| web-streams-polyfill | dead | 8.8 | 8.8 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @img/sharp-wasm32 | unknown | 8.8 | 8.8 | 缺席 | 可达（sharp 兜底分支） | g7 CLEAN | linux 删测·win32 待定 |
| @mixmark-io/domino | alive | 8.7 | 8.7 | 可达 | 可达（turndown） | — | — |
| zod | alive | 8.2 | 8.2 | 可达 | 可达 | — | — |
| @deepseek-ai/dsh-client-ui-sidebar-documentpreview | dead | 7.3 | 7.3 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @modelcontextprotocol/client | dead | 6.5 | 6.5 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @earendil-works/pi-ai | dead | 6.3 | 6.3 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @smithy/core | dead | 6.3 | 6.3 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| typebox | dead | 6.0 | 6.0 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @agentclientprotocol/sdk | dead | 5.8 | 5.8 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| fontkit | dead | 5.7 | 5.7 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @vscode/ripgrep-linux-x64 | dead | 5.5 | — | 缺席 | 不触达 | g6 CLEAN | linux 删测（无 win32 变体） |
| @vscode/ripgrep-win32-x64 | dead† | — | 5.2 | 缺席 | 不触达 | 父链 g6 CLEAN | win32-only 变体·随父链 |
| @octokit/openapi-types | dead | 5.1 | 5.1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/sdk-metrics | dead | 4.8 | 4.8 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-web-frontend | dead | 4.8 | 4.8 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/otlp-transformer | dead | 3.7 | 3.7 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| protobufjs | dead | 3.2 | 3.2 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/sdk-trace | dead | 3.1 | 3.1 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/resources | dead | 3.0 | 3.0 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/api | dead | 2.8 | 2.8 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @opentelemetry/sdk-logs | dead | 2.7 | 2.7 | 缺席 | 不触达 | g2 CLEAN | linux 删测·win32 待复核 |
| @types/node | dead | 2.7 | 2.7 | 缺席 | 不触达 | g6 CLEAN | linux 删测·win32 待复核 |
| @octokit/openapi-webhooks-types | dead | 2.6 | 2.6 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @aws-sdk/nested-clients | dead | 2.5 | 2.5 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| undici | alive | 2.4 | 2.4 | 可达 | 可达（dsh-http-proxy / web-fetch-http） | — | — |
| @swc/helpers | dead | 2.3 | 2.3 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @koromix/koffi-linux-x64 | alive | 2.3 | — | 可达 | 可达（lazy） | — | linux-only |
| @aws-sdk/core | dead | 2.1 | 2.1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @xterm/headless | alive | 1.9 | 1.9 | 可达 | 可达（lazy） | — | — |
| koffi | alive | 1.9 | 1.9 | 可达 | 可达（lazy） | — | — |
| js-yaml | alive | 1.9 | 1.9 | 可达 | 可达 | — | — |
| yaml | alive | 1.9 | 1.9 | 可达 | 可达 | — | — |
| sharp | alive | 1.0 | 1.0 | 可达 | 可达（lazy，attachment-local） | — | — |
| @deepseek-ai/dsh-web-app | dead | <1 | <1 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-office-to-pdf | dead | <1 | <1 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/libreoffice-kit | dead | <1 | <1 | 缺席 | 不触达 | g1 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-llm-pi-ai | dead | <1 | <1 | 缺席 | 不触达 | g3 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-webhook | dead | <1 | <1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-webhook-github | dead | <1 | <1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-mcp-client | dead | <1 | <1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-acp | dead | <1 | <1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-acp-app | dead | <1 | <1 | 缺席 | 不触达 | g4 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-session-query-sqlite | dead | <1 | <1 | 缺席 | 不触达 | g5 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-tool-fs-search | dead | <1 | <1 | 缺席 | 不触达 | g5 CLEAN | linux 删测·win32 待复核 |
| @deepseek-ai/dsh-base | dead | <1 | <1 | 缺席 | 不触达 | g5 CLEAN | linux 删测·win32 待复核 |
| @vscode/ripgrep | dead | <1 | <1 | 缺席 | 不触达 | g6 CLEAN | linux 删测·win32 待复核 |
| node-addon-api | unknown | <1 | <1 | 可达 | 字面 require 边存在于 `sharp/install/build.js:17`（npm 源码构建路径，运行时入口不装载该文件） | g7 CLEAN | linux 删测·win32 待定 |

`dead†` = win32-only 二进制变体，按 spec Decision 3 判其 JS 父包；父包 dead → 整链可裁，体积按 win32 scratch 实测。

补充：`daniya-bridge` alive（激活面根），dev 目录 du 66MB 是 src/tests/node_modules 开发产物——`prepare-harness.mjs` 白名单只拷 `lib/`+`package.json`+`README`，入包体积 ~0.1MB。

## dead 全量清单（351 包）

逐包列出；每包的冒烟证据 = 所属组的 CLEAN 结果（组序即上表，累积删除，单包回归按组内二分定位）。

**平台覆盖面（每条 dead 判定适用）**：默认 = linux 树实测删除+冒烟 CLEAN，win32 同源包按相同证据推断、待 win32 boot 复核兜底；`win32-only` 变体随 JS 父链判定；组内另行标注的包 = win32 复核优先项（见各组注记）。

### g1 — web/office/libreoffice 簇（135 包，linux 231.4MB / win32 45.8MB＋变体 329.8MB）

`@deepseek-ai/dsh-api-gateway`, `dsh-api-remotes`, `dsh-api-session-controller`, `dsh-api-settings-controller`, `dsh-api-terminal-controller`, `dsh-api-workspace-controller`, `dsh-api-workspace-files`, `dsh-authorization`, `dsh-client-connection`, `dsh-client-file-upload`, `dsh-client-hmr`, `dsh-client-locale`, `dsh-client-modules`, `dsh-client-resources`, `dsh-client-ui-agent-preset`, `dsh-client-ui-approval`, `dsh-client-ui-attachment`, `dsh-client-ui-brand-official`, `dsh-client-ui-chat`, `dsh-client-ui-commands`, `dsh-client-ui-conversation`, `dsh-client-ui-cordis`, `dsh-client-ui-deliverables`, `dsh-client-ui-directory-picker-browse`, `dsh-client-ui-directory-picker-native`, `dsh-client-ui-goal`, `dsh-client-ui-input-trigger`, `dsh-client-ui-jobs`, `dsh-client-ui-layout`, `dsh-client-ui-message-feedback`, `dsh-client-ui-model-selection`, `dsh-client-ui-open-in-app`, `dsh-client-ui-permission-presets`, `dsh-client-ui-plan`, `dsh-client-ui-plugin-manager`, `dsh-client-ui-primitives`, `dsh-client-ui-reference`, `dsh-client-ui-renderer`, `dsh-client-ui-schedule`, `dsh-client-ui-session`, `dsh-client-ui-settings`, `dsh-client-ui-settings-general`, `dsh-client-ui-settings-models`, `dsh-client-ui-settings-plugin-inventory`, `dsh-client-ui-settings-plugins`, `dsh-client-ui-settings-unarchive-sessions`, `dsh-client-ui-sidebar`, `dsh-client-ui-sidebar-browser`, `dsh-client-ui-sidebar-documentpreview`, `dsh-client-ui-sidebar-files`, `dsh-client-ui-sidebar-right`, `dsh-client-ui-sidebar-terminal`, `dsh-client-ui-skill`, `dsh-client-ui-slots`, `dsh-client-ui-subagent`, `dsh-client-ui-theme`, `dsh-client-ui-tool`, `dsh-client-ui-trajectory`, `dsh-client-ui-user-questions`, `dsh-client-ui-workflow-run`, `dsh-client-ui-workspace`, `dsh-cordis-client-runner`, `dsh-cordis-host-runner`, `dsh-experimental-agent-team`, `dsh-experimental-agent-team-profile`, `dsh-experimental-agent-team-web-profile`, `dsh-experimental-client-ui-agent-team`, `dsh-experimental-tool-agent-team`, `dsh-file-reference`, `dsh-file-reference-local`, `dsh-hmr`, `dsh-host-directory-picker`, `dsh-host-directory-picker-auto`, `dsh-host-directory-picker-browse`, `dsh-host-directory-picker-native`, `dsh-host-frontend-static`, `dsh-host-open-in-app`, `dsh-host-webserver`, `dsh-native-command`, `dsh-office-to-pdf`, `dsh-session-log-export`, `dsh-session-stats`, `dsh-session-turn-outline`, `dsh-web-app`, `dsh-web-frontend`, `dsh-workspace`, `dsh-workspace-changes`, `libreoffice-kit`, `libreoffice-kit-wasm`（均 `@deepseek-ai/`），及 vendor 库：`@swc/helpers`, `@xterm/addon-serialize`, `base64-js`, `brotli`, `bundle-name`, `bytes`, `chokidar`, `clone`, `compressible`, `compression`, `content-type`, `debug`, `default-browser`, `default-browser-id`, `define-lazy-prop`, `destroy`, `dfa`, `diff`, `fast-deep-equal`, `fflate`, `fontkit`, `is-docker`, `is-in-ssh`, `is-inside-container`, `is-wsl`, `mime-db`, `mime-types`, `ms`, `negotiator`, `on-headers`, `open`, `pako`, `picomatch`, `powershell-utils`, `readdirp`, `restructure`, `run-applescript`, `safe-buffer`, `saxes`, `tiny-inflate`, `unicode-properties`, `unicode-trie`, `vary`, `ws`, `wsl-utils`, `xmlchars`

win32-only 附随：`@deepseek-ai/libreoffice-kit-win32-x64`（330MB，父链 dead）。

### g2 — OpenTelemetry + protobufjs（24 包，双树各 39.7MB）

`@deepseek-ai/dsh-session-telemetry`, `dsh-session-telemetry-otel`；`@opentelemetry/api`, `api-logs`, `core`, `exporter-logs-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `resources`, `sdk-logs`, `sdk-metrics`, `sdk-trace`, `semantic-conventions`；`@protobufjs/aspromise`, `base64`, `codegen`, `eventemitter`, `fetch`, `float`, `path`, `pool`, `utf8`；`long`, `protobufjs`。

### g3 — pi-ai 多供应商 LLM 链（27 包，双树各 69.0MB）

`@deepseek-ai/dsh-llm-pi-ai`；`@earendil-works/pi-ai`, `pi-telemetry`；`@anthropic-ai/sdk`, `@google/genai`, `openai`；及独占 vendor：`agent-base`, `bignumber.js`, `data-uri-to-buffer`, `eventsource`, `extend`, `fetch-blob`, `formdata-polyfill`, `gaxios`, `gcp-metadata`, `google-auth-library`, `google-logging-utils`, `http-proxy-agent`, `https-proxy-agent`, `json-bigint`, `jwa`, `jws`, `node-domexception`, `node-fetch`, `typebox`, `undici-types`, `web-streams-polyfill`。

### g4 — webhook/octokit/smithy/aws + mcp/acp（58 包，双树各 41.7MB）

`@deepseek-ai/dsh-webhook`, `dsh-webhook-github`, `dsh-mcp-client`, `dsh-acp`, `dsh-acp-app`；`@modelcontextprotocol/client`, `core`；`@agentclientprotocol/sdk`；`@octokit/openapi-types`, `openapi-webhooks-types`, `request-error`, `types`, `webhooks`, `webhooks-methods`；`@smithy/core`, `credential-provider-imds`, `fetch-http-handler`, `is-array-buffer`, `node-http-handler`, `signature-v4`, `types`, `util-buffer-from`, `util-utf8`；`@aws-sdk/client-bedrock-runtime`, `core`, `credential-provider-env`, `credential-provider-http`, `credential-provider-ini`, `credential-provider-login`, `credential-provider-node`, `credential-provider-process`, `credential-provider-sso`, `credential-provider-web-identity`, `eventstream-handler-node`, `middleware-eventstream`, `middleware-websocket`, `nested-clients`, `signature-v4-multi-region`, `token-providers`, `types`, `util-locate-window`, `xml-builder`；`@aws-crypto/sha256-browser`, `sha256-js`, `supports-web-crypto`, `util`；`@aws/lambda-invoke-store`；vendor：`buffer-equal-constant-time`, `cross-spawn`, `ecdsa-sig-formatter`, `fast-sha256`, `isexe`, `jose`, `pkce-challenge`, `shebang-command`, `shebang-regex`, `standardwebhooks`, `which`。

### g5 — dsh-base 长尾未激活插件（90 包，双树各 10.0MB）

含 4 个 DISABLED 条目包（`dsh-sdk-app`, `dsh-sdk-jsonrpc-server`, `dsh-session-log-deepseek`, `dsh-plugin-package-inventory-deepseek`）与 `dsh-base` 本体、`cordis-plugin-include`（vendored，见推论 2）。余者：`dsh-agent-default-model`, `dsh-agent-instructions`, `dsh-agent-presets`, `dsh-agent-tool-presentation`, `dsh-bash-local`, `dsh-bash-sandbox`, `dsh-chunked-list`, `dsh-command-compact`, `dsh-command-feedback`, `dsh-command-goal`, `dsh-commands`, `dsh-credentials-local`, `dsh-deque`, `dsh-fs`, `dsh-fs-local`, `dsh-fs-observation-policy`, `dsh-fs-sandbox`, `dsh-goal`, `dsh-goal-round-driver`, `dsh-headless`, `dsh-hook-protocol`, `dsh-hooks-claude-code`, `dsh-hooks-codex`, `dsh-message-feedback`, `dsh-output-retention`, `dsh-package-manifest`, `dsh-permission-presets`, `dsh-persona`, `dsh-plan-mode`, `dsh-ptc-runtime`, `dsh-ptc-runtime-node`, `dsh-pwsh-sandbox`, `dsh-repeat-tool-reminder`, `dsh-schedule`, `dsh-session-checkpoint-policy`, `dsh-session-projection-cache`, `dsh-session-query`, `dsh-session-query-sqlite`, `dsh-session-reference`, `dsh-session-title-first-prompt-llm`, `dsh-session-title-llm`, `dsh-settings`, `dsh-settings-file`, `dsh-shell-env`, `dsh-skill`, `dsh-skill-badge`, `dsh-skill-filesystem`, `dsh-spill`, `dsh-spill-local`, `dsh-spill-policy`, `dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`, `dsh-subagent`, `dsh-subagent-fork-in-process`, `dsh-subagent-in-process-driver`, `dsh-subagent-spawn-in-process`, `dsh-time-context`, `dsh-tmux-context`, `dsh-tool-ask-user`, `dsh-tool-bash`, `dsh-tool-call-timeout-policy`, `dsh-tool-cordis`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-goal`, `dsh-tool-jobs`, `dsh-tool-present`, `dsh-tool-pwsh`, `dsh-tool-ralph`, `dsh-tool-skill`, `dsh-tool-str-replace-editor`, `dsh-tool-subagent`, `dsh-tool-subagent-control`, `dsh-tool-todo`, `dsh-tool-workflow`, `dsh-typert-loader`, `dsh-typert-registry`, `dsh-user-approval`, `dsh-user-questions`, `dsh-util-time`, `dsh-util-workspace-path`, `dsh-workflow`, `dsh-workflow-ptc`（均 `@deepseek-ai/`）。

win32 复核优先项：`dsh-tool-pwsh`、`dsh-pwsh-sandbox`（pwsh 家族——union 闭包不触达、非任何条目的插件名，但属 win32 激活面近邻，win32 boot 复核优先）；`dsh-bash-local`、`dsh-bash-sandbox`、`dsh-shell-env`（bash 家族——linux 实测由 `dsh-subprocess-local` 内嵌 runner 承担）。

### g6 — vendor 尾（17 包，linux 11.7MB / win32 6.2MB）

`@babel/code-frame`, `helper-validator-identifier`, `runtime`；`@stablelib/base64`, `@standard-schema/spec`, `@types/node`, `@types/retry`, `@vscode/ripgrep`, `@vscode/ripgrep-linux-x64`；`bowser`, `js-tokens`, `json-schema-to-ts`, `p-retry`, `partial-json`, `picocolors`, `retry`, `ts-algebra`。

win32-only 附随：`@vscode/ripgrep-win32-x64`（5.2MB，父链 dead）。

### g7 — 专项（3 包全部 unknown，不入 dead 清单）

`@img/sharp-wasm32`、`@emnapi/runtime`、`node-addon-api` → unknown（下节）。删后冒烟 CLEAN 但三者均存在字面 require 边，按 spec 判定口径（dead 须「无 require 链触达」）不归 dead。

## alive 清单（121 包）

require 闭包 122 包 = 119 个未删除 alive + 3 个 g7 unknown（`@img/sharp-wasm32`/`@emnapi/runtime`/`node-addon-api`）；另有 2 个扫描不可见但机制上 alive 的路径装载包，合计 121：

- `@deepseek-ai/node-addon-system-linux-x64` — landlock 沙箱 launcher，`node-addon-system` 用计算式 specifier（`${platform}-${arch}`）解析。**linux boot 面必须保留**；win32 无此变体（win32 走 windows-acl rung）。注意：删它 boot 冒烟也看不出问题（launcher 在 spawn 时才探测）——本条 alive 判的是机制证据而非冒烟。
- `node-addon-require-builtin-linux-x64-gnu` — cordis loader 的 .node 装载二进制，按路径装载。linux 必留；win32 对应 `node-addon-require-builtin-win32-x64-msvc`。

其余 alive（require 可达，含全部 ACTIVE 条目包与其真实运行依赖；`daniya-bridge` 为自研包）：
`@deepseek-ai/cordis`, `cordis-plugin-group`, `cordis-plugin-loader`, `cordis-plugin-timer`, `cosmokit`, `dsh`, `dsh-agent`, `dsh-agent-loop`, `dsh-anonymous-user-id`, `dsh-app-boot`, `dsh-atomic-write`, `dsh-attachment`, `dsh-attachment-local`, `dsh-brand`, `dsh-cmdline`, `dsh-compaction`, `dsh-compaction-basic`, `dsh-compaction-image-offload`, `dsh-compaction-tool-result-pruner`, `dsh-credentials`, `dsh-deepseek-llm-api-extensions`, `dsh-home-paths`, `dsh-host-plugin-inventory`, `dsh-http-proxy`, `dsh-invariants`, `dsh-jobs`, `dsh-jobs-local`, `dsh-launch-environment`, `dsh-lazy-require`, `dsh-llm`, `dsh-llm-deepseek`, `dsh-llm-retry`, `dsh-mcp-resources`, `dsh-plugin-manager`, `dsh-pwsh-local`, `dsh-sandbox`, `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-sandbox-windows-acl`, `dsh-scope`, `dsh-sdk-minimal`, `dsh-sdk-protocol`, `dsh-session`, `dsh-session-format`, `dsh-session-format-catalog`, `dsh-session-format-v0-to-v1`, `dsh-session-format-v1-to-v2`, `dsh-session-format-v2-to-v3`, `dsh-session-persistence`, `dsh-session-persistence-jsonl`, `dsh-session-projection`, `dsh-session-title`, `dsh-shell`, `dsh-subprocess`, `dsh-subprocess-local`, `dsh-system-prompt`, `dsh-terminal`, `dsh-terminal-bash`, `dsh-timeout`, `dsh-token-meter`, `dsh-tool-bash-persistent`, `dsh-tool-pwsh-persistent`, `dsh-tool-web`, `dsh-tools`, `dsh-typert-protocol`, `dsh-util-crypto`, `dsh-util-values`, `dsh-web`, `dsh-web-fetch-http`, `dsh-web-search-deepseek`, `dsh-win32-process`, `node-addon-system`, `schemastery`（均 `@deepseek-ai/`），及 vendor：`@img/colour`, `@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-linuxmusl-x64`, `@img/sharp-linux-x64`, `@img/sharp-linuxmusl-x64`, `@joplin/turndown-plugin-gfm`, `@koromix/koffi-linux-x64`, `@mixmark-io/domino`, `@sec-ant/readable-stream`, `@sindresorhus/merge-streams`, `@xterm/headless`, `argparse`, `commander`, `daniya-bridge`, `detect-libc`, `eventsource-parser`, `execa`, `figures`, `get-stream`, `human-signals`, `ipaddr.js`, `is-plain-obj`, `is-stream`, `is-unicode-supported`, `js-yaml`, `koffi`, `node-addon-native-custom-loader`, `node-addon-require-builtin`, `node-pty`, `npm-run-path`, `parse-ms`, `path-key`, `pretty-ms`, `resolve.exports`, `semver`, `sharp`, `signal-exit`, `strip-final-newline`, `tslib`, `turndown`, `undici`, `unicorn-magic`, `which-command`, `yaml`, `yoctocolors`, `zod`。

win32-only alive 变体（scratch 树内、linux 判定不可直接覆盖）：`@img/sharp-win32-x64`（sharp 的 win32 二进制）、`@koromix/koffi-win32-x64`、`node-addon-require-builtin-win32-x64-msvc`。linux-only alive：`@deepseek-ai/node-addon-system-linux-x64`、`@koromix/koffi-linux-x64`、`@img/sharp-*-linux*`、`node-pty`（linux 侧实体）、`node-addon-require-builtin-linux-x64-gnu`——**这些不得进 blocklist**（spec Decision 8，保住 linux boot/验证面）。

## unknown 清单（3 包）

| 包 | 缺的证据 | 补法 |
|---|---|---|
| `@img/sharp-wasm32`（8.7MB，双树均有） | 静态 require 边存在于 sharp 运行时文件 `dist/sharp.cjs:104`（`require("@img/sharp-wasm32/sharp.node")`，原生 .node 加载失败后的最终兜底）与 `dist/utility.cjs`（读其 `versions`）。安装路径特殊：sharp 的 optionalDeps 只列 `@img/sharp-{freebsd,webcontainers}-wasm32` 两个 wrapper，本包是 wrapper 的传递 dep、在物化树中 npm 报 `extraneous`，但 linux/win32 两树均实际物化。桌面平台正常走 `@img/sharp-{linux,win32}-x64`，兜底分支仅在原生加载失败时执行——boot 冒烟无法制造该失败路径 | win32 上删后跑「附件图片上传」冒烟；或确认产品可接受「sharp 原生失败即报错」语义后转 dead |
| `@emnapi/runtime`（0.4MB） | 唯一父边来自 `@img/sharp-wasm32`（wasm32 的 emnapi shim），命运随 wasm32 | 同上 |
| `node-addon-api`（0.4MB） | 字面 require 边存在于 `sharp/install/build.js:17`——该文件是 npm 源码构建脚本，sharp 运行时入口（`dist/index.cjs`）不装载它。包级扫描计入可达，文件级看是死边；按 spec 判定口径（dead 须无 require 链触达）保守归 unknown | 确认 `install/build.js` 在任何运行时/安装路径均不被装载（npm 仅在源码构建时调用）后转 dead |

## 建议 blocklist（可贴入 `scripts/prepare-harness.mjs`）

351 个 dead 包 + 2 个 win32-only dead 变体（`libreoffice-kit-win32-x64`、`@vscode/ripgrep-win32-x64`）= **353 项**。unknown 三包不入列。`.bin` 内残留 shim 无害（指向已删包的 shim 永不执行）。

名单与上文 §dead 全量清单 g1–g6 同源生成（另加 2 个 win32-only 变体）；已程序化 diff 校验一致。

```js
// dead-deps-scan 判定结果（work/maps/slim-perf/dead-deps.md）：激活面缺席 +
// require 链不触达 + linux 删后冒烟 CLEAN。win32 boot 复核为 follow-up（见报告 §平台覆盖）。
// win32 复核优先：'@deepseek-ai/dsh-tool-pwsh'、'@deepseek-ai/dsh-pwsh-sandbox'（pwsh 家族近邻）。
const DEAD_DEPS = new Set([
  // ── g1 web/office/libreoffice（linux 231MB + win32 变体 330MB）──
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-settings-controller',
  '@deepseek-ai/dsh-api-terminal-controller', '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-api-workspace-files', '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-hmr', '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-ui-agent-preset', '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-deliverables', '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-native', '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-input-trigger', '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection', '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-permission-presets', '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-reference', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-schedule', '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models', '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins', '@deepseek-ai/dsh-client-ui-settings-unarchive-sessions',
  '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-skill', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-subagent', '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions', '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-cordis-host-runner', '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-agent-team-profile', '@deepseek-ai/dsh-experimental-agent-team-web-profile',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team', '@deepseek-ai/dsh-experimental-tool-agent-team',
  '@deepseek-ai/dsh-file-reference', '@deepseek-ai/dsh-file-reference-local',
  '@deepseek-ai/dsh-hmr', '@deepseek-ai/dsh-host-directory-picker',
  '@deepseek-ai/dsh-host-directory-picker-auto', '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-host-directory-picker-native', '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-host-open-in-app', '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-native-command', '@deepseek-ai/dsh-office-to-pdf',
  '@deepseek-ai/dsh-session-log-export', '@deepseek-ai/dsh-session-stats',
  '@deepseek-ai/dsh-session-turn-outline', '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-web-frontend', '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-workspace-changes', '@deepseek-ai/libreoffice-kit',
  '@deepseek-ai/libreoffice-kit-wasm', '@deepseek-ai/libreoffice-kit-win32-x64',
  '@swc/helpers', '@xterm/addon-serialize', 'base64-js', 'brotli', 'bundle-name',
  'bytes', 'chokidar', 'clone', 'compressible', 'compression', 'content-type',
  'debug', 'default-browser', 'default-browser-id', 'define-lazy-prop', 'destroy',
  'dfa', 'diff', 'fast-deep-equal', 'fflate', 'fontkit', 'is-docker', 'is-in-ssh',
  'is-inside-container', 'is-wsl', 'mime-db', 'mime-types', 'ms', 'negotiator',
  'on-headers', 'open', 'pako', 'picomatch', 'powershell-utils', 'readdirp',
  'restructure', 'run-applescript', 'safe-buffer', 'saxes', 'tiny-inflate',
  'unicode-properties', 'unicode-trie', 'vary', 'ws', 'wsl-utils', 'xmlchars',
  // ── g2 otel + protobufjs（39.7MB）──
  '@deepseek-ai/dsh-session-telemetry', '@deepseek-ai/dsh-session-telemetry-otel',
  '@opentelemetry/api', '@opentelemetry/api-logs', '@opentelemetry/core',
  '@opentelemetry/exporter-logs-otlp-http', '@opentelemetry/otlp-exporter-base',
  '@opentelemetry/otlp-transformer', '@opentelemetry/resources',
  '@opentelemetry/sdk-logs', '@opentelemetry/sdk-metrics', '@opentelemetry/sdk-trace',
  '@opentelemetry/semantic-conventions', '@protobufjs/aspromise', '@protobufjs/base64',
  '@protobufjs/codegen', '@protobufjs/eventemitter', '@protobufjs/fetch',
  '@protobufjs/float', '@protobufjs/path', '@protobufjs/pool', '@protobufjs/utf8',
  'long', 'protobufjs',
  // ── g3 pi-ai 多供应商链（69MB）──
  '@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai', '@earendil-works/pi-telemetry',
  '@anthropic-ai/sdk', '@google/genai', 'openai', 'agent-base', 'bignumber.js',
  'data-uri-to-buffer', 'eventsource', 'extend', 'fetch-blob', 'formdata-polyfill',
  'gaxios', 'gcp-metadata', 'google-auth-library', 'google-logging-utils',
  'http-proxy-agent', 'https-proxy-agent', 'json-bigint', 'jwa', 'jws',
  'node-domexception', 'node-fetch', 'typebox', 'undici-types', 'web-streams-polyfill',
  // ── g4 webhook/octokit/smithy/aws + mcp/acp（41.7MB）──
  '@deepseek-ai/dsh-webhook', '@deepseek-ai/dsh-webhook-github',
  '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-acp-app',
  '@modelcontextprotocol/client', '@modelcontextprotocol/core', '@agentclientprotocol/sdk',
  '@octokit/openapi-types', '@octokit/openapi-webhooks-types', '@octokit/request-error',
  '@octokit/types', '@octokit/webhooks', '@octokit/webhooks-methods',
  '@smithy/core', '@smithy/credential-provider-imds', '@smithy/fetch-http-handler',
  '@smithy/is-array-buffer', '@smithy/node-http-handler', '@smithy/signature-v4',
  '@smithy/types', '@smithy/util-buffer-from', '@smithy/util-utf8',
  '@aws-sdk/client-bedrock-runtime', '@aws-sdk/core', '@aws-sdk/credential-provider-env',
  '@aws-sdk/credential-provider-http', '@aws-sdk/credential-provider-ini',
  '@aws-sdk/credential-provider-login', '@aws-sdk/credential-provider-node',
  '@aws-sdk/credential-provider-process', '@aws-sdk/credential-provider-sso',
  '@aws-sdk/credential-provider-web-identity', '@aws-sdk/eventstream-handler-node',
  '@aws-sdk/middleware-eventstream', '@aws-sdk/middleware-websocket',
  '@aws-sdk/nested-clients', '@aws-sdk/signature-v4-multi-region', '@aws-sdk/token-providers',
  '@aws-sdk/types', '@aws-sdk/util-locate-window', '@aws-sdk/xml-builder',
  '@aws-crypto/sha256-browser', '@aws-crypto/sha256-js', '@aws-crypto/supports-web-crypto',
  '@aws-crypto/util', '@aws/lambda-invoke-store',
  'buffer-equal-constant-time', 'cross-spawn', 'ecdsa-sig-formatter', 'fast-sha256',
  'isexe', 'jose', 'pkce-challenge', 'shebang-command', 'shebang-regex',
  'standardwebhooks', 'which',
  // ── g5 dsh-base 长尾未激活插件（10MB，含 4 个 DISABLED 条目包）──
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-agent-tool-presentation', '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-bash-local', '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-chunked-list', '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-command-feedback', '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-deque', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy', '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-hook-protocol',
  '@deepseek-ai/dsh-hooks-claude-code', '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-message-feedback', '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-package-manifest', '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek', '@deepseek-ai/dsh-ptc-runtime',
  '@deepseek-ai/dsh-ptc-runtime-node', '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-repeat-tool-reminder', '@deepseek-ai/dsh-schedule',
  '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-session-checkpoint-policy', '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-session-projection-cache', '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-query-sqlite', '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-session-title-first-prompt-llm', '@deepseek-ai/dsh-session-title-llm',
  '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings-file',
  '@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-skill-badge',
  '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-spill',
  '@deepseek-ai/dsh-spill-local', '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-fork-in-process', '@deepseek-ai/dsh-subagent-in-process-driver',
  '@deepseek-ai/dsh-subagent-spawn-in-process', '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-tmux-context', '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-cordis', '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-typert-loader', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-util-time', '@deepseek-ai/dsh-util-workspace-path',
  '@deepseek-ai/dsh-workflow', '@deepseek-ai/dsh-workflow-ptc',
  // ── g6 vendor 尾（linux 11.7MB / win32 6.2MB）──
  '@babel/code-frame', '@babel/helper-validator-identifier', '@babel/runtime',
  '@stablelib/base64', '@standard-schema/spec', '@types/node', '@types/retry',
  '@vscode/ripgrep', '@vscode/ripgrep-linux-x64', '@vscode/ripgrep-win32-x64',
  'bowser', 'js-tokens', 'json-schema-to-ts', 'p-retry', 'partial-json',
  'picocolors', 'retry', 'ts-algebra',
])
```

落地提示（归 `slim-installer` spec）：`prepare-harness.mjs` 的 `cpSync` filter 按 `path.relative(node_modules, src)` 首段（或 `scope/name` 两段）命中本名单即跳过。

## 体积回收核算

| 口径 | 体积 |
|---|---|
| win32 物化树（scratch 实测） | 643MB |
| dead 同名包（win32 树内） | ~213MB |
| dead 的 win32-only 变体（libreoffice-kit-win32-x64 329.8 + ripgrep-win32-x64 5.2） | ~335MB |
| **win32 可裁合计** | **~548MB（85%）→ 剩 ~95MB** |
| linux dev 树可裁 | ~403MB / 500MB → 剩 ~97MB |
| unknown 待定 | +9.5MB（sharp-wasm32 8.7 + emnapi 0.4 + node-addon-api 0.4，双树各一份） |

注：scratch 树无 lockfile，传递版本有漂移；`slim-installer` 落地时以锁文件树重测为准。

## 平台覆盖与 follow-up

- 全部 dead 判定的冒烟腿只跑过 **linux**。激活面/require 两腿对 win32 已并集处理（`dsh-tool-pwsh-persistent` 为根的闭包已并入），但 **win32 boot 复核是 follow-up**：在 Windows 上按本 blocklist 删后跑 `verify-profile.mjs`（彼时断言已平台化——`verify-linux` spec 先行）+ `smoke-bridge.mjs`。
- pwsh 家族特别说明：`dsh-tool-pwsh`（非 persistent 变体）、`dsh-pwsh-sandbox` 在 union 闭包中也不可达——`dsh-tool-pwsh-persistent`（win32 ACTIVE）与 `dsh-terminal-bash` 均不引用它们，两包也不是任何条目的插件名。判 dead 但在 blocklist 与 g5 注记中双标 win32 复核优先。`powershell-utils` 名字像 pwsh，实际是 `open`/`wsl-utils`（浏览器打开链）的依赖。
- linux-only 变体（ripgrep-linux-x64 等）的 dead 判定随 JS 父链；同名 win32 变体按「家族 dead」入 blocklist，win32 复核兜底。
- `dsh-bash-local`/`dsh-bash-sandbox`/`dsh-shell-env`：linux 上 bash 工具链实测用的是 `dsh-subprocess-local` 内嵌 runner + `dsh-sandbox-local` landlock rung，三包无任何可达引用——dead。
- follow-up 清单：① win32 boot 复核（本报告 blocklist，pwsh/bash 家族优先项见 g5 注记）；② unknown 三包收口（sharp-wasm32/emnapi 走 win32 attach 图冒烟或语义确认；node-addon-api 确认 `install/build.js` 无运行时装载路径）；③ slim-installer spec 落地 blocklist + prepare-harness 过滤。

## 残余风险与方法局限（复核者须知）

- **冒烟覆盖面**：verify-profile 覆盖 compose→boot→服务解析→工具注册→沙箱策略→shutdown；smoke-bridge 覆盖 initialize→session CRUD→prompt 真实流式回合→shutdown。未覆盖：附件图片处理（sharp 真实调用点）、bash 工具实际执行、web_fetch 真实抓取、compaction 触发。缓释：这些路径的执行代码均在可达闭包内，其声明依赖已计入可达集——被删包要影响它们只能走未声明 require，而动态 specifier 审计（34 处）未发现指向被删包的装载点。
- **require 扫描局限**：字面 specifier 正则对混淆/加密装载无效；`dsh-*` 包均为 tsc/打包产物，未见此类模式。一轮扫描曾漏计 2 个 musl 变体（疑似瞬时读文件失败），复扫稳定为 122 包；删除集与最终可达集交集为空，判定不受影响。
- **`.bin`/lockfile 残留**：`.bin` 内指向被删包的 shim 与 `.package-lock.json` 元数据不进 blocklist，无运行影响。
- **win32-only alive 变体**（sharp-win32-x64、koffi-win32-x64、node-addon-require-builtin-win32-x64-msvc）未经 linux 验证直接判 alive——按机制保守处理，不进 blocklist。
