import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { loadSettings, getApiKey, type AppSettings } from './settings'
import { createNullPet, type PetCoordinator } from './pet/coordinator'
import { createPipePet } from './pet/pipe-pet'
import { petConfigChanged } from './pet/pet-settings'
import { ConversationRegistry } from './harness/conversations'
import { HarnessRuntime, defaultHarnessSpec } from './harness/process'
import type { PetSettings } from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let pet: PetCoordinator = createNullPet()
let lastPetConfig: PetSettings | null = null
let runtime: HarnessRuntime | null = null

function helperScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'pet-helper.ps1')
    : path.join(__dirname, '../../resources/pet-helper.ps1')
}

const WIN_W = 960
const WIN_H = 640

function createWindow(): void {
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, minWidth: 860, minHeight: 600,
    // R28：首启也落在光标附近（B-1），窗口出生时定位避免居中闪跳
    ...boundsNearCursor(WIN_W, WIN_H),
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
function boundsNearCursor(w: number, h: number): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  return {
    x: Math.min(Math.max(cursor.x - Math.round(w / 2), area.x), area.x + area.width - w),
    y: Math.min(Math.max(cursor.y - Math.round(h / 2), area.y), area.y + area.height - h)
  }
}

function showNearCursor(): void {
  if (!win) return
  const [w, h] = win.getSize()
  const { x, y } = boundsNearCursor(w, h)
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

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const settingsFile = path.join(userData, 'settings.json')
  const dshHome = path.join(userData, 'harness')
  const registry = new ConversationRegistry(path.join(userData, 'conversations.json'))
  runtime = new HarnessRuntime({
    // 惰性 spec：首次 ensure() 才解析 launch.mjs（pack 下首 run 把 resources/harness 物化到 DSH_HOME/app）
    spec: () => defaultHarnessSpec({
      isPackaged: app.isPackaged,
      appDir: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      dshHome,
      // B-8：升级首启物化要拷 GB 级——拷贝期间给任务栏不确定进度作可见状态
      onMaterialize: (active) => {
        try { win?.setProgressBar(0, active ? { mode: 'indeterminate' } : { mode: 'none' }) } catch { /* 窗口未建/已毁不阻断 */ }
      }
    }),
    dshHome,
    settingsFile,
    getLaunchContext: () => {
      const s = loadSettings(settingsFile)
      return { apiKey: getApiKey(s), baseUrl: s.baseUrl, workDir: s.file.workDir, model: s.model }
    }
  })
  // B-8：启动即后台解析 spec（触发物化拷贝），首条消息到达时多半已就绪；进程仍惰性拉起
  runtime.prewarm()
  registerIpc({ registry, runtime, settingsFile, pet: () => pet, onSettingsChanged: applyPetSettings })
  createWindow()
  createTray()
  applyPetSettings(loadSettings(settingsFile))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
let drainedForQuit = false
app.on('before-quit', (e) => {
  quitting = true
  if (drainedForQuit) return
  drainedForQuit = true
  const running = pet.status().helperRunning
  pet.stop()
  // harness 排空与 pet 助手排空并行（两个独立子进程，各自有界超时后一并退出）
  const harnessAlive = runtime?.isAlive === true
  if (!running && !harnessAlive) return
  e.preventDefault()
  const petWait = running
    ? new Promise<void>(resolve => setTimeout(resolve, 1600)) // 提权助手杀不掉：等 shutdown 命令送达（stop 内 ≤1.5s 排空）
    : Promise.resolve()
  const harnessWait = harnessAlive && runtime
    ? runtime.shutdown().catch(err => { console.warn('[harness] shutdown 异常:', err) })
    : Promise.resolve()
  void Promise.all([petWait, harnessWait]).then(() => app.quit())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
