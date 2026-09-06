export const DEFAULT_EMOTION_KEYS: Record<string, string> = {
  default: 'D', bubble_on: '0', bubble_off: '-',
  happy: 'I', sad: 'O', sleepy: 'P', dismissive: 'U', shy: 'Y', blush: 'Y', angry: '1', dark: '1'
}

const VK: Record<string, number> = {}
for (let i = 65; i <= 90; i++) VK[String.fromCharCode(i)] = i           // A-Z
for (let i = 0; i <= 9; i++) VK[String(i)] = 48 + i                     // 0-9
VK['-'] = 189; VK['='] = 187; VK['['] = 219; VK[']'] = 221

export const VK_MENU = 18 // Alt

export function comboFor(mapping: Record<string, string>, name: string): { mods: number[]; key: number } | null {
  const letter = mapping[name]
  if (!letter) return null
  const vk = VK[letter.toUpperCase()]
  if (!vk) return null
  return { mods: [VK_MENU], key: vk }
}

export const EMOTION_LABELS: Record<string, string> = {
  happy: '开心-彩虹脸', sad: '难过-哭泣脸', sleepy: '困倦-瞌睡脸', dismissive: '不屑-不屑脸',
  shy: '害羞-鼻血脸', blush: '脸红-鼻血脸', angry: '生气-黑化', dark: '黑化-黑化',
  default: '默认表情', bubble_on: '等待中泡泡', bubble_off: '泡泡消失'
}
