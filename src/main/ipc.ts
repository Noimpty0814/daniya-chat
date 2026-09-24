import { ipcMain, BrowserWindow, shell, dialog, type IpcMainInvokeEvent } from 'electron'
import type { AppSettingsView, StartReplyPayload } from '../shared/types'
import { loadSettings, saveSettings, toView, setApiKey, getApiKey, applyView, type AppSettings } from './settings'
import { capturePrimaryScreen } from './screenshot'
import { FileProposalService } from './files/service'
import { ConversationRegistry } from './harness/conversations'
import { ChatRuntime, type HarnessLike } from './chat-runtime'
import type { PetCoordinator } from './pet/coordinator'

/**
 * IPC 面：通道名与载荷语义对渲染层保持不变。
 * 本文件是纯通道 adapter——全部 ipcMain.handle 注册在此；
 * chat:* 八条一行委托给 ChatRuntime（turn 状态机全部语义见 chat-runtime.ts），
 * settings/file/screen/pet 透传 handler 原样保留。
 * pet:error 不经本文件：由 index.ts 的 pet 装配处推送（onError → webContents.send）
 */

export interface RegisterIpcOpts {
  registry: ConversationRegistry
  runtime: HarnessLike
  settingsFile: string
  pet: () => PetCoordinator
  onSettingsChanged?: (s: AppSettings) => void
}

export function registerIpc(opts: RegisterIpcOpts): void {
  const { registry, runtime, settingsFile, pet } = opts
  const files = new FileProposalService()
  const chat = new ChatRuntime({ registry, runtime, settingsFile, pet, files })

  ipcMain.handle('chat:listConversations', () => chat.listConversations())
  ipcMain.handle('chat:createConversation', () => chat.createConversation())
  ipcMain.handle('chat:renameConversation', (_e, p: { id: string; title: string }) => { chat.renameConversation(p.id, p.title) })
  ipcMain.handle('chat:deleteConversation', (_e, p: { id: string }) => chat.deleteConversation(p.id))
  ipcMain.handle('chat:getMessages', (_e, p: { id: string }) => chat.getMessages(p.id))
  ipcMain.handle('chat:search', (_e, p: { q: string }) => chat.search(p.q))
  ipcMain.handle('chat:startReply', (e: IpcMainInvokeEvent, p: StartReplyPayload) => chat.startReply(e.sender, p))
  ipcMain.handle('chat:stopReply', (_e, p: { requestId: string }) => { chat.stopReply(p.requestId) })

  ipcMain.handle('settings:get', () => toView(loadSettings(settingsFile)))
  ipcMain.handle('settings:save', (_e, v: AppSettingsView) => {
    const next = applyView(loadSettings(settingsFile), v)
    saveSettings(settingsFile, next)
    opts.onSettingsChanged?.(next)
  })
  ipcMain.handle('settings:setApiKey', (_e, p: { key: string }) => { setApiKey(settingsFile, p.key ?? '') })
  ipcMain.handle('settings:testConnection', async () => {
    const s = loadSettings(settingsFile)
    const apiKey = getApiKey(s)
    if (!apiKey) return { ok: false, message: '请先填写 API Key' }
    try {
      const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
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

  // file:register/file:pick 载荷新增 conversationId（授权按会话作用域）；会话存在性校验在 ChatRuntime 内
  ipcMain.handle('file:pick', (_e, p?: { conversationId?: string }) => chat.pickFiles(p?.conversationId ?? ''))
  ipcMain.handle('file:register', (_e, p?: { conversationId?: string; paths?: unknown[] }) =>
    chat.registerFiles(p?.conversationId ?? '', (p?.paths ?? []).filter((x): x is string => typeof x === 'string')))
  ipcMain.handle('file:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0]
  })
  ipcMain.handle('file:apply', (_e, p: { id: string }) => files.applyProposal(p.id))
  ipcMain.handle('file:reject', (_e, p: { id: string }) => { files.rejectProposal(p.id) })
}
