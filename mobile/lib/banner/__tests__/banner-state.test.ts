import { afterEach, describe, expect, it, vi } from 'vitest'

// api/client transitively imports react-native modules — no-op mock so
// `import { ApiError } from '../../api/client'` (transitive via
// banner-state.ts) resolves cleanly under vitest's node env.
class MockApiError extends Error {
  status: number
  code: string
  details: unknown
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
    this.details = undefined
    this.reauthRequired = opts.reauthRequired ?? false
  }
}
vi.mock('../../api/client', () => ({
  ApiError: MockApiError,
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const { formatErrorMessage } = await import('../banner-state')

describe('formatErrorMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when reauthRequired (sign-out path owns the user)', () => {
    const err = new MockApiError({
      status: 401,
      code: 'REAUTH_REQUIRED',
      message: 'reauth',
      reauthRequired: true,
    })
    expect(formatErrorMessage(err)).toBeNull()
  })

  it('returns the canned 5xx message for ApiError 500+', () => {
    const err = new MockApiError({ status: 500, code: 'INTERNAL', message: 'boom' })
    expect(formatErrorMessage(err)).toBe(
      "Cyggie's servers are having trouble. Try again in a moment.",
    )
  })

  it('returns the canned 5xx message for ApiError 503', () => {
    const err = new MockApiError({ status: 503, code: 'UNAVAILABLE', message: 'down' })
    expect(formatErrorMessage(err)).toMatch(/^Cyggie's servers/)
  })

  it('returns err.message for ApiError 4xx (gateway envelope already user-facing)', () => {
    const err = new MockApiError({ status: 400, code: 'BAD_REQUEST', message: 'Title required' })
    expect(formatErrorMessage(err)).toBe('Title required')
  })

  it('returns generic for ApiError 4xx without reauth (404)', () => {
    const err = new MockApiError({ status: 404, code: 'NOT_FOUND', message: 'Meeting not found' })
    expect(formatErrorMessage(err)).toBe('Meeting not found')
  })

  it('returns generic for a plain Error', () => {
    expect(formatErrorMessage(new Error('network'))).toBe(
      'Something went wrong. Tap again to retry.',
    )
  })

  it('returns generic AND logs to console.warn for unknown shape', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const msg = formatErrorMessage({ weird: 'shape' })
    expect(msg).toBe('Something went wrong. Tap again to retry.')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('[banner] unrecognized error shape')
  })

  it('returns generic AND logs for null err (defensive)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(formatErrorMessage(null)).toBe('Something went wrong. Tap again to retry.')
    expect(warnSpy).toHaveBeenCalled()
  })
})
