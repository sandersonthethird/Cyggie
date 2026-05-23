/**
 * Unit tests for backfillMissingSummaries (Item 4 of the mobile summary tab).
 *
 * Mock boundaries:
 *   - @cyggie/db/sqlite/connection  → getDatabase returns a prepare() stub
 *     whose .all() yields the seeded BackfillRow list. We DON'T mock SQLite
 *     itself — we only need the row iteration.
 *   - @cyggie/db/sqlite/repositories → mock the barrel `updateMeeting` so
 *     we can assert call args without exercising withSync / outbox.
 *   - ../main/storage/file-manager  → mock readSummary so each test can
 *     control what content each row's summary_path resolves to.
 *
 * Mirrors the mocking pattern from
 * src/tests/summarizer-emailtocontactid.test.ts (barrel-mock approach).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// updateMeeting from the barrel — captured for call-arg assertions.
const mockUpdateMeeting = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
}))

// readSummary from the desktop file-manager. Default returns null (no file);
// tests can swap behavior per case.
const mockReadSummary = vi.fn<(filename: string) => string | null>()
vi.mock('../main/storage/file-manager', () => ({
  readSummary: (filename: string) => mockReadSummary(filename),
}))

// getDatabase().prepare().all() returns the seeded rows. We don't need any
// other DB methods because the backfill only does a single SELECT.
let seededRows: Array<{ id: string; summary_path: string }> = []
const prepareMock = vi.fn(() => ({ all: () => seededRows }))
vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({ prepare: prepareMock }),
}))

const { backfillMissingSummaries } = await import(
  '../main/services/summary-backfill.service'
)

const USER_ID = 'user-aaa'

beforeEach(() => {
  vi.clearAllMocks()
  seededRows = []
  mockReadSummary.mockReset()
  mockReadSummary.mockReturnValue(null)
})

describe('backfillMissingSummaries', () => {
  it('1: empty pass — no rows means no work, all counters zero', () => {
    seededRows = []
    const result = backfillMissingSummaries(USER_ID)
    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 0 })
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
    expect(mockReadSummary).not.toHaveBeenCalled()
  })

  it('2: happy path — N rows with valid files yield N updates with correct args', () => {
    seededRows = [
      { id: 'm1', summary_path: 'summaries/m1.md' },
      { id: 'm2', summary_path: 'summaries/m2.md' },
    ]
    mockReadSummary.mockImplementation((path) =>
      path === 'summaries/m1.md' ? '# m1 summary' : '# m2 summary',
    )

    const result = backfillMissingSummaries(USER_ID)

    expect(result).toEqual({ updated: 2, skipped: 0, missingFile: 0 })
    expect(mockUpdateMeeting).toHaveBeenCalledTimes(2)
    expect(mockUpdateMeeting).toHaveBeenNthCalledWith(
      1,
      'm1',
      { summary: '# m1 summary' },
      USER_ID,
    )
    expect(mockUpdateMeeting).toHaveBeenNthCalledWith(
      2,
      'm2',
      { summary: '# m2 summary' },
      USER_ID,
    )
  })

  it('3: WHERE clause excludes already-backfilled rows — they never reach the loop', () => {
    // This test stands in for the SQL-layer behavior: if the planner has
    // done its job, only rows with summary IS NULL come through. The
    // assertion is on the SELECT — it must include the IS NULL guard so
    // a future refactor can't silently widen the row set.
    seededRows = []
    backfillMissingSummaries(USER_ID)
    expect(prepareMock).toHaveBeenCalledTimes(1)
    const sql = prepareMock.mock.calls[0]?.[0] as string
    expect(sql).toContain('summary IS NULL')
    expect(sql).toContain('summary_path IS NOT NULL')
  })

  it('4: missing file — readSummary returns null → missingFile++, no updateMeeting call', () => {
    seededRows = [{ id: 'm-gone', summary_path: 'summaries/gone.md' }]
    mockReadSummary.mockReturnValue(null)

    const result = backfillMissingSummaries(USER_ID)

    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 1 })
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
  })

  it('5: whitespace-only content treated as missing — avoids wasted outbox emission', () => {
    seededRows = [{ id: 'm-empty', summary_path: 'summaries/empty.md' }]
    mockReadSummary.mockReturnValue('   \n\t  ')

    const result = backfillMissingSummaries(USER_ID)

    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 1 })
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
  })

  it('6: userId === null — early return, no DB query, no updates', () => {
    seededRows = [{ id: 'm1', summary_path: 'summaries/m1.md' }]
    mockReadSummary.mockReturnValue('# would have backfilled')

    const result = backfillMissingSummaries(null)

    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 0 })
    expect(prepareMock).not.toHaveBeenCalled()
    expect(mockReadSummary).not.toHaveBeenCalled()
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
  })

  it('7: updateMeeting throws on one row — caught, skipped++, loop continues', () => {
    seededRows = [
      { id: 'm-bad', summary_path: 'summaries/bad.md' },
      { id: 'm-ok', summary_path: 'summaries/ok.md' },
    ]
    mockReadSummary.mockImplementation((path) =>
      path === 'summaries/bad.md' ? '# bad' : '# ok',
    )
    mockUpdateMeeting.mockImplementation((id: string) => {
      if (id === 'm-bad') throw new Error('SQLite locked')
    })

    const result = backfillMissingSummaries(USER_ID)

    // The bad row counts as skipped; the ok row goes through normally.
    expect(result).toEqual({ updated: 1, skipped: 1, missingFile: 0 })
    expect(mockUpdateMeeting).toHaveBeenCalledTimes(2)
  })

  it('readSummary throwing (e.g. permission denied) is treated as missingFile, not skipped', () => {
    seededRows = [{ id: 'm-perm', summary_path: 'summaries/perm.md' }]
    mockReadSummary.mockImplementation(() => {
      throw new Error('EACCES')
    })

    const result = backfillMissingSummaries(USER_ID)

    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 1 })
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
  })

  it('EINTR retry: first read throws EINTR, second succeeds, updateMeeting runs', () => {
    // macOS readFileSync surfaces EINTR under load — must retry, not skip.
    // Without retry, historical summaries get lost on a transient signal.
    seededRows = [{ id: 'm-flaky', summary_path: 'summaries/flaky.md' }]
    let calls = 0
    mockReadSummary.mockImplementation(() => {
      calls++
      if (calls === 1) {
        const err = new Error('EINTR: interrupted system call, read') as Error & {
          code?: string
        }
        err.code = 'EINTR'
        throw err
      }
      return '# recovered summary'
    })

    const result = backfillMissingSummaries(USER_ID)

    expect(result).toEqual({ updated: 1, skipped: 0, missingFile: 0 })
    expect(calls).toBe(2)
    expect(mockUpdateMeeting).toHaveBeenCalledWith(
      'm-flaky',
      { summary: '# recovered summary' },
      USER_ID,
    )
  })

  it('EINTR retry: gives up after MAX_READ_ATTEMPTS consecutive EINTRs', () => {
    seededRows = [{ id: 'm-persistent', summary_path: 'summaries/p.md' }]
    let calls = 0
    mockReadSummary.mockImplementation(() => {
      calls++
      const err = new Error('EINTR') as Error & { code?: string }
      err.code = 'EINTR'
      throw err
    })

    const result = backfillMissingSummaries(USER_ID)

    // 3 attempts (MAX_READ_ATTEMPTS), then missingFile++
    expect(calls).toBe(3)
    expect(result).toEqual({ updated: 0, skipped: 0, missingFile: 1 })
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
  })

  it('non-EINTR errors do NOT trigger retry (single call)', () => {
    // ENOENT / EACCES / etc. are persistent — retrying wastes effort
    // and muddies logs. Only EINTR retries.
    seededRows = [{ id: 'm-perm', summary_path: 'summaries/p.md' }]
    let calls = 0
    mockReadSummary.mockImplementation(() => {
      calls++
      const err = new Error('EACCES') as Error & { code?: string }
      err.code = 'EACCES'
      throw err
    })

    backfillMissingSummaries(USER_ID)

    expect(calls).toBe(1)
  })
})
