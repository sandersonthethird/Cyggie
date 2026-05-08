import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, statSync } from 'fs'
import { join, extname } from 'path'
import { getTranscriptsDir, getSummariesDir, getRecordingsDir } from './paths'
import { extractCompanyFromEmail } from '../utils/company-extractor'
import { hasDriveContentScope } from '../calendar/google-auth'

// Domain to exclude from filenames (user's own domain)
const EXCLUDED_DOMAIN = 'redswanventures.com'

/**
 * Extract person's first name from display name or email
 */
function extractPersonName(attendee: string): string | null {
  // If it looks like an email, extract the part before @
  if (attendee.includes('@')) {
    const localPart = attendee.split('@')[0]
    // Convert firstname.lastname or firstname_lastname to just firstname
    const firstName = localPart.split(/[._]/)[0]
    return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
  }
  // Otherwise use the first word of the display name
  const firstName = attendee.split(/\s+/)[0]
  return firstName || null
}

/**
 * Build attendee prefix for filename from attendee list.
 * Filters out user's own domain and extracts company + person name.
 */
function buildAttendeePrefix(attendees: string[] | null | undefined): string {
  if (!attendees || attendees.length === 0) return ''

  // Filter out user's own domain
  const filteredAttendees = attendees.filter((a) => {
    const lower = a.toLowerCase()
    return !lower.includes(EXCLUDED_DOMAIN)
  })

  if (filteredAttendees.length === 0) return ''

  // Try to extract company from the first attendee with a corporate email
  let company: string | null = null
  let personName: string | null = null

  for (const attendee of filteredAttendees) {
    if (!company && attendee.includes('@')) {
      company = extractCompanyFromEmail(attendee)
    }
    if (!personName) {
      personName = extractPersonName(attendee)
    }
    if (company && personName) break
  }

  // Build prefix: "Company - Person" or just "Person" or just "Company"
  const parts: string[] = []
  if (company) parts.push(company)
  if (personName) parts.push(personName)

  return parts.length > 0 ? parts.join(' - ') : ''
}

