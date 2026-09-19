import type { Emotion } from '../harness/emotion'
import type { PetStatus } from '../../shared/types'

export interface PetCoordinator {
  start(): void
  stop(): void
  onPetClick(cb: () => void): void
  bubble(on: boolean): void
  emotion(e: Emotion | null): void
  status(): PetStatus
}

export function createNullPet(): PetCoordinator {
  return {
    start() {}, stop() {},
    onPetClick() {},
    bubble() {}, emotion() {},
    status() { return { helperRunning: false, connected: false, petWindowFound: false } }
  }
}
