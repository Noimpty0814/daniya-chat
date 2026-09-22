# daniya-chat

Electron desktop AI chat app (React renderer + main process + `packages/daniya-bridge` dsh plugin). Windows-only product: pet helper, DPAPI key storage, and `pwsh` tool are Windows-specific.

## Coordination

- `work/` holds in-flight coordination artifacts: `work/specs/*.md` are work orders (deleted when their work lands), `work/maps/*.md` are effort maps. They are committed on `main` so every session shares them. Nothing in `work/` is permanent documentation.
- `docs/` holds only what stays true after the work lands: `docs/adr/` for hard-to-reverse decisions.
- `CONTEXT.md` is the project vocabulary (maintained by `/align`). Use its terms when naming things.
- Non-trivial work flows through the spec pipeline: `/align` → `/to-spec` → `/dispatch` (remote agent host) or `/execute-spec` (local) → `/review`. Branch `feat/<name>` pairs with `work/specs/<name>.md`. Dispatched sessions always run SWE-2 Max.

## Remote execution (`fairybox`)

- Dispatched specs run on the `fairybox` cloud host (Linux x64, node 22, npm 10) under `~/workspaces/daniya-chat[-<name>]` worktrees. Repo slug: `Noimpty0814/daniya-chat`.
- Runnable there: `npm install`, `npm run typecheck`, `npm run test`. Harness work additionally needs `npm --prefix packages/daniya-bridge install && npm --prefix packages/daniya-bridge run build` then `npm install --prefix harness/profile` (three separate installs; fresh clones lack all).
- Local WSL box: the `https` origin is unreliable from here (GnuTLS errors/hangs) — fetch/push via the explicit SSH URL `git@github.com:Noimpty0814/daniya-chat.git`; do not change remote config. Note: remote `main` history was rewritten relative to pre-2026-09-22 checkouts (same content, new SHAs) — stale clones must `reset --hard` onto it, not merge/rebase.
- Not runnable there: `npm run pack` (electron-builder NSIS targets Windows), launching the app/Electron GUI, `pet-helper.ps1`, `pwsh`, DPAPI behavior. Specs whose acceptance needs a running app must state that UI verification stays local in their Testing section — remote verification is typecheck + unit tests.

## Local verification

`npm run typecheck` and `npm run test` before marking work done; `npm run build` when main/preload/renderer wiring changed.
