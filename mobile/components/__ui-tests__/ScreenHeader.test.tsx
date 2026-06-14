import { render, screen, fireEvent } from '@testing-library/react-native'
import { ScreenHeader } from '../ScreenHeader'

// ScreenHeader is the shared app bar the 5 tab screens + global chat migrated
// onto. The two behaviors worth pinning: the persistent chat button is present
// by default (and routes to /chat), and the optional back chevron fires
// onBack. ChatHeaderButton is exercised transitively here.

// jest.mock factories may only reference out-of-scope vars prefixed with `mock`.
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
  },
}))

describe('ScreenHeader', () => {
  beforeEach(() => mockPush.mockClear())

  test('renders title/subtitle and the persistent chat button → /chat', () => {
    render(<ScreenHeader title="Calendar" subtitle="3 meetings" />)
    expect(screen.getByText('Calendar')).toBeOnTheScreen()
    expect(screen.getByText('3 meetings')).toBeOnTheScreen()

    fireEvent.press(screen.getByLabelText('Ask Cyggie'))
    expect(mockPush).toHaveBeenCalledWith('/chat')
  })

  test('showChatButton={false} hides the chat button; onBack fires the back chevron', () => {
    const onBack = jest.fn()
    render(<ScreenHeader title="Ask Cyggie" showChatButton={false} onBack={onBack} />)

    expect(screen.queryByLabelText('Ask Cyggie')).toBeNull()
    fireEvent.press(screen.getByLabelText('Back'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
