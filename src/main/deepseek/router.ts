// ChatTurn 正式类型由 Task 6 在 client.ts 定义；此处用最小结构，任务 6 后改为
// import type { ChatTurn } from './client' 并使用 ChatTurn[]（签名不变，测试不受影响）
export interface TurnLike { images?: string[] }

export function pickModel(textModel: string, visionModel: string, turns: TurnLike[]): string {
  return turns.some(t => t.images && t.images.length > 0) ? visionModel : textModel
}
