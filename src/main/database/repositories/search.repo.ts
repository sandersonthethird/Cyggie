import { getDatabase } from '../connection'
import type { SearchResult, AdvancedSearchParams, AdvancedSearchResult } from '../../../shared/types/meeting'

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

export function searchMeetings(query: string, limit = 20): SearchResult[] {
  const db = getDatabase()

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
    .all(query, limit) as { meeting_id: string; snippet: string; rank: number }[]

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
  duration_seconds: number | null
  status: string
}

export function advancedSearch(params: AdvancedSearchParams): AdvancedSearchResult[] {
  const db = getDatabase()
  const limit = params.limit || 50

  // If text query provided, search FTS index + title matches
  if (params.query && params.query.trim()) {
    const seenIds = new Set<string>()
    let results: AdvancedSearchResult[] = []

    // 1. FTS full-text search (transcripts + summaries)
    try {
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
        .all(params.query, limit) as { meeting_id: string; snippet: string; rank: number }[]

      if (ftsRows.length > 0) {
        const placeholders = ftsRows.map(() => '?').join(',')
        const ids = ftsRows.map((r) => r.meeting_id)

        const sqlParts = [`SELECT id, title, date, speaker_map, duration_seconds, status FROM meetings WHERE id IN (${placeholders})`]
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
            status: m.status as AdvancedSearchResult['status']
          })
        }
      }
    } catch {
      // FTS query syntax error — fall through to title search
    }

    // 2. Title search (catches meetings not in FTS index)
    const titleSqlParts = ['SELECT id, title, date, speaker_map, duration_seconds, status FROM meetings WHERE title LIKE ?']
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
        status: m.status as AdvancedSearchResult['status']
      })
    }

    // 3. Speaker name search (speaker_map is JSON, search in app code)
    const speakerSqlParts = ['SELECT id, title, date, speaker_map, duration_seconds, status FROM meetings WHERE speaker_map LIKE ?']
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
        status: m.status as AdvancedSearchResult['status']
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
  const sqlParts = ['SELECT id, title, date, speaker_map, duration_seconds, status FROM meetings WHERE 1=1']
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
      status: m.status as AdvancedSearchResult['status']
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
