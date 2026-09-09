import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_PERSONA } from './deepseek/client'
import { DEFAULT_EMOTION_KEYS, isValidComboChar } from './pet/keys'

export interface AppSettings {
  apiKeyEncrypted: string | null
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
  pet: { enabled: boolean; exePath: string; exeName: string }
  emotionKeys: Record<string, string>
  file: { workDir: string; autoApply: boolean }
  search: { apiKeyEncrypted: string | null; enabledDefault: boolean }
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeyEncrypted: null,
  baseUrl: 'https://api.deepseek.com',
  textModel: 'deepseek-chat',
  visionModel: 'deepseek-v4-flash-vision-exp',
  systemPrompt: DEFAULT_PERSONA,
  pet: { enabled: true, exePath: 'E:\\迅雷下载\\达妮娅-带表情版\\A-达妮娅\\Bongo Cat Mver.exe', exeName: 'Bongo Cat Mver.exe' },
  emotionKeys: { ...DEFAULT_EMOTION_KEYS },
  file: { workDir: '', autoApply: false },
  search: { apiKeyEncrypted: null, enabledDefault: false }
}

export function loadSettings(file: string): AppSettings {
  // 深拷贝嵌套子对象：损坏回退路径不共享 DEFAULT_SETTINGS 引用（避免 setSearchKey 等原地修改污染全局默认）
  let s: AppSettings = { ...DEFAULT_SETTINGS, pet: { ...DEFAULT_SETTINGS.pet }, emotionKeys: { ...DEFAULT_EMOTION_KEYS }, file: { ...DEFAULT_SETTINGS.file }, search: { ...DEFAULT_SETTINGS.search } }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    s = { ...DEFAULT_SETTINGS, ...raw, pet: { ...DEFAULT_SETTINGS.pet, ...(raw.pet ?? {}) }, emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(raw.emotionKeys ?? {}) }, file: { ...DEFAULT_SETTINGS.file, ...(raw.file ?? {}) }, search: { ...DEFAULT_SETTINGS.search, ...(raw.search ?? {}) } }
  } catch { /* 损坏回退默认 */ }
  migrateBochaKey(file, s)
  return s
}

/** 一次性懒迁移：settings 无 search 密文且同目录 bocha-key.enc 存在 → 迁入并删除（迁移失败静默跳过） */
function migrateBochaKey(file: string, s: AppSettings): void {
  if (s.search.apiKeyEncrypted) return
  const encFile = path.join(path.dirname(file), 'bocha-key.enc')
  try {
    if (!fs.existsSync(encFile)) return
    const enc = fs.readFileSync(encFile, 'utf8').trim()
    if (!enc) return
    s.search.apiKeyEncrypted = enc
    saveSettings(file, s)
    fs.rmSync(encFile)
  } catch { /* 迁移失败不阻断加载 */ }
}

export function saveSettings(file: string, s: AppSettings): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, file)
}

export function toView(s: AppSettings): import('../shared/types').AppSettingsView {
  return {
    baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel,
    systemPrompt: s.systemPrompt, pet: { ...s.pet },
    file: { ...s.file },
    search: { hasKey: !!s.search.apiKeyEncrypted, enabledDefault: s.search.enabledDefault },
    emotionKeys: { ...s.emotionKeys }, hasApiKey: !!s.apiKeyEncrypted
  }
}

export function setApiKey(file: string, key: string): AppSettings {
  const s = loadSettings(file)
  s.apiKeyEncrypted = key ? safeStorage.encryptString(key).toString('base64') : null
  saveSettings(file, s)
  return s
}

export function getApiKey(s: AppSettings): string | null {
  if (!s.apiKeyEncrypted) return null
  try { return safeStorage.decryptString(Buffer.from(s.apiKeyEncrypted, 'base64')) }
  catch { return null }
}

export function setSearchKey(file: string, key: string): AppSettings {
  const s = loadSettings(file)
  s.search.apiKeyEncrypted = key ? safeStorage.encryptString(key).toString('base64') : null
  saveSettings(file, s)
  return s
}

export function getSearchKey(s: AppSettings): string | null {
  if (!s.search.apiKeyEncrypted) return null
  try { return safeStorage.decryptString(Buffer.from(s.search.apiKeyEncrypted, 'base64')) }
  catch { return null }
}

export function applyView(cur: AppSettings, v: import('../shared/types').AppSettingsView): AppSettings {
  return {
    ...cur, baseUrl: v.baseUrl, textModel: v.textModel, visionModel: v.visionModel, systemPrompt: v.systemPrompt, pet: { ...cur.pet, ...v.pet },
    file: {
      workDir: typeof v.file?.workDir === 'string' ? v.file.workDir : cur.file.workDir,
      autoApply: typeof v.file?.autoApply === 'boolean' ? v.file.autoApply : cur.file.autoApply
    },
    search: {
      apiKeyEncrypted: cur.search.apiKeyEncrypted,
      enabledDefault: typeof v.search?.enabledDefault === 'boolean' ? v.search.enabledDefault : cur.search.enabledDefault
    },
    emotionKeys: sanitizeEmotionKeys(v.emotionKeys)
  }
}

/** Task 9 minor⑦：非法键（中文/多字符等）在落盘前剔除；空串保留（表示不映射）；单字符统一大写 */
function sanitizeEmotionKeys(v: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, ch] of Object.entries(v)) {
    if (typeof ch !== 'string') continue
    if (ch === '') { out[name] = ''; continue }
    const up = ch.toUpperCase()
    if (isValidComboChar(up)) out[name] = up
  }
  return out
}
