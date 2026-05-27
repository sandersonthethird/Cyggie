import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native'
import { ApiError } from '../../lib/api/client'

// Mocks must be hoisted before importing the unit-under-test so the component
// reads the stubbed reauthorizeGoogle + useAuthStore. Jest only allows the
// mock factory to reference identifiers prefixed with `mock`.
const mockReauthorizeGoogle = jest.fn()
jest.mock('../../lib/auth/oauth', () => ({
  reauthorizeGoogle: (...args: unknown[]) => mockReauthorizeGoogle(...args),
}))

const mockSignIn = jest.fn()
type FakeAuthState = { userId: string | null; accessToken: string | null; signIn: typeof mockSignIn }
let mockStoreSnapshot: FakeAuthState = {
  userId: 'u_current',
  accessToken: 'token-current',
  signIn: mockSignIn,
}
jest.mock('../../lib/auth/store', () => {
  const selectorImpl = (selector: (s: FakeAuthState) => unknown) => selector(mockStoreSnapshot)
  const useAuthStore = Object.assign(selectorImpl, {
    getState: () => mockStoreSnapshot,
  })
  return { useAuthStore }
})

import {
  CalendarReauthState,
  needsGoogleReauth,
} from '../CalendarReauthState'

beforeEach(() => {
  mockReauthorizeGoogle.mockReset()
  mockSignIn.mockReset()
  mockStoreSnapshot = {
    userId: 'u_current',
    accessToken: 'token-current',
    signIn: mockSignIn,
  }
})

// ============================================================================
// Branching contract:
//
//   needsGoogleReauth(error):
//     ApiError + code ∈ REAUTH_CODES → true   (calendar shows ReauthState)
//     anything else                  → false  (calendar shows "Try again")
//
//   ReauthState button press:
//     reauthorizeGoogle → cancel    → no-op, no message
//                       → error     → "<code>: <message>"
//                       → success
//                            ├── userId mismatch → "Please reconnect with…"
//                            ├── signIn throws   → "Sign-in failed after OAuth: <msg>"
//                            └── signIn ok       → onComplete()
// ============================================================================

describe('needsGoogleReauth (predicate)', () => {
  test.each([
    ['REAUTH_REQUIRED', true],
    ['NO_GOOGLE_TOKENS', true],
    ['NO_ACCESS_TOKEN', true],
    ['GOOGLE_AUTH_FAILED', true],
    ['HTTP_500', false],
    ['SOMETHING_ELSE', false],
  ] as Array<[string, boolean]>)(
    'code=%s → %s',
    (code, expected) => {
      const err = new ApiError({ status: 401, code, message: 'm' })
      expect(needsGoogleReauth(err)).toBe(expected)
    },
  )

  test('non-ApiError values → false', () => {
    expect(needsGoogleReauth(new Error('plain'))).toBe(false)
    expect(needsGoogleReauth(null)).toBe(false)
    expect(needsGoogleReauth('string error')).toBe(false)
  })
})

describe('CalendarReauthState', () => {
  test('t1/t2: renders title + "Reconnect Google" button (covers all 4 reauth codes via predicate test)', () => {
    render(<CalendarReauthState onComplete={() => {}} />)
    expect(screen.getByText('Calendar failed to load')).toBeOnTheScreen()
    expect(screen.getByLabelText('Reconnect Google')).toBeOnTheScreen()
    expect(screen.getByTestId('reauth-button')).toHaveTextContent('Reconnect Google')
  })

  test('t4: success path → signIn → onComplete in order', async () => {
    mockReauthorizeGoogle.mockResolvedValueOnce({
      kind: 'success',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      userId: 'u_current', // matches
      action: 'returning',
      email: null,
    })
    mockSignIn.mockResolvedValueOnce(undefined)
    const onComplete = jest.fn()

    render(<CalendarReauthState onComplete={onComplete} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(mockReauthorizeGoogle).toHaveBeenCalledWith({ authToken: 'token-current' })
    expect(mockSignIn).toHaveBeenCalledWith({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      userId: 'u_current',
      action: 'returning',
    })
    // Order: reauthorize before signIn before onComplete.
    expect(mockReauthorizeGoogle.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignIn.mock.invocationCallOrder[0],
    )
  })

  test('t5: cancel → no signIn, no onComplete, no message', async () => {
    mockReauthorizeGoogle.mockResolvedValueOnce({ kind: 'cancel' })
    const onComplete = jest.fn()

    render(<CalendarReauthState onComplete={onComplete} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() => expect(mockReauthorizeGoogle).toHaveBeenCalled())
    expect(mockSignIn).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reauth-message')).toBeNull()
  })

  test('t6: userId mismatch → message shown, signIn NOT called', async () => {
    mockReauthorizeGoogle.mockResolvedValueOnce({
      kind: 'success',
      accessToken: 'wrong-access',
      refreshToken: 'wrong-refresh',
      userId: 'u_DIFFERENT',
      action: 'returning',
      email: null,
    })
    const onComplete = jest.fn()

    render(<CalendarReauthState onComplete={onComplete} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() =>
      expect(screen.getByTestId('reauth-message')).toHaveTextContent(
        'Please reconnect with your original Google account.',
      ),
    )
    expect(mockSignIn).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  test('t7: button disabled while pending; spinner replaces label', async () => {
    let resolveReauth: (val: unknown) => void = () => {}
    mockReauthorizeGoogle.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReauth = resolve
      }),
    )

    render(<CalendarReauthState onComplete={() => {}} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() => expect(screen.getByTestId('reauth-spinner')).toBeOnTheScreen())
    // Button label is hidden behind the spinner.
    expect(screen.getByTestId('reauth-button')).not.toHaveTextContent('Reconnect Google')
    expect(screen.getByLabelText('Reconnect Google')).toBeDisabled()

    await act(async () => {
      resolveReauth({ kind: 'cancel' })
      await Promise.resolve()
    })
  })

  test('reauthorize returns error kind → shows "<code>: <message>"', async () => {
    mockReauthorizeGoogle.mockResolvedValueOnce({
      kind: 'error',
      code: 'AUTH_SESSION',
      message: 'Auth session failed',
    })

    render(<CalendarReauthState onComplete={() => {}} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() =>
      expect(screen.getByTestId('reauth-message')).toHaveTextContent(
        'AUTH_SESSION: Auth session failed',
      ),
    )
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  test('t10: signIn() throws → "Sign-in failed after OAuth: …" shown, onComplete NOT called', async () => {
    mockReauthorizeGoogle.mockResolvedValueOnce({
      kind: 'success',
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'u_current',
      action: 'returning',
      email: null,
    })
    mockSignIn.mockRejectedValueOnce(new Error('Keychain write failed'))
    const onComplete = jest.fn()

    render(<CalendarReauthState onComplete={onComplete} />)
    fireEvent.press(screen.getByLabelText('Reconnect Google'))

    await waitFor(() =>
      expect(screen.getByTestId('reauth-message')).toHaveTextContent(
        'Sign-in failed after OAuth: Keychain write failed',
      ),
    )
    expect(onComplete).not.toHaveBeenCalled()
    // Button re-enabled after failure.
    expect(screen.getByLabelText('Reconnect Google')).not.toBeDisabled()
  })
})
