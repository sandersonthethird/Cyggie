import { getDatabase } from '../connection'
import { extractCompanyFromEmail, extractDomainFromEmail } from '../../utils/company-extractor'
import * as companyRepo from './company.repo'
import type { SearchResult, AdvancedSearchParams, AdvancedSearchResult, CategorizedSuggestions, CompanySuggestion } from '../../../shared/types/meeting'

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
  'only', 'same', 'tell', 'know', 'think', 'said'
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

  const rows = db
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

  // Join with meetings table for title and date
  if (rows.length === 0) return []

  const placeholders = rows.map(() => '?').join(',')
  const meetingIds = rows.map((r) => r.meeting_id)
  const meetings = db
    .prepare(`SELECT id, title, date FROM meetings WHERE id IN (${placeholders})`)
    .all(...meetingIds) as { id: string; title: string; date: string }[]

  const meetingMap = new Map(meetings.map((m) => [m.id, m]))

  return rows
    .map((row) => {
      const meeting = meetingMap.get(row.meeting_id)
      if (!meeting) return null
      return {
        meetingId: row.meeting_id,
        title: meeting.title,
        date: meeting.date,
        snippet: row.snippet,
        rank: row.rank
      }
    })
    .filter((r): r is SearchResult => r !== null)
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

  // 2. Companies: direct prefix matches from the companies cache table
  const cachedCompanyRows = db
    .prepare('SELECT domain, display_name FROM companies WHERE display_name LIKE ? LIMIT ?')
    .all(`%${prefix}%`, limit) as { domain: string; display_name: string }[]

  for (const row of cachedCompanyRows) {
    if (!companyMap.has(row.domain)) {
      companyMap.set(row.domain, row.display_name)
    }
  }

  // Also check companies column in meetings for names not yet in cache
  const meetingCompanyRows = db
    .prepare('SELECT companies FROM meetings WHERE companies IS NOT NULL')
    .all() as { companies: string }[]

  for (const row of meetingCompanyRows) {
    try {
      const comps: string[] = JSON.parse(row.companies)
      for (const c of comps) {
        if (c.toLowerCase().includes(lower) && !companyMap.has(c)) {
          companyMap.set(c, c)
        }
      }
    } catch { /* skip */ }
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

  return {
    people: [...people].sort().slice(0, limit),
    companies: companySuggestions,
    meetings: meetingRows
  }
}
