import { useEffect, useRef, useState } from 'react'
import type { ConversationMeta, SearchHit } from '../../../shared/types'

export function ConversationList(props: {
  conversations: ConversationMeta[]
  activeId: string | null
  searchQuery: string
  searchHits: SearchHit[] | null
  onNew(): void
  onSelect(id: string): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
  onSearchInput(v: string): void
  onSearch(query: string): void
  setViewSettings(): void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const debounceRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.clearTimeout(debounceRef.current)
    const q = props.searchQuery.trim()
    if (!q) return
    debounceRef.current = window.setTimeout(() => props.onSearch(q), 250)
  }, [props.searchQuery])

  const finishEdit = (id: string): void => {
    if (editText.trim()) props.onRename(id, editText.trim())
    setEditingId(null)
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="app-title">达妮娅聊天</span>
        <button className="new-btn" onClick={props.onNew} title="新建对话">＋</button>
      </div>
      <input
        className="search-input" placeholder="搜索历史消息…" value={props.searchQuery}
        onChange={e => props.onSearchInput(e.target.value)}
      />
      <div className="conv-list">
        {props.searchQuery.trim() && props.searchHits ? (
          props.searchHits.length === 0 ? <div className="empty-tip">没有匹配的消息</div> :
          props.searchHits.map((h, i) => (
            <button key={i} className="search-hit" onClick={() => props.onSelect(h.conversationId)}>
              <span className="hit-role">{h.role === 'user' ? '我' : '达妮娅'}</span>
              <span className="hit-snippet">{h.snippet}</span>
            </button>
          ))
        ) : (
          props.conversations.map(c => (
            <div key={c.id} className={`conv-item${c.id === props.activeId ? ' active' : ''}`} onClick={() => props.onSelect(c.id)}>
              {editingId === c.id ? (
                <input autoFocus value={editText}
                  onChange={e => setEditText(e.target.value)}
                  onBlur={() => finishEdit(c.id)}
                  onKeyDown={e => { if (e.key === 'Enter') finishEdit(c.id); if (e.key === 'Escape') setEditingId(null) }} />
              ) : (
                <span className="conv-title" onDoubleClick={() => { setEditingId(c.id); setEditText(c.title) }}>{c.title}</span>
              )}
              <span className="conv-actions" onClick={e => e.stopPropagation()}>
                {confirmDeleteId === c.id ? (
                  <button className="danger" onClick={() => { props.onDelete(c.id); setConfirmDeleteId(null) }}>确认删除</button>
                ) : (
                  <button onClick={() => setConfirmDeleteId(c.id)}>删除</button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="sidebar-foot">
        <button onClick={props.setViewSettings}>设置</button>
      </div>
    </div>
  )
}
