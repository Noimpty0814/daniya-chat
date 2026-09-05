import type { ChatMessage } from '../../../shared/types'
import type { Streaming } from '../state/chatStore'
import { Message } from './Message'

export function MessageArea(props: {
  messages: ChatMessage[]
  streaming: Streaming | null
  error: string | null
  onRetry: () => void
  onDismissError: () => void
}): React.JSX.Element {
  return (
    <div className="messages">
      {props.messages.map(m => <Message key={m.id} msg={m} />)}
      {props.streaming && props.streaming.text.length === 0 && <div className="thinking">达妮娅思考中…</div>}
      {props.streaming && props.streaming.text.length > 0 && (
        <Message msg={{ id: '__streaming__', role: 'assistant', content: props.streaming.text, createdAt: Date.now() }} streaming />
      )}
      {props.error && (
        <div className="error-banner">
          <span>{props.error}</span>
          <button onClick={props.onRetry}>重试</button>
          <button onClick={props.onDismissError}>关闭</button>
        </div>
      )}
    </div>
  )
}
