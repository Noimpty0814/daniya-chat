import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PetCoordinator } from './coordinator'

// 纯逻辑测试：mock 掉 child_process（spawn/spawnSync），用假临时目录与假事件流驱动
const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: h.spawn, spawnSync: h.spawnSync }))

import { createPipePet } from './pipe-pet'
import { DEFAULT_EMOTION_KEYS } from './keys'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  kill = vi.fn()
}

type Rect = { x: number; y: number; w: number; h: number }
type PipePetExt = PetCoordinator & {
  setMapping(m: Record<string, string>): void
  onWindow(cb: (r: Rect | null) => void): void
  onError(cb: (msg: string) => void): void
}

const EXE = 'Bongo Cat Mver.exe'
const HELPER = 'C:/fake/pet-helper.ps1'
const dirs: string[] = []
const pets: PetCoordinator[] = []

function setup(): PipePetExt {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daniya-pet-test-'))
  dirs.push(dir)
  const pet = createPipePet({ exeName: EXE, helperPath: HELPER, dir }) as PipePetExt
  pet.setMapping({ ...DEFAULT_EMOTION_KEYS })
  pets.push(pet)
  return pet
}

function petExists(stdout = `${EXE}          1234 Console  1  100 K`): void {
  h.spawnSync.mockReturnValue({ stdout, status: 0 } as ReturnType<typeof h.spawnSync>)
}

/** 把最近一次 spawn（探针）解析为指定提权状态 */
function resolveProbe(state: 'missing' | 'elevated' | 'not-elevated'): void {
  const probe = h.spawn.mock.results.at(-1)!.value as FakeChild
  probe.stdout.write(state)
  probe.emit('close', 0)
}

async function stopPet(pet: PetCoordinator): Promise<void> {
  pet.stop()
  await vi.advanceTimersByTimeAsync(2000)   // 排空 shutdown 送达与清理定时器
}

beforeEach(() => {
  h.spawn.mockReset()
  h.spawnSync.mockReset()
  h.spawn.mockImplementation(() => new FakeChild())
  h.spawnSync.mockReturnValue({ stdout: '', status: 0 } as ReturnType<typeof h.spawnSync>)
  vi.useFakeTimers()
})

afterEach(() => {
  for (const pet of pets) pet.stop()
  pets.length = 0
  vi.useRealTimers()
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('createPipePet 启动模式（R27）', () => {
  it('桌宠进程不存在时不启动助手（解耦：一切照常）', async () => {
    const pet = setup()
    pet.start()
    expect(h.spawn).not.toHaveBeenCalled()
    expect(pet.status()).toEqual({ helperRunning: false, connected: false, petWindowFound: false })
    await stopPet(pet)
  })

  it('桌宠非管理员：直接 spawn 普通 powershell（detached+stdio ignore，先探测再启动）', async () => {
    petExists()
    const pet = setup()
    pet.start()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.spawn.mock.calls[0][1]).toContain('-CheckElevation')
    resolveProbe('not-elevated')
    expect(h.spawn).toHaveBeenCalledTimes(2)
    const [cmd, args, opts] = h.spawn.mock.calls[1]
    expect(cmd).toBe('powershell.exe')
    expect(args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER, '-ExeName', EXE])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })
    expect(pet.status()).toEqual({ helperRunning: true, connected: false, petWindowFound: false })
    await stopPet(pet)
  })

  it('桌宠为管理员：PowerShell Start-Process -Verb RunAs 触发 UAC', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('elevated')
    expect(h.spawn).toHaveBeenCalledTimes(2)
    const [cmd, args] = h.spawn.mock.calls[1]
    expect(cmd).toBe('powershell.exe')
    const command = String(args[2])
    expect(command).toContain('Start-Process')
    expect(command).toContain('-Verb RunAs')
    expect(command).toContain(EXE)
    // 包装进程退出（UAC 已触发/助手已拉起）不影响 helperRunning 判定
    const wrapper = h.spawn.mock.results[1].value as FakeChild
    wrapper.emit('exit', 0)
    expect(pet.status().helperRunning).toBe(true)
    await stopPet(pet)
  })

  it('elevated：UAC 确认期间（wrapper 存活）心跳不重复弹窗', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('elevated')
    expect(h.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20000)   // 心跳 5/10/15/20s：wrapper 存活 → 等待用户点"是"，不重启
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(pet.status()).toEqual({ helperRunning: true, connected: false, petWindowFound: false })
    await stopPet(pet)
  })

  it('elevated：wrapper 退出且长期未连接时最多再探一次，仍失败则放弃（不再弹 UAC）', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('elevated')
    const wrapper = h.spawn.mock.results[1].value as FakeChild
    wrapper.emit('exit', 0)                    // UAC 已确认、助手已拉起（wrapper 使命结束）
    await vi.advanceTimersByTimeAsync(20000)   // 15s 心跳：未连接 >15s → 重探（uacPrompts=2）
    expect(h.spawn).toHaveBeenCalledTimes(3)   // 新探针
    resolveProbe('elevated')
    expect(h.spawn).toHaveBeenCalledTimes(4)   // 第二次 wrapper
    const wrapper2 = h.spawn.mock.results[3].value as FakeChild
    wrapper2.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(21000)   // 40s 心跳：未连接 >15s 且 uacPrompts≥2 → 放弃
    expect(h.spawn).toHaveBeenCalledTimes(4)
    expect(pet.status().helperRunning).toBe(false)
    await stopPet(pet)
  })

  it('直接模式助手连续退出最多重启 3 次', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    for (let i = 0; i < 4; i++) {
      const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
      direct.emit('exit', 0)
      if (i < 3) resolveProbe('not-elevated')
    }
    // 初始 probe+direct 各 1 次，3 次重启各 probe+direct → 共 8 次；第 4 次退出不再重启
    expect(h.spawn).toHaveBeenCalledTimes(8)
    await stopPet(pet)
  })
})

