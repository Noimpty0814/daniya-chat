import type { PetSettings } from '../../shared/types'

export function petConfigChanged(prev: PetSettings | null, next: PetSettings): boolean {
  if (!prev) return true
  return prev.enabled !== next.enabled || prev.exePath !== next.exePath || prev.exeName !== next.exeName
}
