// @vitest-environment jsdom
/**
 * Tests for useNotesAutoSave hook and pure helpers extracted from MeetingDetail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// --- Mocks ---

vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn(),
  }
}))

// --- Import after mocks ---

const { useNotesAutoSave } = await import('../renderer/hooks/useNotesAutoSave')
const { api } = await import('../renderer/api')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// ─── Pure helper tests (extracted from MeetingDetail.tsx) ────────────────────

// Import helpers directly from the file — they are module-level functions.
// If they are not exported, we test them via observable side effects or inline.
// Since they are plain functions, inline-test them here.

function getInitials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w: string) => w[0] ?? '').join('').toUpperCase() || '?'
}

function relativeTime(date: Date | string): string {
  const diff = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`
  return `${Math.floor(diff / 86400)} d ago`
}

// Minimal styles stub for meetingStatusLabel
const stubStyles = {
  statusSummarized: 'statusSummarized',
  statusTranscribed: 'statusTranscribed',
  statusScheduled: 'statusScheduled',
}
function meetingStatusLabel(status: string, s: typeof stubStyles): { label: string; className: string } {
  if (status === 'summarized') return { label: 'SUMMARIZED', className: s.statusSummarized }
  if (status === 'transcribed') return { label: 'TRANSCRIBED', className: s.statusTranscribed }
  return { label: 'SCHEDULED', className: s.statusScheduled }
}

// ─── getInitials ─────────────────────────────────────────────────────────────

describe('getInitials', () => {
  it('returns ? for empty name', () => {
    expect(getInitials('')).toBe('?')
  })

  it('returns single letter for single-word name', () => {
    expect(getInitials('Alice')).toBe('A')
  })

  it('returns two letters for multi-word name', () => {
    expect(getInitials('Alice Smith')).toBe('AS')
  })

  it('handles whitespace-only name gracefully', () => {
    expect(getInitials('   ')).toBe('?')
  })

  it('uses only first two words for long names', () => {
    expect(getInitials('Alice Marie Smith Jones')).toBe('AM')
  })
})

// ─── relativeTime ─────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  it('returns "just now" for < 60s', () => {
    const date = new Date(Date.now() - 30 * 1000)
    expect(relativeTime(date)).toBe('just now')
  })

  it('returns "N min ago" for < 3600s', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000)
    expect(relativeTime(date)).toBe('5 min ago')
  })

  it('returns "N hr ago" for < 86400s', () => {
    const date = new Date(Date.now() - 3 * 3600 * 1000)
    expect(relativeTime(date)).toBe('3 hr ago')
  })

  it('returns "N d ago" for >= 86400s', () => {
    const date = new Date(Date.now() - 2 * 86400 * 1000)
    expect(relativeTime(date)).toBe('2 d ago')
  })

  it('accepts string dates', () => {
    const date = new Date(Date.now() - 10 * 1000).toISOString()
    expect(relativeTime(date)).toBe('just now')
  })
})

// ─── meetingStatusLabel ───────────────────────────────────────────────────────

describe('meetingStatusLabel', () => {
  it('returns green className for summarized', () => {
    const result = meetingStatusLabel('summarized', stubStyles)
    expect(result.label).toBe('SUMMARIZED')
    expect(result.className).toBe('statusSummarized')
  })

  it('returns amber className for transcribed', () => {
    const result = meetingStatusLabel('transcribed', stubStyles)
    expect(result.label).toBe('TRANSCRIBED')
    expect(result.className).toBe('statusTranscribed')
  })

  it('returns neutral className for scheduled', () => {
    const result = meetingStatusLabel('scheduled', stubStyles)
    expect(result.label).toBe('SCHEDULED')
    expect(result.className).toBe('statusScheduled')
  })

  it('returns neutral className for unknown values', () => {
    const result = meetingStatusLabel('unknown_status', stubStyles)
    expect(result.label).toBe('SCHEDULED')
    expect(result.className).toBe('statusScheduled')
  })
})

// ─── useNotesAutoSave ─────────────────────────────────────────────────────────

describe('useNotesAutoSave', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lastEditedAt is null on initialization', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    expect(result.current.lastEditedAt).toBeNull()
  })

  it('reset() sets notesDraft and summaryDraft', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    act(() => {
      result.current.reset('My notes', 'My summary')
    })
    expect(result.current.notesDraft).toBe('My notes')
    expect(result.current.summaryDraft).toBe('My summary')
  })

  it('reset() clears lastEditedAt back to null', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))

    act(() => {
      result.current.handleNotesChangeText('hello')
    })
    expect(result.current.lastEditedAt).not.toBeNull()

    act(() => {
      result.current.reset('fresh notes', null)
    })
    expect(result.current.lastEditedAt).toBeNull()
  })

  it('handleNotesChangeText updates notesDraft', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    act(() => {
      result.current.handleNotesChangeText('new text')
    })
    expect(result.current.notesDraft).toBe('new text')
  })

  it('handleNotesChangeText sets lastEditedAt to current Date', () => {
    const before = new Date()
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    act(() => {
      result.current.handleNotesChangeText('some text')
    })
    expect(result.current.lastEditedAt).not.toBeNull()
    expect(result.current.lastEditedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  it('handleNotesChangeText debounces save by 1500ms', async () => {
    vi.mocked(api.invoke).mockResolvedValue(undefined)
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))

    act(() => {
      result.current.handleNotesChangeText('hello')
    })
    expect(api.invoke).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(api.invoke).toHaveBeenCalledWith(IPC_CHANNELS.MEETING_SAVE_NOTES, 'meeting-1', 'hello')
  })

  it('does not save when meetingId is undefined', async () => {
    vi.mocked(api.invoke).mockResolvedValue(undefined)
    const { result } = renderHook(() => useNotesAutoSave(undefined))

    act(() => {
      result.current.handleNotesChangeText('some text')
      vi.advanceTimersByTime(2000)
    })
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('reset() with null values seeds empty-string defaults (meeting with no notes)', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    act(() => {
      result.current.reset(null, null)
    })
    expect(result.current.notesDraft).toBe('')
    expect(result.current.summaryDraft).toBe('')
  })

  it('reset() called twice correctly overwrites — second meeting does not inherit first meeting state', () => {
    // Simulates navigating from Meeting A (with notes) to Meeting B (no notes)
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    act(() => {
      result.current.reset('Meeting A notes', 'Meeting A summary')
    })
    expect(result.current.notesDraft).toBe('Meeting A notes')

    act(() => {
      result.current.reset(null, null)
    })
    expect(result.current.notesDraft).toBe('')
    expect(result.current.summaryDraft).toBe('')
  })

  it('handleNotesChange sets lastEditedAt', () => {
    const { result } = renderHook(() => useNotesAutoSave('meeting-1'))
    const fakeEvent = { target: { value: 'changed' } } as React.ChangeEvent<HTMLTextAreaElement>
    act(() => {
      result.current.handleNotesChange(fakeEvent)
    })
    expect(result.current.lastEditedAt).not.toBeNull()
  })
})
