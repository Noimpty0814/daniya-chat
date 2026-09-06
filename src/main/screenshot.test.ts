import { describe, it, expect, vi, beforeEach } from 'vitest'

// Task 10：desktopCapturer/screen 仅主进程可用，按"单测只测纯编排逻辑"纪律
// mock electron 模块，验证 capturePrimaryScreen 的源选择/回退/空图/降采样/错误契约。
const h = vi.hoisted(() => ({
  getSources: vi.fn(),
  getPrimaryDisplay: vi.fn()
}))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: h.getSources },
  screen: { getPrimaryDisplay: h.getPrimaryDisplay }
}))

import { capturePrimaryScreen } from './screenshot'

interface FakeImage {
  isEmpty: ReturnType<typeof vi.fn>
  toDataURL: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
}

function makeImage(opts: { empty?: boolean; dataUrl?: string; resizedDataUrl?: string } = {}): FakeImage {
  return {
    isEmpty: vi.fn(() => opts.empty ?? false),
    toDataURL: vi.fn(() => opts.dataUrl ?? 'data:image/png;base64,AAAA'),
    resize: vi.fn(() => makeImage({ dataUrl: opts.resizedDataUrl ?? 'data:image/png;base64,RESIZED' }))
  }
}

function primary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, size: { width: 1920, height: 1080 }, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getPrimaryDisplay.mockReturnValue(primary())
})

describe('capturePrimaryScreen', () => {
  it('按主显示器尺寸请求 screen 源，并优先选择 display_id 匹配的源', async () => {
    const other = makeImage({ dataUrl: 'data:image/png;base64,OTHER' })
    const matched = makeImage({ dataUrl: 'data:image/png;base64,MATCHED' })
    h.getSources.mockResolvedValue([
      { display_id: '9', thumbnail: other },
      { display_id: '1', thumbnail: matched }
    ])
    await expect(capturePrimaryScreen()).resolves.toBe('data:image/png;base64,MATCHED')
    expect(h.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    expect(matched.toDataURL).toHaveBeenCalledTimes(1)
    expect(other.toDataURL).not.toHaveBeenCalled()
  })

  it('无 display_id 匹配时回退第一个源', async () => {
    const first = makeImage({ dataUrl: 'data:image/png;base64,FIRST' })
    h.getPrimaryDisplay.mockReturnValue(primary({ id: 42 }))
    h.getSources.mockResolvedValue([
      { display_id: '', thumbnail: first },
      { display_id: '43', thumbnail: makeImage() }
    ])
    await expect(capturePrimaryScreen()).resolves.toBe('data:image/png;base64,FIRST')
  })

  it('无任何屏幕源时抛"未找到屏幕源"', async () => {
    h.getSources.mockResolvedValue([])
    await expect(capturePrimaryScreen()).rejects.toThrow('未找到屏幕源')
  })

  it('缩略图为空时抛"截屏失败：图像为空"', async () => {
    h.getSources.mockResolvedValue([{ display_id: '1', thumbnail: makeImage({ empty: true }) }])
    await expect(capturePrimaryScreen()).rejects.toThrow('截屏失败：图像为空')
  })

  it('dataUrl 超过 12MB 时 resize 到 1920 宽并返回缩放后的 dataUrl', async () => {
    const big = makeImage({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(12_000_000), resizedDataUrl: 'data:image/png;base64,SMALL' })
    h.getSources.mockResolvedValue([{ display_id: '1', thumbnail: big }])
    await expect(capturePrimaryScreen()).resolves.toBe('data:image/png;base64,SMALL')
    expect(big.resize).toHaveBeenCalledWith({ width: 1920 })
  })

  it('getSources 失败时错误向上传播（由 IPC 层转 { ok:false, error }）', async () => {
    h.getSources.mockRejectedValue(new Error('desktopCapturer 失败'))
    await expect(capturePrimaryScreen()).rejects.toThrow('desktopCapturer 失败')
  })
})
