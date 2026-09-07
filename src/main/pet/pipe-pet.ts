import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Emotion } from '../deepseek/emotion'
import type { PetStatus } from '../../shared/types'
import type { PetCoordinator } from './coordinator'
import { comboFor } from './keys'

interface Rect { x: number; y: number; w: number; h: number }
type PetEvent =
  | { type: 'ready' } | { type: 'pong' } | { type: 'stopped' }
  | { type: 'pet-click'; x: number; y: number }
  | { type: 'window'; rect?: Rect; gone?: boolean }
  | { type: 'error'; error: string }

export interface PipePetOpts {
  exeName: string
  helperPath: string
  /** 事件/命令目录，默认 %TEMP%\daniya-pet；测试注入临时目录 */
  dir?: string
}

/** 助手运行方式：missing=桌宠进程不存在不启动；direct=普通权限直启；elevated=RunAs 提权（UAC） */
type Mode = 'missing' | 'direct' | 'elevated'

function psSingleQuote(s: string): string { return `'${s.replace(/'/g, "''")}'` }

export function createPipePet(opts: PipePetOpts): PetCoordinator {
  const dir = opts.dir ?? path.join(os.tmpdir(), 'daniya-pet')
  const eventsPath = path.join(dir, 'events.jsonl')
  const cmdPath = path.join(dir, 'cmd.json')
  fs.mkdirSync(dir, { recursive: true })

  let child: ChildProcess | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let connected = false
  let connectedSince = 0
  let lastPong = 0
  let helperStartAt = 0
  let restarts = 0
  let stopped = false
  let starting = false
  let mode: Mode = 'missing'
  let helperRunning = false
  let uacPrompts = 0
  let lastProbeAt = 0
  let windowRect: Rect | null = null
  let petWindowFound = false
  let lastEmotion: Emotion | null = null
  let lastKeys: { mods: number[]; key: number } | null = null
  let keysRetried = false
  const clickHandlers = new Set<() => void>()
  const windowHandlers = new Set<(r: Rect | null) => void>()
  const errorHandlers = new Set<(msg: string) => void>()
  // 命令队列：仅当 cmd.json 不存在时才写入（助手读取后自行删除），队列保证连发命令不丢失
  const pending: Record<string, unknown>[] = []

  function appendEvent(e: PetEvent): void {
    if (e.type === 'ready' || e.type === 'pong') { connected = true; lastPong = Date.now(); if (connectedSince === 0) connectedSince = Date.now() }
    if (e.type === 'stopped') { connected = false; connectedSince = 0; petWindowFound = false; helperRunning = false }
    if (e.type === 'pet-click') clickHandlers.forEach(cb => cb())
    if (e.type === 'window') { petWindowFound = !e.gone; windowRect = e.rect ?? null; windowHandlers.forEach(cb => cb(windowRect)) }
    if (e.type === 'error' && e.error === 'pet-window-not-found') {
      // R29：首次失败重发一次 keys；再失败通知渲染层错误条
      if (lastKeys && !keysRetried) {
        keysRetried = true
        sendCmd({ cmd: 'keys', mods: lastKeys.mods, key: lastKeys.key })
      } else {
        errorHandlers.forEach(cb => cb('桌宠窗口未找到'))
      }
    }
  }

  function probePetExists(): boolean {
    // tasklist 可枚举提权进程；输出按映像名匹配，不受本地化影响
    try {
      const r = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${opts.exeName}`, '/NH'], { windowsHide: true, encoding: 'utf8' })
      return r.stdout.includes(opts.exeName)
    } catch { return false }
  }

  function probeElevation(cb: (state: 'elevated' | 'not-elevated' | 'missing') => void): void {
    try {
      const probe = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', opts.helperPath, '-ExeName', opts.exeName, '-CheckElevation'
      ], { windowsHide: true })
      let out = ''
      probe.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
      probe.on('error', () => cb('missing'))
      probe.on('close', () => {
        const s = out.trim()
        cb(s === 'elevated' || s === 'not-elevated' ? s : 'missing')
      })
    } catch { cb('missing') }
  }

  function startHelper(): void {
    if (stopped || starting) return
    starting = true
    lastProbeAt = Date.now()
    connectedSince = 0   // 任何重启都会打断稳定连接窗口，配额归零计时重新开始
    if (child) { try { child.kill() } catch { /* 已退出 */ } child = null }
    if (!probePetExists()) {
      starting = false
      mode = 'missing'
      helperRunning = false
      connected = false
      return
    }
    probeElevation(state => {
      starting = false
      if (stopped) return
      if (state === 'missing') { mode = 'missing'; helperRunning = false; connected = false; return }
      // 清理上次运行残留（未送达的 cmd.json / 旧事件）
      try { fs.rmSync(cmdPath, { force: true }) } catch { /* 忽略 */ }
      try { fs.writeFileSync(eventsPath, '') } catch { /* 目录不存在时忽略 */ }
      offset = 0
      pending.length = 0
      helperStartAt = Date.now()
      connected = false
      helperRunning = true
      if (state === 'elevated') {
        mode = 'elevated'
        uacPrompts++
        const inner = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${opts.helperPath}" -ExeName "${opts.exeName}"`
        const command = `Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList ${psSingleQuote(inner)} -Verb RunAs -WindowStyle Hidden`
        const wrapper = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, stdio: 'ignore' })
        wrapper.on('exit', () => { if (child === wrapper) child = null })
        child = wrapper
      } else {
        mode = 'direct'
        const c = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', opts.helperPath, '-ExeName', opts.exeName
        ], { detached: true, stdio: 'ignore', windowsHide: true })
        c.on('exit', () => {
          if (child !== c) return
          child = null
          connected = false
          connectedSince = 0
          helperRunning = false
          if (!stopped && restarts < 3) { restarts++; startHelper() }
        })
        child = c
      }
    })
  }

  // Task 11 minor①：原子写（temp+rename）；仅当 cmd.json 不存在时才写入（助手读取后删除，避免覆盖未消费命令）
  function flushOnce(): void {
    if (pending.length === 0) return
    try {
      if (fs.existsSync(cmdPath)) return
      const tmp = cmdPath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(pending[0]))
      fs.renameSync(tmp, cmdPath)
      pending.shift()
    } catch { /* 助手未运行时静默 */ }
  }

  function sendCmd(cmd: Record<string, unknown>): void {
    pending.push(cmd)
    flushOnce()   // 立即尝试送达（stop 时保证 shutdown 在退出前落盘）
    if (pending.length > 0 && !flushTimer) {
      flushTimer = setInterval(() => {
        flushOnce()
        if (pending.length === 0) { clearInterval(flushTimer!); flushTimer = null }
      }, 80)
    }
  }

  let mapping: Record<string, string> = {}

  function sendCombo(name: string): void {
    const combo = comboFor(mapping, name)
    if (combo) {
      lastKeys = { mods: combo.mods, key: combo.key }
      keysRetried = false
      sendCmd({ cmd: 'keys', mods: combo.mods, key: combo.key })
    }
  }

  const coordinator: PetCoordinator = {
    start(): void {
      stopped = false
      startHelper()
      pollTimer = setInterval(() => {
        try {
          const size = fs.statSync(eventsPath).size
          if (size < offset) offset = 0
          if (size > offset) {
            const fd = fs.openSync(eventsPath, 'r')
            const buf = Buffer.alloc(size - offset)
            fs.readSync(fd, buf, 0, buf.length, offset)
            fs.closeSync(fd)
            offset = size
            for (const line of buf.toString('utf8').split('\n')) {
              if (!line.trim()) continue
              try { appendEvent(JSON.parse(line) as PetEvent) } catch { /* 半行或坏行忽略 */ }
            }
          }
        } catch { /* 事件文件暂不存在 */ }
      }, 300)
      heartbeat = setInterval(() => {
        if (mode === 'missing') {
          // 桌宠未运行时每 30s 重探（用户稍后启动桌宠也能自动接入）
          if (Date.now() - lastProbeAt > 30000) startHelper()
          return
        }
        // 提权模式：UAC 确认期间包装进程存活，等待用户点"是"，避免重复弹窗
        if (mode === 'elevated' && child) return
        // 稳定连接超过 60s 才归零配额：ready 瞬间归零会让崩溃-重连循环绕过重启上限
        if (connected && connectedSince > 0 && Date.now() - connectedSince > 60000) {
          restarts = 0
          uacPrompts = 0
        }
        if ((!connected && Date.now() - helperStartAt > 15000) || (connected && Date.now() - lastPong > 15000)) {
          if (mode === 'elevated' && uacPrompts >= 2) { helperRunning = false; return } // 避免反复弹 UAC
          if (restarts >= 3) {
            // 直启侧同等级护栏：配额耗尽后放弃，不再无限重拉
            helperRunning = false
            connected = false
            connectedSince = 0
            if (child) { try { child.kill() } catch { /* 已退出 */ } child = null }
            return
          }
          restarts++
          startHelper()
        } else {
          sendCmd({ cmd: 'ping' })
        }
      }, 5000)
    },
    stop(): void {
      if (stopped) return
      stopped = true
      sendCmd({ cmd: 'shutdown' })   // 内含 flushOnce：cmd.json 空闲时立即落盘
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeat) clearInterval(heartbeat)
      pollTimer = null
      heartbeat = null
      if (child) { try { child.kill() } catch { /* 已退出 */ } child = null }
      if (pending.length === 0) {
        if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
        return
      }
      // 等命令送达（提权助手只能靠 shutdown 命令退出）；超时清理残留避免下次启动误读
      const deadline = Date.now() + 1500
      const drain = setInterval(() => {
        flushOnce()
        if (pending.length === 0 || Date.now() > deadline) {
          clearInterval(drain)
          if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
          if (pending.length > 0) { try { fs.rmSync(cmdPath, { force: true }) } catch { /* 忽略 */ } }
          pending.length = 0
        }
      }, 80)
    },
    onPetClick(cb: () => void): void { clickHandlers.add(cb) },
    bubble(on: boolean): void { sendCombo(on ? 'bubble_on' : 'bubble_off') },
    emotion(e: Emotion | null): void {
      if (e === null) {
        if (lastEmotion !== null) sendCombo('default')
        lastEmotion = null
        return
      }
      if (e === lastEmotion) return
      if (lastEmotion !== null) sendCombo(lastEmotion)   // 先关旧表情（开关式切换）
      sendCombo(e)
      lastEmotion = e
    },
    status(): PetStatus { return { helperRunning, connected, petWindowFound } }
  }

  // 扩展注入（供 index.ts 使用）：mapping、错误回调、窗口矩形（window 事件照常解析存储，未来可用）
  ;(coordinator as PetCoordinator & { setMapping(m: Record<string, string>): void }).setMapping = (m: Record<string, string>) => { mapping = m }
  ;(coordinator as PetCoordinator & { getWindowRect(): Rect | null }).getWindowRect = () => windowRect
  ;(coordinator as PetCoordinator & { onWindow(cb: (r: Rect | null) => void): void }).onWindow = (cb) => { windowHandlers.add(cb) }
  ;(coordinator as PetCoordinator & { onError(cb: (msg: string) => void): void }).onError = (cb) => { errorHandlers.add(cb) }

  return coordinator
}
