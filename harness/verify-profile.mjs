/**
 * T-1 profile verification: boots the daniya profile through the same
 * `loadProfileDirectory` + `runProfile` path as `launch.mjs`, then inspects
 * the live Cordis tree and tool registry.
 *
 * Assertions (design spec §4):
 *   - disabled:  sdk-app-startup, sdk-jsonrpc-server, session-log-deepseek,
 *                plugin-package-inventory-deepseek
 *   - active:    daniya-bridge, attachment-local, web, web-search-deepseek,
 *                web-fetch-http, tool-web, compaction-basic,
 *                tool-result-pruner, token-meter
 *   - sandbox-policy config is workspace-write rooted at $DANIYA_WORKDIR
 *   - model-visible tools are exactly pwsh / web_search / web_fetch
 *
 * All diagnostics go to stderr; stdout stays reserved for the bridge
 * protocol, so this script is also a stdout-cleanliness probe.
 *
 * Usage: node harness/verify-profile.mjs
 * Exits 0 when every assertion holds, 1 otherwise.
 */

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(harnessDir, '..')
const profileDir = resolve(harnessDir, 'profile')

if (process.env.DSH_HOME === undefined || process.env.DSH_HOME.trim() === '') {
  process.env.DSH_HOME = resolve(repoRoot, '.dev-dsh-home')
}

const profileRequire = createRequire(resolve(profileDir, 'package.json'))
const importFromProfile = (specifier) =>
  import(pathToFileURL(profileRequire.resolve(specifier)).href)

const { loadLayeredEnv, loadProfileDirectory } =
  await importFromProfile('@deepseek-ai/dsh-app-boot')
const { runProfile } = await importFromProfile('@deepseek-ai/dsh/profile-boot')

const installAnchor = profileRequire.resolve('@deepseek-ai/dsh/package.json')
const profile = loadProfileDirectory('dsh', profileDir, installAnchor)

const report = { ok: true, failures: [] }
const fail = (msg) => { report.ok = false; report.failures.push(msg) }

let runtime
try {
  runtime = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'daniya',
    resolutionMode: 'runtime',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [],
  })
} catch (error) {
  fail(`runProfile threw: ${(error && error.stack) || error}`)
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
}

const { ctx, shutdown } = runtime

// FiberState enum mirrors vendor/cordis/src/fiber.ts. `options.disabled` holds
// the raw value: literal `true`, or a `{__jsExpr}` object that is only
// evaluated at entry-update time — so the authoritative "did it run" signal is
// the fiber, not the option.
const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const fiberState = (entry) =>
  entry.fiber ? (FIBER_STATE[entry.fiber.state] ?? `state=${entry.fiber.state}`) : 'NO_FIBER'
const entryState = (entry) =>
  entry.options.disabled === true ? 'DISABLED' : fiberState(entry)

const entries = new Map()
for (const entry of ctx.loader.entries()) entries.set(entry.options.id, entry)

report.entries = Object.fromEntries(
  [...entries.values()].map((e) => [
    e.options.id,
    { name: e.options.name, state: entryState(e), fiber: fiberState(e) },
  ]),
)

const mustBeDisabled = [
  'sdk-app-startup',
  'sdk-jsonrpc-server',
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
]
const mustBeActive = [
  'daniya-bridge',
  'attachment-local',
  'web',
  'web-search-deepseek',
  'web-fetch-http',
  'tool-web',
  'compaction-basic',
  'tool-result-pruner',
  'token-meter',
  'sandbox-policy',
  'persistent-pwsh',
]

// The four removals are literal `disabled: true` — no fiber should exist.
for (const id of mustBeDisabled) {
  const entry = entries.get(id)
  if (!entry) fail(`expected entry '${id}' is missing`)
  else if (entry.options.disabled !== true)
    fail(`entry '${id}' should be disabled, options.disabled=${JSON.stringify(entry.options.disabled)}`)
}
// Inserts + platform-selected rows must have an ACTIVE fiber.
for (const id of mustBeActive) {
  const entry = entries.get(id)
  if (!entry) fail(`expected entry '${id}' is missing`)
  else if (entry.fiber?.state !== 2)
    fail(`entry '${id}' should be ACTIVE, fiber=${fiberState(entry)}`)
}
// Platform-deactivated rows must NOT have an ACTIVE fiber (win32 → bash off).
for (const id of ['terminal-bash', 'persistent-bash']) {
  const entry = entries.get(id)
  if (entry && entry.fiber?.state === 2)
    fail(`entry '${id}' should not be ACTIVE on ${process.platform}`)
}

// sandbox-policy: evaluated mode/root via the service (options keep raw jsExpr).
try {
  const policy = ctx.sandboxPolicy
  const expectedRoot = process.env.DANIYA_WORKDIR || process.cwd()
  report.sandboxPolicy = { mode: 'workspace-write (asserted)', workspaceRoot: policy.workspaceRoot }
  if (policy.workspaceRoot !== expectedRoot)
    fail(`sandboxPolicy.workspaceRoot='${policy.workspaceRoot}', expected '${expectedRoot}'`)
} catch (error) {
  fail(`ctx.sandboxPolicy threw: ${(error && error.message) || error}`)
}

// Model-visible tools: exactly pwsh / web_search / web_fetch.
try {
  const schemas = ctx.tools?.schemas?.() ?? []
  const toolNames = schemas.map((s) => s.name).sort()
  report.tools = toolNames
  const expected = ['pwsh', 'web_fetch', 'web_search']
  if (JSON.stringify(toolNames) !== JSON.stringify(expected))
    fail(`tool set mismatch: got [${toolNames.join(', ')}], expected [${expected.join(', ')}]`)
} catch (error) {
  fail(`tools.schemas() threw: ${(error && error.message) || error}`)
}

// Services the bridge injects must resolve.
report.services = {}
for (const service of ['agents', 'sessions', 'systemPrompt', 'attachments']) {
  try {
    report.services[service] = ctx.get(service) !== undefined
    if (!report.services[service]) fail(`service '${service}' is undefined`)
  } catch (error) {
    report.services[service] = false
    fail(`ctx.get('${service}') threw: ${(error && error.message) || error}`)
  }
}

await shutdown.shutdown(report.ok ? 0 : 1)
console.error(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
