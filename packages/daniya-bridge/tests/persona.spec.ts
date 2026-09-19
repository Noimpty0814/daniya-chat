/**
 * 人设段组装测试：settings 每轮重读、契约逐字、缺失/损坏软失败。
 *
 * @module daniya-bridge/tests/persona
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPersonaText } from '../src/persona.js'
import { EMOTION_CONTRACT, FILE_CONTRACT } from '../src/contracts.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daniya-bridge-persona-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function settingsPath(content: unknown): string {
  const file = join(dir, 'settings.json')
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

describe('buildPersonaText', () => {
  it('拼接 人设 + EMOTION + FILE + 工作目录行（\\n\\n 分隔）', () => {
    const file = settingsPath({ systemPrompt: '你是达妮娅' })
    const text = buildPersonaText(file, 'D:\\work')
    expect(text).toBe(
      `你是达妮娅\n\n${EMOTION_CONTRACT}\n\n${FILE_CONTRACT}\n\n用户当前工作目录：D:\\work`,
    )
  })

  it('每次调用重读文件：改 settings 下一轮即生效', () => {
    const file = settingsPath({ systemPrompt: '旧人设' })
    const first = buildPersonaText(file, 'D:\\work')
    expect(first.startsWith('旧人设')).toBe(true)
    writeFileSync(file, JSON.stringify({ systemPrompt: '新人设' }))
    const second = buildPersonaText(file, 'D:\\work')
    expect(second.startsWith('新人设')).toBe(true)
  })

  it('文件缺失/字段缺失/JSON 损坏：人设为空串，契约与工作目录行仍输出', () => {
    for (const file of [
      join(dir, 'missing.json'),
      settingsPath({ other: 1 }),
      settingsPath('not json {{{'),
      settingsPath([1, 2]),
      settingsPath({ systemPrompt: 42 }),
    ]) {
      const text = buildPersonaText(file, 'D:\\work')
      expect(text).toBe(`${EMOTION_CONTRACT}\n\n${FILE_CONTRACT}\n\n用户当前工作目录：D:\\work`)
    }
  })

  it('settingsFile 未配置同样软失败', () => {
    expect(buildPersonaText(undefined, 'D:\\work')).toBe(
      `${EMOTION_CONTRACT}\n\n${FILE_CONTRACT}\n\n用户当前工作目录：D:\\work`,
    )
  })

  it('systemPrompt 为空串时不留前导空行', () => {
    const file = settingsPath({ systemPrompt: '' })
    const text = buildPersonaText(file, 'D:\\work')
    expect(text.startsWith(EMOTION_CONTRACT)).toBe(true)
  })
})
