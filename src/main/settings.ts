import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_PERSONA } from './harness/persona'
import { DEFAULT_EMOTION_KEYS, isValidComboChar } from './pet/keys'

export interface AppSettings {
  apiKeyEncrypted: string | null
  baseUrl: string
  /** 单模型：文本与图像输入共用（原 textModel/visionModel 合并，spec §7） */
  model: string
  systemPrompt: string
  pet: { enabled: boolean; exePath: string; exeName: string }
  emotionKeys: Record<string, string>
  file: { workDir: string; autoApply: boolean }
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeyEncrypted: null,
  baseUrl: 'https://api.deepseek.com',
  // TODO(V-2)：实测选定支持图像输入的默认型号后替换（现为旧 textModel 占位）
  model: 'deepseek-flash',
  systemPrompt: DEFAULT_PERSONA,
  pet: { enabled: true, exePath: 'E:\\迅雷下载\\达妮娅-带表情版\\A-达妮娅\\Bongo Cat Mver.exe', exeName: 'Bongo Cat Mver.exe' },
  emotionKeys: { ...DEFAULT_EMOTION_KEYS },
  file: { workDir: '', autoApply: false }
}

/** 旧版设置文件中已被删除的字段（一次性迁移清理对象，spec §7） */
const LEGACY_KEYS = ['search', 'textModel', 'visionModel', 'searchKeyEncrypted', 'bochaKeyEncrypted'] as const

export function loadSettings(file: string): AppSettings {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') raw = {}
  } catch { /* 损坏/缺失回退默认 */ }
  const s: AppSettings = {
    apiKeyEncrypted: typeof raw.apiKeyEncrypted === 'string' || raw.apiKeyEncrypted === null ? raw.apiKeyEncrypted : null,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
    // 迁移取值优先级：现 model > 旧 visionModel > 旧 textModel —— 单模型须保住图像输入能力（V-2 再复核）
    model: pickModel(raw),
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
    pet: { ...DEFAULT_SETTINGS.pet, ...(isObj(raw.pet) ? raw.pet : {}) } as AppSettings['pet'],
    emotionKeys: { ...DEFAULT_EMOTION_KEYS, ...(isObj(raw.emotionKeys) ? raw.emotionKeys : {}) } as Record<string, string>,
    file: { ...DEFAULT_SETTINGS.file, ...(isObj(raw.file) ? raw.file : {}) } as AppSettings['file']
  }
  migrateLegacySettings(file, raw, s)
  return s
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function pickModel(raw: Record<string, unknown>): string {
  for (const k of ['model', 'visionModel', 'textModel'] as const) {
    const v = raw[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return DEFAULT_SETTINGS.model
}

/**
 * 一次性迁移（spec §7）：检测到旧字段（search.* / 双模型）或 bocha-key.enc 残留时
 * 回写清理后的 settings.json 并删除 bocha-key.enc；失败静默不阻断加载。
 */
function migrateLegacySettings(file: string, raw: Record<string, unknown>, s: AppSettings): void {
  const hasLegacy = LEGACY_KEYS.some(k => k in raw)
  const encFile = path.join(path.dirname(file), 'bocha-key.enc')
  const hasEncFile = fs.existsSync(encFile)
  if (!hasLegacy && !hasEncFile) return
  try {
    saveSettings(file, s)
    if (hasEncFile) fs.rmSync(encFile, { force: true })
  } catch { /* 迁移失败不阻断加载 */ }
}

export function saveSettings(file: string, s: AppSettings): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, file)
}

export function toView(s: AppSettings): import('../shared/types').AppSettingsView {
  return {
    baseUrl: s.baseUrl, model: s.model,
    systemPrompt: s.systemPrompt, pet: { ...s.pet },
    file: { ...s.file },
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
  return {
    ...cur,
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : cur.baseUrl,
    // 单 model 权威字段：只采信 v.model，视图其余字段按白名单逐项合并
    model: typeof v.model === 'string' && v.model.trim() ? v.model : cur.model,
    systemPrompt: typeof v.systemPrompt === 'string' ? v.systemPrompt : cur.systemPrompt,
    pet: { ...cur.pet, ...v.pet },
    file: {
      workDir: typeof v.file?.workDir === 'string' ? v.file.workDir : cur.file.workDir,
      autoApply: typeof v.file?.autoApply === 'boolean' ? v.file.autoApply : cur.file.autoApply
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
