# Spec: dead-deps-scan — dsh 物化依赖树的死依赖判定清单

研究票：交付物是一份带实测证据的判定报告，不改生产代码。属于 effort `work/maps/slim-perf.md`（体积/性能优化，底线"零冗余"）。

## Problem

安装包随带的 harness 物化依赖树实测 621MB / ~486 包（win32-x64），其中过半体积来自从不进入 cordis 激活面的传递依赖：`libreoffice-kit-win32-x64` 独占 330MB（链：`@deepseek-ai/dsh` → `dsh-web-app` → `dsh-office-to-pdf` → `libreoffice-kit`，产品没有 office→PDF 功能）、`@opentelemetry/*` 35MB（遥测在 profile patch 中被禁用）、`openai` 17MB / `@google/genai` 14MB / `@anthropic-ai/*` 13MB（`dsh-base` → `dsh-llm-pi-ai` → `@earendil-works/pi-ai` 多供应商链，产品只用 DeepSeek）、`@octokit`/`@smithy`/`@aws-sdk` ~25MB。这些是 `@deepseek-ai/dsh` 的硬依赖，npm 层摘不掉，但运行时是否可达从未被系统判定——现在没有权威清单，裁剪只能凭猜。

## Outcome

`work/maps/slim-perf/dead-deps.md` 随本分支合回：候选依赖逐包判定（dead / alive / unknown）+ 每条判定的证据 + 删除后冒烟实测结果 + 可回收体积，外加一份可直接贴进 `scripts/prepare-harness.mjs` 的建议 blocklist。复核者能对每个 dead 判定追到三重证据（激活面缺席 + require 链不触达 + 删后冒烟无新增失败），或看到明确标注的不确定性。

## User Stories

1. 作为 slim-perf effort，我要一张逐包判定表，使裁剪 spec 不必重复探查。
2. 作为裁剪实现者，我要每个候选"删除后 boot 冒烟是否受影响"的实测结果，使 blocklist 开箱可用。
3. 作为复核者，我要报告区分"实测删除验证"与"仅静态推断"，使残余风险可见。
4. 作为 Windows 侧验收者，我要报告标注哪些判定仅在 linux 树验证过、需 win32 树复核，使平台差异不失控。

## Decisions

1. 交付物只有报告：`work/maps/slim-perf/dead-deps.md`。不改 `src/`、不改 `scripts/prepare-harness.mjs`、不改任何 package.json——blocklist 落地归后续 spec `slim-installer`。
2. 判定三档：`dead`（不在激活面、无 require 链触达、删后冒烟无新增失败）、`alive`（运行时可达或删除引发新失败）、`unknown`（证据不足，须列出缺的证据与补法）。
3. win32 专属二进制负载（`libreoffice-kit-win32-x64` 等 optional 变体）在 linux 树里不存在——判定对象是它们的 JS 父包（`dsh-office-to-pdf`、`libreoffice-kit` 等）；父包判 dead 则整链可裁，体积按 win32 scratch 树实测记录。
4. 激活面事实源 = `harness/profile/cordis.patch.yml` 叠加 `@deepseek-ai/dsh-sdk-minimal` bundle 的 cordis 树；运行实证 = `node harness/verify-profile.mjs` 输出的 entries 列表（35 个 ACTIVE entry 即 linux 激活面全集）。
5. Linux 冒烟基线：`verify-profile.mjs` 在 linux 上恰有 4 个已知平台断言失败（`persistent-pwsh` NO_FIBER、`terminal-bash`/`persistent-bash` ACTIVE、工具集 `[bash, web_fetch, web_search]` 而非 pwsh）——这是正确行为被硬编码断言误报。删依赖后失败集不得超出这 4 项，而非要求 0 失败。
6. 体积测量双轨：linux 树测 JS 可达性与删除后冒烟；win32 scratch 树（拷 `harness/profile/package.json` 去掉 `daniya-bridge` file: 依赖后 `npm install --os=win32 --cpu=x64 --ignore-scripts` 到 scratch 目录）测真实体积回收。
7. 候选种子清单（须全判，且不停于此——按 du 排名把 ≥2MB 的包全部判完）：`dsh-web-app`→`dsh-office-to-pdf`→`libreoffice-kit` 链、`@opentelemetry/*`、`dsh-llm-pi-ai`→`@earendil-works/pi-ai`→`openai`/`@google/genai`/`@anthropic-ai/*`、`@octokit`/`@smithy`/`@aws-sdk`（webhook 周边）、`@modelcontextprotocol`、`@agentclientprotocol`、`dsh-session-query-sqlite`（全文搜索明确不挂，ADR 0001）、`dsh-tool-fs-search`+`@vscode/ripgrep`、`dsh-webhook*`、`sharp`/`@img`（注意：attachment-local 在激活面，大概率 alive——须验证）。`node-pty`/`koffi` 已实证 alive（linux 上 bash 工具链/sandbox 在用），不用判。
8. 裁剪名单须保住 Linux boot 面：只在 linux 上需要的包（terminal-bash/persistent-bash 链、koffi-linux-x64 等）不得进 blocklist——报告对每条 dead 判定注明平台覆盖面。

## Testing

- 每个 dead 判定的实证：从 `harness/profile/node_modules` 删除该包目录后 `node harness/verify-profile.mjs` 的失败集仍等于 4 项平台基线；`node harness/smoke-bridge.mjs`（keyless 错误路径即可）不新增失败。
- 删除分组进行并记录顺序，使单包回归可定位；每组删除后跑冒烟，结束恢复（`npm install --prefix harness/profile` 重装）。
- 环境前置（fresh clone 三步缺一不可）：root `npm install`；`npm --prefix packages/daniya-bridge install && npm --prefix packages/daniya-bridge run build`（产出 lib/，boot 需要）；`npm install --prefix harness/profile`。
- 完成后 root `npm run typecheck && npm run test` 须全绿（本 spec 不该有影响，防误伤）。

## Out of Scope

- 实施 blocklist（改 `prepare-harness.mjs`）——归后续 spec `slim-installer`。
- Windows 真机验证——win32 树 boot 复核在报告中标注为 follow-up。
- 性能侧问题（首启拷贝、冷启动、常驻占用）——归兄弟票 `first-boot-copy` 与后续 spec。
- 修 `verify-profile.mjs` 的平台硬编码断言——归 spec `verify-linux`；本票以 4 项已知失败为基线工作即可。

## Open Questions

（无——本票不阻塞于未决项。）
