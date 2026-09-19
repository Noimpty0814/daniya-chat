#!/usr/bin/env node
/**
 * daniya harness dev 启动器（方案 C：app-owned profile 直启，desktop-host 同款模式）。
 *
 * - `loadProfileDirectory` 直接加载仓库内 profile 目录 `harness/profile`，
 *   不经 `$DSH_HOME/profiles/<name>` 查找（`dsh --profile` 只接受名字，见 apps/cli/args.ts）。
 * - `runProfile`（`@deepseek-ai/dsh/profile-boot`）负责 fail-loud、代理解析、
 *   cmdline args、SIGTERM/SIGINT 回收——与 `dsh` bin 同一条启动管线。
 * - `DSH_HOME` 仍隔离数据面：会话日志（dshHomePath('sessions')）、附件存储、
 *   家目录 patch 层；dev 默认 `<repo>/.dev-dsh-home`，env 可覆盖。
 * - stdin/stdout 归 daniya-bridge 协议独占：本脚本不写 stdout；stdin 打开期间
 *   进程存活，stdin EOF → shutdown（复刻 sdk-app-startup 的 EOF 语义，T-2 桥接管后由其负责）。
 *
 * 用法：node harness/launch.mjs
 * env：DSH_HOME、DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DANIYA_SETTINGS_FILE、DANIYA_WORKDIR
 */

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(harnessDir, '..')
const profileDir = resolve(harnessDir, 'profile')

// dev 默认 home；进程 env 优先（T-3 spawn 注入用户态 home 时同一路径生效）。
if (process.env.DSH_HOME === undefined || process.env.DSH_HOME.trim() === '') {
  process.env.DSH_HOME = resolve(repoRoot, '.dev-dsh-home')
}

// 裸说明符相对 profile 的 package.json 解析（本脚本在 profile 的 node_modules 之外）。
const profileRequire = createRequire(resolve(profileDir, 'package.json'))
const importFromProfile = (specifier) => import(pathToFileURL(profileRequire.resolve(specifier)).href)

const { loadLayeredEnv, loadProfileDirectory } = await importFromProfile('@deepseek-ai/dsh-app-boot')
const { runProfile } = await importFromProfile('@deepseek-ai/dsh/profile-boot')

// installAnchor：dsh 安装自身的 package.json，bundle 与安装依赖图的第一解析锚点。
const installAnchor = profileRequire.resolve('@deepseek-ai/dsh/package.json')
const profile = loadProfileDirectory('dsh', profileDir, installAnchor)

const { shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'daniya',
  resolutionMode: 'runtime', // 不写磁盘链接；打包可执行文件同款（link/dual 会物化 profile 链接）
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: [],
})

// stdin 持有进程生命周期：打开则存活，EOF 则退出。bridge 接管前由启动器兜底。
process.stdin.on('end', () => void shutdown.shutdown(0))
process.stdin.resume()
