import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, saveSettings, toView, DEFAULT_SETTINGS, applyView, setApiKey, getApiKey, DEFAULT_PERSONA, type AppSettings } from './settings'
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
    saveSettings(file, { ...DEFAULT_SETTINGS, model: 'custom-model' })
    expect(loadSettings(file).model).toBe('custom-model')
    expect(loadSettings(file).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('文件损坏时回退默认值', () => {
    fs.writeFileSync(file, '不是JSON{{{')
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('旧版本缺少字段时按默认补齐（含 pet/emotionKeys/file 子对象）', () => {
    fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://example.com' }))
    const s = loadSettings(file)
    expect(s.baseUrl).toBe('https://example.com')
    expect(s.pet).toEqual(DEFAULT_SETTINGS.pet)
    expect(s.emotionKeys.happy).toBe(DEFAULT_SETTINGS.emotionKeys.happy)
    expect(s.file).toEqual(DEFAULT_SETTINGS.file)
    expect(s.model).toBe(DEFAULT_SETTINGS.model)
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

  it('toView 暴露单 model，且只含白名单字段（无兼容镜像）', () => {
    const v = toView({ ...DEFAULT_SETTINGS, model: 'm-x' })
    expect(v.model).toBe('m-x')
    expect(Object.keys(v).sort()).toEqual(
      ['baseUrl', 'emotionKeys', 'file', 'hasApiKey', 'model', 'pet', 'systemPrompt'].sort()
    )
  })

  it('默认 systemPrompt 为达妮娅人设卡文本（契约由 bridge 拼接，不在默认值内）', () => {
    expect(DEFAULT_SETTINGS.systemPrompt).toBe(DEFAULT_PERSONA)
    expect(DEFAULT_SETTINGS.systemPrompt).not.toContain('{EMO:')
  })

  it('setApiKey/getApiKey 往返：加密后读回原文，空值清除', () => {
    setApiKey(file, 'sk-test-key')
    const s = loadSettings(file)
    expect(s.apiKeyEncrypted).toBe(Buffer.from('enc:sk-test-key').toString('base64'))
    expect(getApiKey(s)).toBe('sk-test-key')
    setApiKey(file, '')
    expect(getApiKey(loadSettings(file))).toBeNull()
  })
})

// dsh 重构一次性迁移（spec §7）：旧 search/双模型字段与 bocha-key.enc 残留清理
describe('settings 迁移', () => {
  it('旧 search/textModel/visionModel 字段被剥离并回写清理后的文件', () => {
    fs.writeFileSync(file, JSON.stringify({
      baseUrl: 'https://example.com',
      textModel: 'old-text', visionModel: 'old-vision',
      search: { apiKeyEncrypted: 'enc-x', enabledDefault: true }
    }))
    const s = loadSettings(file)
    expect('search' in s).toBe(false)
    expect('textModel' in s).toBe(false)
    expect('visionModel' in s).toBe(false)
    // 单 model 取旧 visionModel（保图像输入能力），其余字段正常合并
    expect(s.model).toBe('old-vision')
    expect(s.baseUrl).toBe('https://example.com')
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect('search' in disk).toBe(false)
    expect('textModel' in disk).toBe(false)
    expect('visionModel' in disk).toBe(false)
    expect(disk.model).toBe('old-vision')
  })

  it('迁移取值优先级：现 model > 旧 visionModel > 旧 textModel', () => {
    fs.writeFileSync(file, JSON.stringify({ textModel: 'only-text' }))
    expect(loadSettings(file).model).toBe('only-text')
    fs.writeFileSync(file, JSON.stringify({ model: 'now', visionModel: 'v', textModel: 't' }))
    expect(loadSettings(file).model).toBe('now')
  })

  it('bocha-key.enc 残留被删除（即使无旧字段也清理）', () => {
    fs.writeFileSync(path.join(dir, 'bocha-key.enc'), 'enc-bocha')
    loadSettings(file)
    expect(fs.existsSync(path.join(dir, 'bocha-key.enc'))).toBe(false)
  })

  it('无旧字段且无 enc 文件时不回写（load 不产生副作用）', () => {
    saveSettings(file, DEFAULT_SETTINGS)
    const before = fs.readFileSync(file, 'utf8')
    loadSettings(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

// Task 9 新增：applyView 白名单合并（settings:save 改用此合并，堵住渲染层字段注入）
describe('applyView', () => {
  it('视图白名单字段生效，apiKeyEncrypted 保持主进程现值，emotionKeys 整体替换', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS, apiKeyEncrypted: 'enc-value' }
    const v: AppSettingsView = {
      ...toView(cur),
      baseUrl: 'https://changed.example.com',
      model: 'model-2',
      pet: { ...cur.pet, enabled: false },
      emotionKeys: { happy: 'X' }
    }
    const next = applyView(cur, v)
    expect(next.baseUrl).toBe('https://changed.example.com')
    expect(next.model).toBe('model-2')
    expect(next.apiKeyEncrypted).toBe('enc-value')
    expect(next.pet.enabled).toBe(false)
    expect(next.pet.exePath).toBe(cur.pet.exePath)
    expect(next.emotionKeys).toEqual({ happy: 'X' })
  })

  it('白名单外字段不采信：视图多余字段不落盘，model 权威', () => {
    const cur: AppSettings = { ...DEFAULT_SETTINGS, model: 'keep' }
    const v = {
      ...toView(cur),
      search: { hasKey: true, enabledDefault: true },
      extraField: 'evil'
    } as unknown as AppSettingsView
    const next = applyView(cur, v)
    expect(next.model).toBe('keep')
    expect('search' in next).toBe(false)
    expect('extraField' in next).toBe(false)
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
