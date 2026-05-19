import { beforeEach, describe, expect, test, vi } from 'vitest'
import { parseCallbackUrl } from '@cyggie/shared/auth-callback'

// =============================================================================
// cyggie-auth.test.ts — tests the shared callback parser + the desktop refresh
// orchestration (storage round-trip, single-flight refresh, sign-out wipe).
//
// We mock the modules that touch Electron + SQLite so this runs in plain Node.
// =============================================================================

// ── In-memory shim for the storage layer ────────────────────────────────────
//
// safeStorage isn't available in Node tests. We replace the storage module
// with an in-memory map so the refresh / sign-out paths exercise their real
// logic without crashing.

const memoryStore = new Map<string, string>()

vi.mock('../main/auth/cyggie-auth-storage', () => {
  // Direct read-through to memoryStore — no closure cache. The real
  // cyggie-auth-storage.ts has an in-memory cache for performance, but the
  // tests don't need to assert that behaviour; they assert refresh and
  // sign-out orchestration.
  return {
    storeCyggieTokens: vi.fn((t: { accessToken: string; refreshToken: string; userId: string; email: string }) => {
      memoryStore.set('access', t.accessToken)
      memoryStore.set('refresh', t.refreshToken)
      memoryStore.set('user_id', t.userId)
      memoryStore.set('email', t.email)
    }),
    storeCyggieRefreshedTokens: vi.fn((opts: { accessToken: string; refreshToken: string }) => {
      memoryStore.set('access', opts.accessToken)
      memoryStore.set('refresh', opts.refreshToken)
    }),
    getCyggieAccessTokenSync: vi.fn(() => memoryStore.get('access') ?? null),
    getCyggieRefreshToken: vi.fn(() => memoryStore.get('refresh') ?? null),
    getCyggieUserId: vi.fn(() => memoryStore.get('user_id') ?? null),
    getCyggieUserEmail: vi.fn(() => memoryStore.get('email') ?? null),
    clearCyggieTokens: vi.fn(() => {
      memoryStore.clear()
    }),
    _resetCacheForTesting: vi.fn(),
  }
})

// settingsRepo is used inside cyggie-auth.ts for the device_id. Stub it.
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => {
  return {
    getSetting: vi.fn(() => 'test-device-id'),
    setSetting: vi.fn(),
  }
})

// Electron stubs.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) },
}))

// IPC_CHANNELS is imported by cyggie-auth; the real module works fine.

// ── parseCallbackUrl (lives in @cyggie/shared) ─────────────────────────────

describe('parseCallbackUrl', () => {
  test('happy path: returns kind=success with all params + email', () => {
    const url =
      'cyggie-desktop://auth-callback?session=AAA&refresh=BBB&user_id=u-1&action=returning&email=sandy%40redswanventures.com'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('success')
    if (r.kind !== 'success') throw new Error('unreachable')
    expect(r.accessToken).toBe('AAA')
    expect(r.refreshToken).toBe('BBB')
    expect(r.userId).toBe('u-1')
    expect(r.action).toBe('returning')
    expect(r.email).toBe('sandy@redswanventures.com')
  })

  test('email is optional (pre-2026-05 gateway back-compat): null when omitted', () => {
    const url =
      'cyggie-desktop://auth-callback?session=A&refresh=B&user_id=u&action=returning'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('success')
    if (r.kind !== 'success') throw new Error('unreachable')
    expect(r.email).toBeNull()
  })

  test('mobile scheme works identically', () => {
    const url = 'cyggie://auth-callback?session=A&refresh=B&user_id=u&action=returning'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('success')
  })

  test('missing required params → CALLBACK_INCOMPLETE', () => {
    const url = 'cyggie-desktop://auth-callback?session=AAA&action=returning'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') throw new Error('unreachable')
    expect(r.code).toBe('CALLBACK_INCOMPLETE')
  })

  test('unknown action → CALLBACK_UNKNOWN_ACTION', () => {
    const url =
      'cyggie-desktop://auth-callback?session=A&refresh=B&user_id=u&action=not_an_action'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') throw new Error('unreachable')
    expect(r.code).toBe('CALLBACK_UNKNOWN_ACTION')
  })

  test('OAuth provider error param → OAUTH_<UPPER>', () => {
    const url = 'cyggie-desktop://auth-callback?error=access_denied'
    const r = parseCallbackUrl(url)
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') throw new Error('unreachable')
    expect(r.code).toBe('OAUTH_ACCESS_DENIED')
  })

  test('garbage URL → CALLBACK_INVALID_URL', () => {
    const r = parseCallbackUrl('not a url')
    expect(r.kind).toBe('error')
    if (r.kind !== 'error') throw new Error('unreachable')
    expect(r.code).toBe('CALLBACK_INVALID_URL')
  })
})

// ── Refresh orchestration ──────────────────────────────────────────────────

describe('cyggie-auth refresh', () => {
  // Re-import after the mocks are installed so the module wires to them.
  let mod: typeof import('../main/auth/cyggie-auth')
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    memoryStore.clear()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    mod = await import('../main/auth/cyggie-auth')
    mod._resetRefreshInFlightForTesting()
  })

  test('refresh() returns null + does NOT call gateway when no refresh token stored', async () => {
    const result = await mod.refresh()
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('refresh() happy path rotates tokens and returns new access token', async () => {
    memoryStore.set('refresh', 'old-refresh')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })
    const result = await mod.refresh()
    expect(result).toBe('new-access')
    expect(memoryStore.get('access')).toBe('new-access')
    expect(memoryStore.get('refresh')).toBe('new-refresh')
  })

  test('refresh() with reauth_required wipes storage and returns null', async () => {
    memoryStore.set('access', 'a')
    memoryStore.set('refresh', 'r')
    memoryStore.set('user_id', 'u-1')
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ reauth_required: true }),
      text: async () => 'reauth',
    })
    const result = await mod.refresh()
    expect(result).toBeNull()
    expect(memoryStore.get('access')).toBeUndefined()
    expect(memoryStore.get('refresh')).toBeUndefined()
  })

  test('CONCURRENT refresh(): two parallel callers coalesce onto one fetch', async () => {
    memoryStore.set('refresh', 'old')

    // Resolve the same promise for both callers; assert only one fetch happened.
    let resolveFetch!: (v: unknown) => void
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res
    })
    fetchMock.mockReturnValueOnce(pending)

    const callA = mod.refresh()
    const callB = mod.refresh()

    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'shared-access', refresh_token: 'shared-refresh' }),
    })

    const [a, b] = await Promise.all([callA, callB])
    expect(a).toBe('shared-access')
    expect(b).toBe('shared-access')
    expect(fetchMock).toHaveBeenCalledTimes(1) // belt + suspenders
  })

  test('signOut() wipes storage + best-effort POST /auth/logout', async () => {
    memoryStore.set('access', 'a')
    memoryStore.set('user_id', 'u-1')
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 })
    await mod.signOut()
    expect(memoryStore.get('access')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/logout'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('getAccessToken() returns cached token without hitting refresh()', async () => {
    memoryStore.set('access', 'cached')
    const result = await mod.getAccessToken()
    expect(result).toBe('cached')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('getAccessToken() falls back to refresh() when cache is empty', async () => {
    memoryStore.set('refresh', 'r')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh', refresh_token: 'r2' }),
    })
    const result = await mod.getAccessToken()
    expect(result).toBe('fresh')
  })
})
