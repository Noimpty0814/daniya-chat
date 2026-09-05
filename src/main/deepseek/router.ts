import type { ChatTurn } from './client'

export function pickModel(textModel: string, visionModel: string, turns: ChatTurn[]): string {
  return turns.some(t => t.images && t.images.length > 0) ? visionModel : textModel
}
