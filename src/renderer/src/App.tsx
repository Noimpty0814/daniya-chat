import { useCallback, useEffect, useReducer } from 'react'
import { initialState, reducer } from './state/chatStore'
import { ConversationList } from './components/ConversationList'
import { MessageArea } from './components/MessageArea'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/SettingsPage'

export default function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)

  const select = useCallback(async (id: string) => {
    const messages = await window.api.getMessages(id)
    dispatch({ type: 'select', id, messages })
  }, [])

  useEffect(() => {
    let disposed = false
    void window.api.listConversations().then(cs => {
      if (disposed) return
      dispatch({ type: 'init', conversations: cs })
      if (cs[0]) void select(cs[0].id)
    })
    // 修复④：done/error 后主进程可能已追加/更新会话（updatedAt 变化），刷新侧栏排序
    const offStream = window.api.onStream(e => {
      dispatch({ type: 'streamEvent', e })
      if (e.type === 'done' || e.type === 'error') {
        void window.api.listConversations().then(cs => {
          if (!disposed) dispatch({ type: 'init', conversations: cs })
        })
      }
    })
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') void window.api.hideWindow() }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; offStream(); window.removeEventListener('keydown', onKey) }
  }, [select])

  const send = useCallback(async (content: string, images: string[]) => {
    if (!state.activeId) return
    const r = await window.api.startReply({ conversationId: state.activeId, content, images })
    if (!r.ok) {
      // 修复②：send 失败路径不落 user 消息，把本次 content 存入 error 的 retry 载荷供重试使用
      dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error }, retry: { content } })
      return
    }
    if (r.requestId && r.userMessage) {
      dispatch({ type: 'appendUser', message: r.userMessage })
      dispatch({ type: 'startStream', requestId: r.requestId })
    }
  }, [state.activeId])

  const retry = useCallback(() => {
    if (!state.activeId) return
    // 修复②：优先使用 error 动作携带的 retry 载荷；无载荷时回退现有行为（找最后一条 user 消息）
    const last = [...state.messages].reverse().find(m => m.role === 'user')
    const p = state.errorRetry ?? (last ? { content: last.content, images: last.images?.map(i => i.dataUrl) } : null)
    if (!p || !p.content) return
    void window.api.startReply({
      conversationId: state.activeId, content: p.content, images: p.images
    }).then(r => {
      if (!r.ok) {
        // 重试再次失败时同样携带载荷，保证可继续重试同一内容
        if (r.error) dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error }, retry: p })
      } else if (r.requestId) {
        dispatch({ type: 'startStream', requestId: r.requestId })
      }
    })
  }, [state.errorRetry, state.messages, state.activeId])

  if (state.view === 'settings') {
    return <SettingsPage onBack={() => dispatch({ type: 'setView', view: 'chat' })} />
  }

  return (
    <div className="app">
      <ConversationList
        conversations={state.conversations}
        activeId={state.activeId}
        searchQuery={state.searchQuery}
        searchHits={state.searchHits}
        onNew={() => void window.api.createConversation().then(m => dispatch({ type: 'newConversation', meta: m }))}
        onSelect={id => { void select(id) }}
        onRename={(id, title) => { void window.api.renameConversation(id, title); dispatch({ type: 'rename', id, title }) }}
        onDelete={id => {
          void window.api.deleteConversation(id)
          // 修复③：删除的是当前会话时，reducer remove 会选中剩余首个会话但 messages 为空，
          // 这里对过滤后的首个会话补拉历史并 select（与 reducer remove 同序）
          const remaining = state.conversations.filter(c => c.id !== id)
          if (state.activeId === id && remaining[0]) {
            const nextId = remaining[0].id
            void window.api.getMessages(nextId).then(messages => dispatch({ type: 'select', id: nextId, messages }))
          }
          dispatch({ type: 'remove', id })
        }}
        onSearchInput={v => dispatch({ type: 'setSearch', query: v, hits: null })}
        onSearch={q => { void window.api.search(q).then(hits => dispatch({ type: 'setSearch', query: q, hits })) }}
        setViewSettings={() => dispatch({ type: 'setView', view: 'settings' })}
      />
      <div className="main">
        {state.activeId ? (
          <>
            <MessageArea messages={state.messages} streaming={state.streaming} error={state.error}
              onRetry={retry} onDismissError={() => dispatch({ type: 'clearError' })} />
            <Composer streaming={!!state.streaming}
              onSend={(content, images) => void send(content, images)}
              onStop={() => { if (state.streaming) void window.api.stopReply(state.streaming.requestId) }} />
          </>
        ) : (
          <div className="empty">点击左侧 ＋ 新建对话开始</div>
        )}
      </div>
    </div>
  )
}
