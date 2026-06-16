import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react-native'
import { RecordTabButton } from '../RecordTabButton'

// The center tab button is the app's primary capture action. The one piece of
// real logic here is the double-tap guard: a rushed partner double-tapping
// between meetings must not start two impromptu recordings. We assert the
// start-impromptu orchestrator runs exactly once even on a rapid double-tap.

// jest.mock factories may only reference out-of-scope vars prefixed with `mock`.
const mockStartImpromptu = jest.fn()
jest.mock('../../lib/recording/start-impromptu', () => ({
  startImpromptuRecording: (...args: unknown[]) => mockStartImpromptu(...args),
}))

// RecordTabButton calls useQueryClient(); return a stub so we don't need a
// provider in the test tree.
const fakeQueryClient = {}
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => fakeQueryClient,
}))

// RecordTabButton receives expo-router's BottomTabBarButtonProps but ignores
// them — an empty object is enough for the render.
const tabProps = {} as React.ComponentProps<typeof RecordTabButton>

describe('RecordTabButton', () => {
  beforeEach(() => mockStartImpromptu.mockClear())

  test('single tap → starts an impromptu recording once', () => {
    render(<RecordTabButton {...tabProps} />)
    fireEvent.press(screen.getByLabelText('New meeting'))
    expect(mockStartImpromptu).toHaveBeenCalledTimes(1)
    expect(mockStartImpromptu).toHaveBeenCalledWith(fakeQueryClient)
  })

  test('rapid double-tap → still starts only once (guard)', () => {
    render(<RecordTabButton {...tabProps} />)
    const btn = screen.getByLabelText('New meeting')
    fireEvent.press(btn)
    fireEvent.press(btn)
    expect(mockStartImpromptu).toHaveBeenCalledTimes(1)
  })
})
