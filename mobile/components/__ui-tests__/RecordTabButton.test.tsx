import { render, screen, fireEvent } from '@testing-library/react-native'
import { RecordTabButton } from '../RecordTabButton'

// The center tab button is the app's primary capture action. The one piece of
// real logic here is the double-tap guard: a rushed partner double-tapping
// between meetings must not stack two recorder screens (the recorder
// auto-starts recording on mount). We assert it navigates to /record exactly
// once even on a rapid double-tap.

// jest.mock factories may only reference out-of-scope vars prefixed with `mock`.
const mockNavigate = jest.fn()
jest.mock('expo-router', () => ({
  router: {
    navigate: (...args: unknown[]) => mockNavigate(...args),
  },
}))

// RecordTabButton receives expo-router's BottomTabBarButtonProps but ignores
// them — an empty object is enough for the render.
const tabProps = {} as never

describe('RecordTabButton', () => {
  beforeEach(() => mockNavigate.mockClear())

  test('single tap → navigates to the recorder once', () => {
    render(<RecordTabButton {...tabProps} />)
    fireEvent.press(screen.getByLabelText('New meeting'))
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/record')
  })

  test('rapid double-tap → still navigates only once (guard)', () => {
    render(<RecordTabButton {...tabProps} />)
    const btn = screen.getByLabelText('New meeting')
    fireEvent.press(btn)
    fireEvent.press(btn)
    expect(mockNavigate).toHaveBeenCalledTimes(1)
  })
})
