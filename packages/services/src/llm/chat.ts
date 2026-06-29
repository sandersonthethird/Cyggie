import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import { searchMeetings, extractKeywords, buildOrQuery, searchByTitle, searchBySpeaker, searchByAllSpeakers } from '@cyggie/db/sqlite/repositories/search.repo'
import { readTranscript, readSummary } from '@main/storage/file-manager'
import { runChatTurn, abortChatTurn } from './chat-runner'
import {
  buildSearchResultsContext,
  SEARCH_RESULTS_SYSTEM_PROMPT,
  SEARCH_RESULTS_QUESTION_FOOTER,
} from './context-builders'
import type { ChatAttachment } from '@shared/types/chat'

export function abortChat(): void {
  // Both queryMeeting and querySearchResults route through runChatTurn's
  // single shared AbortController.
  abortChatTurn()
}

// Re-exported from chat-runner for crm-chat.ts (queryAll's attachment
// injection runs before runChatTurn).
export { injectTextAttachments } from './chat-runner'

const MEETING_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about a meeting.
You have access to the meeting's transcript and/or user notes, plus the AI-generated summary (if available).
Answer questions accurately based on what was discussed in the meeting.
If the information isn't in the provided context, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

// Used when the user has attached companies/contacts to a meeting chat via
// "+ Add context": the meeting stays primary, but the model may also draw on the
// attached entities' broader history (their meetings, emails, notes, files).
const MEETING_WITH_ENTITIES_SYSTEM_PROMPT = `You are a helpful research assistant for a venture capital firm.
Your PRIMARY context is one meeting — its transcript and/or notes and AI summary. The user has ALSO
attached the broader context of one or more companies/contacts (their meetings, emails, notes, and files),
shown under "## Attached context". Answer using all of it; when the question is about the meeting itself,
lead with the meeting. If the information isn't in the provided context, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

/**
 * Single-meeting chat. The meeting's full transcript/notes/summary is the
 * primary context. When `attachedContext` is provided (deduped markdown for the
 * companies/contacts the user attached via "+ Add context", built by the caller
 * — see chat-dispatch.ts), it's appended under "## Attached context" and a
 * combined system prompt is used. Resolving the attached markdown in the caller
 * keeps chat.ts free of an entities-chat import (avoids a chat ↔ crm-chat cycle).
 */
export async function queryMeeting(
  meetingId: string,
  question: string,
  attachments: ChatAttachment[] = [],
  attachedContext: string | null = null,
): Promise<string> {
  const meeting = meetingRepo.getMeeting(meetingId)
  if (!meeting) throw new Error('Meeting not found')

  // Gather all context
  const parts: string[] = []

  parts.push(`Meeting: ${meeting.title}`)
  parts.push(`Date: ${new Date(meeting.date).toLocaleDateString()}`)

  if (meeting.speakerMap && Object.keys(meeting.speakerMap).length > 0) {
    const speakers = Object.values(meeting.speakerMap).join(', ')
    parts.push(`Participants: ${speakers}`)
  }

  parts.push('')

  // Track whether the meeting itself yielded any usable content. A meeting may
  // legitimately have notes/summary but no transcript (in-person calls), so we
  // no longer hard-require a transcript.
  let hasMeetingContent = false

  // Add transcript
  if (meeting.transcriptPath) {
    const transcript = readTranscript(meeting.transcriptPath, meeting)
    if (transcript) {
      parts.push('## Transcript')
      parts.push(transcript)
      parts.push('')
      hasMeetingContent = true
    }
  }

  // Add notes if present
  if (meeting.notes) {
    parts.push('## User Notes')
    parts.push(meeting.notes)
    parts.push('')
    hasMeetingContent = true
  }

  // Add summary if present
  if (meeting.summaryPath) {
    const summary = readSummary(meeting.summaryPath, meeting)
    if (summary) {
      parts.push('## AI Summary')
      parts.push(summary)
      parts.push('')
      hasMeetingContent = true
    }
  }

  // Proceed when the meeting OR the attached entities contributed something.
  if (!hasMeetingContent && !attachedContext) {
    throw new Error('No transcript, notes, or summary available for this meeting')
  }

  if (attachedContext) {
    parts.push('## Attached context')
    parts.push('The user attached the following companies/contacts for additional context:')
    parts.push('')
    parts.push(attachedContext)
    parts.push('')
  }

  const context = parts.join('\n')

  return runChatTurn({
    systemPrompt: attachedContext ? MEETING_WITH_ENTITIES_SYSTEM_PROMPT : MEETING_SYSTEM_PROMPT,
    context,
    question,
    attachments,
    userPromptPrefix: 'Here is the meeting information:',
    questionLabel: 'User question',
  })
}

export async function querySearchResults(meetingIds: string[], question: string, attachments: ChatAttachment[] = []): Promise<string> {
  const result = buildSearchResultsContext({ meetingIds })

  if (result.kind === 'response') return result.text
  if (result.kind === 'error') throw new Error(result.message)

  return runChatTurn({
    systemPrompt: SEARCH_RESULTS_SYSTEM_PROMPT,
    context: result.markdown,
    question,
    attachments,
    userPromptPrefix: "Here are the meetings from the user's search results:",
    questionLabel: 'User question',
    questionFooter: SEARCH_RESULTS_QUESTION_FOOTER,
  })
}

// buildMeetingContext: 4-strategy meeting search assembling a markdown
// context string for queryAll(). Imported cross-module by crm-chat.ts so
// vi.mock can intercept it for the parity baseline test (same-module calls
// can't be intercepted by vi.mock).
export function buildMeetingContext(question: string): string {
  const keywords = extractKeywords(question)
  const seenIds = new Set<string>()
  const searchResults: { meetingId: string; title: string; date: string; snippet: string; rank: number }[] = []

  // Capitalized words that survived stop-word filtering — likely person names
  const keywordSet = new Set(keywords)
  const potentialNames = (question.match(/\b[A-Z][a-z]{1,}\b/g) ?? [])
    .filter((n) => keywordSet.has(n.toLowerCase()))
    .map((n) => n.toLowerCase())

  // Strategy 0: AND-based attendee co-occurrence
  if (potentialNames.length >= 2) {
    const coAttendeeMatches = searchByAllSpeakers(potentialNames, 20)
    for (const m of coAttendeeMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  // Strategy 1: OR-based FTS keyword search
  if (keywords.length > 0) {
    try {
      const orQuery = buildOrQuery(keywords)
      const ftsResults = searchMeetings(orQuery, 20, true)
      for (const r of ftsResults) {
        if (!seenIds.has(r.meetingId)) {
          seenIds.add(r.meetingId)
          searchResults.push(r)
        }
      }
    } catch {
      /* FTS query error — continue */
    }
  }

  // Strategy 2: Title LIKE search
  if (keywords.length > 0) {
    const titleMatches = searchByTitle(keywords, 20)
    for (const m of titleMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  // Strategy 3: Speaker/attendee name search
  if (keywords.length > 0) {
    const speakerMatches = searchBySpeaker(keywords, 20)
    for (const m of speakerMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  if (searchResults.length === 0) return ''

  const contextParts: string[] = []

  for (const result of searchResults.slice(0, 15)) {
    const meeting = meetingRepo.getMeeting(result.meetingId)
    if (!meeting) continue

    const parts: string[] = []
    parts.push(`### "${meeting.title}" (${new Date(meeting.date).toLocaleDateString()})`)
    if (meeting.speakerMap && Object.keys(meeting.speakerMap).length > 0) {
      parts.push(`Participants: ${Object.values(meeting.speakerMap).join(', ')}`)
    }
    if (meeting.attendees && meeting.attendees.length > 0) {
      parts.push(`Attendee emails: ${meeting.attendees.join(', ')}`)
    }
    parts.push('')

    if (meeting.summaryPath) {
      const summary = readSummary(meeting.summaryPath, meeting)
      if (summary) {
        parts.push('**Summary:**')
        parts.push(summary)
        parts.push('')
      }
    }

    if (meeting.notes) {
      parts.push('**Notes:**')
      parts.push(meeting.notes)
      parts.push('')
    }

    if (meeting.transcriptPath) {
      const transcript = readTranscript(meeting.transcriptPath, meeting)
      if (transcript) {
        const excerptLength = meeting.summaryPath ? 1500 : 3000
        let excerpt = transcript
        if (transcript.length > excerptLength) {
          if (result.snippet) {
            const snippetText = result.snippet.replace(/<mark>|<\/mark>/g, '').replace(/\.\.\./g, '')
            const matchIndex = transcript.toLowerCase().indexOf(snippetText.toLowerCase().substring(0, 50))
            if (matchIndex >= 0) {
              const start = Math.max(0, matchIndex - 500)
              const end = Math.min(transcript.length, matchIndex + excerptLength - 500)
              excerpt = transcript.substring(start, end)
              if (start > 0) excerpt = '...' + excerpt
              if (end < transcript.length) excerpt = excerpt + '...'
            } else {
              excerpt = transcript.substring(0, excerptLength) + '...'
            }
          } else {
            excerpt = transcript.substring(0, excerptLength) + '...'
          }
        }
        parts.push('**Transcript excerpt:**')
        parts.push(excerpt)
        parts.push('')
      }
    }

    if (parts.length > 2) {
      contextParts.push(parts.join('\n'))
      contextParts.push('---')
      contextParts.push('')
    }
  }

  return contextParts.join('\n')
}