function sanitizeFilename(title: string, date: string, attendees?: string[] | null): string {
  // Remove filesystem-unsafe characters
  let safe = title.replace(/[\/\\:*?"<>|]/g, '-')
  // Collapse multiple dashes/spaces into single dash
  safe = safe.replace(/[-\s]+/g, ' ').trim()
  // Limit length to keep paths manageable
  if (safe.length > 60) {
    safe = safe.substring(0, 60).trim()
  }
  // Format date as YYYY-MM-DD
  const d = new Date(date)
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  // Build attendee prefix
  const attendeePrefix = buildAttendeePrefix(attendees)

  // Combine: "Company - Person - Title - Date" or "Title - Date"
  if (attendeePrefix) {
    return `${attendeePrefix} - ${safe} - ${dateStr}`
  }
  return safe ? `${safe} - ${dateStr}` : dateStr
}

export function writeTranscript(
  meetingId: string,
  content: string,
  title?: string,
  date?: string,
  attendees?: string[] | null
): string {
  const shortId = meetingId.split('-')[0]
  const filename =
    title && date ? `${sanitizeFilename(title, date, attendees)} (${shortId}).md` : `${meetingId}.md`
  const filepath = join(getTranscriptsDir(), filename)
  writeFileSync(filepath, content, 'utf-8')
  return filename
}

export function updateTranscriptContent(filename: string, content: string): void {
  const filepath = join(getTranscriptsDir(), filename)
  writeFileSync(filepath, content, 'utf-8')
}

export function readTranscript(filename: string): string | null {
  const filepath = join(getTranscriptsDir(), filename)
  if (!existsSync(filepath)) return null
  return readFileSync(filepath, 'utf-8')
}

export function writeSummary(
  meetingId: string,
  content: string,
  title?: string,
  date?: string,
  attendees?: string[] | null
): string {
  const shortId = meetingId.split('-')[0]
  const filename =
    title && date ? `${sanitizeFilename(title, date, attendees)} (${shortId}).md` : `${meetingId}.md`
  const filepath = join(getSummariesDir(), filename)
  writeFileSync(filepath, content, 'utf-8')
  return filename
}

export function readSummary(filename: string): string | null {
  const filepath = join(getSummariesDir(), filename)
  if (!existsSync(filepath)) return null
  return readFileSync(filepath, 'utf-8')
}

export function updateSummaryContent(filename: string, content: string): void {
  const filepath = join(getSummariesDir(), filename)
  writeFileSync(filepath, content, 'utf-8')
}

export function renameTranscript(
  oldFilename: string,
  meetingId: string,
  newTitle: string,
  date: string,
  attendees?: string[] | null
): string {
  const shortId = meetingId.split('-')[0]
  const newFilename = `${sanitizeFilename(newTitle, date, attendees)} (${shortId}).md`
  const oldPath = join(getTranscriptsDir(), oldFilename)
  const newPath = join(getTranscriptsDir(), newFilename)
  if (existsSync(oldPath) && oldPath !== newPath) {
    renameSync(oldPath, newPath)
  }
  return newFilename
}

export function renameSummary(
  oldFilename: string,
  meetingId: string,
  newTitle: string,
  date: string,
  attendees?: string[] | null
): string {
  const shortId = meetingId.split('-')[0]
  const newFilename = `${sanitizeFilename(newTitle, date, attendees)} (${shortId}).md`
  const oldPath = join(getSummariesDir(), oldFilename)
  const newPath = join(getSummariesDir(), newFilename)
  if (existsSync(oldPath) && oldPath !== newPath) {
    renameSync(oldPath, newPath)
  }
  return newFilename
}

export function deleteTranscript(filename: string): void {
  const filepath = join(getTranscriptsDir(), filename)
  if (existsSync(filepath)) unlinkSync(filepath)
}

export function deleteSummary(filename: string): void {
  const filepath = join(getSummariesDir(), filename)
  if (existsSync(filepath)) unlinkSync(filepath)
}

export function deleteRecording(filename: string): void {
  const filepath = join(getRecordingsDir(), filename)
  if (existsSync(filepath)) unlinkSync(filepath)
}

export function renameRecording(
  oldFilename: string,
  meetingId: string,
  newTitle: string,
  date: string,
  attendees?: string[] | null
): string {
  const shortId = meetingId.split('-')[0]
  const existingExt = extname(oldFilename) || '.mp4'
  const newFilename = `${sanitizeFilename(newTitle, date, attendees)} (${shortId})${existingExt}`
  const oldPath = join(getRecordingsDir(), oldFilename)
  const newPath = join(getRecordingsDir(), newFilename)
  if (existsSync(oldPath) && oldPath !== newPath) {
    renameSync(oldPath, newPath)
  }
  return newFilename
}

const READABLE_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.csv', '.docx', '.xlsx'])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const GOOGLE_NATIVE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

/**
 * Pre-flight validation for files the user is about to flag as chat
 * context. Returns ok:true when the file can be successfully read by
 * `readLocalFile`, or ok:false with a typed code describing why not.
 *
 *   MISSING            file path doesn't exist on disk
 *   UNSUPPORTED_FORMAT extension not in READABLE_EXTENSIONS (and not Google native)
 *   TOO_LARGE          size > MAX_FILE_SIZE (10 MB)
 *
 * Drive native files (Google Docs / Sheets / Slides — distinguished by
 * their `application/vnd.google-apps.*` mimeType) skip filesystem checks
 * entirely: the listing is the source of truth, sizes aren't reported, and
 * the export-time error path surfaces missing scope / 404 separately.
 *
 * Used by the COMPANY_FILE_FLAG_TOGGLE IPC handler so users get an
 * inline toast at flag-time instead of silently flagging a file that
 * `readLocalFile` will later skip during chat assembly.
 */
export type ValidationCode =
  | 'MISSING'
  | 'UNSUPPORTED_FORMAT'
  | 'TOO_LARGE'
  | 'DRIVE_SCOPE_INSUFFICIENT'

export function validateFileForChatContext(
  filePath: string,
  mimeType?: string,
): { ok: true } | { ok: false; code: ValidationCode; message: string } {
  if (mimeType && GOOGLE_NATIVE_MIMES.has(mimeType)) {
    // Drive-native files: trust the listing — no existsSync, no size cap.
    // But check we have drive.readonly so chat context can actually export
    // the file later. Without it, flagging would succeed and chat would
    // silently drop the file — confusing UX.
    if (!hasDriveContentScope()) {
      return {
        ok: false,
        code: 'DRIVE_SCOPE_INSUFFICIENT',
        message:
          'Reconnect Google Drive to enable Docs / Sheets / Slides ingestion. Cyggie needs read access to export the file content.',
      }
    }
    return { ok: true }
  }

  if (!existsSync(filePath)) {
    return { ok: false, code: 'MISSING', message: `File not found on disk: ${filePath}` }
  }
  const ext = extname(filePath).toLowerCase()
  if (!READABLE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: `Unsupported file format (${ext || 'no extension'}). Supported: ${[...READABLE_EXTENSIONS].join(', ')}.`,
    }
  }
  try {
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(1)
      return {
        ok: false,
        code: 'TOO_LARGE',
        message: `File is too large (${sizeMb} MB). Max ${MAX_FILE_SIZE / (1024 * 1024)} MB.`,
      }
    }
  } catch (err) {
    return { ok: false, code: 'MISSING', message: `Could not stat file: ${String(err)}` }
  }
  return { ok: true }
}

