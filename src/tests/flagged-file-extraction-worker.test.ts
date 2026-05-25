import { describe, expect, it, vi, beforeEach } from 'vitest'

// =============================================================================
// flagged-file-extraction-worker.test.ts — Phase 3 worker state machine.
//
// Verifies:
//   1. Boot drain: rows in 'pending' / stuck 'extracting' get processed.
//   2. Successful extraction: status transitions pending → extracting → done;
//      extracted_text + length + extracted_at populated.
//   3. readLocalFile rejection → status='failed', extraction_error filled.
//   4. readLocalFile returns null (e.g. PDF with no text layer) → 'failed'
//      with the "no extractable text" message; distinguishable from a
//      thrown error.
//   5. notifyPending while a row is in flight → re-scan after current
//      completes; second row drains.
//   6. user_id backfill: rows where userId is null get stamped on first
//      transition (single-user-per-device — getCurrentUserId() fills it).
//
// Boundaries mocked:
//   - getPendingExtractionRows / updateFlaggedFileExtraction (barrel)
//   - readLocalFile (file-manager)
//   - getCurrentUserId
// =============================================================================

const getPendingExtractionRowsMock = vi.fn()
const updateFlaggedFileExtractionMock = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  getPendingExtractionRows: getPendingExtractionRowsMock,
  updateFlaggedFileExtraction: updateFlaggedFileExtractionMock,
}))

const readLocalFileMock = vi.fn()
vi.mock('../main/storage/file-manager', () => ({
  readLocalFile: readLocalFileMock,
}))

const getCurrentUserIdMock = vi.fn()
vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: getCurrentUserIdMock,
}))

const {
  notifyPending,
  startExtractionWorker,
  __test,
} = await import('../main/services/flagged-file-extraction-worker')

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-' + Math.random().toString(36).slice(2, 8),
    companyId: 'co-1',
    userId: 'user-1',
    fileId: '/tmp/file.pdf',
    fileName: 'file.pdf',
    mimeType: 'application/pdf',
    flaggedAt: '2026-05-25T00:00:00Z',
    extractedText: null,
    extractedTextChars: null,
    driveVersion: null,
    flaggedByUserId: 'user-1',
    extractionStatus: 'pending' as const,
    extractionError: null,
    extractedAt: null,
    lamport: '0',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __test.resetState()
  getCurrentUserIdMock.mockReturnValue('current-user')
})

