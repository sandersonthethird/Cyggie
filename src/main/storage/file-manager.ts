import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, statSync } from 'fs'
import { join, extname } from 'path'
import { getTranscriptsDir, getSummariesDir, getRecordingsDir } from './paths'
import { extractCompanyFromEmail } from '../utils/company-extractor'

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

const READABLE_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.csv'])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

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

export async function readLocalFile(filePath: string): Promise<string | null> {
  try {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) return null
    const ext = extname(filePath).toLowerCase()
    if (!READABLE_EXTENSIONS.has(ext)) return null
    if (ext === '.pdf') {
      const buf = readFileSync(filePath)

      // Pass 1: pdf-parse (fast, good for standard text-layer PDFs)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
      const parsed = await pdfParse(buf)
      if (parsed.text && parsed.text.trim().length >= MIN_PDF_TEXT_LENGTH) {
        return parsed.text
      }

      // Pass 2: pdfjs-dist (handles more font encodings, ligatures, CID fonts)
      // Falls through to null if still insufficient — triggers vision fallback in ingestion service
      return await extractTextWithPdfjs(buf)
    }
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
