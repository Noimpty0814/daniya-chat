# harness/ — dsh runtime integration for daniya-chat

This directory owns the dsh (DeepSeek Harness) side of the app: the **daniya
profile** (`harness/profile/`), an app-owned launcher (`launch.mjs`), a dev-home
setup helper (`setup-dev-home.mjs`), and a composition/boot verifier
(`verify-profile.mjs`).

It replaces the legacy custom chat engine: the agent loop, streaming, sessions,
tools, and web search all live in dsh; the Electron app talks to the runtime
through `daniya-bridge` (stdio JSON-RPC).

## Quick start

```bash
# one-time: build the local bridge stub (harness/profile depends on it via file:)
npm --prefix packages/daniya-bridge run build

# one-command dev startup — materializes .dev-dsh-home, then boots the profile
npm run dev:harness
```

`dev:harness` runs `node harness/setup-dev-home.mjs && node harness/launch.mjs`.
The launcher stays alive until stdin reaches EOF, then shuts the profile down
with exit code 0 — stdin/stdout are reserved for the bridge JSON-RPC protocol.

Verification (boots the profile, asserts the composition contract, exits 0/1):

```bash
node harness/verify-profile.mjs
```

Composition dump without booting plugins (the same algorithm the boot path
uses), through the materialized dev home:

```bash
DSH_HOME=.dev-dsh-home node harness/profile/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile daniya --dump-config
```

## Startup approach

`launch.mjs` loads the app-owned profile **in place** — mirroring
`apps/desktop-host` in the reference repo:

1. `createRequire(harness/profile/package.json)` — the profile's own
   `node_modules` is the module-resolution anchor.
2. `loadProfileDirectory('dsh', profileDir, installAnchor)` from
   `@deepseek-ai/dsh-app-boot` builds the resolved profile (sdk-minimal bundle
   + `cordis.patch.yml` applied).
3. `runProfile({ ..., resolutionMode: 'runtime', resolvedProfile, ... })` from
   `@deepseek-ai/dsh/profile-boot` performs the standard dsh boot.
4. `process.stdin` is resumed; `'end'` → `shutdown(0)`.

Why not `dsh --profile daniya` (approach A)? The CLI resolves profiles under
`$DSH_HOME/profiles/<name>`, which would need the profile copied/linked into
the Harness home on every run. Loading the repository profile directly keeps
one source of truth and uses the same `runProfile` boot path anyway.
`setup-dev-home.mjs` still creates the `$DSH_HOME/profiles/daniya` junction so
the real CLI (`--dump-config`, manual debugging) works unchanged.

Launcher diagnostics go to **stderr only**; stdout is never written by the
launcher itself. Note that `npm run` prints its own lifecycle banner to
**stdout** — when spawning for the real bridge protocol, prefer
`node harness/launch.mjs` directly or `npm run --silent dev:harness`.

## Environment variables

| Variable              | Required | Purpose |
|-----------------------|----------|---------|
| `DSH_HOME`            | optional | dsh home (sessions, logs, resolved config). Defaults to `<repo>/.dev-dsh-home` when unset/blank. |
| `DEEPSEEK_API_KEY`    | optional* | DeepSeek API key. **Boot does not require it** — it is only needed when a model/web-search request is actually made. |
| `DEEPSEEK_BASE_URL`   | optional | DeepSeek API base URL override. |
| `DANIYA_WORKDIR`      | optional | Sandbox workspace root; falls back to `process.cwd()`. Wired via `!!js` in `sandbox-policy`. |
| `DANIYA_SETTINGS_FILE`| optional | Path to the app settings file consumed by `daniya-bridge`. |

## Directory layout

```
harness/
  launch.mjs           app-owned profile launcher (stdin/stdout = bridge protocol)
  verify-profile.mjs   boots the profile and asserts the composition contract
  smoke-bridge.mjs     live bridge protocol smoke (initialize → session CRUD → prompt → shutdown)
  repro-pwsh.mjs       B-7 repro: prompt a real pwsh tool call, capture tool events + stderr
  setup-dev-home.mjs   creates .dev-dsh-home + profiles/daniya junction
  profile/
    package.json       dsh.profile.bundles + pinned deps (all 0.1.6-alpha.2)
    cordis.patch.yml   patch layer: disable 4 rows, adjust sandbox-policy, insert 9 rows
    package-lock.json  committed lockfile
    node_modules/      (gitignored)
    cordis.yml         (gitignored — runtime-resolved tree written by the loader)
.dev-dsh-home/         (gitignored — dev Harness home; sessions/profiles junction)
```

