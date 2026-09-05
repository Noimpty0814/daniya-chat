export interface ConversationMeta { id: string; title: string; createdAt: number; updatedAt: number }
export interface ImagePart { id: string; dataUrl: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: ImagePart[]
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
export interface StartReplyPayload { conversationId: string; content: string; images?: string[] }
export interface StartReplyResult { ok: boolean; error?: string; requestId?: string; userMessage?: ChatMessage }
export interface PetStatus { helperRunning: boolean; connected: boolean; petWindowFound: boolean }
