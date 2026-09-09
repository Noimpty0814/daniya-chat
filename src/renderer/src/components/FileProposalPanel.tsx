import { useState } from 'react'
import type { FileProposalEvent } from '../../../shared/types'

export function FileProposalPanel(props: {
  ev: FileProposalEvent
  onApply: (id: string) => void
  onReject: (id: string) => void
}): React.JSX.Element {
  const { ev } = props
  const [busy, setBusy] = useState(false)
  if (ev.error) return <div className="proposal-panel"><span className="proposal-note">{ev.error}</span></div>
  if (ev.status === 'applied') return <div className="proposal-panel"><span className="proposal-note">已应用修改：{ev.path}</span></div>
  if (ev.status === 'apply-failed') return <div className="proposal-panel"><span className="proposal-note">应用失败，文件未改动：{ev.path}</span></div>
  if (ev.status === 'rejected') return <div className="proposal-panel"><span className="proposal-note">已拒绝修改：{ev.path}</span></div>
  if (ev.autoApplied) return <div className="proposal-panel"><span className="proposal-note">已自动应用修改：{ev.path}</span></div>
  return (
    <div className="proposal-panel">
      <div className="proposal-head">
        <span>达妮娅提议修改 {ev.path}</span>
        <span className="proposal-note">确认后原文件备份为 .bak</span>
      </div>
      <div className="proposal-diff">
        {ev.diff.map((l, i) => (
          <div key={i} className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}>
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}{l.text}
          </div>
        ))}
      </div>
      <div className="proposal-actions">
        <button className="apply" disabled={busy} onClick={() => { if (busy) return; setBusy(true); props.onApply(ev.id) }}>应用修改</button>
        <button onClick={() => props.onReject(ev.id)}>拒绝</button>
      </div>
    </div>
  )
}
