/**
 * Tests for recoverSummaryFromCompanionNote() in meeting-summary-recovery.ts.
 *
 * Mock boundaries:
 *   - getDatabase()     → controlled SQLite prepare/get mock
 *   - writeSummary      → controlled file-manager mock
 *   - meetingRepo.updateMeeting → controlled repo mock
 *   - getCurrentUserId  → fixed 'user-1'
 *
 * Coverage:
 *   happy path:        companion note found with title line → strips title, repairs DB, returns summary
 *   no newline:        companion note content has no '\n' → returns full content (no crash)
 *   no companion note: query returns undefined → returns null
 *   writeSummary throws: disk/path error → logs warn, returns null (graceful degrade)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Meeting } from '../shared/types/meeting'

// --- Mocks ---

const getMock = vi.fn()
const prepareMock = vi.fn(() => ({ get: getMock }))
vi.mock('../main/database/connection', () => ({
  getDatabase: () => ({ prepare: prepareMock }),
}))

const writeSummaryMock = vi.fn(() => 'recovered-summary-path.md')
vi.mock('../main/storage/file-manager', () => ({
  writeSummary: writeSummaryMock,
}))

const updateMeetingMock = vi.fn()
vi.mock('../main/database/repositories/meeting.repo', () => ({
  updateMeeting: updateMeetingMock,
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'user-1',
}))

// --- Import after mocks ---

const { recoverSummaryFromCompanionNote } = await import('../main/services/meeting-summary-recovery')

// --- Helpers ---

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'meeting-1',
    title: 'Acme Q1 Review',
    date: '2026-04-09T13:00:00Z',
    durationSeconds: 1980,
    calendarEventId: null,
    meetingPlatform: null,
    meetingUrl: null,
    transcriptPath: 'transcript.txt',
    summaryPath: null,
    recordingPath: null,
    transcriptDriveId: null,
    summaryDriveId: null,
    notes: null,
    transcriptSegments: null,
    templateId: null,
    speakerCount: 2,
    speakerMap: {},
    speakerContactMap: {},
    attendees: null,
    attendeeEmails: null,
    companies: null,
    chatMessages: null,
    status: 'summarized',
    createdAt: '2026-04-09T13:00:00Z',
    updatedAt: '2026-04-09T14:00:00Z',
    ...overrides,
  }
}

// --- Tests ---

describe('recoverSummaryFromCompanionNote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeSummaryMock.mockReturnValue('recovered-summary-path.md')
  })

  it('strips title line, repairs DB, and returns summary when companion note found', () => {
    getMock.mockReturnValue({ content: 'Acme Q1 Review\n## Executive Summary\n\nStrong quarter.' })
    const meeting = makeMeeting()

    const result = recoverSummaryFromCompanionNote(meeting)

    expect(result).toBe('## Executive Summary\n\nStrong quarter.')
    expect(writeSummaryMock).toHaveBeenCalledWith(
      'meeting-1',
      '## Executive Summary\n\nStrong quarter.',
      'Acme Q1 Review',
      '2026-04-09T13:00:00Z',
      null
    )
    expect(updateMeetingMock).toHaveBeenCalledWith(
      'meeting-1',
      { summaryPath: 'recovered-summary-path.md' },
      'user-1'
    )
  })

  it('returns full content when companion note has no newline (no title line)', () => {
    getMock.mockReturnValue({ content: 'Strong standalone summary.' })
    const meeting = makeMeeting()

    const result = recoverSummaryFromCompanionNote(meeting)

    expect(result).toBe('Strong standalone summary.')
    expect(writeSummaryMock).toHaveBeenCalledWith(
      'meeting-1',
      'Strong standalone summary.',
      expect.any(String),
      expect.any(String),
      null
    )
  })

  it('returns null when no companion note exists', () => {
    getMock.mockReturnValue(undefined)
    const meeting = makeMeeting()

    const result = recoverSummaryFromCompanionNote(meeting)

    expect(result).toBeNull()
    expect(writeSummaryMock).not.toHaveBeenCalled()
    expect(updateMeetingMock).not.toHaveBeenCalled()
  })

  it('returns null and logs warning when writeSummary throws', () => {
    getMock.mockReturnValue({ content: 'Meeting Title\nSummary content here.' })
    writeSummaryMock.mockImplementation(() => { throw new Error('ENOSPC: no space left on device') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const meeting = makeMeeting()

    const result = recoverSummaryFromCompanionNote(meeting)

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SummaryRecovery]'),
      'meeting-1',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})
