#!/usr/bin/env node
// Generate CounterStrafe extension icons — dark background + white CS crosshair.
// Run: node generate-icons.js  (no external deps)

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function uint32BE(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

let _crcTable = null
function makeCrcTable() {
  if (_crcTable) return _crcTable
  _crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    _crcTable[n] = c
  }
  return _crcTable
}
function crc32(buf) {
  const table = makeCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  return Buffer.concat([uint32BE(data.length), t, data, uint32BE(crc32(Buffer.concat([t, data])))])
}

/**
 * Build a PNG from a pixel callback: fn(x, y) → [r, g, b, a]
 */
function buildPng(size, pixelFn) {
  const scanline = 1 + size * 4
  const raw = Buffer.alloc(size * scanline)
  for (let y = 0; y < size; y++) {
    raw[y * scanline] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const off = y * scanline + 1 + x * 4
      raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a
    }
  }
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = pngChunk('IHDR', Buffer.concat([uint32BE(size), uint32BE(size), Buffer.from([8, 6, 0, 0, 0])]))
  const idat = pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 }))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, idat, iend])
}

/**
 * Icon design:
 *  - Dark navy background (#0d1117) with rounded corners
 *  - Blue accent ring/glow
 *  - White CS-style crosshair (4 bars with center gap)
 *  - Blue (#3b82f6) center dot
 */
function makeIcon(size) {
  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.46        // rounded corner outer radius
  const barW  = Math.max(2, Math.round(size * 0.09))   // crosshair bar thickness
  const barLen = Math.round(size * 0.22)                // bar length (from gap to edge)
  const gap    = Math.round(size * 0.10)                // gap from center

  // Background color
  const BG = [13, 17, 23]          // #0d1117
  const FG = [248, 250, 252]       // #f8fafc  (crosshair bars)
  const AC = [59, 130, 246]        // #3b82f6  (center dot + accent)

  return buildPng(size, (x, y) => {
    const dx = x - cx + 0.5
    const dy = y - cy + 0.5
    const dist = Math.sqrt(dx*dx + dy*dy)

    // Outside rounded square → transparent
    const rx = Math.abs(dx)
    const ry = Math.abs(dy)
    const cornerR = size * 0.18
    const halfS = size * 0.46
    if (rx > halfS || ry > halfS) return [0,0,0,0]
    if (rx > halfS - cornerR && ry > halfS - cornerR) {
      const cdx = rx - (halfS - cornerR)
      const cdy = ry - (halfS - cornerR)
      if (Math.sqrt(cdx*cdx + cdy*cdy) > cornerR) return [0,0,0,0]
    }

    // Center blue dot
    const dotR = size * 0.07
    if (dist <= dotR) return [...AC, 255]

    // Crosshair bars
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    const half = barW / 2

    // Horizontal bar
    if (ay <= half && ax >= gap && ax <= gap + barLen) return [...FG, 255]
    // Vertical bar
    if (ax <= half && ay >= gap && ay <= gap + barLen) return [...FG, 255]

    // Subtle inner ring (accent glow at 38% of size)
    const ringR = size * 0.38
    const ringW = Math.max(1, size * 0.025)
    if (dist >= ringR - ringW && dist <= ringR) {
      return [...AC, 40]  // very faint
    }

    // Background
    return [...BG, 255]
  })
}

const sizes = [16, 48, 128]
for (const size of sizes) {
  const outPath = path.join(__dirname, `icon${size}.png`)
  fs.writeFileSync(outPath, makeIcon(size))
  console.log(`✓ icon${size}.png`)
}
console.log('Done.')
