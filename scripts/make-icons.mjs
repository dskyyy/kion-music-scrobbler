// Builds 1:1 extension icons from a source image. Cross-platform (Node + sharp).
// Usage: node scripts/make-icons.mjs [assets/icon-source.png]
// The white note is centered via its bounding box before the square crop.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const WHITE_THRESHOLD = 225
const BORDER_COLOR = '#eab308'
const SIZES = [16, 32, 48, 128]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, process.argv[2] ?? 'assets/icon-source.png')
const outDir = path.join(root, 'public')

const meta = await sharp(source).metadata()
const w = meta.width ?? 0
const h = meta.height ?? 0
if (!w || !h) {
  throw new Error(`Cannot read image size: ${source}`)
}

const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true })
const channels = info.channels

let minX = w
let minY = h
let maxX = -1
let maxY = -1
for (let y = 0; y < h; y += 2) {
  for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * channels
    if (
      data[i] > WHITE_THRESHOLD &&
      data[i + 1] > WHITE_THRESHOLD &&
      data[i + 2] > WHITE_THRESHOLD
    ) {
      if (x < minX) {
        minX = x
      }
      if (y < minY) {
        minY = y
      }
      if (x > maxX) {
        maxX = x
      }
      if (y > maxY) {
        maxY = y
      }
    }
  }
}

const side = Math.min(w, h)
const half = side / 2
let cx = w / 2
let cy = h / 2
if (maxX >= 0) {
  cx = (minX + maxX) / 2
  cy = (minY + maxY) / 2
}
// Clamp so the square crop stays inside the image.
cx = Math.min(Math.max(cx, half), w - half)
cy = Math.min(Math.max(cy, half), h - half)
const crop = {
  left: Math.round(cx - half),
  top: Math.round(cy - half),
  width: side,
  height: side,
}

for (const size of SIZES) {
  for (const variant of ['icon', 'icon-offline']) {
    let pipeline = sharp(source).extract(crop).resize(size, size)
    if (variant === 'icon-offline') {
      const bw = Math.max(2, Math.round(size / 8))
      const border = Buffer.from(
        `<svg width="${size}" height="${size}">` +
          `<rect x="${bw / 2}" y="${bw / 2}" width="${size - bw}" height="${size - bw}" ` +
          `fill="none" stroke="${BORDER_COLOR}" stroke-width="${bw}"/></svg>`,
      )
      pipeline = pipeline.composite([{ input: border }])
    }
    const out = path.join(outDir, `${variant}-${size}.png`)
    await pipeline.png().toFile(out)
    console.log(out)
  }
}