// Minimum character count to consider text extraction successful.
// Matches MIN_TEXT_LENGTH in pitch-deck-ingestion.service.ts.
const MIN_PDF_TEXT_LENGTH = 100

/**
 * Attempt text extraction via pdfjs-dist (legacy Node build).
 * Returns extracted text, or null if extraction yields less than MIN_PDF_TEXT_LENGTH chars.
 *
 * pdfjs-dist handles more font encodings, ligatures, and character maps than pdf-parse,
 * so it is used as a second-pass fallback before triggering the vision (image) path.
 */
async function extractTextWithPdfjs(buf: Buffer): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf') as {
      getDocument: (opts: { data: Uint8Array; disableFontFace: boolean }) => { promise: Promise<{
        numPages: number
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str: string }[] }> }>
      }> }
    }
    const data = new Uint8Array(buf)
    const doc = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise
    const parts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      parts.push(content.items.map((item) => item.str).join(' '))
    }
    const text = parts.join('\n').trim()
    return text.length >= MIN_PDF_TEXT_LENGTH ? text : null
  } catch {
    return null
  }
}

/**
 * In-memory file-extraction cache. Keyed by `${filePath}|${mtimeMs}|${size}`
 * so a file edited in place naturally invalidates. Bounded LRU at
 * PARSE_CACHE_MAX entries; oldest evicted on insert. Cache is process-local —
 * sufficient for typical chat-context reads where the same flagged file is
 * read across many turns within one session. Covers PDF, DOCX, XLSX (the
 * three extensions whose extraction is non-trivial). Plain-text formats
 * (.txt/.md/.csv) bypass the cache because readFileSync is microseconds.
 */
const PARSE_CACHE_MAX = 32
const DRIVE_CACHE_TTL_MS = 30 * 60 * 1000 // 30 min
// Local entries leave expiresAt undefined — they self-invalidate via the
// (mtime, size) component of the key. Drive entries set expiresAt so users
// see fresh content within 30 min of editing the source Doc/Sheet/Slides.
type ParseCacheEntry = { text: string | null; expiresAt?: number }
const parseCache = new Map<string, ParseCacheEntry>()

function parseCacheKey(filePath: string, mtimeMs: number, size: number): string {
  return `${filePath}|${mtimeMs}|${size}`
}

function parseCacheGet(key: string): ParseCacheEntry | undefined {
  const hit = parseCache.get(key)
  if (!hit) return undefined
  // Refresh recency
  parseCache.delete(key)
  parseCache.set(key, hit)
  return hit
}

function parseCacheSet(key: string, entry: ParseCacheEntry): void {
  if (parseCache.has(key)) parseCache.delete(key)
  parseCache.set(key, entry)
  while (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value
    if (oldest === undefined) break
    parseCache.delete(oldest)
  }
}

