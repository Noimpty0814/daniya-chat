export interface ConversationMeta { id: string; title: string; createdAt: number; updatedAt: number }
export interface ImagePart { id: string; dataUrl: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImagePart[]
  files?: FileAttachment[]
  /** 该轮是否勾选了联网搜索；搜索失败原因（主进程映射的中文） */
  searched?: boolean
  searchError?: string
  model?: string
  createdAt: number
}
export interface SearchHit { conversationId: string; messageId: string; role: 'user' | 'assistant'; snippet: string }
export interface PetSettings { enabled: boolean; exePath: string; exeName: string }
export interface AppSettingsView {
  baseUrl: string
  textModel: string
  visionModel: string
  systemPrompt: string
  pet: PetSettings
  emotionKeys: Record<string, string>
  file: { workDir: string; autoApply: boolean }
  search: { hasKey: boolean; enabledDefault: boolean }
  hasApiKey: boolean
}
export interface StreamEventMsg {
  requestId: string
  type: 'delta' | 'emotion' | 'done' | 'error'
  delta?: string
  emotion?: string
  message?: ChatMessage
  error?: string
  aborted?: boolean
}
export interface StartReplyPayload {
  conversationId: string
  content: string
  images?: string[]
  files?: FileAttachment[]
  search?: boolean
  /** R23：流错误重试时该 user 消息已在库中，主进程跳过再次落库（仍构造并返回 userMessage） */
  skipUserAppend?: boolean
}
export interface StartReplyResult { ok: boolean; error?: string; requestId?: string; userMessage?: ChatMessage }
export interface PetStatus { helperRunning: boolean; connected: boolean; petWindowFound: boolean }

export interface FileAttachment { name: string; path: string }
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface FileProposalEvent {
  id: string
  path: string
  resolvedPath: string
  diff: DiffLine[]
  autoApplied: boolean
  error?: string
  /** 渲染层本地状态（主进程事件不携带） */
  status?: 'applied' | 'apply-failed' | 'rejected'
}
