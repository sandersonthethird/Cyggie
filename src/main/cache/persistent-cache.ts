/**
 * Disk-backed JSON cache for the main process.
 *
 * Each entry lives in its own file under `<userData>/cache/<sanitized-key>.json`
 * shaped as `{ value, expiresAt }`. Used for cross-restart caching where
 * paying a remote API cost on every cold start would be wasteful (e.g.
 * Google Calendar events).
 *
 *      get(key, ttl, fetcher)
 *           │
 *           ▼
 *      read <userData>/cache/<key>.json
 *           │
 *      ┌────┴────┐
 *      │         │
 *   hit (fresh)  miss / expired / corrupt
 *      │         │
 *      ▼         ▼
 *   return    fetcher() → write file → return
 *
 * No locking. The expected use is single-writer (one main process), low
 * concurrency. A concurrent write-during-read produces either the old
 * value or the new — both acceptable for cache semantics.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

function getCacheDir(): string {
  const dir = join(app.getPath('userData'), 'cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeKey(key: string): string {
  // Allow ASCII alphanumerics, dot, dash, underscore. Anything else → underscore.
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
}

function getPath(key: string): string {
  return join(getCacheDir(), `${sanitizeKey(key)}.json`)
}

export const persistentCache = {
  /**
   * Returns the cached value if present and unexpired, otherwise calls
   * `fetcher`, persists the result, and returns it.
   *
   * Corrupt files (unparseable JSON / wrong shape) are treated as a miss
   * and overwritten on the next successful fetch.
   *
   * If the fetcher throws, the cache is NOT updated — the error propagates
   * to the caller, and a future call retries.
   */
  async get<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const filePath = getPath(key)
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const entry = JSON.parse(raw) as CacheEntry<T>
        if (
          entry &&
          typeof entry.expiresAt === 'number' &&
          entry.expiresAt > Date.now() &&
          'value' in entry
        ) {
          console.log(`[persistent-cache] hit ${key}`)
          return entry.value
        }
      } catch {
        // Corrupt — fall through to refetch.
      }
    }
    console.log(`[persistent-cache] miss ${key}`)
    const value = await fetcher()
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs }
    try {
      writeFileSync(filePath, JSON.stringify(entry), 'utf-8')
    } catch (err) {
      console.warn(`[persistent-cache] write failed for ${key}:`, err)
    }
    return value
  },

  /** Drop the cached entry for `key`. Next get(...) call will refetch. */
  invalidate(key: string): void {
    const filePath = getPath(key)
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch (err) {
        console.warn(`[persistent-cache] invalidate failed for ${key}:`, err)
      }
    }
  },
}