describe('重启配额上限（Important 修复：心跳重启计入配额，稳定连接 60s 后才归零）', () => {
  it('心跳超时重启计入配额：直启一直未连接最多重启 3 次后放弃（不再无限重拉）', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')          // t=0：初始 probe+direct（初始启动不计配额）
    expect(h.spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20000)   // t=20s 心跳：未连接 >15s → 重启 1（restarts=1）
    expect(h.spawn).toHaveBeenCalledTimes(3)   // 新探针
    resolveProbe('not-elevated')
    expect(h.spawn).toHaveBeenCalledTimes(4)   // 新助手
    await vi.advanceTimersByTimeAsync(20000)   // t=40s → 重启 2（restarts=2）
    expect(h.spawn).toHaveBeenCalledTimes(5)
    resolveProbe('not-elevated')
    expect(h.spawn).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(20000)   // t=60s → 重启 3（restarts=3，配额耗尽）
    expect(h.spawn).toHaveBeenCalledTimes(7)
    resolveProbe('not-elevated')
    expect(h.spawn).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(20000)   // t=80s：配额耗尽 → 放弃，不再 spawn
    expect(h.spawn).toHaveBeenCalledTimes(8)
    expect(pet.status()).toEqual({ helperRunning: false, connected: false, petWindowFound: false })
    await stopPet(pet)
  })

  it('ready 后立即崩溃不重置配额：崩溃-重连循环最多重启 3 次', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    const events = path.join(dirs[0], 'events.jsonl')
    for (let i = 0; i < 4; i++) {
      fs.appendFileSync(events, '{"type":"ready"}\n')
      await vi.advanceTimersByTimeAsync(350)   // poll 读到 ready（connected）
      const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
      direct.emit('exit', 0)                   // 连接后立即崩溃
      if (i < 3) resolveProbe('not-elevated')  // restarts=1,2,3
    }
    // 初始 probe+direct 2 次 + 3 次重启各 probe+direct → 共 8 次；第 4 次崩溃不再重启
    expect(h.spawn).toHaveBeenCalledTimes(8)
    await stopPet(pet)
  })

  it('配额耗尽后短暂连接（<60s）不重置配额，再次崩溃不再重启', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    for (let i = 0; i < 3; i++) {              // 连续 3 次崩溃耗尽配额（restarts=3）
      const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
      direct.emit('exit', 0)
      resolveProbe('not-elevated')
    }
    expect(h.spawn).toHaveBeenCalledTimes(8)
    const events = path.join(dirs[0], 'events.jsonl')
    fs.appendFileSync(events, '{"type":"ready"}\n')
    await vi.advanceTimersByTimeAsync(350)
    for (let i = 0; i < 3; i++) {              // 保持连接 30s（<60s 稳定窗口），pong 防心跳误杀
      fs.appendFileSync(events, '{"type":"pong"}\n')
      await vi.advanceTimersByTimeAsync(10000)
    }
    const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
    direct.emit('exit', 0)                     // 崩溃：配额未归零 → 不再重启
    expect(h.spawn).toHaveBeenCalledTimes(8)
    expect(pet.status().helperRunning).toBe(false)
    await stopPet(pet)
  })

  it('持续稳定连接超过 60s 后配额归零，再次崩溃允许重启', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    for (let i = 0; i < 3; i++) {              // 耗尽配额（restarts=3）
      const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
      direct.emit('exit', 0)
      resolveProbe('not-elevated')
    }
    expect(h.spawn).toHaveBeenCalledTimes(8)
    const events = path.join(dirs[0], 'events.jsonl')
    fs.appendFileSync(events, '{"type":"ready"}\n')
    await vi.advanceTimersByTimeAsync(350)
    for (let i = 0; i < 7; i++) {              // 稳定连接 70s（超过 60s 稳定窗口）
      fs.appendFileSync(events, '{"type":"pong"}\n')
      await vi.advanceTimersByTimeAsync(10000)
    }
    const direct = h.spawn.mock.results.at(-1)!.value as FakeChild
    direct.emit('exit', 0)                     // 崩溃：配额已归零 → 允许重启
    expect(h.spawn).toHaveBeenCalledTimes(9)   // 新探针
    resolveProbe('not-elevated')
    expect(h.spawn).toHaveBeenCalledTimes(10)  // 新助手
    expect(pet.status().helperRunning).toBe(true)
    await stopPet(pet)
  })
})

