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
