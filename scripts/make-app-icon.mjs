// Bakes the macOS app-icon shape into the Cyggie icon.
//
// macOS does NOT auto-round app icons (unlike iOS) — neither the packaged
// .icns nor app.dock.setIcon() applies a mask. So the rounded "squircle"
// shape and the transparent margin that make the icon sit at the same visual
// size as its dock neighbors must be baked into the PNG.
//
// Apple's icon grid (1024px canvas):
//   body 824x824, centered (100px margin), corner radius ~185.4
//
// Source: mobile/assets/icon.png (pristine full-bleed artwork)
// Outputs: build/icon.png  (used by app.dock.setIcon in src/main/index.ts)
//          build/icon.icns (used by electron-builder for the packaged .app)
//
// Run from the repo root:  node scripts/make-app-icon.mjs

import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'mobile/assets/icon.png')
const OUT_PNG = join(root, 'build/icon.png')
const OUT_ICNS = join(root, 'build/icon.icns')

const CANVAS = 1024
const BODY = 824
const RADIUS = 185.4
const MARGIN = (CANVAS - BODY) / 2

// Rounded-rectangle mask at body size; dest-in keeps only the inside.
const mask = Buffer.from(
  `<svg width="${BODY}" height="${BODY}"><rect width="${BODY}" height="${BODY}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`
)

const body = await sharp(SRC)
  .resize(BODY, BODY, { fit: 'cover' })
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer()

// 1024 rounded icon on a transparent canvas (the master we derive everything from).
const master = await sharp({
  create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
})
  .composite([{ input: body, left: MARGIN, top: MARGIN }])
  .png()
  .toBuffer()

await sharp(master).toFile(OUT_PNG)
console.log('wrote', OUT_PNG)

// Build the .icns from the master via an .iconset + iconutil.
const iconset = mkdtempSync(join(tmpdir(), 'cyggie-icon-')) + '.iconset'
execFileSync('mkdir', ['-p', iconset])
const sizes = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
]
for (const [name, px] of sizes) {
  writeFileSync(join(iconset, name), await sharp(master).resize(px, px).png().toBuffer())
}
execFileSync('iconutil', ['--convert', 'icns', '--output', OUT_ICNS, iconset])
rmSync(iconset, { recursive: true, force: true })
console.log('wrote', OUT_ICNS)
