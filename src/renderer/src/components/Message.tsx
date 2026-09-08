import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../../../shared/types'
import 'highlight.js/styles/github-dark.css'

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  const match = /language-(\w+)/.exec(className ?? '')
  const preRef = useRef<HTMLPreElement>(null)
  const copy = (): void => { void navigator.clipboard.writeText(preRef.current?.textContent ?? '') }
  if (match) {
    return (
      <div className="codeblock">
        <div className="codeblock-head">
          <span>{match[1]}</span>
          <button className="copy-btn" onClick={copy}>复制</button>
        </div>
        <pre ref={preRef}><code className={className}>{children}</code></pre>
      </div>
    )
  }
  return <code className="inline-code">{children}</code>
}

export function Message({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }): React.JSX.Element {
  return (
    <div className={`msg msg-${msg.role}${streaming ? ' streaming' : ''}`}>
      {msg.images && msg.images.length > 0 && (
        <div className="msg-images">
          {msg.images.map(i => <img key={i.id} src={i.dataUrl} alt="截图" />)}
        </div>
      )}
      {msg.files && msg.files.length > 0 && (
        <div className="msg-files">
          {msg.files.map((f, i) => <span key={`${f.path}-${i}`} className="file-chip" title={f.path}>{f.name}</span>)}
        </div>
      )}
      {msg.content && (
        <div className="msg-bubble">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
            components={{ code: CodeBlock }}>
            {msg.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}
