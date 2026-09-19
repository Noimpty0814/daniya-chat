import type { ChatMessage, ConversationMeta, FileAttachment, FileProposalEvent, SearchHit, StreamEventMsg, ToolBadge } from '../../../shared/types'

export type View = 'chat' | 'settings'

export interface Streaming { requestId: string; text: string; tools: ToolBadge[] }

/** 发送失败时随错误保存的重试载荷（修复②：retry 优先用它重发，而非找最后一条 user 消息） */
export interface RetryPayload {
  content: string
  images?: string[]
  files?: FileAttachment[]
  /**
   * 该载荷对应的 user 气泡是否已在界面上屏：
   * false=首次失败发生在流建立前（无 Key/并发流），重试成功后需补气泡；
   * true=气泡已上屏（流错误重试或回退自 state 最后一条 user 消息），重试时不再补气泡
   */
  userVisible?: boolean
}

export interface State {
  view: View
  conversations: ConversationMeta[]
  activeId: string | null
  messages: ChatMessage[]
  streaming: Streaming | null
  error: string | null
  errorRetry: RetryPayload | null
  searchQuery: string
  searchHits: SearchHit[] | null
  proposal: FileProposalEvent | null
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
  | { type: 'streamEvent'; e: StreamEventMsg; retry?: RetryPayload }
  | { type: 'fileProposal'; e: FileProposalEvent }
  | { type: 'petError'; message: string }
  | { type: 'clearError' }
  | { type: 'setSearch'; query: string; hits: SearchHit[] | null }

export const initialState: State = {
  view: 'chat', conversations: [], activeId: null, messages: [],
  streaming: null, error: null, errorRetry: null, searchQuery: '', searchHits: null,
  proposal: null
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'init':
      return { ...state, conversations: a.conversations }
    case 'setView':
      return { ...state, view: a.view }
    case 'select':
      return { ...state, activeId: a.id, messages: a.messages, streaming: null, error: null, errorRetry: null, proposal: null }
    case 'newConversation':
      return { ...state, conversations: [a.meta, ...state.conversations], activeId: a.meta.id, messages: [], streaming: null, error: null, errorRetry: null, proposal: null }
    case 'rename':
      return { ...state, conversations: state.conversations.map(c => c.id === a.id ? { ...c, title: a.title } : c) }
    case 'remove': {
      const conversations = state.conversations.filter(c => c.id !== a.id)
      return { ...state, conversations, activeId: state.activeId === a.id ? (conversations[0]?.id ?? null) : state.activeId, messages: state.activeId === a.id ? [] : state.messages, proposal: null }
    }
    case 'appendUser':
      return { ...state, messages: [...state.messages, a.message] }
    case 'startStream':
      return { ...state, streaming: { requestId: a.requestId, text: '', tools: [] }, error: null, errorRetry: null, proposal: null }
    case 'streamEvent': {
      const e = a.e
      if (e.type === 'error') {
        if (state.streaming && e.requestId !== state.streaming.requestId) return state
        return { ...state, streaming: null, error: e.error ?? '未知错误', errorRetry: a.retry ?? null, proposal: null }
      }
      if (!state.streaming || e.requestId !== state.streaming.requestId) return state
      if (e.type === 'delta') return { ...state, streaming: { ...state.streaming, text: state.streaming.text + (e.delta ?? '') } }
      if (e.type === 'tool') {
        const t = e.tool
        if (!t) return state
        // 按 callId 归并：tool.call 登记进行中徽照搬，tool.result 回写成败态（preview 不丢先到的 args 摘要）
        const tools = [...state.streaming.tools]
        const i = tools.findIndex(x => x.callId === t.callId)
        if (i >= 0) tools[i] = { name: t.name || tools[i].name, callId: t.callId, ok: t.ok ?? tools[i].ok, preview: t.preview ?? tools[i].preview }
        else tools.push(t)
        return { ...state, streaming: { ...state.streaming, tools } }
      }
      if (e.type === 'done') {
        // 徽照搬以 done 载荷为权威；主进程漏带时用流式累积兜底（{name,ok} 投影为 ToolUse）
        const m = e.message
        const fallbackTools = !(m?.tools?.length) && state.streaming.tools.length
          ? state.streaming.tools.map(t => ({ name: t.name, ok: t.ok }))
          : undefined
        const message = m && (m.content.trim() || (m.tools?.length ?? 0) > 0 || fallbackTools)
          ? { ...m, tools: m.tools ?? fallbackTools }
          : null
        const messages = message ? [...state.messages, message] : state.messages
        return { ...state, streaming: null, messages, error: null, errorRetry: null }
      }
      return state
    }
    case 'fileProposal':
      return { ...state, proposal: a.e }
    case 'petError':
      return { ...state, error: a.message }
    case 'clearError':
      return { ...state, error: null, errorRetry: null }
    case 'setSearch':
      return { ...state, searchQuery: a.query, searchHits: a.hits }
    default:
      return state
  }
}
