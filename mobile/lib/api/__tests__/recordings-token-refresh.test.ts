// Unit tests for uploadRecording's 401 → refresh → retry path.
//
// The fix mirrors commit 742bb69's pushAnthropicKey pattern:
//   1) try once with the cached access token
//   2) if 401 and reauth_required is not set, call ensureFreshAccessToken
//      and retry once with the fresh token
//   3) if refresh returns null (revoked) or the second attempt 401s,
//      surface the error so performUpload's catch persists the recording
//      to MMKV for retry after re-signin (the 2A flow).
//
// We mock createUploadTask at the expo-file-system/legacy boundary and
// stub `useAuthStore` + `ensureFreshAccessToken` to drive the branches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// createUploadTask: each test enqueues the result-per-attempt and we
// drain that queue. Records how many attempts fired + which token each
// used so we can assert the retry actually re-stamped the header.
interface UploadResultMock {
  status: number
  body: string
}
const attemptLog: Array<{ token: string }> = []
let attemptResults: UploadResultMock[] = []

vi.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { MULTIPART: 0 },
  createUploadTask: (
    _url: string,
    _uri: string,
    opts: { headers: Record<string, string> },
  ) => {
    const headerToken = (opts.headers?.Authorization ?? '').replace(/^Bearer /, '')
    return {
      uploadAsync: async (): Promise<UploadResultMock | undefined> => {
        attemptLog.push({ token: headerToken })
        return attemptResults.shift()
      },
    }
  },
}))

// useAuthStore: just exposes the current cached token. Tests mutate it
// freely between cases.
let currentAccessToken: string | null = 'token-cached'
vi.mock('../../auth/store', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: currentAccessToken }),
  },
}))

// ensureFreshAccessToken: tests set this to either a refreshed token or
// null (revoked refresh token).
let refreshResult: string | null = null
const refreshMock = vi.fn(async () => refreshResult)
vi.mock('../client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code: string
    reauthRequired: boolean
    constructor(opts: {
      status: number
      code: string
      message: string
      reauthRequired?: boolean
    }) {
      super(opts.message)
      this.status = opts.status
      this.code = opts.code
      this.reauthRequired = opts.reauthRequired ?? false
    }
  },
  ensureFreshAccessToken: refreshMock,
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

const { uploadRecording } = await import('../recordings')
const { ApiError } = await import('../client')

const UPLOAD_ARGS = {
  localUri: 'file:///rec.m4a',
  title: 'meeting',
  clientRecordedAt: '2026-05-22T10:00:00Z',
}

beforeEach(() => {
  attemptLog.length = 0
  attemptResults = []
  refreshResult = null
  refreshMock.mockClear()
  currentAccessToken = 'token-cached'
})
afterEach(() => {
  attemptLog.length = 0
  attemptResults = []
})

describe('uploadRecording — happy path (no refresh needed)', () => {
  it('returns meetingId on a single 200', async () => {
    attemptResults = [{ status: 200, body: JSON.stringify({ meetingId: 'mtg-1' }) }]
    const out = await uploadRecording(UPLOAD_ARGS)
    expect(out).toEqual({ meetingId: 'mtg-1' })
    expect(attemptLog).toEqual([{ token: 'token-cached' }])
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

describe('uploadRecording — 401 refresh retry (the actual user bug)', () => {
  it('refreshes the token once and retries; second 200 succeeds', async () => {
    attemptResults = [
      // First attempt: gateway says token is stale, refresh allowed.
      { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }) },
      // Second attempt with fresh token: succeeds.
      { status: 200, body: JSON.stringify({ meetingId: 'mtg-2' }) },
    ]
    refreshResult = 'token-fresh'

    const out = await uploadRecording(UPLOAD_ARGS)
    expect(out).toEqual({ meetingId: 'mtg-2' })
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Crucially: the retry must use the fresh token, not the cached one.
    expect(attemptLog).toEqual([{ token: 'token-cached' }, { token: 'token-fresh' }])
  })

  it('does NOT retry when 401 body has reauth_required:true', async () => {
    // reauth_required signals the gateway has already invalidated the
    // session — refresh won't help. The pattern from gateway-credentials
    // skips refresh in this case to avoid burning a refresh token call.
    attemptResults = [
      {
        status: 401,
        body: JSON.stringify({
          error: { code: 'REAUTH_REQUIRED' },
          reauth_required: true,
        }),
      },
    ]

    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toMatchObject({
      status: 401,
      reauthRequired: true,
    })
    expect(refreshMock).not.toHaveBeenCalled()
    expect(attemptLog).toEqual([{ token: 'token-cached' }])
  })

  it('throws 401 when refresh returns null (revoked refresh token)', async () => {
    attemptResults = [
      { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }) },
    ]
    refreshResult = null

    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toBeInstanceOf(ApiError)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Only one attempt — without a fresh token there's nothing to retry with.
    expect(attemptLog).toEqual([{ token: 'token-cached' }])
  })

  it('throws when refresh succeeded but the second attempt still 401s', async () => {
    attemptResults = [
      { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }) },
      {
        status: 401,
        body: JSON.stringify({ error: { code: 'REAUTH_REQUIRED' }, reauth_required: true }),
      },
    ]
    refreshResult = 'token-fresh'

    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toMatchObject({
      status: 401,
      reauthRequired: true,
    })
    expect(attemptLog).toEqual([{ token: 'token-cached' }, { token: 'token-fresh' }])
  })
})

describe('uploadRecording — non-401 failure paths bypass refresh', () => {
  it('throws on 500 without refreshing', async () => {
    attemptResults = [
      { status: 500, body: JSON.stringify({ error: { code: 'INTERNAL' } }) },
    ]

    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toMatchObject({
      status: 500,
    })
    expect(refreshMock).not.toHaveBeenCalled()
    expect(attemptLog).toHaveLength(1)
  })

  it('throws NOT_SIGNED_IN when there is no cached access token', async () => {
    currentAccessToken = null
    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toMatchObject({
      status: 401,
      code: 'NOT_SIGNED_IN',
    })
    // Should not even attempt the upload
    expect(attemptLog).toHaveLength(0)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('throws UPLOAD_FAILED when uploadAsync returns undefined', async () => {
    // createUploadTask resolves with `undefined` on some platform edge
    // cases (rare). Treat as a non-retriable failure — the catch in
    // performUpload will persist the audio + surface markError.
    attemptResults = [] // queue empty → mock returns undefined

    await expect(uploadRecording(UPLOAD_ARGS)).rejects.toMatchObject({
      status: 0,
      code: 'UPLOAD_FAILED',
    })
  })
})
