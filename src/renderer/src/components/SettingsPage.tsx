export function SettingsPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <div className="settings">
      <button onClick={onBack}>← 返回聊天</button>
      <p>设置页将在下一步实现</p>
    </div>
  )
}
