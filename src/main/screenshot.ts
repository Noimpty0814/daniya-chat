import { desktopCapturer, screen } from 'electron'

export async function capturePrimaryScreen(): Promise<string> {
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: primary.size.width, height: primary.size.height }
  })
  const source = sources.find(s => s.display_id === String(primary.id)) ?? sources[0]
  if (!source) throw new Error('未找到屏幕源')
  const image = source.thumbnail
  if (image.isEmpty()) throw new Error('截屏失败：图像为空')
  let dataUrl = image.toDataURL()
  if (dataUrl.length > 12_000_000) {
    const resized = image.resize({ width: 1920 })
    dataUrl = resized.toDataURL()
  }
  return dataUrl
}