## Effective composition

Verified by `verify-profile.mjs` against the live Cordis tree:

- **Disabled**: `sdk-app-startup`, `sdk-jsonrpc-server`,
  `session-log-deepseek`, `plugin-package-inventory-deepseek`.
- **Adjusted**: `sandbox-policy` → `mode: workspace-write`,
  `workspaceRoot: !!js process.env.DANIYA_WORKDIR || process.cwd()`.
- **Inserted + ACTIVE**: `daniya-bridge` (`daniya-bridge`),
  `attachment-local`, `web` (deepseek-official search + http fetch),
  `web-search-deepseek`, `web-fetch-http`, `tool-web`,
  `compaction-basic`, `tool-result-pruner`, `token-meter`.
- **Model-visible tools**: exactly `pwsh`, `web_search`, `web_fetch`
  (on Windows `terminal-bash`/`persistent-bash` are off by platform jsExpr).
- Bridge-injected services `agents`, `sessions`, `systemPrompt`,
  `attachments` all resolve.

## Dependency updates

All `@deepseek-ai/*` deps are pinned to `0.1.6-alpha.2` (the version matching
the reference repo). To update:

```bash
cd harness/profile
npm install --save-exact @deepseek-ai/dsh-sdk-minimal@<version> ... # repeat per package
```

then rebuild `packages/daniya-bridge` if it changed, and re-run
`verify-profile.mjs`. Commit the updated `package-lock.json`.

Note: some packages' `latest` npm dist-tags point at older releases — always
pin the explicit version; check `npm view <pkg> versions` for the real list.

## Known limitations / caveats

- **`file:` dep must stay a link**: `node_modules/daniya-bridge` must be a
  junction to `packages/daniya-bridge`, not a copied directory — a stale copy
  activates silently with an outdated `lib/`. If `ls -la` shows a real
  directory, delete it and re-run `npm install` inside `harness/profile`.
  Rebuild the bridge (`npm --prefix packages/daniya-bridge run build`) after
  changing its sources; the link picks up `lib/` live.
- **Protocol smoke**: `node harness/smoke-bridge.mjs` exercises the live
  bridge (initialize → session CRUD → prompt → notifications → shutdown)
  against the real profile; works keyless (error path) and with a key
  (real streaming).
- **npm 11 blocked install scripts**: `npm install` in `harness/profile`
  reported pending scripts for `node-pty`, `koffi`, `protobufjs`,
  `@google/genai`, `dsh-subprocess-local`. The shipped Windows prebuilds are
  sufficient — a full boot (persistent pwsh terminal, subprocess, sandbox)
  succeeds without them — but if native behavior regresses, run
  `npm rebuild --foreground-scripts` inside `harness/profile`.
- **`DEEPSEEK_API_KEY` deferred**: boot, tool registration, and the bridge
  all work keyless; the first real LLM/search request is what needs the key.
- **stdout must stay clean**: never add `console.log` or stdout logging to
  anything on this path — it corrupts the bridge protocol stream.
- **Host must be real Node, not electron-as-node**: the windows-acl sandbox
  wraps `pwsh` as `[process.execPath, runner.js, …]` and spawns that inside a
  ConPTY. `electron.exe` is a GUI-subsystem binary and gets no console under
  ConPTY, so the whole confined shell chain dies silently at startup
  ("PTY shell exited during startup"). The packaged app therefore ships
  `runtime/node.exe` (copied from the build machine's Node by
  `prepare-harness.mjs` — same ABI as the installed dependency tree), and dev
  falls back to `node` on PATH. Do not spawn the harness via
  `ELECTRON_RUN_AS_NODE`.
- `.dev-dsh-home` accumulates session JSONL logs; it is disposable — delete it
  and re-run `setup-dev-home.mjs` to reset.
