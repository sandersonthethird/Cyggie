#!/usr/bin/env node
// Wrapper for `electron-vite dev` that filters macOS Core Text spam from
// stderr ("Ran out of space in font private use area"). It's an Apple bug
// on Sequoia (see electron/electron#45462) — harmless, but floods the
// terminal so badly that real log output scrolls off-screen.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const NOISE = [/Ran out of space in font private use area/]

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: ['inherit', 'inherit', 'pipe'],
  env: process.env,
})

const rl = createInterface({ input: child.stderr })
rl.on('line', (line) => {
  if (NOISE.some((re) => re.test(line))) return
  process.stderr.write(line + '\n')
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig))
}
