/**
 * Tests for context-formatters.ts — pure markdown formatters used by every
 * chat path.
 *
 *   What this exercises:
 *     1. Empty inputs return ''
 *     2. Cap clamping (perItem, total)
 *     3. MIN_BODY filter on emails (< 50 chars skipped)
 *     4. MIN_CONTENT filter on notes (< 10 chars skipped)
 *     5. MIN_FILE filter on flagged files (< 50 chars skipped, doesn't count
 *        toward total)
 *     6. "Summaries first / transcripts as fallback" priority for meetings
 *     7. Date formatting + missing-date handling for notes
 *     8. Wire-format invariants (header + separators) so the assembled
 *        context matches the parity baseline
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  SectionCaps,
  MeetingRef,
  MeetingFull,
  NoteRef,
} from '@cyggie/services/llm/context-formatters'

const mockReadSummary = vi.fn<[string], string | null>()
const mockReadTranscript = vi.fn<[string], string | null>()
const mockReadLocalFile = vi.fn<[string], Promise<string | null>>()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (p: string) => mockReadSummary(p),
  readTranscript: (p: string) => mockReadTranscript(p),
  readLocalFile: async (p: string) => mockReadLocalFile(p),
}))

const {
  formatMeetingsSection,
  formatNotesSection,
  formatFlaggedFilesSection,
} = await import('@cyggie/services/llm/context-formatters')

beforeEach(() => {
  vi.clearAllMocks()
  mockReadSummary.mockReturnValue(null)
  mockReadTranscript.mockReturnValue(null)
  mockReadLocalFile.mockResolvedValue(null)
})

const generousCaps: SectionCaps = { perItem: 10_000, total: 100_000 }

// ── Meetings ───────────────────────────────────────────────────────────

describe('formatMeetingsSection', () => {
  function fakeMeeting(id: string, title: string, date = '2026-05-02'): MeetingRef {
    return { id, title, date }
  }

  function loadFull(map: Record<string, MeetingFull>): (id: string) => MeetingFull | null {
    return (id) => map[id] ?? null
  }

  it('returns empty string when no meetings render', () => {
    const out = formatMeetingsSection({
      meetings: [],
      loadFull: () => null,
      summaryCaps: generousCaps,
      transcriptCaps: generousCaps,
    })
    expect(out).toBe('')
  })

  it('returns empty string when meetings exist but have no summaries or transcripts', () => {
    const out = formatMeetingsSection({
      meetings: [fakeMeeting('m1', 'Empty meeting')],
      loadFull: loadFull({ m1: { id: 'm1' } }),
      summaryCaps: generousCaps,
      transcriptCaps: generousCaps,
    })
    expect(out).toBe('')
  })

  it('renders summaries section when summary exists', () => {
    mockReadSummary.mockReturnValue('Discussed Q2 pricing reset.')
    const out = formatMeetingsSection({
      meetings: [fakeMeeting('m1', 'Init Labs partner call', '2026-05-02')],
      loadFull: loadFull({ m1: { id: 'm1', summaryPath: '/fake/s.txt' } }),
      summaryCaps: generousCaps,
      transcriptCaps: generousCaps,
    })
    expect(out).toContain('## Meeting Summaries')
    expect(out).toContain('### Init Labs partner call (')
    expect(out).toContain('Discussed Q2 pricing reset.')
    expect(out).not.toContain('## Meeting Transcripts')
  })

  it('falls back to transcript when no summary', () => {
    mockReadTranscript.mockReturnValue('Sandy: ... Priya: ...')
    const out = formatMeetingsSection({
      meetings: [fakeMeeting('m1', 'No-summary meeting')],
      loadFull: loadFull({ m1: { id: 'm1', transcriptPath: '/fake/t.txt' } }),
      summaryCaps: generousCaps,
      transcriptCaps: generousCaps,
    })
    expect(out).toContain('## Meeting Transcripts')
    expect(out).toContain('Sandy: ... Priya: ...')
    expect(out).not.toContain('## Meeting Summaries')
  })

  it('summaries-first / transcripts-as-fallback priority', () => {
    mockReadSummary.mockImplementation((p) => (p === '/s1' ? 'Summary 1.' : null))
    mockReadTranscript.mockReturnValue('Transcript text.')
    const out = formatMeetingsSection({
      meetings: [
        fakeMeeting('m1', 'Has summary'),
        fakeMeeting('m2', 'Only transcript'),
      ],
      loadFull: loadFull({
        m1: { id: 'm1', summaryPath: '/s1', transcriptPath: '/t1' },
        m2: { id: 'm2', transcriptPath: '/t2' },
      }),
      summaryCaps: generousCaps,
      transcriptCaps: generousCaps,
    })
    // Meeting m1 should ONLY appear in Summaries (its transcript is suppressed).
    const transcriptSection = out.split('## Meeting Transcripts')[1] ?? ''
    expect(transcriptSection).toContain('Only transcript')
    expect(transcriptSection).not.toContain('Has summary')
  })

  it('truncates excerpts that exceed perItem cap', () => {
    mockReadSummary.mockReturnValue('A'.repeat(500))
    const out = formatMeetingsSection({
      meetings: [fakeMeeting('m1', 'Long')],
      loadFull: loadFull({ m1: { id: 'm1', summaryPath: '/s' } }),
      summaryCaps: { perItem: 100, total: 1000 },
      transcriptCaps: generousCaps,
    })
    expect(out).toMatch(/A{100}\.\.\./)
    expect(out).not.toMatch(/A{101}/)
  })

  it('respects total cap (stops adding more summaries)', () => {
    mockReadSummary.mockReturnValue('B'.repeat(50))
    const meetings = [
      fakeMeeting('m1', 'One'),
      fakeMeeting('m2', 'Two'),
      fakeMeeting('m3', 'Three'),
    ]
    const out = formatMeetingsSection({
      meetings,
      loadFull: loadFull({
        m1: { id: 'm1', summaryPath: '/a' },
        m2: { id: 'm2', summaryPath: '/b' },
        m3: { id: 'm3', summaryPath: '/c' },
      }),
      summaryCaps: { perItem: 50, total: 60 }, // ~1 summary fits before stop
      transcriptCaps: generousCaps,
    })
    // First two summaries: m1 added (total=50), m2 attempted (total<60, fits, total=100), m3 stops
    // Note: stops AFTER pushing the one that crosses the cap, not before.
    expect(out).toContain('### One')
    expect(out).not.toContain('### Three')
  })
})

// Email rendering is covered by the shared renderer's suite in
// packages/services/src/llm/email-signal.test.ts (renderEmailRows /
// stripQuotedHistory / truncateEmailBody). The old formatEmailsSection was
// removed (decisions 1A/2A + Part F).

// ── Notes ──────────────────────────────────────────────────────────────

describe('formatNotesSection', () => {
  it('returns empty string when no notes', () => {
    expect(formatNotesSection([], generousCaps)).toBe('')
  })

  it('skips notes with content < 10 chars', () => {
    const notes: NoteRef[] = [{ content: 'short', createdAt: '2026-05-01' }]
    expect(formatNotesSection(notes, generousCaps)).toBe('')
  })

  it('renders header + content with date prefix', () => {
    const notes: NoteRef[] = [
      { content: 'Bobby focuses on Series A AI infrastructure deals.', createdAt: '2026-04-15T00:00:00Z' },
    ]
    const out = formatNotesSection(notes, generousCaps)
    expect(out).toContain('## Notes')
    expect(out).toMatch(/\(\d+\/\d+\/\d+\) Bobby focuses on Series A/)
  })

  it('omits date prefix when createdAt missing', () => {
    const notes: NoteRef[] = [{ content: 'Note without a date timestamp.' }]
    const out = formatNotesSection(notes, generousCaps)
    expect(out).toContain('Note without a date timestamp')
    expect(out).not.toMatch(/^\(/)
  })

  it('renders title in **bold** when present', () => {
    const notes: NoteRef[] = [
      { title: 'Investment thesis', content: 'Init Labs fits our infra-AI thesis.', createdAt: '2026-05-01' },
    ]
    const out = formatNotesSection(notes, generousCaps)
    expect(out).toContain('**Investment thesis**')
    expect(out).toContain('Init Labs fits our infra-AI thesis.')
  })

  it('separates multiple notes with `\\n\\n`', () => {
    const notes: NoteRef[] = [
      { content: 'Note one is long enough.', createdAt: '2026-05-01' },
      { content: 'Note two is also long enough.', createdAt: '2026-05-02' },
    ]
    const out = formatNotesSection(notes, generousCaps)
    const items = out.split('\n\n')
    expect(items.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Flagged files ──────────────────────────────────────────────────────

describe('formatFlaggedFilesSection', () => {
  it('returns empty string when no fileIds', async () => {
    expect(await formatFlaggedFilesSection([], generousCaps)).toBe('')
  })

  it('renders header + ### filename + content', async () => {
    mockReadLocalFile.mockResolvedValue(
      'Init Labs Memo: Investment Thesis. AI infrastructure with $180/seat enterprise pricing.'
    )
    const out = await formatFlaggedFilesSection(
      [{ fileId: '/fake/init-labs-memo.pdf', fileName: 'init-labs-memo.pdf', mimeType: null }],
      generousCaps,
    )
    expect(out).toContain('## Linked Documents')
    expect(out).toContain('### init-labs-memo.pdf')
    expect(out).toContain('Init Labs Memo')
  })

  it('silently skips files that fail to read (returns null)', async () => {
    mockReadLocalFile.mockResolvedValue(null)
    const out = await formatFlaggedFilesSection(['/missing.pdf'], generousCaps)
    expect(out).toBe('')
  })

  it('skips files with content < 50 chars; remaining files still render', async () => {
    mockReadLocalFile.mockImplementation(async (p) => {
      if (p === '/short.pdf') return 'tiny'
      if (p === '/long.pdf') {
        return 'A long enough file body to pass the 50-char minimum filter for chat context inclusion.'
      }
      return null
    })
    const out = await formatFlaggedFilesSection(
      [
        { fileId: '/short.pdf', fileName: 'short.pdf', mimeType: null },
        { fileId: '/long.pdf', fileName: 'long.pdf', mimeType: null },
      ],
      generousCaps,
    )
    expect(out).toContain('### long.pdf')
    expect(out).not.toContain('### short.pdf')
  })

  it('truncates excerpts above perItem cap', async () => {
    mockReadLocalFile.mockResolvedValue('Z'.repeat(2000))
    const out = await formatFlaggedFilesSection(
      [{ fileId: '/big.pdf', fileName: 'big.pdf', mimeType: null }],
      { perItem: 100, total: 1000 },
    )
    expect(out).toMatch(/Z{100}\.\.\./)
  })

  it('stops adding more files once total cap reached', async () => {
    mockReadLocalFile.mockResolvedValue('Y'.repeat(80))
    const out = await formatFlaggedFilesSection(
      [
        { fileId: '/a.pdf', fileName: 'a.pdf', mimeType: null },
        { fileId: '/b.pdf', fileName: 'b.pdf', mimeType: null },
        { fileId: '/c.pdf', fileName: 'c.pdf', mimeType: null },
      ],
      { perItem: 80, total: 100 },
    )
    expect(out).toContain('### a.pdf')
    expect(out).not.toContain('### c.pdf')
  })
})
