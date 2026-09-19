#!/usr/bin/env node
/**
 * 物化 dev 用 Harness home：`.dev-dsh-home/profiles/daniya` → `harness/profile`（junction）。
 *
 * `dsh --profile <name>` 只解析 `$DSH_HOME/profiles` 下的名字，不能直指仓库目录；
 * 建一个目录 junction 后，标准 CLI 路径 `dsh --profile daniya [--dump-config]` 即可用，
 * 供组合检查与备选启动。junction 在 Windows 不需要管理员权限，且与 pnpm/npm
 * 链接机制一致。幂等：已存在且指向正确则跳过；指向别处则报错退出（不误删）。
 *
 * 主启动路径仍是 `harness/launch.mjs`（不依赖本 junction）。
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(harnessDir, '..')
const homeDir = resolve(repoRoot, '.dev-dsh-home')
const profilesDir = resolve(homeDir, 'profiles')
const linkPath = resolve(profilesDir, 'daniya')
const target = resolve(harnessDir, 'profile')

mkdirSync(profilesDir, { recursive: true })

if (existsSync(linkPath)) {
  let stat
  try {
    stat = lstatSync(linkPath)
  } catch {
    stat = undefined
  }
  if (stat?.isSymbolicLink() && resolve(readlinkSync(linkPath)) === target) {
    process.stderr.write(`dev-dsh-home: ${linkPath} already linked\n`)
    process.exit(0)
  }
  process.stderr.write(
    `dev-dsh-home: ${linkPath} exists and is not the daniya profile junction; remove it and re-run\n`,
  )
  process.exit(1)
}

symlinkSync(target, linkPath, 'junction')
process.stderr.write(`dev-dsh-home: ${linkPath} -> ${target}\n`)