describe('flagged-file-extraction-worker', () => {
  it('1. boot drain processes all pending rows → done', async () => {
    const rows = [
      pendingRow({ id: 'r1', fileId: '/a.txt' }),
      pendingRow({ id: 'r2', fileId: '/b.txt' }),
      pendingRow({ id: 'r3', fileId: '/c.txt' }),
    ]
    // First call returns all 3; second call (post-drain) returns empty.
    getPendingExtractionRowsMock
      .mockReturnValueOnce(rows)
      .mockReturnValue([])
    readLocalFileMock.mockImplementation(
      async (fid: string) => `text for ${fid}`,
    )

    startExtractionWorker()
    // Wait for serial drain to complete.
    await new Promise((r) => setTimeout(r, 50))

    // 3 rows × 2 transitions (pending→extracting + extracting→done) = 6 calls.
    expect(updateFlaggedFileExtractionMock).toHaveBeenCalledTimes(6)
    // Verify the final 'done' transitions carry the extracted text.
    const doneCalls = updateFlaggedFileExtractionMock.mock.calls.filter(
      (c) => (c[1] as { extractionStatus: string }).extractionStatus === 'done',
    )
    expect(doneCalls).toHaveLength(3)
    for (const call of doneCalls) {
      const patch = call[1] as { extractedText: string; extractedTextChars: number }
      expect(patch.extractedText).toMatch(/^text for /)
      expect(patch.extractedTextChars).toBe(patch.extractedText.length)
    }
  })

  it('2. readLocalFile rejects → status=failed with error message', async () => {
    const rows = [pendingRow({ id: 'r-bad', fileId: '/missing.pdf' })]
    getPendingExtractionRowsMock.mockReturnValueOnce(rows).mockReturnValue([])
    readLocalFileMock.mockRejectedValueOnce(new Error('ENOENT: no such file'))

    startExtractionWorker()
    await new Promise((r) => setTimeout(r, 50))

    const failedCall = updateFlaggedFileExtractionMock.mock.calls.find(
      (c) => (c[1] as { extractionStatus: string }).extractionStatus === 'failed',
    )
    expect(failedCall).toBeDefined()
    const patch = failedCall![1] as { extractionError: string }
    expect(patch.extractionError).toContain('ENOENT')
  })

  it('3. readLocalFile returns null → failed with "no extractable text"', async () => {
    const rows = [pendingRow({ id: 'r-blank', fileId: '/encrypted.pdf' })]
    getPendingExtractionRowsMock.mockReturnValueOnce(rows).mockReturnValue([])
    readLocalFileMock.mockResolvedValueOnce(null)

    startExtractionWorker()
    await new Promise((r) => setTimeout(r, 50))

    const failedCall = updateFlaggedFileExtractionMock.mock.calls.find(
      (c) => (c[1] as { extractionStatus: string }).extractionStatus === 'failed',
    )
    expect(failedCall).toBeDefined()
    const patch = failedCall![1] as { extractionError: string }
    expect(patch.extractionError).toMatch(/no extractable text/i)
  })

  it('4. notifyPending while draining → re-scan + drain new row', async () => {
    const firstBatch = [pendingRow({ id: 'r-first', fileId: '/first.txt' })]
    const secondBatch = [pendingRow({ id: 'r-second', fileId: '/second.txt' })]
    getPendingExtractionRowsMock
      .mockReturnValueOnce(firstBatch)
      .mockReturnValueOnce(secondBatch)
      .mockReturnValue([])
    readLocalFileMock.mockImplementation(async (fid: string) => {
      // While the first row is in flight, simulate a new flag arriving.
      if (fid === '/first.txt') notifyPending()
      return `text for ${fid}`
    })

    startExtractionWorker()
    await new Promise((r) => setTimeout(r, 50))

    // Both rows should have done transitions.
    const doneRowIds = updateFlaggedFileExtractionMock.mock.calls
      .filter((c) => (c[1] as { extractionStatus: string }).extractionStatus === 'done')
      .map((c) => c[0])
    expect(doneRowIds).toContain('r-first')
    expect(doneRowIds).toContain('r-second')
  })

  it('5. row with NULL user_id → backfilled from getCurrentUserId on first transition', async () => {
    const rows = [pendingRow({ id: 'r-nouser', userId: null, fileId: '/a.txt' })]
    getPendingExtractionRowsMock.mockReturnValueOnce(rows).mockReturnValue([])
    readLocalFileMock.mockResolvedValueOnce('contents')

    startExtractionWorker()
    await new Promise((r) => setTimeout(r, 50))

    // First update (pending → extracting) should carry user_id.
    const firstCall = updateFlaggedFileExtractionMock.mock.calls.find(
      (c) => (c[1] as { extractionStatus: string }).extractionStatus === 'extracting',
    )
    expect(firstCall).toBeDefined()
    const patch = firstCall![1] as { userId?: string }
    expect(patch.userId).toBe('current-user')
  })

  it('6. row that already had user_id is NOT backfilled', async () => {
    const rows = [pendingRow({ id: 'r-stamped', userId: 'user-existing' })]
    getPendingExtractionRowsMock.mockReturnValueOnce(rows).mockReturnValue([])
    readLocalFileMock.mockResolvedValueOnce('contents')

    startExtractionWorker()
    await new Promise((r) => setTimeout(r, 50))

    const firstCall = updateFlaggedFileExtractionMock.mock.calls.find(
      (c) => (c[1] as { extractionStatus: string }).extractionStatus === 'extracting',
    )
    const patch = firstCall![1] as { userId?: string }
    expect(patch.userId).toBeUndefined()
  })

  it('7. notifyPending while idle → drain starts immediately', async () => {
    const rows = [pendingRow({ id: 'r-arrived', fileId: '/x.txt' })]
    getPendingExtractionRowsMock.mockReturnValueOnce(rows).mockReturnValue([])
    readLocalFileMock.mockResolvedValueOnce('x contents')

    // No startExtractionWorker(); rely on notifyPending only.
    notifyPending()
    await new Promise((r) => setTimeout(r, 50))

    expect(updateFlaggedFileExtractionMock).toHaveBeenCalled()
  })
})
