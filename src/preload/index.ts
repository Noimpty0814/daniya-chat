import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/api'
import type { StreamEventMsg } from '../shared/types'

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
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', { key }),
  testConnection: () => ipcRenderer.invoke('settings:testConnection'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getPetStatus: () => ipcRenderer.invoke('pet:status')
}
contextBridge.exposeInMainWorld('api', api)
