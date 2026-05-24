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
 * INVALIDATIONS_BY_TABLE — single source of truth for cache invalidation.
 *
 * Keys are OWNED_TABLES table names (packages/db/src/sync/owned-tables.ts)
 * plus a few "virtual tables" for non-owned domains (calendar). Values
 * are the list of renderer ipcCache channels that depend on rows in
 * that table.
 *
 * Two trigger paths dispatch through this map:
 *
 *   1. LOCAL mutations (existing): the IPC invoke wrapper at
 *      `api/index.ts:13` looks up MUTATION_INVALIDATIONS (computed
 *      below from this map via CHANNEL_TO_TABLE) and invalidates the
 *      listed caches whenever a mutation channel resolves.
 *
 *   2. REMOTE applies (new — Bug A from 2026-05-24 plan): the
 *      `useRemoteApply` hook subscribes to *_REMOTE_APPLIED IPC
 *      channels, looks up the corresponding table from
 *      REMOTE_APPLIED_TO_TABLE, and calls `invalidateTable(table)`
 *      which reads this same map.
 *
 * Adding a new mobile-mutable table:
 *   1. Add entry here listing affected cache channels
 *   2. Add the local IPC channel → table routing in CHANNEL_TO_TABLE
 *   3. Add the REMOTE_APPLIED IPC channel → table routing in
 *      REMOTE_APPLIED_TO_TABLE
 *   4. The cross-check test (ipcCache-invalidations.test.ts) will fail
 *      if the per-channel and per-table sets drift.
 */
export const INVALIDATIONS_BY_TABLE: Record<string, readonly string[]> = {
  org_companies:    ['company:list', 'pipeline:list', 'dashboard:get'],
  org_company_aliases: ['company:list'],
  contacts:         ['contact:list', 'dashboard:get'],
  contact_emails:   ['contact:list'],
  meetings:         ['meeting:list', 'dashboard:get'],
  notes:            ['notes:list', 'notes:folder-counts'],
  note_folders:     ['notes:list-folders', 'notes:folder-counts', 'notes:list'],
  tasks:            ['task:list', 'dashboard:get'],
  chat_sessions:           ['chat-session:list-recent'],
  chat_session_messages:   ['chat-session:list-recent'],
  templates:        ['template:list'],
  // Virtual table — calendar is a network refresh, not a sync-owned table.
  // Listed here so the same dispatcher works.
  calendar:         ['calendar:events'],
}

/**
 * CHANNEL_TO_TABLE — routes each local mutation IPC channel to its
 * owning table. The IPC invoke wrapper uses this to look up which
 * caches to invalidate. Some mutations on the meetings table
 * (renames) historically had narrower invalidation sets than
 * create/update/delete; the 2026-05-24 refactor collapsed them — the
 * extra invalidation is one cheap cache miss and removes a drift
 * surface (one map, not per-mutation variants).
 */
const CHANNEL_TO_TABLE: Record<string, string> = {
  'company:create': 'org_companies',
  'company:update': 'org_companies',
  'company:delete': 'org_companies',
  'company:merge':  'org_companies',
  'task:create':    'tasks',
  'task:update':    'tasks',
  'task:delete':    'tasks',
  'meeting:create':                 'meetings',
  'meeting:update':                 'meetings',
  'meeting:delete':                 'meetings',
  'meeting:rename-title':           'meetings',
  'meeting:rename-speakers':        'meetings',
  'meeting:tag-speaker-contact':    'meetings',
  'notes:create':         'notes',
  'notes:update':         'notes',
  'notes:delete':         'notes',
  'notes:folder-create':  'note_folders',
  'notes:folder-rename':  'note_folders',
  'notes:folder-delete':  'note_folders',
  'chat-session:create-new':         'chat_sessions',
  'chat-session:rename':             'chat_sessions',
  'chat-session:pin':                'chat_sessions',
  'chat-session:unpin':              'chat_sessions',
  'chat-session:archive':            'chat_sessions',
  'chat-session:delete':             'chat_sessions',
  'chat-session:append-modal-turn':  'chat_session_messages',
  'chat-session:end-active':         'chat_sessions',
  'template:create':  'templates',
  'template:update':  'templates',
  'template:delete':  'templates',
  'calendar:refresh': 'calendar',
  'calendar:sync':    'calendar',
}

/**
 * REMOTE_APPLIED_TO_TABLE — routes each *_REMOTE_APPLIED IPC channel
 * (broadcast by sync-bootstrap.ts after sync-pull) to its table. Used
 * by the `useRemoteApply` hook. Values mirror the IPC channel names
 * in src/shared/constants/channels.ts so this stays a pure routing
 * map, no dependency on the channels constant module here (kept loose
 * to avoid a circular import; cross-check test asserts every key
 * matches a real IPC_CHANNELS.*_REMOTE_APPLIED constant).
 */
export const REMOTE_APPLIED_TO_TABLE: Record<string, string> = {
  'sync:meetings-remote-applied':              'meetings',
  'sync:notes-remote-applied':                 'notes',
  'sync:contacts-remote-applied':              'contacts',
  'sync:org-companies-remote-applied':         'org_companies',
  'sync:contact-emails-remote-applied':        'contact_emails',
  'sync:org-company-aliases-remote-applied':   'org_company_aliases',
  'sync:chat-sessions-remote-applied':         'chat_sessions',
  'sync:chat-session-messages-remote-applied': 'chat_session_messages',
}

/**
 * Backward-compatible MUTATION_INVALIDATIONS — computed from
 * INVALIDATIONS_BY_TABLE via CHANNEL_TO_TABLE. Exported because the
 * IPC invoke wrapper (api/index.ts) reads it directly. Identical
 * shape to the pre-refactor object, just no longer hand-maintained.
 */
export const MUTATION_INVALIDATIONS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    Object.entries(CHANNEL_TO_TABLE).map(([channel, table]) => [
      channel,
      INVALIDATIONS_BY_TABLE[table] ?? [],
    ]),
  )

/**
 * Invalidate every cache key that depends on rows in the given table.
 * Used by both:
 *   - Local mutation handler (via MUTATION_INVALIDATIONS lookup)
 *   - Remote-apply hook (via REMOTE_APPLIED_TO_TABLE lookup)
 */
export function invalidateTable(table: string): void {
  const targets = INVALIDATIONS_BY_TABLE[table]
  if (!targets) return
  for (const target of targets) {
    ipcCache.invalidate(target)
  }
}