describe('events.jsonl 增量解析（Task 11 minor②）', () => {
  it('ready/pet-click/window/stopped 触发回调与状态，损坏行跳过不中断', async () => {
    const pet = setup()
    const clickCb = vi.fn()
    const windowCb = vi.fn()
    pet.onPetClick(clickCb)
    pet.onWindow(windowCb)
    pet.start()
    const events = path.join(dirs[0], 'events.jsonl')
    fs.writeFileSync(events, '{"type":"ready"}\nNOT JSON\n{"type":"pet-click","x":1,"y":2}\n{"type":"window","rect":{"x":10,"y":20,"w":30,"h":40}}\n')
    await vi.advanceTimersByTimeAsync(350)
    expect(pet.status()).toEqual({ helperRunning: false, connected: true, petWindowFound: true })
    expect(clickCb).toHaveBeenCalledTimes(1)
    expect(windowCb).toHaveBeenCalledWith({ x: 10, y: 20, w: 30, h: 40 })
    // 半行不解析、增量续读
    fs.appendFileSync(events, '{"type":"window","rect":{"x":5')
    await vi.advanceTimersByTimeAsync(350)
    expect(windowCb).toHaveBeenCalledTimes(1)
    fs.appendFileSync(events, ',"y":6,"w":7,"h":8}}\n{"type":"stopped"}\n')
    await vi.advanceTimersByTimeAsync(350)
    expect(pet.status()).toEqual({ helperRunning: false, connected: false, petWindowFound: false })
    await stopPet(pet)
  })
})

describe('cmd.json 原子写（Task 11 minor①）', () => {
  it('temp+rename 原子写、无 .tmp 残留、命令队列串行送达不覆盖未消费命令', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    const cmdPath = path.join(dirs[0], 'cmd.json')
    pet.emotion('happy')
    await vi.advanceTimersByTimeAsync(90)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 73 })
    expect(fs.existsSync(cmdPath + '.tmp')).toBe(false)
    // cmd.json 尚未被助手取走时，后续命令排队等待而非覆盖
    pet.emotion('sad')
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 73 })
    fs.rmSync(cmdPath)   // 模拟助手消费第一命令
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 73 })   // 队首：关旧表情 happy
    fs.rmSync(cmdPath)
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 79 })   // 随后：开新表情 sad
    await stopPet(pet)
  })
})

describe('R29：pet-window-not-found 错误重试与反馈', () => {
  it('首次失败重发一次 keys，再失败回调 onError（渲染层错误条文案）', async () => {
    petExists()
    const pet = setup()
    const errorCb = vi.fn()
    pet.onError(errorCb)
    pet.start()
    resolveProbe('not-elevated')
    const cmdPath = path.join(dirs[0], 'cmd.json')
    const events = path.join(dirs[0], 'events.jsonl')
    pet.emotion('happy')
    await vi.advanceTimersByTimeAsync(90)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 73 })
    fs.rmSync(cmdPath)
    fs.appendFileSync(events, '{"type":"error","error":"pet-window-not-found"}\n')
    await vi.advanceTimersByTimeAsync(420)
    expect(JSON.parse(fs.readFileSync(cmdPath, 'utf8'))).toEqual({ cmd: 'keys', mods: [18], key: 73 })   // 已重发
    expect(errorCb).not.toHaveBeenCalled()
    fs.rmSync(cmdPath)
    fs.appendFileSync(events, '{"type":"error","error":"pet-window-not-found"}\n')
    await vi.advanceTimersByTimeAsync(420)
    expect(errorCb).toHaveBeenCalledTimes(1)
    expect(errorCb).toHaveBeenCalledWith('桌宠窗口未找到')
    await stopPet(pet)
  })
})

describe('生命周期', () => {
  it('stop 发送 shutdown、杀掉直接模式子进程且幂等', async () => {
    petExists()
    const pet = setup()
    pet.start()
    resolveProbe('not-elevated')
    const direct = h.spawn.mock.results[1].value as FakeChild
    pet.stop()
    expect(direct.kill).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(90)
    expect(JSON.parse(fs.readFileSync(path.join(dirs[0], 'cmd.json'), 'utf8'))).toEqual({ cmd: 'shutdown' })
    pet.stop()   // 幂等，不抛错
    await vi.advanceTimersByTimeAsync(2000)
  })
})
