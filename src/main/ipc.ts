import { ipcMain, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from './storage/store'
import type { AppSettingsView, ChatMessage, StreamEventMsg, StartReplyPayload, StartReplyResult } from '../shared/types'
import { streamChat, ApiError, type ChatTurn } from './deepseek/client'
import type { DeepSeekConfig } from './deepseek/client'
import type { Emotion } from './deepseek/emotion'
import { loadSettings, saveSettings, toView, setApiKey, applyView, type AppSettings } from './settings'
import { capturePrimaryScreen } from './screenshot'
import type { PetCoordinator } from './pet/coordinator'

interface StreamHandle { abort: AbortController; conversationId: string }
const MAX_CONTEXT = 40

function toTurn(m: ChatMessage): ChatTurn {
  return { role: m.role, content: m.content, images: m.images?.map(i => i.dataUrl) }
}

export interface RegisterIpcOpts {
  store: Store
  settingsFile: string
  pet: () => PetCoordinator
  getConfig: (s: AppSettings) => DeepSeekConfig | null
  onSettingsChanged?: (s: AppSettings) => void
}

export function registerIpc(opts: RegisterIpcOpts): void {
  const { store, settingsFile, pet, getConfig } = opts
  const streams = new Map<string, StreamHandle>()

  ipcMain.handle('chat:listConversations', () => store.listConversations())
  ipcMain.handle('chat:createConversation', () => store.createConversation())
  ipcMain.handle('chat:renameConversation', (_e, p: { id: string; title: string }) => { store.renameConversation(p.id, p.title) })
  ipcMain.handle('chat:deleteConversation', (_e, p: { id: string }) => {
    for (const [rid, h] of streams) if (h.conversationId === p.id) { h.abort.abort(); streams.delete(rid) }
    store.deleteConversation(p.id)
  })
  ipcMain.handle('chat:getMessages', (_e, p: { id: string }) => store.getMessages(p.id))
  ipcMain.handle('chat:search', (_e, p: { q: string }) => store.search(p.q))

  ipcMain.handle('chat:startReply', async (e: IpcMainInvokeEvent, p: StartReplyPayload): Promise<StartReplyResult> => {
    if (!p.content.trim() && !(p.images && p.images.length > 0)) return { ok: false, error: '消息内容不能为空' }
    if ([...streams.values()].some(h => h.conversationId === p.conversationId)) return { ok: false, error: '该会话正在生成回复中' }
    const settings = loadSettings(settingsFile)
    const cfg = getConfig(settings)
    if (!cfg) return { ok: false, error: '请先在设置中填写 API Key' }

    const userMessage: ChatMessage = {
      id: randomUUID(), role: 'user', content: p.content,
      images: p.images?.map(u => ({ id: randomUUID(), dataUrl: u })),
      createdAt: Date.now()
    }
    // R23：流错误后的重试复用已在库中的 user 消息，跳过落库避免重复（userMessage 仍返回供渲染层补气泡判断）
    if (!p.skipUserAppend) {
      store.appendMessage(p.conversationId, userMessage)
      store.autoTitle(p.conversationId)
    }

    const requestId = randomUUID()
    const history = store.getMessages(p.conversationId).slice(-MAX_CONTEXT).map(toTurn)
    const ac = new AbortController()
    streams.set(requestId, { abort: ac, conversationId: p.conversationId })
    const send = (msg: Omit<StreamEventMsg, 'requestId'>) => { if (!e.sender.isDestroyed()) e.sender.send('chat:stream', { requestId, ...msg }) }

    pet().bubble(true)
    void (async () => {
      let full = ''
      let emotion: Emotion | null = null
      let modelUsed = ''
      try {
        const gen = await streamChat(cfg, history, ac.signal)
        for await (const ev of gen) {
          if (ev.type === 'delta') { full += ev.delta; send({ type: 'delta', delta: ev.delta }) }
          else if (ev.type === 'emotion') { emotion = ev.emotion; pet().emotion(emotion); send({ type: 'emotion', emotion }) }
          else if (ev.type === 'done') { modelUsed = ev.model; break }
        }
      } catch (err) {
        if (ac.signal.aborted) {
          const partial: ChatMessage = { id: randomUUID(), role: 'assistant', content: full, model: modelUsed, createdAt: Date.now() }
          if (full.trim()) store.appendMessage(p.conversationId, partial)
          send({ type: 'done', message: partial, aborted: true })
        } else {
          const msg = err instanceof ApiError ? err.message : '网络错误，请重试'
          send({ type: 'error', error: msg })
        }
        return
      } finally {
        streams.delete(requestId)
        pet().bubble(false)
      }
      if (emotion === null) pet().emotion(null)
      const assistantMessage: ChatMessage = { id: randomUUID(), role: 'assistant', content: full, model: modelUsed, createdAt: Date.now() }
      store.appendMessage(p.conversationId, assistantMessage)
      send({ type: 'done', message: assistantMessage, emotion: emotion ?? undefined })
    })()

    return { ok: true, requestId, userMessage }
  })

  ipcMain.handle('chat:stopReply', (_e, p: { requestId: string }) => { streams.get(p.requestId)?.abort.abort() })

  ipcMain.handle('settings:get', () => toView(loadSettings(settingsFile)))
  ipcMain.handle('settings:save', (_e, v: AppSettingsView) => {
    const next = applyView(loadSettings(settingsFile), v)
    saveSettings(settingsFile, next)
    opts.onSettingsChanged?.(next)
  })
  ipcMain.handle('settings:setApiKey', (_e, p: { key: string }) => { setApiKey(settingsFile, p.key ?? '') })
  ipcMain.handle('settings:testConnection', async () => {
    const s = loadSettings(settingsFile)
    const cfg = getConfig(s)
    if (!cfg) return { ok: false, message: '请先填写 API Key' }
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: `Bearer ${cfg.apiKey}` }
      })
      return res.ok
        ? { ok: true, message: '连接成功，API Key 有效' }
        : { ok: false, message: `连接失败 (HTTP ${res.status})，请检查 Key 与 Base URL` }
    } catch {
      return { ok: false, message: '网络错误，无法连接到 Base URL' }
    }
  })
  ipcMain.handle('screen:capture', async (): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => {
    try { return { ok: true, dataUrl: await capturePrimaryScreen() } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : '截屏失败' } }
  })
  ipcMain.handle('shell:openExternal', (_e, p: { url: string }) => { if (/^https?:\/\//.test(p.url)) return shell.openExternal(p.url) })
  ipcMain.handle('window:hide', (e) => { BrowserWindow.fromWebContents(e.sender)?.hide() })
  ipcMain.handle('pet:status', () => pet().status())
}
