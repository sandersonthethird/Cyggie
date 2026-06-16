import React from 'react'
import { render, fireEvent, act } from '@testing-library/react-native'

// Required risk test (b): offline notes ordering. While a meeting's gateway row
// is UNCONFIRMED, NotesEditor must buffer keystrokes in the MMKV draft but NOT
// enqueue to the outbox (a PATCH for a non-existent row dead-letters → lost
// note). On confirmation it must flush the buffered draft exactly once.
//
// jest.mock factories may only reference out-of-scope vars prefixed with `mock`.

const mockMmkv = new Map<string, string>()
jest.mock('../../lib/cache/mmkv', () => ({
  appStateStorage: {
    set: (k: string, v: string) => void mockMmkv.set(k, v),
    getString: (k: string) => mockMmkv.get(k),
    delete: (k: string) => void mockMmkv.delete(k),
    getAllKeys: () => Array.from(mockMmkv.keys()),
  },
}))

const mockEnqueue = jest.fn()
let mockPending = 0
jest.mock('../../lib/sync/outbox', () => ({
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
  pendingCount: () => mockPending,
}))
jest.mock('../../lib/sync/clock', () => ({ tick: () => '5' }))
jest.mock('../../lib/sync/agent', () => ({ drainNow: () => Promise.resolve() }))

import { NotesEditor } from '../NotesEditor'

const baseProps = {
  meetingId: 'mtg-offline',
  status: 'recording',
  serverNotes: null,
  serverUpdatedAt: new Date().toISOString(),
  serverLamport: '0',
}

beforeEach(() => {
  mockMmkv.clear()
  mockEnqueue.mockClear()
  mockPending = 0
  jest.useFakeTimers()
})
afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe('NotesEditor deferred flush (offline notes ordering)', () => {
  test('unconfirmed: typing buffers the draft but does NOT enqueue', () => {
    const { getByLabelText } = render(<NotesEditor {...baseProps} serverConfirmed={false} />)
    fireEvent.changeText(getByLabelText('Meeting notes'), 'flight notes')
    act(() => {
      jest.advanceTimersByTime(1000) // fire the debounce
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
    // Draft IS persisted (offline-safe buffer).
    expect(mockMmkv.get('notes-draft:mtg-offline')).toBe('flight notes')
  })

  test('confirmation flushes the buffered draft exactly once', () => {
    const view = render(<NotesEditor {...baseProps} serverConfirmed={false} />)
    fireEvent.changeText(view.getByLabelText('Meeting notes'), 'flight notes')
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(mockEnqueue).not.toHaveBeenCalled()

    // Row becomes confirmed (pre-create / upload landed).
    view.rerender(<NotesEditor {...baseProps} serverConfirmed={true} />)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'meeting.notes.update',
        resourceId: 'mtg-offline',
        payload: expect.objectContaining({ notes: 'flight notes' }),
      }),
    )
  })

  test('confirmed from the start: typing enqueues normally', () => {
    const { getByLabelText } = render(<NotesEditor {...baseProps} serverConfirmed={true} />)
    fireEvent.changeText(getByLabelText('Meeting notes'), 'live notes')
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })
})
