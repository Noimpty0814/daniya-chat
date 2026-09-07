const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const W = 256, H = 256
function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([t, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const px = Buffer.alloc(W * H * 4)
const R = 56
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const inSquare = x >= 6 && x < W - 6 && y >= 6 && y < H - 6
    const cx = x < 6 + R ? 6 + R : x > W - 6 - R ? W - 6 - R : x
    const cy = y < 6 + R ? 6 + R : y > H - 6 - R ? H - 6 - R : y
    const dx = x - cx, dy = y - cy
    const inside = inSquare && (dx * dx + dy * dy <= R * R || (x >= 6 + R && x < W - 6 - R) || (y >= 6 + R && y < H - 6 - R))
    if (!inside) continue
    px[i] = 139; px[i + 1] = 92; px[i + 2] = 246; px[i + 3] = 255
    // 白色对话气泡三点（聊天符号）
    for (const [bx, by] of [[88, 118], [128, 118], [168, 118]]) {
      const ddx = x - bx, ddy = y - by
      if (ddx * ddx + ddy * ddy <= 18 * 18) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255 }
    }
    // 尾巴
    if (x >= 100 && x <= 156 && y >= 142 && y <= 152 && x - 100 <= (152 - y) * 2.5 && x - 100 >= (152 - y) * 1.2) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255 }
  }
}

const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4) }
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
])
const out = path.join(__dirname, '..', 'resources', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('icon.png written:', png.length, 'bytes ->', out)
