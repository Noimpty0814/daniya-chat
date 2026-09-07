import fs from 'node:fs'
import { safeStorage } from 'electron'
import { DEFAULT_PERSONA } from './deepseek/client'
import { DEFAULT_EMOTION_KEYS } from './pet/keys'

export interface AppSettings {
  apiKeyEncrypted: string | null
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
  pet: { enabled: boolean; exePath: string; exeName: string }
  emotionKeys: Record<string, string>
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeyEncrypted: null,
  baseUrl: 'https://api.deepseek.com',
  textModel: 'deepseek-chat',
  visionModel: 'deepseek-v4-flash-vision-exp',
  systemPrompt: DEFAULT_PERSONA,
  pet: { enabled: true, exePath: 'E:\\迅雷下载\\达妮娅-带表情版\\A-达妮娅\\Bongo Cat Mver.exe', exeName: 'Bongo Cat Mver.exe' },
  emotionKeys: { ...DEFAULT_EMOTION_KEYS }
}

export function loadSettings(file: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...raw, pet: { ...DEFAULT_SETTINGS.pet, ...(raw.pet ?? {}) }, emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(raw.emotionKeys ?? {}) } }
  } catch { return { ...DEFAULT_SETTINGS } }
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

export function applyView(cur: AppSettings, v: import('../shared/types').AppSettingsView): AppSettings {
  return { ...cur, baseUrl: v.baseUrl, textModel: v.textModel, visionModel: v.visionModel, systemPrompt: v.systemPrompt, pet: { ...cur.pet, ...v.pet }, emotionKeys: { ...v.emotionKeys } }
}
