import { getDatabase } from '../connection'
import { extractCompanyFromEmail, extractDomainFromEmail } from '../../utils/company-extractor'
import * as companyRepo from './company.repo'
import type { SearchResult, AdvancedSearchParams, AdvancedSearchResult, CategorizedSuggestions, CompanySuggestion } from '../../../shared/types/meeting'
import type {
  UnifiedSearchResponse,
  UnifiedSearchResult,
  UnifiedSearchResultsGrouped
} from '../../../shared/types/unified-search'

/** Sanitize a user query for FTS5 MATCH — quote each word to avoid syntax errors from ?, *, etc. */
function sanitizeFts5Query(query: string): string {
  const words = query
    .replace(/["""]/g, '') // strip any existing quotes
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')) // strip leading/trailing punctuation
    .filter((w) => w.length > 0)
  if (words.length === 0) return '""'
  return words.map((w) => `"${w}"`).join(' ')
}

const STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'how',
  'have', 'has', 'had', 'been', 'about', 'does', 'did', 'doing',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'the',
  'and', 'but', 'for', 'not', 'are', 'was', 'were', 'will', 'would',
  'could', 'should', 'can', 'may', 'might', 'shall', 'there', 'then',
  'than', 'also', 'just', 'very', 'really', 'some', 'any', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'such',
  'only', 'same', 'tell', 'know', 'think', 'said',
  'find', 'show', 'list', 'give', 'search', 'between', 'meeting', 'meetings', 'attended', 'together'
])

/** Extract meaningful keywords from a natural language question */
export function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}

/** Build an OR-based FTS5 query from keywords */
export function buildOrQuery(keywords: string[]): string {
  if (keywords.length === 0) return '""'
  return keywords.map((w) => `"${w}"`).join(' OR ')
}

/** Search meetings by title using LIKE */
export function searchByTitle(keywords: string[], limit = 10): { id: string; title: string; date: string }[] {
  const db = getDatabase()
  if (keywords.length === 0) return []

  const conditions = keywords.map(() => 'title LIKE ?')
  const params = keywords.map((k) => `%${k}%`)

  return db
    .prepare(
      `SELECT id, title, date FROM meetings
       WHERE ${conditions.join(' OR ')}
       ORDER BY date DESC LIMIT ?`
    )
    .all(...params, limit) as { id: string; title: string; date: string }[]
}

/** Search meetings by speaker/attendee names using LIKE */
export function searchBySpeaker(keywords: string[], limit = 10): { id: string; title: string; date: string }[] {
  const db = getDatabase()
  if (keywords.length === 0) return []

  const conditions = keywords.map(() => '(speaker_map LIKE ? OR attendees LIKE ?)')
  const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`])

  return db
    .prepare(
      `SELECT id, title, date FROM meetings
       WHERE ${conditions.join(' OR ')}
       ORDER BY date DESC LIMIT ?`
    )
    .all(...params, limit) as { id: string; title: string; date: string }[]
}

/** Search meetings where ALL provided names appear in speaker/attendee fields (AND logic) */
export function searchByAllSpeakers(names: string[], limit = 20): { id: string; title: string; date: string }[] {
  const db = getDatabase()
  if (names.length < 2) return []

  const conditions = names.map(() => '(speaker_map LIKE ? OR attendees LIKE ?)')
  const params = names.flatMap((k) => [`%${k}%`, `%${k}%`])

  return db
    .prepare(
      `SELECT id, title, date FROM meetings
       WHERE ${conditions.join(' AND ')}
       ORDER BY date DESC LIMIT ?`
    )
    .all(...params, limit) as { id: string; title: string; date: string }[]
}

export function indexMeeting(
  meetingId: string,
  title: string,
  transcriptText: string,
  summaryText: string = ''
): void {
  const db = getDatabase()
  // Remove existing entry first
  db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(meetingId)
  // Insert new entry
  db.prepare(
    'INSERT INTO meetings_fts (meeting_id, title, transcript_text, summary_text) VALUES (?, ?, ?, ?)'
  ).run(meetingId, title, transcriptText, summaryText)
}

export function updateSummaryIndex(meetingId: string, summaryText: string): void {
  const db = getDatabase()
  // FTS5 contentless tables don't support UPDATE, so delete and re-insert
  const existing = db
    .prepare(
      'SELECT meeting_id, title, transcript_text FROM meetings_fts WHERE meeting_id = ?'
    )
    .get(meetingId) as { meeting_id: string; title: string; transcript_text: string } | undefined

  if (existing) {
    db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(meetingId)
    db.prepare(
      'INSERT INTO meetings_fts (meeting_id, title, transcript_text, summary_text) VALUES (?, ?, ?, ?)'
    ).run(meetingId, existing.title, existing.transcript_text, summaryText)
  }
}

export function searchMeetings(query: string, limit = 20, rawFts = false): SearchResult[] {
  const db = getDatabase()
  const ftsQuery = rawFts ? query : sanitizeFts5Query(query)

  const ftsRows = db
    .prepare(
      `SELECT
        meeting_id,
        snippet(meetings_fts, 2, '<mark>', '</mark>', '...', 32) as snippet,
        bm25(meetings_fts) as rank
      FROM meetings_fts
      WHERE meetings_fts MATCH ?
      ORDER BY rank
      LIMIT ?`
    )
    .all(ftsQuery, limit) as { meeting_id: string; snippet: string; rank: number }[]

  // Also search by title for meetings not in the FTS index (e.g. no transcript yet)
  const keywords = query.trim().split(/\s+/).filter(Boolean)
  const titleMatches = searchByTitle(keywords, limit)
  const ftsIdSet = new Set(ftsRows.map((r) => r.meeting_id))
  const titleOnlyIds = titleMatches.filter((m) => !ftsIdSet.has(m.id)).map((m) => m.id)

  // Collect all meeting IDs to fetch metadata
  const allIds = [...ftsRows.map((r) => r.meeting_id), ...titleOnlyIds]
  if (allIds.length === 0) return []

  const placeholders = allIds.map(() => '?').join(',')
  const meetingRows = db
    .prepare(`SELECT id, title, date FROM meetings WHERE id IN (${placeholders})`)
    .all(...allIds) as { id: string; title: string; date: string }[]
  const meetingMap = new Map(meetingRows.map((m) => [m.id, m]))

  const results: SearchResult[] = []

  for (const row of ftsRows) {
    const meeting = meetingMap.get(row.meeting_id)
    if (!meeting) continue
    results.push({ meetingId: row.meeting_id, title: meeting.title, date: meeting.date, snippet: row.snippet, rank: row.rank })
  }

  // Append title-only matches at the end (lower rank than FTS hits)
  for (const id of titleOnlyIds) {
    const meeting = meetingMap.get(id)
    if (!meeting) continue
    results.push({ meetingId: id, title: meeting.title, date: meeting.date, snippet: '', rank: 999 })
  }

  return results
}

export function removeFromIndex(meetingId: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(meetingId)
}

export function getSuggestions(prefix: string, limit = 8): string[] {
  const db = getDatabase()
  const lower = prefix.toLowerCase()

  // Collect terms from meeting titles
  const titleRows = db
    .prepare('SELECT title FROM meetings')
    .all() as { title: string }[]

  // Collect speaker names
  const speakerRows = db
    .prepare('SELECT speaker_map FROM meetings WHERE speaker_map != \'{}\'')
    .all() as { speaker_map: string }[]

  // Build a frequency map of meaningful terms
  const freq = new Map<string, number>()

  // Tokenize titles into multi-word chunks and individual words
  for (const { title } of titleRows) {
    // Add the full title as a suggestion candidate
    if (title.toLowerCase().startsWith(lower)) {
      freq.set(title, (freq.get(title) || 0) + 5)
    }
    // Add individual words (skip short/common ones)
    const words = title.split(/[\s,\-–—:;/]+/).filter((w) => w.length >= 3)
    for (const word of words) {
      if (word.toLowerCase().startsWith(lower)) {
        freq.set(word, (freq.get(word) || 0) + 1)
      }
    }
  }

  // Add speaker names
  for (const row of speakerRows) {
    try {
      const map: Record<string, string> = JSON.parse(row.speaker_map)
      for (const name of Object.values(map)) {
        if (name && !/^Speaker \d+$/.test(name) && name.toLowerCase().startsWith(lower)) {
          freq.set(name, (freq.get(name) || 0) + 3)
        }
      }
    } catch {
      // skip
    }
  }

  // Sort by frequency (descending), return top N
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term)
}

export function getAllSpeakers(): string[] {
  const db = getDatabase()
  const rows = db
    .prepare('SELECT speaker_map FROM meetings WHERE speaker_map != \'{}\'')
    .all() as { speaker_map: string }[]

  const names = new Set<string>()
  for (const row of rows) {
    try {
      const map: Record<string, string> = JSON.parse(row.speaker_map)
      for (const name of Object.values(map)) {
        // Skip generic names like "Speaker 1"
        if (name && !/^Speaker \d+$/.test(name)) {
          names.add(name)
        }
      }
    } catch {
      // skip malformed JSON
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b))
}

interface MeetingRow {
  id: string
  title: string
  date: string
  speaker_map: string
  attendees: string | null
  attendee_emails: string | null
  companies: string | null
  duration_seconds: number | null
  status: string
}

function companySuggestionsFromRow(row: MeetingRow): CompanySuggestion[] {
  const results: CompanySuggestion[] = []
  const seenDomains = new Set<string>()

  // Derive from attendee_emails (preferred — gives us domains)
  if (row.attendee_emails) {
    try {
      const emails: string[] = JSON.parse(row.attendee_emails)
      for (const email of emails) {
        const domain = extractDomainFromEmail(email)
        if (domain && !seenDomains.has(domain)) {
          seenDomains.add(domain)
          const cached = companyRepo.getByDomain(domain)
          const name = cached?.displayName || extractCompanyFromEmail(email) || domain
          results.push({ name, domain })
        }
      }
    } catch { /* skip */ }
  }

  // Fallback: companies column names without domains
  if (results.length === 0 && row.companies) {
    try {
      const names: string[] = JSON.parse(row.companies)
      for (const name of names) {
        results.push({ name, domain: '' })
      }
    } catch { /* skip */ }
  }

  return results
}

export function advancedSearch(params: AdvancedSearchParams): AdvancedSearchResult[] {
  const db = getDatabase()
  const limit = params.limit || 50

  // Person filter: find meetings where this person is a speaker or attendee
  if (params.person) {
    const personLower = params.person.toLowerCase()
    const rows = db
      .prepare(
        `SELECT id, title, date, speaker_map, attendees, attendee_emails, companies, duration_seconds, status
         FROM meetings
         WHERE speaker_map LIKE ? OR attendees LIKE ?
         ORDER BY date DESC LIMIT ?`
      )
      .all(`%${params.person}%`, `%${params.person}%`, limit) as MeetingRow[]

    return rows
      .filter((m) => {
        const map: Record<string, string> = JSON.parse(m.speaker_map || '{}')
        const attendees: string[] = m.attendees ? JSON.parse(m.attendees) : []
        return (
          Object.values(map).some((n) => n.toLowerCase() === personLower) ||
          attendees.some((a) => a.toLowerCase() === personLower)
        )
      })
      .map((m) => ({
        meetingId: m.id,
        title: m.title,
        date: m.date,
        snippet: '',
        rank: 0,
        speakerMap: JSON.parse(m.speaker_map || '{}'),
        durationSeconds: m.duration_seconds,
        status: m.status as AdvancedSearchResult['status'],
        companies: companySuggestionsFromRow(m)
      }))
  }

  // Company filter: find meetings tagged with this company
  if (params.company) {
    const companyLower = params.company.toLowerCase()
    const rows = db
      .prepare(
        `SELECT id, title, date, speaker_map, attendees, attendee_emails, companies, duration_seconds, status
         FROM meetings
         WHERE companies LIKE ?
         ORDER BY date DESC LIMIT ?`
      )
      .all(`%${params.company}%`, limit) as MeetingRow[]

    return rows
      .filter((m) => {
        const companies: string[] = m.companies ? JSON.parse(m.companies) : []
        return companies.some((c) => c.toLowerCase() === companyLower)
      })
      .map((m) => ({
        meetingId: m.id,
        title: m.title,
        date: m.date,
        snippet: '',
        rank: 0,
        speakerMap: JSON.parse(m.speaker_map || '{}'),
        durationSeconds: m.duration_seconds,
        status: m.status as AdvancedSearchResult['status'],
        companies: companySuggestionsFromRow(m)
      }))
  }

  // If text query provided, search FTS index + title matches
  if (params.query && params.query.trim()) {
    const seenIds = new Set<string>()
    let results: AdvancedSearchResult[] = []

    // 1. FTS full-text search (transcripts + summaries)
    try {
      const ftsQuery = sanitizeFts5Query(params.query!)
      const ftsRows = db
        .prepare(
          `SELECT
            meeting_id,
            snippet(meetings_fts, 2, '<mark>', '</mark>', '...', 32) as snippet,
            bm25(meetings_fts) as rank
          FROM meetings_fts
          WHERE meetings_fts MATCH ?
          ORDER BY rank
          LIMIT ?`
        )
        .all(ftsQuery, limit) as { meeting_id: string; snippet: string; rank: number }[]

      if (ftsRows.length > 0) {
        const placeholders = ftsRows.map(() => '?').join(',')
        const ids = ftsRows.map((r) => r.meeting_id)

        const sqlParts = [`SELECT id, title, date, speaker_map, attendee_emails, companies, duration_seconds, status FROM meetings WHERE id IN (${placeholders})`]
        const sqlParams: unknown[] = [...ids]

        if (params.dateFrom) {
          sqlParts.push('AND date >= ?')
          sqlParams.push(params.dateFrom)
        }
        if (params.dateTo) {
          sqlParts.push('AND date <= ?')
          sqlParams.push(params.dateTo)
        }

        const meetings = db
          .prepare(sqlParts.join(' '))
          .all(...sqlParams) as MeetingRow[]

        const meetingMap = new Map(meetings.map((m) => [m.id, m]))

        for (const fts of ftsRows) {
          const m = meetingMap.get(fts.meeting_id)
          if (!m) continue
          seenIds.add(m.id)
          results.push({
            meetingId: m.id,
            title: m.title,
            date: m.date,
            snippet: fts.snippet,
            rank: fts.rank,
            speakerMap: JSON.parse(m.speaker_map || '{}'),
            durationSeconds: m.duration_seconds,
            status: m.status as AdvancedSearchResult['status'],
            companies: companySuggestionsFromRow(m)
          })
        }
      }
    } catch {
      // FTS query syntax error — fall through to title search
    }

    // 2. Title search (catches meetings not in FTS index)
    const titleSqlParts = ['SELECT id, title, date, speaker_map, attendee_emails, companies, duration_seconds, status FROM meetings WHERE title LIKE ?']
    const titleSqlParams: unknown[] = [`%${params.query}%`]

    if (params.dateFrom) {
      titleSqlParts.push('AND date >= ?')
      titleSqlParams.push(params.dateFrom)
    }
    if (params.dateTo) {
      titleSqlParts.push('AND date <= ?')
      titleSqlParams.push(params.dateTo)
    }
    titleSqlParts.push('LIMIT ?')
    titleSqlParams.push(limit)

    const titleMatches = db
      .prepare(titleSqlParts.join(' '))
      .all(...titleSqlParams) as MeetingRow[]

    for (const m of titleMatches) {
      if (seenIds.has(m.id)) continue
      seenIds.add(m.id)
      results.push({
        meetingId: m.id,
        title: m.title,
        date: m.date,
        snippet: '',
        rank: 0,
        speakerMap: JSON.parse(m.speaker_map || '{}'),
        durationSeconds: m.duration_seconds,
        status: m.status as AdvancedSearchResult['status'],
        companies: companySuggestionsFromRow(m)
      })
    }

    // 3. Speaker name search (speaker_map is JSON, search in app code)
    const speakerSqlParts = ['SELECT id, title, date, speaker_map, attendee_emails, companies, duration_seconds, status FROM meetings WHERE speaker_map LIKE ?']
    const speakerSqlParams: unknown[] = [`%${params.query}%`]

    if (params.dateFrom) {
      speakerSqlParts.push('AND date >= ?')
      speakerSqlParams.push(params.dateFrom)
    }
    if (params.dateTo) {
      speakerSqlParts.push('AND date <= ?')
      speakerSqlParams.push(params.dateTo)
    }
    speakerSqlParts.push('LIMIT ?')
    speakerSqlParams.push(limit)

    const speakerMatches = db
      .prepare(speakerSqlParts.join(' '))
      .all(...speakerSqlParams) as MeetingRow[]

    const queryLower = params.query.toLowerCase()
    for (const m of speakerMatches) {
      if (seenIds.has(m.id)) continue
      const map: Record<string, string> = JSON.parse(m.speaker_map || '{}')
      const hasMatch = Object.values(map).some((name) =>
        name.toLowerCase().includes(queryLower)
      )
      if (!hasMatch) continue
      seenIds.add(m.id)
      results.push({
        meetingId: m.id,
        title: m.title,
        date: m.date,
        snippet: '',
        rank: 0,
        speakerMap: map as Record<number, string>,
        durationSeconds: m.duration_seconds,
        status: m.status as AdvancedSearchResult['status'],
        companies: companySuggestionsFromRow(m)
      })
    }

    // Filter by speakers in application code (JSON column)
    if (params.speakers && params.speakers.length > 0) {
      const speakerSet = new Set(params.speakers.map((s) => s.toLowerCase()))
      results = results.filter((r) => {
        const names = Object.values(r.speakerMap).map((n) => n.toLowerCase())
        return names.some((n) => speakerSet.has(n))
      })
    }

    return results
  }

  // No text query — filter meetings table directly
  const sqlParts = ['SELECT id, title, date, speaker_map, attendee_emails, companies, duration_seconds, status FROM meetings WHERE 1=1']
  const sqlParams: unknown[] = []

  if (params.dateFrom) {
    sqlParts.push('AND date >= ?')
    sqlParams.push(params.dateFrom)
  }
  if (params.dateTo) {
    sqlParts.push('AND date <= ?')
    sqlParams.push(params.dateTo)
  }

  sqlParts.push('ORDER BY date DESC LIMIT ?')
  sqlParams.push(limit)

  const meetings = db
    .prepare(sqlParts.join(' '))
    .all(...sqlParams) as MeetingRow[]

  let results: AdvancedSearchResult[] = meetings.map((m) => {
    const speakerMap: Record<number, string> = JSON.parse(m.speaker_map || '{}')
    return {
      meetingId: m.id,
      title: m.title,
      date: m.date,
      snippet: '',
      rank: 0,
      speakerMap,
      durationSeconds: m.duration_seconds,
      status: m.status as AdvancedSearchResult['status'],
      companies: companySuggestionsFromRow(m)
    }
  })

  if (params.speakers && params.speakers.length > 0) {
    const speakerSet = new Set(params.speakers.map((s) => s.toLowerCase()))
    results = results.filter((r) => {
      const names = Object.values(r.speakerMap).map((n) => n.toLowerCase())
      return names.some((n) => speakerSet.has(n))
    })
  }

  return results
}

/**
 * Sanitize user input for SQLite FTS5 MATCH queries.
 * Strips special FTS5 chars and appends * for prefix matching.
 * Returns null if nothing searchable remains.
 */
function sanitizeFtsQuery(input: string): string | null {
  const sanitized = input.replace(/["()*^]/g, '').trim()
  if (!sanitized) return null
  return sanitized + '*'
}

export function getCategorizedSuggestions(prefix: string, limit = 5): CategorizedSuggestions {
  const db = getDatabase()
  const lower = prefix.toLowerCase()

  // 1. People: from speaker_map values + attendees (non-email entries)
  //    Also cross-reference matched people with their companies
  const peopleRows = db
    .prepare("SELECT speaker_map, attendees, attendee_emails, companies FROM meetings WHERE speaker_map != '{}' OR attendees IS NOT NULL")
    .all() as { speaker_map: string; attendees: string | null; attendee_emails: string | null; companies: string | null }[]

  const people = new Set<string>()
  // Track companies as domain → displayName map
  const companyMap = new Map<string, string>()

  for (const row of peopleRows) {
    const matchedNames: string[] = []

    if (row.speaker_map && row.speaker_map !== '{}') {
      try {
        const map: Record<string, string> = JSON.parse(row.speaker_map)
        for (const name of Object.values(map)) {
          if (name && !/^Speaker \d+$/.test(name) && name.toLowerCase().includes(lower)) {
            people.add(name)
            matchedNames.push(name)
          }
        }
      } catch { /* skip */ }
    }

    if (row.attendees) {
      try {
        const attendees: string[] = JSON.parse(row.attendees)
        for (const name of attendees) {
          if (name && !name.includes('@') && name.toLowerCase().includes(lower)) {
            people.add(name)
            matchedNames.push(name)
          }
        }
      } catch { /* skip */ }
    }

    // Cross-reference: surface companies associated with matched people
    if (matchedNames.length > 0) {
      let foundViaEmail = false

      // Try attendee_emails first (precise: match name parts to email local part)
      if (row.attendee_emails) {
        try {
          const emails: string[] = JSON.parse(row.attendee_emails)
          for (const name of matchedNames) {
            const nameParts = name.toLowerCase().split(/\s+/)
            for (const email of emails) {
              const localPart = email.split('@')[0]?.toLowerCase() || ''
              if (nameParts.some((part) => part.length >= 2 && localPart.includes(part))) {
                const domain = extractDomainFromEmail(email)
                if (domain && !companyMap.has(domain)) {
                  const cached = companyRepo.getByDomain(domain)
                  const displayName = cached?.displayName || extractCompanyFromEmail(email) || domain
                  companyMap.set(domain, displayName)
                  foundViaEmail = true
                }
              }
            }
          }
        } catch { /* skip */ }
      }

      // Also check attendees entries that ARE emails (old meetings stored email as name)
      if (!foundViaEmail && row.attendees) {
        try {
          const attendees: string[] = JSON.parse(row.attendees)
          for (const name of matchedNames) {
            const nameParts = name.toLowerCase().split(/\s+/)
            for (const entry of attendees) {
              if (entry.includes('@')) {
                const localPart = entry.split('@')[0]?.toLowerCase() || ''
                if (nameParts.some((part) => part.length >= 2 && localPart.includes(part))) {
                  const domain = extractDomainFromEmail(entry)
                  if (domain && !companyMap.has(domain)) {
                    const cached = companyRepo.getByDomain(domain)
                    const displayName = cached?.displayName || extractCompanyFromEmail(entry) || domain
                    companyMap.set(domain, displayName)
                    foundViaEmail = true
                  }
                }
              }
            }
          }
        } catch { /* skip */ }
      }

      // Fallback: include companies from the meeting's companies column (without domain)
      if (!foundViaEmail && row.companies) {
        try {
          const comps: string[] = JSON.parse(row.companies)
          for (const c of comps) {
            if (!companyMap.has(c)) companyMap.set(c, c)
          }
        } catch { /* skip */ }
      }
    }
  }

  // 2. Companies: org_companies is the source of truth, supplemented by
  //    the companies cache table and meetings.companies column.
  //    Deduplicate by tracking seen canonical names (lowercased) so that
  //    cache/meeting entries don't create duplicates of existing org companies.
  // No per-source LIMIT — the final .slice(0, limit) below caps output.
  const seenCompanyNames = new Set<string>()

  // 2a. org_companies first (authoritative — has domain for logo)
  const orgCompanyRows = db
    .prepare('SELECT id, canonical_name, primary_domain FROM org_companies WHERE canonical_name LIKE ?')
    .all(`%${prefix}%`) as { id: string; canonical_name: string; primary_domain: string | null }[]

  for (const row of orgCompanyRows) {
    const key = row.primary_domain || row.id
    if (!companyMap.has(key)) {
      companyMap.set(key, row.canonical_name)
    }
    seenCompanyNames.add(row.canonical_name.toLowerCase())
  }

  // 2b. companies cache table — skip entries whose name matches an org_company
  const cachedCompanyRows = db
    .prepare('SELECT domain, display_name FROM companies WHERE display_name LIKE ?')
    .all(`%${prefix}%`) as { domain: string; display_name: string }[]

  for (const row of cachedCompanyRows) {
    if (seenCompanyNames.has(row.display_name.toLowerCase())) continue
    if (!companyMap.has(row.domain)) {
      companyMap.set(row.domain, row.display_name)
      seenCompanyNames.add(row.display_name.toLowerCase())
    }
  }

  // 2c. meetings.companies column — skip entries whose name matches an existing result
  const meetingCompanyRows = db
    .prepare('SELECT companies FROM meetings WHERE companies IS NOT NULL AND companies LIKE ?')
    .all(`%${prefix}%`) as { companies: string }[]

  for (const row of meetingCompanyRows) {
    try {
      const comps: string[] = JSON.parse(row.companies)
      for (const c of comps) {
        if (c.toLowerCase().includes(lower) && !seenCompanyNames.has(c.toLowerCase())) {
          if (!companyMap.has(c)) {
            companyMap.set(c, c)
            seenCompanyNames.add(c.toLowerCase())
          }
        }
      }
    } catch { /* skip */ }
  }

  // 2b. Affiliated people: surface people from matched company domains
  const matchedDomains = [...companyMap.keys()].filter((k) => k.includes('.'))
  if (matchedDomains.length > 0) {
    const domainConditions = matchedDomains.map(() => 'attendee_emails LIKE ?')
    const domainParams = matchedDomains.map((d) => `%@${d}%`)

    const affiliatedRows = db
      .prepare(
        `SELECT speaker_map, attendees, attendee_emails FROM meetings WHERE ${domainConditions.join(' OR ')}`
      )
      .all(...domainParams) as { speaker_map: string; attendees: string | null; attendee_emails: string | null }[]

    for (const row of affiliatedRows) {
      if (!row.attendee_emails) continue

      let emails: string[]
      try {
        emails = JSON.parse(row.attendee_emails)
      } catch { continue }

      // Parse speaker names for name resolution
      const speakerNames: string[] = []
      try {
        const map: Record<string, string> = JSON.parse(row.speaker_map || '{}')
        for (const name of Object.values(map)) {
          if (name && !/^Speaker \d+$/.test(name)) speakerNames.push(name)
        }
      } catch { /* skip */ }

      // Parse non-email attendee entries for name resolution
      const attendeeNames: string[] = []
      if (row.attendees) {
        try {
          const attendees: string[] = JSON.parse(row.attendees)
          for (const a of attendees) {
            if (!a.includes('@')) attendeeNames.push(a)
          }
        } catch { /* skip */ }
      }

      const allNames = [...speakerNames, ...attendeeNames]

      for (const email of emails) {
        const domain = extractDomainFromEmail(email)
        if (!domain || !matchedDomains.includes(domain)) continue

        // Try to resolve email to a display name
        const localPart = email.split('@')[0]?.toLowerCase() || ''
        let resolved: string | null = null

        for (const name of allNames) {
          const nameParts = name.toLowerCase().split(/\s+/)
          if (nameParts.some((part) => part.length >= 2 && localPart.includes(part))) {
            resolved = name
            break
          }
        }

        if (resolved) {
          people.add(resolved)
        } else {
          // Before adding email fallback, check if person already exists by name
          const alreadyHasByName = [...people].some((existing) => {
            if (existing.includes('@')) return false
            const parts = existing.toLowerCase().split(/\s+/)
            return parts.some((p) => p.length >= 2 && localPart.includes(p))
          })
          if (!alreadyHasByName) people.add(email)
        }
      }
    }
  }

  // 3. Meetings: title match
  const meetingRows = db
    .prepare('SELECT id, title FROM meetings WHERE title LIKE ? ORDER BY date DESC LIMIT ?')
    .all(`%${prefix}%`, limit) as { id: string; title: string }[]

  // Convert companyMap to CompanySuggestion[]
  const companySuggestions: CompanySuggestion[] = [...companyMap.entries()]
    .map(([domain, name]) => ({ name, domain }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)

  // 4. Contacts: name or email match (same try/catch pattern as notes FTS below)
  let contactSuggestions: { id: string; label: string; context?: string }[] = []
  try {
    const contactRows = db
      .prepare(`
        SELECT c.id, c.full_name,
               oc.canonical_name AS company_name,
               c.title AS job_title
        FROM contacts c
        LEFT JOIN org_companies oc ON oc.id = c.primary_company_id
        WHERE c.full_name IS NOT NULL
          AND (c.full_name LIKE ? OR c.email LIKE ?)
        ORDER BY c.full_name
        LIMIT ?
      `)
      .all(`%${prefix}%`, `%${prefix}%`, limit) as {
        id: string
        full_name: string
        company_name: string | null
        job_title: string | null
      }[]

    contactSuggestions = contactRows.map((c) => ({
      id: c.id,
      label: c.full_name,
      context: c.job_title && c.company_name
        ? `${c.job_title} · ${c.company_name}`
        : (c.company_name ?? c.job_title ?? undefined),
    }))
  } catch {
    // DB error — return no contacts, other sections unaffected
  }

  // 5. Notes: FTS5 prefix search with inline company/contact context
  let noteSuggestions: { id: string; label: string; context?: string }[] = []
  const ftsQuery = sanitizeFtsQuery(prefix)
  if (ftsQuery) {
    try {
      const noteRows = db
        .prepare(`
          SELECT nf.id, n.title, n.content,
                 c.canonical_name AS company_name,
                 ct.full_name AS contact_name
          FROM notes_fts nf
          JOIN notes n ON nf.id = n.id
          LEFT JOIN org_companies c ON c.id = n.company_id
          LEFT JOIN contacts ct ON ct.id = n.contact_id
          WHERE notes_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(ftsQuery, limit) as {
          id: string
          title: string | null
          content: string
          company_name: string | null
          contact_name: string | null
        }[]

      noteSuggestions = noteRows.map((n) => {
        const raw = n.title?.trim() || n.content.replace(/\n/g, ' ').trim()
        const label = raw
          ? raw.length > 60 ? raw.slice(0, 60) + '…' : raw
          : 'Untitled note'
        const context = n.company_name ?? n.contact_name ?? undefined
        return { id: n.id, label, context }
      })
    } catch {
      // FTS5 MATCH failed (e.g. unsanitized edge case) — return no notes
    }
  }

  return {
    people: [...people].sort().slice(0, limit),
    companies: companySuggestions,
    contacts: contactSuggestions,
    meetings: meetingRows,
    notes: noteSuggestions,
  }
}

function emptyUnifiedGroups(): UnifiedSearchResultsGrouped {
  return {
    meeting: [],
    email: [],
    note: [],
    memo: []
  }
}

function formatCitationDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function recencyBoost(value: string | null): number {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return 0
  const days = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24))
  return Math.max(0, 45 - days)
}

function dedupeUnifiedResults(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
  const seen = new Set<string>()
  const deduped: UnifiedSearchResult[] = []
  for (const result of results) {
    const key = `${result.entityType}:${result.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(result)
  }
  return deduped
}

export function searchUnified(query: string, limit = 40): UnifiedSearchResponse {
  const trimmed = query.trim()
  if (!trimmed) {
    return {
      query: '',
      totalCount: 0,
      grouped: emptyUnifiedGroups(),
      flat: []
    }
  }

  const db = getDatabase()
  const lowerLike = `%${trimmed.toLowerCase()}%`
  const results: UnifiedSearchResult[] = []

  const meetingLimit = Math.max(8, Math.ceil(limit * 0.4))
  const ftsQuery = sanitizeFts5Query(trimmed)
  try {
    const meetingRows = db
      .prepare(`
        SELECT
          m.id,
          m.title,
          m.date,
          snippet(meetings_fts, 2, '<mark>', '</mark>', '...', 24) AS snippet,
          bm25(meetings_fts) AS bm_rank,
          c.id AS company_id,
          c.canonical_name AS company_name
        FROM meetings_fts
        JOIN meetings m ON m.id = meetings_fts.meeting_id
        LEFT JOIN org_companies c ON c.id = (
          SELECT l.company_id
          FROM meeting_company_links l
          WHERE l.meeting_id = m.id
          ORDER BY l.confidence DESC, datetime(l.created_at) ASC
          LIMIT 1
        )
        WHERE meetings_fts MATCH ?
        ORDER BY bm_rank
        LIMIT ?
      `)
      .all(ftsQuery, meetingLimit) as Array<{
      id: string
      title: string
      date: string
      snippet: string
      bm_rank: number
      company_id: string | null
      company_name: string | null
    }>

    meetingRows.forEach((row) => {
      const rank = 1200 + (-row.bm_rank || 0) + recencyBoost(row.date)
      results.push({
        id: `meeting:${row.id}`,
        entityType: 'meeting',
        entityId: row.id,
        title: row.title,
        snippet: row.snippet || '',
        occurredAt: row.date,
        rank,
        companyId: row.company_id,
        companyName: row.company_name,
        route: `/meeting/${row.id}`,
        citationLabel: `Meeting: ${row.title} (${formatCitationDate(row.date)})`
      })
    })
  } catch {
    // If FTS parsing fails, continue with non-FTS entities.
  }

  const emailRows = db
    .prepare(`
      SELECT
        em.id,
        COALESCE(NULLIF(TRIM(em.subject), ''), '(no subject)') AS subject,
        COALESCE(em.received_at, em.sent_at, em.created_at) AS occurred_at,
        COALESCE(em.snippet, '') AS snippet,
        c.id AS company_id,
        c.canonical_name AS company_name
      FROM email_messages em
      LEFT JOIN org_companies c ON c.id = (
        SELECT l.company_id
        FROM email_company_links l
        WHERE l.message_id = em.id
        ORDER BY l.confidence DESC, datetime(l.created_at) ASC
        LIMIT 1
      )
      WHERE
        lower(COALESCE(em.subject, '')) LIKE ?
        OR lower(COALESCE(em.snippet, '')) LIKE ?
        OR lower(COALESCE(em.body_text, '')) LIKE ?
      ORDER BY datetime(occurred_at) DESC
      LIMIT ?
    `)
    .all(lowerLike, lowerLike, lowerLike, Math.max(8, Math.ceil(limit * 0.3))) as Array<{
    id: string
    subject: string
    occurred_at: string
    snippet: string
    company_id: string | null
    company_name: string | null
  }>
  emailRows.forEach((row) => {
    const rank = 900 + recencyBoost(row.occurred_at)
    results.push({
      id: `email:${row.id}`,
      entityType: 'email',
      entityId: row.id,
      title: row.subject,
      snippet: row.snippet || '',
      occurredAt: row.occurred_at,
      rank,
      companyId: row.company_id,
      companyName: row.company_name,
      route: row.company_id
        ? `/company/${row.company_id}?tab=timeline&filter=emails&focus=${row.id}`
        : '/companies',
      citationLabel: `Email: ${row.subject} (${formatCitationDate(row.occurred_at)})`
    })
  })

  const noteRows = db
    .prepare(`
      SELECT
        n.id,
        n.company_id,
        c.canonical_name AS company_name,
        COALESCE(NULLIF(TRIM(n.title), ''), 'Note') AS title,
        substr(replace(replace(trim(n.content), char(10), ' '), char(13), ' '), 1, 320) AS snippet,
        n.updated_at AS occurred_at
      FROM notes n
      LEFT JOIN org_companies c ON c.id = n.company_id
      WHERE
        n.company_id IS NOT NULL
        AND (lower(COALESCE(n.title, '')) LIKE ?
        OR lower(COALESCE(n.content, '')) LIKE ?)
      ORDER BY datetime(n.updated_at) DESC
      LIMIT ?
    `)
    .all(lowerLike, lowerLike, Math.max(8, Math.ceil(limit * 0.2))) as Array<{
    id: string
    company_id: string | null
    company_name: string | null
    title: string
    snippet: string
    occurred_at: string
  }>
  noteRows.forEach((row) => {
    const rank = 780 + recencyBoost(row.occurred_at)
    results.push({
      id: `note:${row.id}`,
      entityType: 'note',
      entityId: row.id,
      title: row.title,
      snippet: row.snippet,
      occurredAt: row.occurred_at,
      rank,
      companyId: row.company_id,
      companyName: row.company_name,
      route: row.company_id
        ? `/company/${row.company_id}?tab=timeline&filter=notes&focus=${row.id}`
        : '/companies',
      citationLabel: `Note: ${row.title} (${formatCitationDate(row.occurred_at)})`
    })
  })

  const memoRows = db
    .prepare(`
      SELECT
        imv.id AS version_id,
        im.id AS memo_id,
        im.company_id,
        c.canonical_name AS company_name,
        im.title,
        substr(replace(replace(trim(imv.content_markdown), char(10), ' '), char(13), ' '), 1, 320) AS snippet,
        imv.created_at AS occurred_at
      FROM investment_memo_versions imv
      JOIN investment_memos im ON im.id = imv.memo_id
      LEFT JOIN org_companies c ON c.id = im.company_id
      WHERE lower(COALESCE(im.title, '')) LIKE ?
         OR lower(COALESCE(imv.content_markdown, '')) LIKE ?
      ORDER BY datetime(imv.created_at) DESC
      LIMIT ?
    `)
    .all(lowerLike, lowerLike, Math.max(6, Math.ceil(limit * 0.15))) as Array<{
    version_id: string
    memo_id: string
    company_id: string | null
    company_name: string | null
    title: string
    snippet: string
    occurred_at: string
  }>
  memoRows.forEach((row) => {
    const rank = 700 + recencyBoost(row.occurred_at)
    results.push({
      id: `memo:${row.version_id}`,
      entityType: 'memo',
      entityId: row.memo_id,
      title: row.title,
      snippet: row.snippet,
      occurredAt: row.occurred_at,
      rank,
      companyId: row.company_id,
      companyName: row.company_name,
      route: row.company_id ? `/company/${row.company_id}?tab=memo` : '/companies',
      citationLabel: `Memo: ${row.title} (${formatCitationDate(row.occurred_at)})`
    })
  })

  const flat = dedupeUnifiedResults(results)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
  const grouped = emptyUnifiedGroups()
  flat.forEach((result) => {
    grouped[result.entityType].push(result)
  })

  return {
    query: trimmed,
    totalCount: flat.length,
    grouped,
    flat
  }
}
