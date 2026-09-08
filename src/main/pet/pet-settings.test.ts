import { describe, it, expect } from 'vitest'
import { petConfigChanged } from './pet-settings'
import type { PetSettings } from '../../shared/types'

const base: PetSettings = { enabled: true, exePath: 'C:/pet/pet.exe', exeName: 'pet.exe' }

describe('petConfigChanged（I2：仅 enabled/exePath/exeName 变化才需重建协调器）', () => {
  it('prev 为 null → true（首次必然重建）', () => {
    expect(petConfigChanged(null, base)).toBe(true)
  })
  it('三个字段全相同 → false', () => {
    expect(petConfigChanged(base, { ...base })).toBe(false)
  })
  it('enabled 变化 → true', () => {
    expect(petConfigChanged(base, { ...base, enabled: false })).toBe(true)
  })
  it('exePath 变化 → true', () => {
    expect(petConfigChanged(base, { ...base, exePath: 'D:/other/pet.exe' })).toBe(true)
  })
  it('exeName 变化 → true', () => {
    expect(petConfigChanged(base, { ...base, exeName: 'other.exe' })).toBe(true)
  })
})
