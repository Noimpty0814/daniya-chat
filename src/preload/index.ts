import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '../shared/api'
import type { FileProposalEvent, StreamEventMsg } from '../shared/types'

const api: Api = {
  listConversations: () => ipcRenderer.invoke('chat:listConversations'),
  createConversation: () => ipcRenderer.invoke('chat:createConversation'),
  renameConversation: (id, title) => ipcRenderer.invoke('chat:renameConversation', { id, title }),
  deleteConversation: (id) => ipcRenderer.invoke('chat:deleteConversation', { id }),
  getMessages: (id) => ipcRenderer.invoke('chat:getMessages', { id }),
  search: (q) => ipcRenderer.invoke('chat:search', { q }),
  startReply: (p) => ipcRenderer.invoke('chat:startReply', p),
  stopReply: (requestId) => ipcRenderer.invoke('chat:stopReply', { requestId }),
  onStream: (cb) => {
    const h = (_e: unknown, data: StreamEventMsg): void => cb(data)
    ipcRenderer.on('chat:stream', h)
    return () => ipcRenderer.removeListener('chat:stream', h)
  },
  onPetError: (cb) => {
    const h = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('pet:error', h)
    return () => ipcRenderer.removeListener('pet:error', h)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', { key }),
  testConnection: () => ipcRenderer.invoke('settings:testConnection'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  registerFiles: (paths) => ipcRenderer.invoke('file:register', { paths }),
  pickWorkDir: () => ipcRenderer.invoke('file:pickDir'),
  applyProposal: (id) => ipcRenderer.invoke('file:apply', { id }),
  rejectProposal: (id) => ipcRenderer.invoke('file:reject', { id }),
  onFileProposal: (cb) => {
    const h = (_e: unknown, data: FileProposalEvent): void => cb(data)
    ipcRenderer.on('file:proposal', h)
    return () => ipcRenderer.removeListener('file:proposal', h)
  },
  getPathForFile: (f) => webUtils.getPathForFile(f),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getPetStatus: () => ipcRenderer.invoke('pet:status'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url })
}
contextBridge.exposeInMainWorld('api', api)
