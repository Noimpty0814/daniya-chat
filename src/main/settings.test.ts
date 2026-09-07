import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, toView, DEFAULT_SETTINGS, applyView, type AppSettings } from './settings'
import { DEFAULT_PERSONA } from './deepseek/client'
import type { AppSettingsView } from '../shared/types'

let dir: string
let file: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-settings-')); file = path.join(dir, 'settings.json') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('settings', () => {
  it('无文件时返回默认值', () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('保存后可读回，且与默认合并', () => {
    saveSettings(file, { ...DEFAULT_SETTINGS, textModel: 'custom-model' })
    expect(loadSettings(file).textModel).toBe('custom-model')
    expect(loadSettings(file).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('文件损坏时回退默认值', () => {
    fs.writeFileSync(file, '不是JSON{{{')
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('旧版本缺少字段时按默认补齐（含 pet/emotionKeys 子对象）', () => {
    fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://example.com' }))
    const s = loadSettings(file)
    expect(s.baseUrl).toBe('https://example.com')
    expect(s.pet).toEqual(DEFAULT_SETTINGS.pet)
    expect(s.emotionKeys.happy).toBe(DEFAULT_SETTINGS.emotionKeys.happy)
  })

  it('toView 不暴露密文，hasApiKey 反映是否已保存', () => {
    const v = toView({ ...DEFAULT_SETTINGS, apiKeyEncrypted: 'xxx' })
    expect(v.hasApiKey).toBe(true)
    expect('apiKeyEncrypted' in v).toBe(false)
  })

  it('默认 systemPrompt 为达妮娅人设卡文本（表情契约由 streamChat 拼接，不在默认值内）', () => {
    expect(DEFAULT_SETTINGS.systemPrompt).toBe(DEFAULT_PERSONA)
    expect(DEFAULT_SETTINGS.systemPrompt).not.toContain('{EMO:')
  })
})

// Task 9 新增：applyView 白名单合并（settings:save 改用此合并，堵住渲染层字段注入）
describe('applyView', () => {
  it('视图白名单字段生效，apiKeyEncrypted 保持主进程现值，emotionKeys 整体替换', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS, apiKeyEncrypted: 'enc-value' }
    const v: AppSettingsView = {
      ...toView(cur),
      baseUrl: 'https://changed.example.com',
      textModel: 'model-2',
      pet: { ...cur.pet, enabled: false },
      emotionKeys: { happy: 'X' }
    }
    const next = applyView(cur, v)
    expect(next.baseUrl).toBe('https://changed.example.com')
    expect(next.textModel).toBe('model-2')
    expect(next.apiKeyEncrypted).toBe('enc-value')
    expect(next.pet.enabled).toBe(false)
    expect(next.pet.exePath).toBe(cur.pet.exePath)
    expect(next.emotionKeys).toEqual({ happy: 'X' })
  })
})
