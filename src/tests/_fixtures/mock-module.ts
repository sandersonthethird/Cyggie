import { vi } from 'vitest'

/**
 * Build a module mock that returns a `vi.fn()` stub for ANY named export, so a
 * `vi.mock()` of an owned repository satisfies the repository **barrel**'s
 * re-exports without the test having to enumerate every function name.
 *
 * Why a Proxy and not `() => ({ ...explicit })` or `importOriginal()` keys:
 *  - The barrel (`repositories/index.ts`) re-exports each repo's owned writes
 *    (`export const createX = rawRepo.createX`). Vitest validates every
 *    re-exported name against the mock, so a partial object mock throws
 *    "No <name> export is defined on the mock".
 *  - Some barrel re-exports reference names that aren't real exports of the
 *    underlying repo (they resolve to `undefined` even in production), so
 *    enumerating the real module's keys via `importOriginal()` still misses
 *    them. The Proxy covers every possible name.
 *
 * Traps:
 *  - `has` → true for string keys so vitest's named-import validation passes.
 *  - `get` → an explicit override if provided, else a memoized `vi.fn()`.
 *    Returns `undefined` for `then` (so the module namespace isn't mistaken for
 *    a thenable and awaited forever — that bug hung the whole suite),
 *    `__esModule`, and any symbol key.
 *
 * Pass explicit overrides for the functions the test actually exercises; every
 * other name auto-resolves to a no-op `vi.fn()`.
 */
export function stubModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cache = new Map<string, unknown>()
  const passthrough = (prop: string | symbol): boolean =>
    prop === 'then' || prop === '__esModule' || typeof prop === 'symbol'

  return new Proxy(overrides, {
    has(_target, prop) {
      return passthrough(prop) ? false : true
    },
    get(target, prop) {
      if (passthrough(prop)) return undefined
      if (prop in target) return target[prop as string]
      if (!cache.has(prop as string)) cache.set(prop as string, vi.fn())
      return cache.get(prop as string)
    },
  }) as Record<string, unknown>
}
