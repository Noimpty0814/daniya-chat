import { useEffect, useState } from 'react'
import type { AppSettingsView } from '../../../shared/types'
import { EMOTION_LABELS } from '../../../main/pet/keys'

const EMOTION_ORDER = ['happy', 'sad', 'sleepy', 'dismissive', 'shy', 'blush', 'angry', 'dark', 'default', 'bubble_on', 'bubble_off']

export function SettingsPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [form, setForm] = useState<AppSettingsView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const [petStatus, setPetStatus] = useState('')

  useEffect(() => {
    void window.api.getSettings().then(s => setForm(s))
    const t = window.setInterval(() => {
      void window.api.getPetStatus().then(p => setPetStatus(p.helperRunning ? '联动助手运行中' : '联动助手未运行'))
    }, 3000)
    return () => window.clearInterval(t)
  }, [])

  if (!form) return <div className="settings"><p>加载中…</p></div>

  const set = (patch: Partial<AppSettingsView>): void => setForm({ ...form, ...patch })
  const save = async (): Promise<void> => {
    try {
      await window.api.saveSettings(form)
      if (apiKey) { await window.api.setApiKey(apiKey); setApiKey('') }
      setSaved('已保存')
      window.setTimeout(() => setSaved(''), 2000)
    } catch (e) {
      setSaved('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }
  const test = async (): Promise<void> => {
    try {
      const r = await window.api.testConnection()
      setTestMsg(r.message)
    } catch (e) {
      setTestMsg('测试失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <button onClick={onBack}>← 返回聊天</button>
        <h1>设置</h1>
        <span className="pet-status">{petStatus}</span>
      </div>
      <div className="settings-body">
        <section>
          <h2>API</h2>
          <label>API Key
            <input type="password" value={apiKey} placeholder={form.hasApiKey ? '已保存（输入新值可覆盖，留空不变）' : '粘贴 DeepSeek API Key'}
              onChange={e => setApiKey(e.target.value)} />
          </label>
          <label>Base URL
            <input value={form.baseUrl} onChange={e => set({ baseUrl: e.target.value })} />
          </label>
          <label>文本模型
            <input value={form.textModel} onChange={e => set({ textModel: e.target.value })} />
          </label>
          <label>视觉模型（截屏消息使用）
            <input value={form.visionModel} onChange={e => set({ visionModel: e.target.value })} />
          </label>
          <div className="settings-actions">
            <button onClick={() => void test()}>测试连接</button>
            {testMsg && <span className="test-msg">{testMsg}</span>}
          </div>
        </section>

        <section>
          <h2>Key 申请指引</h2>
          <ol className="guide">
            <li>打开 <a href="#" onClick={e => { e.preventDefault(); void window.api.openExternal('https://platform.deepseek.com') }}>platform.deepseek.com</a> 注册并登录</li>
            <li>在左侧菜单进入「API Keys」页面</li>
            <li>点击「创建 API Key」，命名后复制生成的 Key（Key 只显示一次，请立即粘贴到本应用）</li>
            <li>需先在平台充值（按量计费，费用很低）；视觉模型为实验版，随 Key 自动可用</li>
          </ol>
        </section>

        <section>
          <h2>桌宠联动</h2>
          <label className="checkbox"><input type="checkbox" checked={form.pet.enabled} onChange={e => set({ pet: { ...form.pet, enabled: e.target.checked } })} /> 启用桌宠联动（点击桌宠弹出聊天框、AI 情绪驱动表情）</label>
          <label>桌宠程序路径
            <input value={form.pet.exePath} onChange={e => set({ pet: { ...form.pet, exePath: e.target.value } })} />
          </label>
          <label>进程名（用于定位桌宠窗口）
            <input value={form.pet.exeName} onChange={e => set({ pet: { ...form.pet, exeName: e.target.value } })} />
          </label>
        </section>

        <section>
          <h2>情绪 → 桌宠按键（Alt+该键）</h2>
          <div className="emotion-grid">
            {EMOTION_ORDER.map(name => (
              <label key={name}>{EMOTION_LABELS[name] ?? name}
                <input maxLength={1} value={form.emotionKeys[name] ?? ''}
                  onChange={e => set({ emotionKeys: { ...form.emotionKeys, [name]: e.target.value.toUpperCase() } })} />
              </label>
            ))}
          </div>
        </section>

        <div className="settings-actions">
          <button className="primary" onClick={() => void save()}>保存</button>
          {saved && <span className="test-msg">{saved}</span>}
        </div>
      </div>
    </div>
  )
}
