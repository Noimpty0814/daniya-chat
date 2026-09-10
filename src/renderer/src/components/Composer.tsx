import { useEffect, useRef, useState } from 'react'
import type { FileAttachment } from '../../../shared/types'

export function Composer(props: {
  streaming: boolean
  initialSearch: boolean
  onSend(content: string, images: string[], files: FileAttachment[], search: boolean): void
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [search, setSearch] = useState(props.initialSearch)
  const [shotMsg, setShotMsg] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // R1-M3：getSettings 异步返回晚于挂载时同步初始勾选状态
  useEffect(() => { setSearch(props.initialSearch) }, [props.initialSearch])

  const submit = (): void => {
    const t = text.trim()
    if ((!t && images.length === 0 && files.length === 0) || props.streaming) return
    props.onSend(t, images, files, search)
    setText(''); setImages([]); setFiles([])
  }

  const capture = async (): Promise<void> => {
    setShotMsg('截屏中…')
    const r = await window.api.captureScreen()
    setShotMsg('')
    if (r.ok && r.dataUrl) setImages([...images, r.dataUrl])
    else setShotMsg(r.error ?? '截屏失败')
  }

  const pick = async (): Promise<void> => {
    const { files: picked, error } = await window.api.pickFiles()
    if (picked.length) {
      if (files.length + picked.length > 3) setShotMsg('最多附加 3 个文件')
      setFiles([...files, ...picked].slice(0, 3))
    }
    if (error) setShotMsg(error)
  }

  const register = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const r = await window.api.registerFiles(paths)
    if (r.files.length) {
      if (files.length + r.files.length > 3) setShotMsg('最多附加 3 个文件')
      setFiles([...files, ...r.files].slice(0, 3))
    }
    if (!r.ok && r.error) setShotMsg(r.error)
  }

  const removeFile = (i: number): void => setFiles(files.filter((_, j) => j !== i))

  return (
    <div className="composer"
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        const paths = Array.from(e.dataTransfer.files)
          .map(f => window.api.getPathForFile(f))
          .filter(Boolean)
        void register(paths)
      }}>
      {(images.length > 0 || files.length > 0) && (
        <div className="shot-previews">
          {images.map((u, i) => (
            <div key={`img-${i}`} className="shot-preview">
              <img src={u} alt="待发送截图" />
              <button className="shot-remove" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {files.map((f, i) => (
            <div key={`${f.path}-${i}`} className="file-chip">
              <span title={f.path}>{f.name}</span>
              <button className="shot-remove" onClick={() => removeFile(i)}>×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef} value={text} rows={3} placeholder="和达妮娅说点什么…（Enter 发送，Shift+Enter 换行，可拖入文件）"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
      />
      <div className="composer-actions">
        <span className="composer-hint">{shotMsg || 'Esc 收起窗口'}</span>
        <button className={`shot-btn search-btn${search ? ' active' : ''}`} onClick={() => setSearch(!search)} disabled={props.streaming}>联网搜索</button>
        <button className="shot-btn" onClick={() => void pick()} disabled={props.streaming}>选文件</button>
        <button className="shot-btn" onClick={() => void capture()} disabled={props.streaming}>截屏</button>
        {props.streaming
          ? <button className="stop-btn" onClick={props.onStop}>停止</button>
          : <button className="send-btn" disabled={!text.trim() && images.length === 0 && files.length === 0} onClick={submit}>发送</button>}
      </div>
    </div>
  )
}