/** Test-only: drop all cached extracted-file entries. */
export function clearParseCache(): void {
  parseCache.clear()
}

/** Drop only the Drive-keyed entries — used by the Files-tab refresh button
 *  so the user can force a re-export without losing local-file cache hits. */
export function clearDriveCache(): void {
  for (const key of parseCache.keys()) {
    if (key.startsWith('drive|')) parseCache.delete(key)
  }
}

/**
 * Wraps the cache-read / read-bytes / extract / cache-write sequence shared
 * by any non-trivial format (DOCX, XLSX — and any future format whose
 * extraction is a single pass). PDF stays bespoke because its two-pass
 * fallback structure doesn't fit a single extractor.
 */
async function cachedExtract(
  filePath: string,
  cacheKey: string,
  extractor: (filePath: string, buf: Buffer) => Promise<string | null>,
): Promise<string | null> {
  const cached = parseCacheGet(cacheKey)
  if (cached) return cached.text
  const buf = readFileSync(filePath)
  const text = await extractor(filePath, buf)
  parseCacheSet(cacheKey, { text })
  return text
}

/**
 * Extract plain text from a Word document via mammoth's extractRawText.
 * Returns null on parse failure (logs `[chat-files]`) or empty document.
 */
async function extractDocxText(filePath: string, buf: Buffer): Promise<string | null> {
  try {
    const mod = (await import('mammoth')) as
      | { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> }
      | { default: { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> } }
    const mammoth = 'extractRawText' in mod ? mod : mod.default
    const result = await mammoth.extractRawText({ buffer: buf })
    const text = (result.value ?? '').trim()
    return text.length > 0 ? text : null
  } catch (err) {
    console.warn(`[chat-files] parse failed format=docx path=${filePath} err=${String(err)}`)
    return null
  }
}

/**
 * Extract per-sheet CSV from an Excel workbook via exceljs. Each sheet is
 * rendered as a `# Sheet: <name>` markdown section followed by its rows in
 * minimal-correctness CSV (cells with comma/quote/newline are quoted).
 * Empty workbook → null. Returns null on parse failure (logs `[chat-files]`).
 */
async function extractXlsxText(filePath: string, buf: Buffer): Promise<string | null> {
  try {
    const mod = (await import('exceljs')) as
      | typeof import('exceljs')
      | { default: typeof import('exceljs') }
    const ExcelJS = 'Workbook' in mod ? mod : mod.default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const parts: string[] = []
    wb.eachSheet((sheet) => {
      const rows: string[] = []
      sheet.eachRow({ includeEmpty: false }, (row) => {
        // row.values is sparse; index 0 is empty by exceljs convention.
        const cells = (row.values as unknown[]).slice(1).map((v) => {
          if (v === null || v === undefined) return ''
          if (typeof v === 'object' && v !== null && 'text' in v) {
            return String((v as { text: string }).text)
          }
          if (typeof v === 'object' && v !== null && 'result' in v) {
            // Cell formulas: prefer the cached result.
            return String((v as { result: unknown }).result ?? '')
          }
          return String(v)
        })
        const escaped = cells.map((c) =>
          /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c
        )
        rows.push(escaped.join(','))
      })
      const body = rows.join('\n').trim()
      if (body) parts.push(`# Sheet: ${sheet.name}\n\n${body}`)
    })
    const text = parts.join('\n\n').trim()
    return text.length > 0 ? text : null
  } catch (err) {
    console.warn(`[chat-files] parse failed format=xlsx path=${filePath} err=${String(err)}`)
    return null
  }
}

/**
 * Phase 2: read a Google native file (Doc / Sheet / Slides) by Drive ID.
 *
 *   Doc      → exportDriveFile('text/plain') → utf-8 string
 *   Slides   → exportDriveFile('text/plain') → utf-8 string (slides concatenated)
 *   Sheet    → exportDriveFile('xlsx')        → reuse extractXlsxText (phase 1)
 *
 * Cached in the same parseCache Map under `drive|${driveId}` with a 30-min
 * TTL so source-side edits surface within the session. The Files-tab refresh
 * button calls clearDriveCache() to force an immediate re-export.
 */
