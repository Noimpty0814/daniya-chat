import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, toView, DEFAULT_SETTINGS, applyView, setSearchKey, getSearchKey, type AppSettings } from './settings'
import { DEFAULT_PERSONA } from './deepseek/client'
import type { AppSettingsView } from '../shared/types'

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

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
    expect(s.file).toEqual(DEFAULT_SETTINGS.file)
    expect(s.search).toEqual(DEFAULT_SETTINGS.search)
  })

  it('file 子对象合并：旧存档缺 file 字段按默认，部分字段按默认补齐', () => {
    fs.writeFileSync(file, JSON.stringify({ file: { workDir: 'C:/work' } }))
    const s = loadSettings(file)
    expect(s.file.workDir).toBe('C:/work')
    expect(s.file.autoApply).toBe(false)
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

  it('applyView 剔除非法情绪键（中文/多字符），单字符统一大写，空串保留（Task 9 minor⑦）', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS }
    const v: AppSettingsView = {
      ...toView(cur),
      emotionKeys: { happy: '啊', sad: 'i', sleepy: 'AB', dismissive: '', default: '1' }
    }
    const next = applyView(cur, v)
    expect(next.emotionKeys).toEqual({ sad: 'I', dismissive: '', default: '1' })
  })

  it('applyView file 字段白名单：非法类型回退现值', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS }
    const v: AppSettingsView = {
      ...toView(cur),
      file: { workDir: 'D:/proj', autoApply: true }
    }
    const next = applyView(cur, v)
    expect(next.file).toEqual({ workDir: 'D:/proj', autoApply: true })
    const bad = applyView(cur, { ...v, file: { workDir: 123 as unknown as string, autoApply: 'yes' as unknown as boolean } })
    expect(bad.file).toEqual(cur.file)
  })
})

describe('search', () => {
  it('search 子对象合并：旧存档缺 search 字段按默认，部分字段按默认补齐', () => {
    fs.writeFileSync(file, JSON.stringify({ search: { enabledDefault: true } }))
    const s = loadSettings(file)
    expect(s.search.enabledDefault).toBe(true)
    expect(s.search.apiKeyEncrypted).toBeNull()
  })

  it('toView search 不暴露密文，hasKey 反映是否已保存', () => {
    const v = toView({ ...DEFAULT_SETTINGS, search: { apiKeyEncrypted: 'xxx', enabledDefault: true } })
    expect(v.search).toEqual({ hasKey: true, enabledDefault: true })
  })

  it('applyView search 白名单：非法类型回退现值', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS }
    const v: AppSettingsView = {
      ...toView(cur),
      search: { hasKey: false, enabledDefault: true }
    }
    const next = applyView(cur, v)
    expect(next.search.enabledDefault).toBe(true)
    const bad = applyView(cur, { ...v, search: { hasKey: false, enabledDefault: 'yes' as unknown as boolean } })
    expect(bad.search.enabledDefault).toBe(false)
  })

  it('setSearchKey/getSearchKey 往返：加密后读回原文，空值清除', () => {
    setSearchKey(file, 'sk-test-key')
    const s = loadSettings(file)
    // mock 的 encryptString 输出经 base64 落盘：断言落盘值为 base64('enc:sk-test-key')，读回明文为原文
    expect(s.search.apiKeyEncrypted).toBe(Buffer.from('enc:sk-test-key').toString('base64'))
    expect(getSearchKey(s)).toBe('sk-test-key')
    setSearchKey(file, '')
    expect(getSearchKey(loadSettings(file))).toBeNull()
  })

  it('懒迁移：bocha-key.enc 存在且 search 密文为空 → 迁入并删除文件', () => {
    fs.writeFileSync(path.join(dir, 'bocha-key.enc'), 'enc-bocha')
    const s = loadSettings(file)
    expect(s.search.apiKeyEncrypted).toBe('enc-bocha')
    expect(fs.existsSync(path.join(dir, 'bocha-key.enc'))).toBe(false)
  })

  it('懒迁移：search 密文已存在 → 不迁移不动文件', () => {
    fs.writeFileSync(file, JSON.stringify({ search: { apiKeyEncrypted: 'existing' } }))
    fs.writeFileSync(path.join(dir, 'bocha-key.enc'), 'enc-bocha')
    const s = loadSettings(file)
    expect(s.search.apiKeyEncrypted).toBe('existing')
    expect(fs.existsSync(path.join(dir, 'bocha-key.enc'))).toBe(true)
  })
})
