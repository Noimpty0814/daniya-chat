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
    const offStream = window.api.onStream(e => dispatch({ type: 'streamEvent', e }))
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') void window.api.hideWindow() }
    window.addEventListener('keydown', onKey)
    return () => { disposed = true; offStream(); window.removeEventListener('keydown', onKey) }
  }, [select])

  const send = useCallback(async (content: string) => {
    if (!state.activeId) return
    const r = await window.api.startReply({ conversationId: state.activeId, content })
    if (!r.ok) {
      dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error } })
      return
    }
    if (r.requestId && r.userMessage) {
      dispatch({ type: 'appendUser', message: r.userMessage })
      dispatch({ type: 'startStream', requestId: r.requestId })
    }
  }, [state.activeId])

  const retry = useCallback(() => {
    const last = [...state.messages].reverse().find(m => m.role === 'user')
    if (last && state.activeId) {
      void window.api.startReply({
        conversationId: state.activeId, content: last.content,
        images: last.images?.map(i => i.dataUrl)
      }).then(r => {
        if (!r.ok) {
          if (r.error) dispatch({ type: 'streamEvent', e: { requestId: '__none__', type: 'error', error: r.error } })
        } else if (r.requestId) {
          dispatch({ type: 'startStream', requestId: r.requestId })
        }
      })
    }
  }, [state.messages, state.activeId])

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
        onDelete={id => { void window.api.deleteConversation(id); dispatch({ type: 'remove', id }) }}
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
              onSend={content => void send(content)}
              onStop={() => { if (state.streaming) void window.api.stopReply(state.streaming.requestId) }} />
          </>
        ) : (
          <div className="empty">点击左侧 ＋ 新建对话开始</div>
        )}
      </div>
    </div>
  )
}
