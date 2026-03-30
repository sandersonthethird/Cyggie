// @vitest-environment jsdom
/**
 * Race-condition regression test for MeetingDetail's loadIdRef guard.
 *
 * Verifies that when the user navigates from meeting A to meeting B before
 * A's MEETING_GET response resolves, A's stale response does NOT overwrite
 * B's rendered state.
 *
 * Mock boundaries:
 *   - react-router-dom → stub useParams / useNavigate / useLocation
 *   - ../renderer/api  → controlled invoke promises per meeting id
 *   - recording.store  → selector-based stub (isRecording=false, no active recording)
 *   - chat.store       → stub getState() (no conversations)
 *   - AudioCaptureContext → no-op stubs
 *   - hooks (usePicker, useFindInPage, useNotesAutoSave, useTiptapMarkdown) → minimal stubs
 *   - @tiptap/*        → stub (no DOM rendering)
 *   - child components → stub (() => null)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import React from 'react'

// --- Mocks (hoisted before imports) ---

vi.mock('react-router-dom', () => {
  // Stable navigate reference — navigate is a dep of loadMeeting's useCallback;
  // a new fn on every render would cause loadMeeting to be recreated each render.
  const navigate = vi.fn()
  return {
    useParams: vi.fn(() => ({ id: 'meeting-A' })),
    useNavigate: vi.fn(() => navigate),
    useLocation: vi.fn(() => ({ state: null })),
  }
})

vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}))

// Recording store uses selector pattern: useRecordingStore(s => s.field)
vi.mock('../renderer/stores/recording.store', () => {
  const state = {
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    isRecording: false,
    meetingId: null,
    isPaused: false,
    duration: 0,
    error: null,
    setError: vi.fn(),
    liveTranscript: [],
    interimSegment: null,
    channelMode: 'both',
    autoStoppedMeetingIds: new Set<string>(),
  }
  return { useRecordingStore: vi.fn((selector: (s: typeof state) => unknown) => selector(state)) }
})

// Chat store: useChatStore.getState() is called directly in loadMeeting
vi.mock('../renderer/stores/chat.store', () => ({
  useChatStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ conversations: {}, addMessage: vi.fn() })),
  }),
}))

vi.mock('../renderer/contexts/AudioCaptureContext', () => ({
  useSharedAudioCapture: vi.fn(() => ({})),
  useSharedVideoCapture: vi.fn(() => ({})),
}))

vi.mock('../renderer/hooks/useFindInPage', () => ({
  useFindInPage: vi.fn(() => ({
    query: '',
    setQuery: vi.fn(),
    matchCount: 0,
    activeMatchIndex: 0,
    goToNext: vi.fn(),
    goToPrev: vi.fn(),
    highlightedContent: '',
  })),
}))

vi.mock('../renderer/hooks/usePicker', () => ({
  usePicker: vi.fn(() => ({
    query: '',
    setQuery: vi.fn(),
    results: [],
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
    isLoading: false,
    select: vi.fn(),
  })),
}))

vi.mock('../renderer/hooks/useNotesAutoSave', () => ({
  useNotesAutoSave: vi.fn(() => ({
    notesDraft: '',
    summaryDraft: '',
    setSummaryDraft: vi.fn(),
    handleNotesChange: vi.fn(),
    handleNotesChangeText: vi.fn(),
    handleSummaryChange: vi.fn(),
    saveNotes: vi.fn(),
    flushNotes: vi.fn(),
    reset: vi.fn(),
    lastEditedAt: null,
  })),
}))

vi.mock('../renderer/hooks/useTiptapMarkdown', () => {
  // Stable loadContent reference — prevents loadMeeting from being recreated on every render
  const loadContent = vi.fn()
  return {
    useTiptapMarkdown: vi.fn(() => ({ editor: null, loadContent })),
  }
})

vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => null),
  EditorContent: () => null,
}))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('@tiptap/extension-placeholder', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))
vi.mock('react-markdown', () => ({ default: () => null }))
vi.mock('lucide-react', () => ({ Clock: () => null }))

vi.mock('../renderer/components/common/FindBar', () => ({ default: () => null }))
vi.mock('../renderer/components/chat/ChatInterface', () => ({ default: () => null }))
vi.mock('../renderer/components/common/ConfirmDialog', () => ({ default: () => null }))
vi.mock('../renderer/components/enrichment/EnrichmentProposalDialog', () => ({
  EnrichmentProposalDialog: () => null,
}))
vi.mock('../renderer/components/common/EntityPicker', () => ({ EntityPicker: () => null }))
vi.mock('../renderer/components/common/TiptapBubbleMenu', () => ({ TiptapBubbleMenu: () => null }))

// --- Imports after mocks ---

const { default: MeetingDetail } = await import('../renderer/routes/MeetingDetail')
const { useParams } = await import('react-router-dom')
const { api } = await import('../renderer/api')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// --- Helpers ---

function makeMeetingData(id: string, title: string) {
  return {
    meeting: {
      id,
      title,
      date: '2026-03-25T10:00:00Z',
      durationSeconds: null,
      calendarEventId: null,
      meetingPlatform: null,
      meetingUrl: null,
      transcriptPath: null,
      summaryPath: null,
      recordingPath: null,
      transcriptDriveId: null,
      summaryDriveId: null,
      notes: null,
      transcriptSegments: null,
      templateId: null,
      speakerCount: 0,
      speakerMap: {},
      speakerContactMap: {},
      attendees: null,
      attendeeEmails: null,
      companies: null,
      chatMessages: null,
      status: 'scheduled' as const,
      createdAt: '2026-03-25T10:00:00Z',
      updatedAt: '2026-03-25T10:00:00Z',
    },
    transcript: null,
    summary: null,
    linkedCompanies: [],
  }
}

// --- Tests ---

describe('MeetingDetail — loadIdRef stale-load guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-wire api.on to always return a no-op unsubscriber after clearAllMocks
    vi.mocked(api.on).mockReturnValue(() => {})
    vi.mocked(useParams).mockReturnValue({ id: 'meeting-A' })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows Loading... while MEETING_GET is in flight', async () => {
    vi.mocked(api.invoke).mockImplementation(() => new Promise(() => {}))

    render(React.createElement(MeetingDetail))
    expect(screen.getByText('Loading...')).toBeTruthy()
  })

  it('renders meeting title once MEETING_GET resolves', async () => {
    vi.mocked(api.invoke).mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.TEMPLATE_LIST) return Promise.resolve([])
      if (channel === IPC_CHANNELS.MEETING_GET) return Promise.resolve(makeMeetingData('meeting-A', 'Acme Q1 Kickoff'))
      if (channel === IPC_CHANNELS.TASK_LIST_FOR_MEETING) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_GET_SUGGESTIONS) return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(React.createElement(MeetingDetail))

    await waitFor(() => {
      expect(screen.getByText('Acme Q1 Kickoff')).toBeTruthy()
    })
  })

  it('discards stale MEETING_GET result when user navigates away before it resolves', async () => {
    let resolveA!: (value: unknown) => void
    let resolveB!: (value: unknown) => void
    const promiseA = new Promise((r) => { resolveA = r })
    const promiseB = new Promise((r) => { resolveB = r })

    vi.mocked(api.invoke).mockImplementation((channel: string, meetingId?: unknown) => {
      if (channel === IPC_CHANNELS.TEMPLATE_LIST) return Promise.resolve([])
      if (channel === IPC_CHANNELS.MEETING_GET) {
        if (meetingId === 'meeting-A') return promiseA
        if (meetingId === 'meeting-B') return promiseB
      }
      if (channel === IPC_CHANNELS.TASK_LIST_FOR_MEETING) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_GET_SUGGESTIONS) return Promise.resolve([])
      return Promise.resolve(null)
    })

    // Render with meeting A — MEETING_GET('A') is pending
    const { rerender } = render(React.createElement(MeetingDetail))
    expect(screen.getByText('Loading...')).toBeTruthy()

    // Navigate to meeting B before A resolves
    // The immediate-reset useEffect clears data; loadMeeting fires for B
    vi.mocked(useParams).mockReturnValue({ id: 'meeting-B' })
    rerender(React.createElement(MeetingDetail))

    // B resolves first — sets data, renders Meeting B
    await act(async () => {
      resolveB(makeMeetingData('meeting-B', 'Benchmark Partner Meeting'))
    })

    await waitFor(() => {
      expect(screen.getByText('Benchmark Partner Meeting')).toBeTruthy()
    })

    // A resolves late (stale) — loadIdRef guard should discard it
    await act(async () => {
      resolveA(makeMeetingData('meeting-A', 'Acme Q1 Kickoff'))
    })

    // Meeting B's title must remain; Meeting A's must never appear
    await waitFor(() => {
      expect(screen.queryByText('Acme Q1 Kickoff')).toBeNull()
      expect(screen.getByText('Benchmark Partner Meeting')).toBeTruthy()
    })
  })
})
