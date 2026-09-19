export interface ConversationMeta { id: string; title: string; createdAt: number; updatedAt: number }
export interface ImagePart { id: string; dataUrl: string }
export interface ToolUse { name: string; ok?: boolean }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImagePart[]
  files?: FileAttachment[]
  /** 该轮调用过的工具徽照搬（name + 最终成败态） */
  tools?: ToolUse[]
  model?: string
  createdAt: number
}
export interface SearchHit { conversationId: string; messageId: string; role: 'user' | 'assistant' | 'title'; snippet: string }
export interface PetSettings { enabled: boolean; exePath: string; exeName: string }
export interface AppSettingsView {
  baseUrl: string
  model: string
  systemPrompt: string
  pet: PetSettings
  emotionKeys: Record<string, string>
  file: { workDir: string; autoApply: boolean }
  hasApiKey: boolean
}
/** 工具徽照搬事件载荷：tool.call → {name, callId, preview}；tool.result → {name, callId, ok, preview} */
export interface ToolBadge { name: string; callId: string; ok?: boolean; preview?: string }
export interface StreamEventMsg {
  requestId: string
  type: 'delta' | 'emotion' | 'done' | 'error' | 'tool'
  delta?: string
  emotion?: string
  message?: ChatMessage
  error?: string
  aborted?: boolean
  tool?: ToolBadge
}
export interface StartReplyPayload {
  conversationId: string
  content: string
  images?: string[]
  files?: FileAttachment[]
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
