/**
 * localStorage wrapper that NEVER throws.
 *
 *   parse error  → return default, log warn
 *   QuotaExceeded → evict oldest cyggie:chat:draft:* key, retry once,
 *                   then fall back to in-memory if still failing
 *   SecurityError (private mode, disk full, no access) → in-memory Map fallback
 *
 * Used by the chat panel to persist isOpen/width/mode/lastChatId/draftBySession
 * without ever bringing down the renderer on a corrupt or full storage.
 */

const memoryFallback = new Map<string, string>()

function safeGetItem(key: string): string | null {
  // Memory fallback wins: if a previous setItem tripped quota / SecurityError
  // and we wrote to the in-memory map, we must read from there now — otherwise
  // a real-storage null swallows our fallback value silently.
  if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch (err) {
    console.warn('[safe-storage] getItem failed', { key, err: String(err) })
    return null
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch (err) {
    if (isQuotaExceeded(err)) {
      if (evictOldestDraft(key)) {
        try {
          window.localStorage.setItem(key, value)
          return true
        } catch (retryErr) {
          console.warn('[safe-storage] retry after eviction failed', { key, err: String(retryErr) })
        }
      }
    }
    memoryFallback.set(key, value)
    console.warn('[safe-storage] setItem fell back to memory', { key, err: String(err) })
    return false
  }
}

function safeRemoveItem(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch (err) {
    console.warn('[safe-storage] removeItem failed', { key, err: String(err) })
  }
  memoryFallback.delete(key)
}

function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const name = (err as { name?: string }).name ?? ''
  // Different browsers use different names; cover the common ones.
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    name === 'QUOTA_EXCEEDED_ERR'
  )
}

/**
 * Evict the oldest cyggie:chat:draft:* key (we treat lexicographic order as a
 * proxy for age — drafts are keyed by sessionId, but oldest sessionId tends to
 * mean oldest chat for our v4 UUID scheme).
 *
 * Skips the key currently being written (so we don't evict ourselves).
 * Returns true if anything was evicted.
 */
function evictOldestDraft(currentKey: string): boolean {
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith('cyggie:chat:draft:') && k !== currentKey) {
        keys.push(k)
      }
    }
    if (keys.length === 0) return false
    keys.sort()
    window.localStorage.removeItem(keys[0])
    console.info('[safe-storage] evicted oldest draft', { key: keys[0] })
    return true
  } catch (err) {
    console.warn('[safe-storage] eviction failed', { err: String(err) })
    return false
  }
}

export function getJSON<T>(key: string, defaultValue: T): T {
  const raw = safeGetItem(key)
  if (raw === null) return defaultValue
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    console.warn('[safe-storage] JSON.parse failed', { key, err: String(err) })
    return defaultValue
  }
}

export function setJSON(key: string, value: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (err) {
    console.warn('[safe-storage] JSON.stringify failed', { key, err: String(err) })
    return
  }
  safeSetItem(key, serialized)
}

export function removeKey(key: string): void {
  safeRemoveItem(key)
}

export const __test__ = { memoryFallback, isQuotaExceeded, evictOldestDraft }
