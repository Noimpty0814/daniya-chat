import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { Store } from './storage/store'
import { registerIpc } from './ipc'
import { loadSettings, type AppSettings } from './settings'
import { createNullPet } from './pet/coordinator'
import type { DeepSeekConfig } from './deepseek/client'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 960, height: 640, minWidth: 860, minHeight: 600,
    autoHideMenuBar: true, title: '达妮娅聊天', show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function getConfig(s: AppSettings): DeepSeekConfig | null {
  if (!s.apiKeyEncrypted) return null
  return {
    apiKey: 'PLACEHOLDER-TASK9',
    baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, systemPrompt: s.systemPrompt
  }
}

app.whenReady().then(() => {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json')
  const store = new Store(app.getPath('userData'))
  registerIpc({ store, settingsFile, pet: () => createNullPet(), getConfig })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
