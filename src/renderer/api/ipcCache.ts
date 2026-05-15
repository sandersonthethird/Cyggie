/**
 * IPC response cache for the renderer.
 *
 * Keyed by (channel, args). Caches successful results for a configurable TTL,
 * deduplicates concurrent in-flight requests, and supports manual invalidation
 * called from mutation paths.
 *
 * Failures are NOT cached — a rejected fetcher clears the pending entry so the
 * next call retries.
 *
 * The cache is renderer-side only; the main process is untouched. When a list
 * channel's underlying data changes, callers MUST call `ipcCache.invalidate`
 * with the affected channel. The invalidation map below collects the
 * mutation→list mappings in one place so they're easy to audit.
 */

type CacheKey = string
type FetcherResult<T> = Promise<T>

interface CacheEntry<T = unknown> {
  value?: T
  expiresAt?: number
  pending?: Promise<T>
}

const store = new Map<CacheKey, CacheEntry>()
const DEFAULT_TTL_MS = 30_000

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

function buildKey(channel: string, args: unknown): CacheKey {
  return channel + '|' + stableStringify(args)
}

export const ipcCache = {
  async get<T>(
    channel: string,
    args: unknown,
    fetcher: () => FetcherResult<T>,
    options: { ttlMs?: number } = {},
  ): Promise<T> {
    const key = buildKey(channel, args)
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS
    const now = Date.now()
    const entry = store.get(key) as CacheEntry<T> | undefined

    if (entry?.pending) return entry.pending
    if (entry && entry.expiresAt !== undefined && entry.expiresAt > now) {
      return entry.value as T
    }

    const pending = fetcher()
      .then((value) => {
        store.set(key, { value, expiresAt: Date.now() + ttl })
        return value
      })
      .catch((err) => {
        // Don't cache failures; drop the entry entirely so the next call retries.
        store.delete(key)
        throw err
      })
    store.set(key, { pending })
    return pending
  },

  invalidate(channel: string, argsMatcher?: (args: unknown) => boolean): void {
    const prefix = channel + '|'
    for (const key of Array.from(store.keys())) {
      if (!key.startsWith(prefix)) continue
      if (argsMatcher) {
        try {
          const args = JSON.parse(key.slice(prefix.length))
          if (!argsMatcher(args)) continue
        } catch {
          // Fall through and invalidate — corrupt key means we can't filter, so be safe.
        }
      }
      store.delete(key)
    }
  },

  /** Test-only: clear the entire cache between cases. */
  _resetForTests(): void {
    store.clear()
  },
}

/**
 * Mutation → invalidation map. When `api.invoke` is called with a key from
 * this object and resolves successfully, the listed list-channels are
 * invalidated. Add new mutation channels here as caches are added for new
 * list channels — keeping all the wiring in one place makes the contract
 * auditable.
 */
export const MUTATION_INVALIDATIONS: Record<string, readonly string[]> = {
  'company:create': ['company:list', 'pipeline:list', 'dashboard:get'],
  'company:update': ['company:list', 'pipeline:list', 'dashboard:get'],
  'company:delete': ['company:list', 'pipeline:list', 'dashboard:get'],
  'company:merge':  ['company:list', 'pipeline:list', 'dashboard:get'],
  'task:create':    ['task:list', 'dashboard:get'],
  'task:update':    ['task:list', 'dashboard:get'],
  'task:delete':    ['task:list', 'dashboard:get'],
  'meeting:create': ['dashboard:get', 'meeting:list'],
  'meeting:update': ['dashboard:get', 'meeting:list'],
  'meeting:delete': ['dashboard:get', 'meeting:list'],
  'meeting:rename-title':           ['meeting:list'],
  'meeting:rename-speakers':        ['meeting:list'],
  'meeting:tag-speaker-contact':    ['meeting:list'],
  'notes:create':         ['notes:list', 'notes:folder-counts'],
  'notes:update':         ['notes:list', 'notes:folder-counts'],
  'notes:delete':         ['notes:list', 'notes:folder-counts'],
  'notes:folder-create':  ['notes:list-folders', 'notes:folder-counts'],
  'notes:folder-rename':  ['notes:list-folders', 'notes:folder-counts', 'notes:list'],
  'notes:folder-delete':  ['notes:list-folders', 'notes:folder-counts', 'notes:list'],
  'chat-session:create-new':         ['chat-session:list-recent'],
  'chat-session:rename':             ['chat-session:list-recent'],
  'chat-session:pin':                ['chat-session:list-recent'],
  'chat-session:unpin':              ['chat-session:list-recent'],
  'chat-session:archive':            ['chat-session:list-recent'],
  'chat-session:delete':             ['chat-session:list-recent'],
  'chat-session:append-modal-turn':  ['chat-session:list-recent'],
  'chat-session:end-active':         ['chat-session:list-recent'],
  'template:create':  ['template:list'],
  'template:update':  ['template:list'],
  'template:delete':  ['template:list'],
  // Calendar refresh is itself "mutation-like" — it bypasses the persistent
  // cache on the main side and we want the renderer-side cache to drop too.
  'calendar:refresh': ['calendar:events'],
  'calendar:sync':    ['calendar:events'],
}
