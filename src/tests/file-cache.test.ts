/**
 * Tests for the file-extraction parse cache in file-manager.ts (Issue 4B,
 * extended to docx + xlsx in phase 1).
 *
 * What this exercises:
 *
 *   PDF cases (5 — pre-existing):
 *     1. cache HIT      — second readLocalFile call for the same (path, mtime, size)
 *                         returns from cache; pdf-parse is NOT invoked twice.
 *     2. mtime change   — cache MISS; pdf-parse re-invoked.
 *     3. size change    — cache MISS; pdf-parse re-invoked.
 *     4. LRU eviction   — over PARSE_CACHE_MAX (32) entries, oldest evicted.
 *     5. null cached    — pdfjs-dist also yielding null gets stored; subsequent
 *                         reads return null without re-parsing.
 *
 *   Phase 1 additions:
 *     6. docx happy     — mammoth output flows through readLocalFile.
 *     7. docx cache hit — second read doesn't re-invoke mammoth.
 *     8. docx parse err — exception logged + null cached.
 *     9. docx mtime     — invalidation works for docx (uses same cache).
 *    10. xlsx happy     — exceljs sheet/row iteration → labelled CSV markdown.
 *    11. xlsx empty     — empty workbook (no sheets) → null cached.
 *    12. xlsx cache hit — second read doesn't re-load workbook.
 *    13. log fires      — `[chat-files] parse failed format=…` logs on docx + xlsx errors.
 *
 * Mock boundaries:
 *   - fs           → controlled existsSync, statSync, readFileSync
 *   - pdf-parse    → counted invocations
 *   - pdfjs-dist   → returns null (triggers null caching)
 *   - mammoth      → counted invocations, configurable result/throw
 *   - exceljs      → Workbook with controllable eachSheet/eachRow
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

// v5 ships the Node-compatible build at legacy/build/pdf.mjs (the CJS
// `legacy/build/pdf` entry was removed). Mock that path; include
// GlobalWorkerOptions because file-manager sets workerSrc at load time.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 0, getPage: vi.fn() }),
  }),
}))

const mammothExtractMock = vi.fn()
vi.mock('mammoth', () => ({
  default: {
    extractRawText: (opts: { buffer: Buffer }) => mammothExtractMock(opts),
  },
}))

// exceljs stub — `wb.xlsx.load(buf)` resolves; `wb.eachSheet` walks a
// configurable fixture set. Tests rebind exceljsFixture between cases.
type RowFixture = unknown[][]
type SheetFixture = { name: string; rows: RowFixture }
let exceljsFixture: SheetFixture[] = []
let exceljsThrowOnLoad: Error | null = null
vi.mock('exceljs', () => ({
  default: {
    Workbook: class {
      xlsx = {
        load: async () => {
          if (exceljsThrowOnLoad) throw exceljsThrowOnLoad
        },
      }
      eachSheet(cb: (s: { name: string; eachRow: (opts: unknown, fn: (row: { values: unknown[] }) => void) => void }) => void) {
        for (const sheet of exceljsFixture) {
          cb({
            name: sheet.name,
            eachRow: (_opts, fn) => {
              for (const row of sheet.rows) {
                // exceljs convention: values[0] is empty, real cells start at 1.
                fn({ values: [undefined, ...row] })
              }
            },
          })
        }
      }
    },
  },
}))

// Phase 2: mock the Drive export entry-point used by readDriveFile.
const exportDriveFileMock = vi.fn()
vi.mock('../main/drive/google-drive', () => ({
  exportDriveFile: (fileId: string, mime: string) => exportDriveFileMock(fileId, mime),
  GOOGLE_DOC_MIME: 'application/vnd.google-apps.document',
  GOOGLE_SHEET_MIME: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_SLIDES_MIME: 'application/vnd.google-apps.presentation',
}))

vi.mock('../main/calendar/google-auth', () => ({
  hasDriveContentScope: () => true,
}))

const { readLocalFile, clearParseCache, clearDriveCache } = await import('../main/storage/file-manager')

const FAKE_BUF = Buffer.from('%PDF-1.4 fake')

beforeEach(() => {
  vi.clearAllMocks()
  clearParseCache()
  existsSyncMock.mockReturnValue(true)
  readFileSyncMock.mockReturnValue(FAKE_BUF)
  statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 1_000_000 })
  exceljsFixture = []
  exceljsThrowOnLoad = null
  exportDriveFileMock.mockReset()
})

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation'

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

  it('evicts oldest entries past PARSE_CACHE_MAX (32)', async () => {
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

describe('readLocalFile docx', () => {
  it('returns mammoth-extracted text for a .docx', async () => {
    mammothExtractMock.mockResolvedValue({ value: 'Q2 partner memo body — pricing held at $180/seat.' })

    const text = await readLocalFile('/files/memo.docx')

    expect(text).toContain('Q2 partner memo body')
    expect(mammothExtractMock).toHaveBeenCalledTimes(1)
  })

  it('returns cached text on second .docx read with same (path, mtime, size)', async () => {
    mammothExtractMock.mockResolvedValue({ value: 'Init Labs memo — Series A target Q3.' })

    const a = await readLocalFile('/files/memo.docx')
    const b = await readLocalFile('/files/memo.docx')

    expect(a).toBe(b)
    expect(mammothExtractMock).toHaveBeenCalledTimes(1)
  })

  it('returns null and caches null when mammoth throws', async () => {
    mammothExtractMock.mockRejectedValue(new Error('corrupt zip'))

    const a = await readLocalFile('/files/bad.docx')
    const b = await readLocalFile('/files/bad.docx')

    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(mammothExtractMock).toHaveBeenCalledTimes(1)
  })

  it('invalidates docx cache when mtimeMs changes', async () => {
    mammothExtractMock.mockResolvedValue({ value: 'first revision' })
    await readLocalFile('/files/memo.docx')

    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: 2_000_000 })
    mammothExtractMock.mockResolvedValue({ value: 'second revision' })
    const second = await readLocalFile('/files/memo.docx')

    expect(mammothExtractMock).toHaveBeenCalledTimes(2)
    expect(second).toContain('second revision')
  })
})

describe('readLocalFile xlsx', () => {
  it('renders multi-sheet workbook as labelled-sheet CSV markdown', async () => {
    exceljsFixture = [
      { name: 'Cap Table', rows: [['Holder', 'Shares'], ['Founder', 4_000_000], ['Series A', 1_000_000]] },
      { name: 'Model', rows: [['Year', 'Revenue'], [2026, '$1.2M'], [2027, '$3.5M']] },
    ]

    const text = await readLocalFile('/files/cap.xlsx')

    expect(text).toContain('# Sheet: Cap Table')
    expect(text).toContain('# Sheet: Model')
    expect(text).toContain('Holder,Shares')
    expect(text).toContain('Founder,4000000')
    expect(text).toContain('2026,$1.2M')
  })

  it('returns null for an empty workbook (no sheets)', async () => {
    exceljsFixture = []
    const a = await readLocalFile('/files/empty.xlsx')
    const b = await readLocalFile('/files/empty.xlsx')

    expect(a).toBeNull()
    expect(b).toBeNull()
  })

  it('returns cached text on second .xlsx read with same (path, mtime, size)', async () => {
    exceljsFixture = [{ name: 'Sheet1', rows: [['A', 'B'], [1, 2]] }]

    const a = await readLocalFile('/files/sheet.xlsx')
    // Mutate the fixture; a true cache hit ignores the change.
    exceljsFixture = [{ name: 'NEVER', rows: [['x', 'y']] }]
    const b = await readLocalFile('/files/sheet.xlsx')

    expect(b).toBe(a)
    expect(b).toContain('# Sheet: Sheet1')
    expect(b).not.toContain('# Sheet: NEVER')
  })
})

describe('[chat-files] parse-failed log', () => {
  it('logs format=docx with the path on mammoth error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mammothExtractMock.mockRejectedValue(new Error('corrupt zip'))

    const result = await readLocalFile('/files/bad.docx')

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[chat-files\] parse failed format=docx path=\/files\/bad\.docx/),
    )
    warnSpy.mockRestore()
  })

  it('logs format=xlsx with the path on exceljs error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    exceljsThrowOnLoad = new Error('not a zip')

    const result = await readLocalFile('/files/bad.xlsx')

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[chat-files\] parse failed format=xlsx path=\/files\/bad\.xlsx/),
    )
    warnSpy.mockRestore()
  })
})

// ── Phase 2: Drive native files ────────────────────────────────────────────

describe('readLocalFile Drive dispatch', () => {
  it('exports a Google Doc and returns plain text via readLocalFile dispatch', async () => {
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('Q2 partner memo body — pricing held at $180/seat.', 'utf-8'),
    })

    const text = await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)

    expect(text).toContain('Q2 partner memo body')
    expect(exportDriveFileMock).toHaveBeenCalledWith('1ABC_doc', GOOGLE_DOC_MIME)
    // existsSync must NOT be invoked for a Drive ID — proves the dispatch happened
    // before the local-file gate.
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('exports a Google Slides deck and returns plain text', async () => {
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('Slide 1: thesis\n\nSlide 2: market\n', 'utf-8'),
    })

    const text = await readLocalFile('1ABC_slides', GOOGLE_SLIDES_MIME)

    expect(text).toContain('Slide 1: thesis')
    expect(text).toContain('Slide 2: market')
  })

  it('exports a Google Sheet as XLSX and round-trips through extractXlsxText', async () => {
    // The XLSX buffer returned by exportDriveFile gets fed into the existing
    // exceljs path; we hijack the same exceljsFixture used by phase-1 tests.
    exceljsFixture = [
      { name: 'Cap Table', rows: [['Holder', 'Shares'], ['Founder', 4_000_000]] },
    ]
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('fake-xlsx-bytes'),
    })

    const text = await readLocalFile('1ABC_sheet', GOOGLE_SHEET_MIME)

    expect(text).toContain('# Sheet: Cap Table')
    expect(text).toContain('Holder,Shares')
    expect(text).toContain('Founder,4000000')
  })

  it('caches Drive results within the TTL — second read does not re-export', async () => {
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('Init Labs memo', 'utf-8'),
    })

    const a = await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)
    const b = await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)

    expect(a).toBe(b)
    expect(exportDriveFileMock).toHaveBeenCalledTimes(1)
  })

  it('Drive cache TTL expiry triggers a second export', async () => {
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('first revision', 'utf-8'),
    })
    const realNow = Date.now
    let now = realNow.call(Date)
    Date.now = () => now

    await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)

    // Fast-forward 31 minutes and update the export to confirm fresh fetch.
    now += 31 * 60 * 1000
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('second revision', 'utf-8'),
    })
    const second = await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)

    expect(exportDriveFileMock).toHaveBeenCalledTimes(2)
    expect(second).toContain('second revision')
    Date.now = realNow
  })

  it('logs and returns null when Drive returns DRIVE_SCOPE_INSUFFICIENT', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    exportDriveFileMock.mockResolvedValue({
      ok: false,
      error: { kind: 'DRIVE_SCOPE_INSUFFICIENT' },
    })

    const result = await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[chat-files\] drive export failed driveId=1ABC_doc mime=application\/vnd\.google-apps\.document kind=DRIVE_SCOPE_INSUFFICIENT/,
      ),
    )
    warnSpy.mockRestore()
  })

  it('clearDriveCache removes drive|* keys but preserves local entries', async () => {
    // Seed both a Drive entry and a local PDF entry.
    exportDriveFileMock.mockResolvedValue({
      ok: true,
      buf: Buffer.from('drive content', 'utf-8'),
    })
    pdfParseMock.mockResolvedValue({
      text: 'local pdf content ' + 'lorem '.repeat(40),
    })
    await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)
    await readLocalFile('/files/local.pdf')

    clearDriveCache()

    // After clearDriveCache, Drive read re-exports; local read still hits cache.
    await readLocalFile('1ABC_doc', GOOGLE_DOC_MIME)
    await readLocalFile('/files/local.pdf')

    expect(exportDriveFileMock).toHaveBeenCalledTimes(2) // re-fetched
    expect(pdfParseMock).toHaveBeenCalledTimes(1) // cache hit
  })
})