async function readDriveFile(driveId: string, mimeType: string): Promise<string | null> {
  const cacheKey = `drive|${driveId}`
  const cached = parseCacheGet(cacheKey)
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
    return cached.text
  }

  const { exportDriveFile, GOOGLE_DOC_MIME, GOOGLE_SHEET_MIME, GOOGLE_SLIDES_MIME } = await import(
    '../drive/google-drive'
  )
  const result = await exportDriveFile(driveId, mimeType)
  if (!result.ok) {
    console.warn(
      `[chat-files] drive export failed driveId=${driveId} mime=${mimeType} kind=${result.error.kind}`,
    )
    parseCacheSet(cacheKey, { text: null, expiresAt: Date.now() + DRIVE_CACHE_TTL_MS })
    return null
  }

  let text: string | null = null
  if (mimeType === GOOGLE_DOC_MIME || mimeType === GOOGLE_SLIDES_MIME) {
    const raw = result.buf.toString('utf-8').trim()
    text = raw.length > 0 ? raw : null
  } else if (mimeType === GOOGLE_SHEET_MIME) {
    // Reuse phase-1 extractXlsxText. The "filePath" arg is purely for the
    // [chat-files] log prefix on parse failure — pass a synthetic identifier.
    text = await extractXlsxText(`drive:${driveId}`, result.buf)
  }
  parseCacheSet(cacheKey, { text, expiresAt: Date.now() + DRIVE_CACHE_TTL_MS })
  return text
}

export async function readLocalFile(filePath: string, mimeType?: string): Promise<string | null> {
  // Phase 2: Drive native files dispatch before any filesystem checks.
  // filePath is a Drive ID here, not a path.
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) {
    return readDriveFile(filePath, mimeType)
  }

  try {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) return null
    const ext = extname(filePath).toLowerCase()
    if (!READABLE_EXTENSIONS.has(ext)) return null

    const cacheKey = parseCacheKey(filePath, stat.mtimeMs, stat.size)

    if (ext === '.pdf') {
      const cached = parseCacheGet(cacheKey)
      if (cached) return cached.text
      try {
        const buf = readFileSync(filePath)

        // Pass 1: pdf-parse (fast, good for standard text-layer PDFs).
        // Dynamic import (not require) so vitest can intercept the module.
        const pdfParseMod = (await import('pdf-parse')) as
          | { default: (buf: Buffer) => Promise<{ text: string }> }
          | ((buf: Buffer) => Promise<{ text: string }>)
        const pdfParse =
          typeof pdfParseMod === 'function' ? pdfParseMod : pdfParseMod.default
        const parsed = await pdfParse(buf)
        if (parsed.text && parsed.text.trim().length >= MIN_PDF_TEXT_LENGTH) {
          parseCacheSet(cacheKey, { text: parsed.text })
          return parsed.text
        }

        // Pass 2: pdfjs-dist (handles more font encodings, ligatures, CID fonts)
        // Falls through to null if still insufficient — triggers vision fallback in ingestion service
        const pdfjsText = await extractTextWithPdfjs(buf)
        parseCacheSet(cacheKey, { text: pdfjsText })
        return pdfjsText
      } catch (err) {
        console.warn(`[chat-files] parse failed format=pdf path=${filePath} err=${String(err)}`)
        parseCacheSet(cacheKey, { text: null })
        return null
      }
    }

    if (ext === '.docx') return cachedExtract(filePath, cacheKey, extractDocxText)
    if (ext === '.xlsx') return cachedExtract(filePath, cacheKey, extractXlsxText)

    // .txt / .md / .csv — raw read, no cache (already cheap).
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function buildRecordingFilename(
  meetingId: string,
  title: string,
  date: string,
  attendees?: string[] | null,
  extension: '.mp4' | '.webm' = '.mp4'
): string {
  const shortId = meetingId.split('-')[0]
  return title && date
    ? `${sanitizeFilename(title, date, attendees)} (${shortId})${extension}`
    : `${meetingId}${extension}`
}
