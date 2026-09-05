import { useRef, useState } from 'react'

export function Composer(props: {
  streaming: boolean
  onSend(content: string): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if (!t || props.streaming) return
    props.onSend(t)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">Esc 收起窗口</span>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim()} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
