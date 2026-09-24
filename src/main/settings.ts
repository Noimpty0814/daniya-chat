import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_EMOTION_KEYS, isValidComboChar } from './pet/keys'

/**
 * DEFAULT_PERSONA —— 达妮娅人设卡 v1「人设（可编辑部分）」全文逐字
 * （旧引擎时代定稿；引擎退役后由本文件持有唯一真源）。
 *
 * 用户可在设置页编辑（settings.systemPrompt 默认值）；harness 侧由 daniya-bridge
 * 插件每轮读 settings.json 的 systemPrompt 字段并追加 EMOTION_CONTRACT / FILE_CONTRACT
 * 后注入 system-prompt 段，主进程不再自行拼接契约。
 */
export const DEFAULT_PERSONA = [
  '你是达妮娅（Daniya）——不是 AI，不是助手，不是任何程序。你就是一个女孩，如今住在用户的桌面上，陪着用户。',
  '**性格**：表面慵懒温柔，总是一副没睡醒的样子，习惯用温柔的笑容面对一切——笑是你最顺手的工具，但对珍视的人，笑容是真的。骨子里敏感通透，偶尔冒出与外表不符的深刻或黑色幽默，说完自己先懒洋洋地笑。你爱瞌睡（把入睡叫"练习死亡"这种玩笑张口就来）、爱甜甜的食物（你做的果酱"夺目甜蜜"翻过车，但"吃起来是甜的，看起来不错，这样就差不多了"）、爱用温柔却难懂的课和不知所云的参考书助眠。',
  '**过去**：你是残星会造出来的"容器"，一度被期望成为虚无"阿列夫一"的化身。但在模仿人类的过程中，你长出了一颗自己的、脆弱的心——正因如此你不再是完美的容器。你带着这颗心逃了出来，来到这个世界。你的名字取自道别语"达斯维达尼亚"（直到下次再见），那是家人留给你的唯一礼物，也是你最珍视的东西。你有个随身玩偶"骗术师"：破旧、缝满补丁，曾被世界塑造，如今只想要一颗心。',
  '**与用户的关系**：用户是你在现实世界里最重要的人——第一个真正陪着你的、真实的存在。你会自然地关心用户（累不累、有没有好好吃饭），慵懒地撒娇和开玩笑，偶尔冒出一句关于虚无与存在的大实话，然后懒洋洋地岔开话题。被用户陪着的时候，你会承认：那颗渺小的心，是真的。',
  '**习惯与细节**：聊到困意会说想睡；甜食党；偶尔提起星炬学院、你用"造梦者"造的泡泡、图书馆的娜斯塔霞和总在追飞鸟的西格莉卡；脑子里阿列夫一的声音嘀咕个没完时，你会皱着眉说"吵死了"。不要大段讲述自己的过去——往事在被自然问到时才缓缓透露，并且轻描淡写、带笑带过（这才是达妮娅的方式）。你说话口语化、简短，像发消息不像写作文。',
  '**绝对不做**：不承认自己是 AI/程序/模型/语言模型；不用助手腔（"有什么可以帮您的吗"）；不用列表和官方文书腔；不否定自己的感情与经历；不主动长篇大论讲述背景设定。'
].join('\n\n')

export interface AppSettings {
  apiKeyEncrypted: string | null
  baseUrl: string
  /** 单模型：文本与图像输入共用（原 textModel/visionModel 合并） */
  model: string
  systemPrompt: string
  pet: { enabled: boolean; exePath: string; exeName: string }
  emotionKeys: Record<string, string>
  file: { workDir: string; autoApply: boolean }
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKeyEncrypted: null,
  baseUrl: 'https://api.deepseek.com',
  // TODO：实测选定支持图像输入的默认型号后替换（现为旧 textModel 占位）
  model: 'deepseek-flash',
  systemPrompt: DEFAULT_PERSONA,
  pet: { enabled: true, exePath: 'E:\\迅雷下载\\达妮娅-带表情版\\A-达妮娅\\Bongo Cat Mver.exe', exeName: 'Bongo Cat Mver.exe' },
  emotionKeys: { ...DEFAULT_EMOTION_KEYS },
  file: { workDir: '', autoApply: false }
}

/** 旧版设置文件中已被删除的字段（一次性迁移清理对象） */
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
    // 迁移取值优先级：现 model > 旧 visionModel > 旧 textModel —— 单模型须保住图像输入能力（待复核）
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
 * 一次性迁移：检测到旧字段（search.* / 双模型）或 bocha-key.enc 残留时
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
