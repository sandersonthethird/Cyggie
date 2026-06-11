/**
 * Guard: every IPC handler-registration function imported into the main IPC
 * barrel must actually be CALLED inside registerAllHandlers().
 *
 * This catches the class of bug where a new register*Handlers() is imported
 * but the call site is forgotten — the handler silently never registers and
 * the renderer's invoke() fails with "No handler registered" (e.g. the
 * CHAT_QUERY_ENTITIES regression). tsc doesn't flag it because the import
 * still counts as used by the import statement itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(resolve(__dirname, '../main/ipc/index.ts'), 'utf8')

describe('main IPC barrel — every imported handler is registered', () => {
  // Collect every `register*Handlers` / `register*Ipc` symbol imported.
  const imported = [...indexSrc.matchAll(/import\s+\{\s*(register\w+)\s*\}/g)].map((m) => m[1])

  it('imports at least the known chat handlers (sanity)', () => {
    expect(imported).toContain('registerEntitiesChatHandlers')
    expect(imported).toContain('registerChatSessionHandlers')
  })

  it.each(imported)('%s is invoked in registerAllHandlers()', (fn) => {
    // The call appears as `fn(` somewhere after its import (i.e. in the body).
    const callRe = new RegExp(`\\b${fn}\\s*\\(`)
    expect(callRe.test(indexSrc), `${fn} is imported but never called`).toBe(true)
  })
})
