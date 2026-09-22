#!/usr/bin/env node
/**
 * T-5 打包暂存：把可分发 harness 物化到 build/harness-bundle/。
 *
 * 产物布局（经 package.json extraResources 拷入 <install>/resources/harness）：
 *   build/harness-bundle/
 *     launch.mjs            应用自持启动器（就地加载 ./profile）
 *     .stamp                构建版本戳（首启物化的版本判定，process.ts 比对后整树重拷）
 *     runtime/node.exe      harness 子进程的 Node 宿主（构建机 process.execPath 副本；
 *                           electron-as-node 在 ConPTY 下无控制台，windows-acl runner
 *                           以 execPath 为宿主会让 pwsh 工具静默死——B-7）
 *     profile/
 *       package.json        profile 清单（dsh.profile.bundles + pinned deps）
 *       package-lock.json   锁文件（溯源用）
 *       cordis.patch.yml    spec §4 patch 层（运行时 loader 必读）
 *       node_modules/       依赖树（dead-deps blocklist 裁剪后，含 .bin shims）
 *         daniya-bridge/    file: junction 已解引用为真实目录（lib/ + package.json；
 *                         src/tests/node_modules 等 dev 产物不进包）
 *
 * 排除：profile/cordis.yml（loader 运行时生成，随包只读模板里不该有）、
 * *.log、.dev-dsh-home、bridge 的 dev 产物。
 *
 * 复制后即断言：零符号链接残留（V-7 可搬性）、必需文件齐备、输出体积/文件数统计。
 *
 * 用法：npm run prepare:harness   （pack 脚本已串在 electron-builder 之前）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEAD_DEPS } from './dead-deps.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harnessDir = path.join(repoRoot, 'harness')
const profileDir = path.join(harnessDir, 'profile')
const bridgeDir = path.join(repoRoot, 'packages', 'daniya-bridge')
const stagingDir = path.join(repoRoot, 'build', 'harness-bundle')
const stagingProfile = path.join(stagingDir, 'profile')

const log = (msg) => console.log(`prepare-harness: ${msg}`)
const fail = (msg) => {
  console.error(`prepare-harness: FAIL ${msg}`)
  process.exit(1)
}

// ── 1. 前置条件 + bridge lib 新鲜度 ──────────────────────────────────────────
if (!fs.existsSync(path.join(harnessDir, 'launch.mjs'))) fail('harness/launch.mjs 缺失（T-1 未交付？）')
if (!fs.existsSync(path.join(profileDir, 'node_modules'))) {
  fail('harness/profile/node_modules 缺失——先 npm install --prefix harness/profile')
}
// 始终重建 bridge lib：junction 活链接拾取的就是 packages/ 的 lib/，陈旧 lib 会静默进包。
log('building daniya-bridge lib/ ...')
const build = spawnSync(`npm --prefix "${bridgeDir}" run build`, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
})
if (build.status !== 0) fail('daniya-bridge build 失败')
if (!fs.existsSync(path.join(bridgeDir, 'lib', 'index.js'))) fail('packages/daniya-bridge/lib/index.js 缺失')

// ── 2. 清空暂存目录 ─────────────────────────────────────────────────────────
fs.rmSync(stagingDir, { recursive: true, force: true })
fs.mkdirSync(stagingProfile, { recursive: true })

// ── 3. launch.mjs + profile 元文件（cordis.yml 是运行时产物，不进包）─────────
fs.copyFileSync(path.join(harnessDir, 'launch.mjs'), path.join(stagingDir, 'launch.mjs'))
for (const name of ['package.json', 'package-lock.json', 'cordis.patch.yml']) {
  const src = path.join(profileDir, name)
  if (!fs.existsSync(src)) fail(`profile/${name} 缺失`)
  fs.copyFileSync(src, path.join(stagingProfile, name))
}

// ── 4. node_modules（junction 解引用 + 死依赖裁剪），daniya-bridge 单独按白名单复制 ──
const nodeModulesRoot = path.join(profileDir, 'node_modules')
const bridgeLink = path.join(nodeModulesRoot, 'daniya-bridge')
const skipEverywhere = new Set(['.dev-dsh-home', 'cordis.yml'])
// 死依赖裁剪（slim-installer）：名单见 scripts/dead-deps.mjs（三重证据判定）。
// 包键 = path.relative(nodeModulesRoot, src) 首段；首段为 @scope 时取前两段。
// 只判顶层包目录——嵌套路径的首段仍属宿主包，嵌套 node_modules 不被误裁。
const pkgKeyOf = (rel) => {
  const segs = rel.split(path.sep)
  return segs[0].startsWith('@') ? segs.slice(0, 2).join(path.sep) : segs[0]
}
const prunedKeys = new Set()
// 名单漂移容忍：blocklist 项在源树缺席只 warn 不 fail（lockfile 传递漂移正常）。
const absentKeys = [...DEAD_DEPS].filter((key) => !fs.existsSync(path.join(nodeModulesRoot, key)))
log('copying profile/node_modules (dereferencing links, pruning dead deps) ...')
fs.cpSync(nodeModulesRoot, path.join(stagingProfile, 'node_modules'), {
  recursive: true,
  dereference: true,
  filter: (src) => {
    if (path.resolve(src) === bridgeLink) return false // junction 单独处理
    const base = path.basename(src)
    if (skipEverywhere.has(base) || base.endsWith('.log')) return false
    const rel = path.relative(nodeModulesRoot, src)
    if (rel !== '' && DEAD_DEPS.has(pkgKeyOf(rel))) {
      prunedKeys.add(pkgKeyOf(rel))
      return false
    }
    return true
  },
})

// bridge 真实目录：只带运行时需要的面（lib/ + package.json + README），dev 产物排除。
const bridgeDevOnly = new Set(['node_modules', 'src', 'tests', 'tsconfig.json', 'vitest.config.ts', 'package-lock.json'])
fs.cpSync(bridgeDir, path.join(stagingProfile, 'node_modules', 'daniya-bridge'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(bridgeDir, src)
    if (rel === '') return true
    return !bridgeDevOnly.has(rel.split(path.sep)[0])
  },
})

// 版本戳：首启物化"同版复用"判定（process.ts 比对模板与已物化树的 .stamp，不一致整树重拷）。
const appPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
fs.writeFileSync(
  path.join(stagingDir, '.stamp'),
  JSON.stringify({ appVersion: appPkg.version, builtAt: new Date().toISOString() }) + '\n',
)

// Node 宿主：harness 子进程不能是 electron-as-node（GUI 子系统在 ConPTY 下无控制台，
// windows-acl 沙箱 runner 以 process.execPath 为宿主会让 pwsh 工具静默死——B-7）。
// 复制运行本脚本的 node.exe——与安装 profile 依赖、跑冒烟的是同一 Node，ABI 一致。
if (process.platform === 'win32') {
  const runtimeDir = path.join(stagingDir, 'runtime')
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'))
}

// ── 5. 断言 + 统计 ──────────────────────────────────────────────────────────
const mustExist = [
  'launch.mjs',
  ...(process.platform === 'win32' ? ['runtime/node.exe'] : []),
  'profile/package.json',
  'profile/cordis.patch.yml',
  'profile/node_modules/@deepseek-ai/dsh/package.json',
  'profile/node_modules/@deepseek-ai/dsh-app-boot/package.json',
  'profile/node_modules/@deepseek-ai/dsh-sdk-minimal/package.json',
  'profile/node_modules/daniya-bridge/package.json',
  'profile/node_modules/daniya-bridge/lib/index.js',
]
for (const rel of mustExist) {
  if (!fs.existsSync(path.join(stagingDir, rel))) fail(`暂存产物缺失: ${rel}`)
}
for (const rel of ['src', 'tests', 'node_modules']) {
  if (fs.existsSync(path.join(stagingProfile, 'node_modules', 'daniya-bridge', rel))) {
    fail(`bridge dev 产物混入包: daniya-bridge/${rel}`)
  }
}
if (fs.lstatSync(path.join(stagingProfile, 'node_modules', 'daniya-bridge')).isSymbolicLink()) {
  fail('daniya-bridge 仍是符号链接（junction 未解引用）')
}

// 裁剪断言（slim-installer）：暂存 node_modules 顶层包目录任一命中 DEAD_DEPS 即 fail——
// 防 filter 逻辑漏剪。包键口径与裁剪端一致（@scope 取两段）。
const stagedNm = path.join(stagingProfile, 'node_modules')
const stagedOffenders = []
for (const entry of fs.readdirSync(stagedNm, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (entry.name.startsWith('@')) {
    for (const sub of fs.readdirSync(path.join(stagedNm, entry.name), { withFileTypes: true })) {
      if (sub.isDirectory() && DEAD_DEPS.has(`${entry.name}/${sub.name}`)) {
        stagedOffenders.push(`${entry.name}/${sub.name}`)
      }
    }
  } else if (DEAD_DEPS.has(entry.name)) {
    stagedOffenders.push(entry.name)
  }
}
if (stagedOffenders.length) {
  fail(`暂存 node_modules 残留 blocklist 包（filter 漏剪）：\n  ${stagedOffenders.join('\n  ')}`)
}

let files = 0
let bytes = 0
let links = 0
const strays = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) {
      links++
      strays.push(`symlink: ${p}`)
      continue
    }
    if (st.isDirectory()) {
      walk(p)
      continue
    }
    files++
    bytes += st.size
    if (entry.name === 'cordis.yml' || entry.name.endsWith('.log') || entry.name === '.dev-dsh-home') {
      strays.push(`excluded artifact: ${p}`)
    }
  }
}
walk(stagingDir)
if (links > 0) fail(`暂存产物残留 ${links} 个符号链接（V-7）：\n  ${strays.join('\n  ')}`)
if (strays.length) fail(`暂存产物混入排除项：\n  ${strays.join('\n  ')}`)

log(`OK -> ${path.relative(repoRoot, stagingDir)}`)
log(`files=${files} size=${(bytes / 1024 / 1024).toFixed(1)} MiB`)
log(`pruned ${prunedKeys.size}/${DEAD_DEPS.size} dirs`)
if (absentKeys.length) {
  log(`WARN ${absentKeys.length} blocklist 项源树缺席（名单漂移，未裁到）：${absentKeys.join(', ')}`)
}
