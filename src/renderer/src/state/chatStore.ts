import type { ChatMessage, ConversationMeta, SearchHit, StreamEventMsg } from '../../../shared/types'

export type View = 'chat' | 'settings'

export interface Streaming { requestId: string; text: string }

export interface State {
  view: View
  conversations: ConversationMeta[]
  activeId: string | null
  messages: ChatMessage[]
  streaming: Streaming | null
  error: string | null
  searchQuery: string
  searchHits: SearchHit[] | null
}

export type Action =
  | { type: 'init'; conversations: ConversationMeta[] }
  | { type: 'setView'; view: View }
  | { type: 'select'; id: string; messages: ChatMessage[] }
  | { type: 'newConversation'; meta: ConversationMeta }
  | { type: 'rename'; id: string; title: string }
  | { type: 'remove'; id: string }
  | { type: 'appendUser'; message: ChatMessage }
  | { type: 'startStream'; requestId: string }
  | { type: 'streamEvent'; e: StreamEventMsg }
  | { type: 'clearError' }
  | { type: 'setSearch'; query: string; hits: SearchHit[] | null }

export const initialState: State = {
  view: 'chat', conversations: [], activeId: null, messages: [],
  streaming: null, error: null, searchQuery: '', searchHits: null
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'init':
      return { ...state, conversations: a.conversations }
    case 'setView':
      return { ...state, view: a.view }
    case 'select':
      return { ...state, activeId: a.id, messages: a.messages, streaming: null, error: null }
    case 'newConversation':
      return { ...state, conversations: [a.meta, ...state.conversations], activeId: a.meta.id, messages: [], streaming: null, error: null }
    case 'rename':
      return { ...state, conversations: state.conversations.map(c => c.id === a.id ? { ...c, title: a.title } : c) }
    case 'remove': {
      const conversations = state.conversations.filter(c => c.id !== a.id)
      return { ...state, conversations, activeId: state.activeId === a.id ? (conversations[0]?.id ?? null) : state.activeId, messages: state.activeId === a.id ? [] : state.messages }
    }
    case 'appendUser':
      return { ...state, messages: [...state.messages, a.message] }
    case 'startStream':
      return { ...state, streaming: { requestId: a.requestId, text: '' }, error: null }
    case 'streamEvent': {
      const e = a.e
      if (e.type === 'error') {
        if (state.streaming && e.requestId !== state.streaming.requestId) return state
        return { ...state, streaming: null, error: e.error ?? '未知错误' }
      }
      if (!state.streaming || e.requestId !== state.streaming.requestId) return state
      if (e.type === 'delta') return { ...state, streaming: { ...state.streaming, text: state.streaming.text + (e.delta ?? '') } }
      if (e.type === 'done') {
        const messages = e.message && e.message.content.trim() ? [...state.messages, e.message] : state.messages
        return { ...state, streaming: null, messages, error: null }
      }
      return state
    }
    case 'clearError':
      return { ...state, error: null }
    case 'setSearch':
      return { ...state, searchQuery: a.query, searchHits: a.hits }
    default:
      return state
  }
}
