import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron'
import path from 'node:path'
import { Store } from './storage/store'
import { registerIpc } from './ipc'
import { loadSettings, getApiKey, type AppSettings } from './settings'
import { createNullPet, type PetCoordinator } from './pet/coordinator'
import { createPipePet } from './pet/pipe-pet'
import { petConfigChanged } from './pet/pet-settings'
import type { DeepSeekConfig } from './deepseek/client'
import type { PetSettings } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let pet: PetCoordinator = createNullPet()
let lastPetConfig: PetSettings | null = null

function helperScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'pet-helper.ps1')
    : path.join(__dirname, '../../resources/pet-helper.ps1')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 960, height: 640, minWidth: 860, minHeight: 600,
    autoHideMenuBar: true, title: '达妮娅聊天', show: false,
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide() } })
  win.on('closed', () => { win = null })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// R28：聊天窗在光标附近弹出（不依赖桌宠 window 事件定位），保证不超出所在显示屏工作区
function showNearCursor(): void {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const area = display.workArea
  const [w, h] = win.getSize()
  const x = Math.min(Math.max(cursor.x - Math.round(w / 2), area.x), area.x + area.width - w)
  const y = Math.min(Math.max(cursor.y - Math.round(h / 2), area.y), area.y + area.height - h)
  win.setPosition(x, y)
}

function toggleWindow(): void {
  if (!win) return
  if (win.isVisible() && win.isFocused()) { win.hide() }
  else { showNearCursor(); win.show(); win.focus() }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../resources/icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('达妮娅聊天')
  tray.on('click', toggleWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏', click: toggleWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } }
  ]))
}

function applyPetSettings(s: AppSettings): void {
  const ext = pet as PetCoordinator & {
    setMapping?(m: Record<string, string>): void
    onError?(cb: (msg: string) => void): void
  }
  if (!petConfigChanged(lastPetConfig, s.pet)) {
    // I2：桌宠配置未变时只更新按键映射——重建会弹 UAC 并断开联动
    ext.setMapping?.(s.emotionKeys)
    return
  }
  lastPetConfig = { ...s.pet }
  pet.stop()
  pet = s.pet.enabled ? createPipePet({ exeName: s.pet.exeName, helperPath: helperScriptPath() }) : createNullPet()
  const newExt = pet as PetCoordinator & {
    setMapping?(m: Record<string, string>): void
    onError?(cb: (msg: string) => void): void
  }
  newExt.setMapping?.(s.emotionKeys)
  newExt.onError?.((msg) => { win?.webContents.send('pet:error', msg) })
  // R28：pet-click 事件收到就忽略（托盘左键负责弹出/隐藏）
  pet.start()
}

function getConfig(s: AppSettings): DeepSeekConfig | null {
  const apiKey = getApiKey(s)
  if (!apiKey) return null
  return { apiKey, baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, systemPrompt: s.systemPrompt }
}

app.whenReady().then(() => {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json')
  const store = new Store(app.getPath('userData'))
  registerIpc({ store, settingsFile, pet: () => pet, getConfig, onSettingsChanged: applyPetSettings })
  createWindow()
  createTray()
  applyPetSettings(loadSettings(settingsFile))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
let petStoppedForQuit = false
app.on('before-quit', (e) => {
  quitting = true
  if (petStoppedForQuit) return
  petStoppedForQuit = true
  const running = pet.status().helperRunning
  pet.stop()
  if (running) {
    // 提权助手无法被普通权限主进程杀掉：等 shutdown 命令送达（stop 内 ≤1.5s 排空）再退出，避免孤儿进程
    e.preventDefault()
    setTimeout(() => app.quit(), 1600)
  }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
