/**
 * Tests for the PDF parse cache in file-manager.ts (Issue 4B).
 *
 * What this exercises:
 *
 *   1. cache HIT     — second readLocalFile call for the same (path, mtime, size)
 *                      returns from cache; pdf-parse is NOT invoked twice.
 *   2. mtime change  — cache MISS; pdf-parse re-invoked.
 *   3. size change   — cache MISS; pdf-parse re-invoked.
 *   4. LRU eviction  — over PDF_CACHE_MAX (32) entries, oldest evicted.
 *   5. null cached   — pdfjs-dist also yielding null gets stored; subsequent
 *                      reads return null without re-parsing.
 *
 * Mock boundaries:
 *   - fs           → controlled existsSync, statSync, readFileSync
 *   - pdf-parse    → counted invocations
 *   - pdfjs-dist   → returns null (triggers null caching)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const existsSyncMock = vi.fn()
const statSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}))

vi.mock('../main/storage/paths', () => ({
  getTranscriptsDir: () => '/tmp/t',
  getSummariesDir: () => '/tmp/s',
  getRecordingsDir: () => '/tmp/r',
}))

vi.mock('../main/utils/company-extractor', () => ({
  extractCompanyFromEmail: () => null,
}))

const pdfParseMock = vi.fn()
vi.mock('pdf-parse', () => ({ default: (buf: Buffer) => pdfParseMock(buf) }))

vi.mock('pdfjs-dist/legacy/build/pdf', () => ({
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 0, getPage: vi.fn() }),
  }),
}))

const { readLocalFile, clearPdfCache } = await import('../main/storage/file-manager')

const FAKE_BUF = Buffer.from('%PDF-1.4 fake')

beforeEach(() => {
  vi.clearAllMocks()
  clearPdfCache()
  existsSyncMock.mockReturnValue(true)
  readFileSyncMock.mockReturnValue(FAKE_BUF)
  statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 1_000_000 })
})

describe('readLocalFile PDF cache', () => {
  it('returns cached text on second read with same (path, mtime, size)', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Pricing held at $180/seat. Runway 11 months. ' + 'lorem '.repeat(40),
    })

    const a = await readLocalFile('/files/memo.pdf')
    const b = await readLocalFile('/files/memo.pdf')

    expect(a).toContain('Pricing held')
    expect(b).toBe(a)
    expect(pdfParseMock).toHaveBeenCalledTimes(1)
  })

  it('invalidates when mtimeMs changes', async () => {
    pdfParseMock.mockResolvedValue({ text: 'first ' + 'lorem '.repeat(40) })
    await readLocalFile('/files/memo.pdf')

    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 2_000_000 })
    pdfParseMock.mockResolvedValue({ text: 'second ' + 'lorem '.repeat(40) })
    const second = await readLocalFile('/files/memo.pdf')

    expect(pdfParseMock).toHaveBeenCalledTimes(2)
    expect(second).toContain('second')
  })

  it('invalidates when size changes', async () => {
    pdfParseMock.mockResolvedValue({ text: 'first ' + 'lorem '.repeat(40) })
    await readLocalFile('/files/memo.pdf')

    statSyncMock.mockReturnValue({ size: 9999, mtimeMs: 1_000_000 })
    pdfParseMock.mockResolvedValue({ text: 'resized ' + 'lorem '.repeat(40) })
    const second = await readLocalFile('/files/memo.pdf')

    expect(pdfParseMock).toHaveBeenCalledTimes(2)
    expect(second).toContain('resized')
  })

  it('caches null results so a low-text PDF is not re-parsed twice in a row', async () => {
    pdfParseMock.mockResolvedValue({ text: 'too short' })
    const a = await readLocalFile('/files/scan.pdf')
    const b = await readLocalFile('/files/scan.pdf')

    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(pdfParseMock).toHaveBeenCalledTimes(1)
  })

  it('evicts oldest entries past PDF_CACHE_MAX (32)', async () => {
    pdfParseMock.mockImplementation(async () => ({
      text: 'page-text ' + 'lorem '.repeat(40),
    }))

    for (let i = 0; i < 33; i++) {
      statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 1_000_000 + i })
      await readLocalFile(`/files/m${i}.pdf`)
    }
    expect(pdfParseMock).toHaveBeenCalledTimes(33)

    // The earliest entry (i=0) should now be evicted; reading it triggers a re-parse.
    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 1_000_000 + 0 })
    await readLocalFile('/files/m0.pdf')
    expect(pdfParseMock).toHaveBeenCalledTimes(34)
  })
})
