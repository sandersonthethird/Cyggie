#!/usr/bin/env node
// Compiles the macOS Swift helper(s) that Cyggie spawns at runtime.
//
//   native/meeting-audio-watch/meeting-audio-watch.swift
//     → native/meeting-audio-watch/meeting-audio-watch   (host arch, for dev)
//     → … universal (arm64 + x86_64) when run with --universal (for packaging)
//
// macOS-only and a no-op elsewhere, so it's safe in cross-platform installs.
// The compiled binary is git-ignored; it's rebuilt by `predev` and before
// packaging, and bundled into the app via electron-builder extraResources.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const universal = process.argv.includes('--universal')

const HELPERS = [
  {
    src: 'native/meeting-audio-watch/meeting-audio-watch.swift',
    out: 'native/meeting-audio-watch/meeting-audio-watch'
  }
]

if (process.platform !== 'darwin') {
  console.log('[build-native-helper] not macOS — skipping')
  process.exit(0)
}

const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf-8' })
if (swiftc.status !== 0) {
  console.warn('[build-native-helper] swiftc not found (install Xcode CLT) — skipping')
  process.exit(0)
}

function compile(src, out, extraArgs) {
  const args = ['-O', ...extraArgs, resolve(root, src), '-o', resolve(root, out)]
  const r = spawnSync('swiftc', args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`swiftc failed for ${src}`)
}

for (const { src, out } of HELPERS) {
  mkdirSync(dirname(resolve(root, out)), { recursive: true })
  if (universal) {
    const arm = `${out}.arm64`
    const x64 = `${out}.x86_64`
    compile(src, arm, ['-target', 'arm64-apple-macos11'])
    compile(src, x64, ['-target', 'x86_64-apple-macos11'])
    const lipo = spawnSync(
      'lipo',
      ['-create', resolve(root, arm), resolve(root, x64), '-output', resolve(root, out)],
      { stdio: 'inherit' }
    )
    if (lipo.status !== 0) throw new Error('lipo failed')
  } else {
    compile(src, out, [])
  }
  if (!existsSync(resolve(root, out))) throw new Error(`expected output missing: ${out}`)
  console.log(`[build-native-helper] built ${out}${universal ? ' (universal)' : ''}`)
}
