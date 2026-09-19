import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage, ToolUse } from '../../../shared/types'
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

/** 模型可见工具名 → 徽照搬中文文案（spec §8）；未知工具名原样显示 */
const TOOL_LABELS: Record<string, string> = {
  pwsh: '执行命令',
  web_search: '联网搜索',
  web_fetch: '读取网页'
}

/** 徽照搬文案与样式态：进行中（仅流式期间）→ 成功/失败；历史里无结果记录时显示中性文案 */
function toolBadge(t: ToolUse, streaming: boolean): { text: string; state: 'pending' | 'ok' | 'fail' } {
  const label = TOOL_LABELS[t.name] ?? t.name
  if (t.ok === false) return { text: `${label}失败`, state: 'fail' }
  if (t.ok === undefined && streaming) return { text: `正在${label}…`, state: 'pending' }
  return { text: t.ok === true ? `已${label}` : label, state: 'ok' }
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
      {msg.tools && msg.tools.length > 0 && (
        <div className="tool-badges">
          {msg.tools.map((t, i) => {
            const b = toolBadge(t, streaming === true)
            return <span key={`${t.name}-${i}`} className={`tool-badge tool-badge-${b.state}`} title={t.name}>{b.text}</span>
          })}
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
