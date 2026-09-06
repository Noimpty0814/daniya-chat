import { useRef, useState } from 'react'

export function Composer(props: {
  streaming: boolean
  onSend(content: string, images: string[]): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [shotMsg, setShotMsg] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const t = text.trim()
    if ((!t && images.length === 0) || props.streaming) return
    props.onSend(t, images)
    setText(''); setImages([])
  }

  const capture = async (): Promise<void> => {
    setShotMsg('截屏中…')
    const r = await window.api.captureScreen()
    setShotMsg('')
    if (r.ok && r.dataUrl) setImages([...images, r.dataUrl])
    else setShotMsg(r.error ?? '截屏失败')
  }

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="shot-previews">
          {images.map((u, i) => (
            <div key={i} className="shot-preview">
              <img src={u} alt="待发送截图" />
              <button className="shot-remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
      />
      <div className="composer-actions">
        <span className="composer-hint">{shotMsg || 'Esc 收起窗口'}</span>
        <button className="shot-btn" onClick={() => void capture()} disabled={props.streaming}>截屏</button>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim() && images.length === 0} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
