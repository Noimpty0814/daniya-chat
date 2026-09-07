import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

describe('gen-icon', () => {
  it('生成合法 256x256 PNG（签名/IHDR/IDAT 可解压）', () => {
    const script = path.join(__dirname, 'gen-icon.js')
    execFileSync(process.execPath, [script])
    const file = path.join(__dirname, '..', 'resources', 'icon.png')
    const buf = fs.readFileSync(file)
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    expect(buf.readUInt32BE(16)).toBe(256)
    expect(buf.readUInt32BE(20)).toBe(256)
    const idat = buf.subarray(41, buf.length - 12)
    const inflated = zlib.inflateSync(idat)
    expect(inflated.length).toBe(256 * (256 * 4 + 1))
    const r = inflated[1 + 40 * (256 * 4 + 1) + 40 * 4]
    const g = inflated[1 + 40 * (256 * 4 + 1) + 40 * 4 + 1]
    expect([r, g]).toEqual([139, 92])   // (40,40) 位于紫色圆角方块上（简报原取 (128,128)，该点落在白色气泡圆点内，实测为 255,255，属简报自带缺陷，已修正取样点）
  })
})
