import { getProvider } from './provider-factory'
import { sendProgress } from './send-progress'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { searchMeetings, extractKeywords, buildOrQuery, searchByTitle, searchBySpeaker, searchByAllSpeakers } from '../database/repositories/search.repo'
import { readTranscript, readSummary } from '../storage/file-manager'
import { runChatTurn, abortChatTurn, injectTextAttachments } from './chat-runner'
import type { ChatAttachment } from '../../shared/types/chat'

// Local controller for the legacy `querySearchResults` path which hasn't been
// migrated to runChatTurn yet (Step 6 of the chat-paths refactor). Once that
// migration lands, this controller and the dual-abort logic in `abortChat`
// below get deleted, and `chat.ts` itself collapses into context-builders.ts.
let chatAbortController: AbortController | null = null

export function abortChat(): void {
  // Aborts whichever of the two paths is in flight: queryMeeting (now via
  // runChatTurn / chat-runner's shared controller) and the legacy
  // querySearchResults (still on the local controller until Step 6).
  // Both are no-ops if their respective controller isn't holding a turn.
  abortChatTurn()
  chatAbortController?.abort()
  chatAbortController = null
}

// Re-exported from chat-runner for backwards compatibility with the still-
// present legacy paths (contact-chat.ts, company-chat.ts, crm-chat.ts).
// When those files are deleted in Step 9, this re-export goes with chat.ts.
export { injectTextAttachments } from './chat-runner'

const MEETING_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about a meeting transcript.
You have access to the full transcript, any user notes, and the AI-generated summary (if available).
Answer questions accurately based on what was discussed in the meeting.
If the information isn't in the transcript, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

const SEARCH_RESULTS_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's meeting search results.
You have access to summaries, notes, and transcript excerpts from the meetings the user found via search.
Answer questions accurately based on the content provided.
Always cite which meeting the information comes from using the format: "In [Meeting Title] (Date):".
If the information isn't in any of the provided meetings, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

export async function queryMeeting(meetingId: string, question: string, attachments: ChatAttachment[] = []): Promise<string> {
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

  // Add transcript
  if (meeting.transcriptPath) {
    const transcript = readTranscript(meeting.transcriptPath)
    if (transcript) {
      parts.push('## Transcript')
      parts.push(transcript)
      parts.push('')
    }
  }

  // Add notes if present
  if (meeting.notes) {
    parts.push('## User Notes')
    parts.push(meeting.notes)
    parts.push('')
  }

  // Add summary if present
  if (meeting.summaryPath) {
    const summary = readSummary(meeting.summaryPath)
    if (summary) {
      parts.push('## AI Summary')
      parts.push(summary)
      parts.push('')
    }
  }

  const context = parts.join('\n')

  if (!context.includes('## Transcript')) {
    throw new Error('No transcript available for this meeting')
  }

  return runChatTurn({
    systemPrompt: MEETING_SYSTEM_PROMPT,
    context,
    question,
    attachments,
    userPromptPrefix: 'Here is the meeting information:',
    questionLabel: 'User question',
  })
}

// buildMeetingContext runs the 4-strategy meeting search and assembles a markdown context
// string for use in queryAll(). Returns '' if no meetings match — callers should proceed
// with other context sources rather than treating this as an error.
export function buildMeetingContext(question: string): string {
  const keywords = extractKeywords(question)
  const seenIds = new Set<string>()
  const searchResults: { meetingId: string; title: string; date: string; snippet: string; rank: number }[] = []

  // Extract capitalized words that survived stop-word filtering — likely person names
  const keywordSet = new Set(keywords)
  const potentialNames = (question.match(/\b[A-Z][a-z]{1,}\b/g) ?? [])
    .filter(n => keywordSet.has(n.toLowerCase()))
    .map(n => n.toLowerCase())

  // Strategy 0: AND-based attendee co-occurrence — prioritize meetings where ALL named people appear
  if (potentialNames.length >= 2) {
    const coAttendeeMatches = searchByAllSpeakers(potentialNames, 20)
    for (const m of coAttendeeMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  // Strategy 1: OR-based FTS search — find meetings containing ANY keyword
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
      // FTS query error — continue to other strategies
    }
  }

  // Strategy 2: Title search — catches meetings whose title matches but may not be FTS-indexed
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

  // Build context from relevant meetings
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
      const summary = readSummary(meeting.summaryPath)
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
      const transcript = readTranscript(meeting.transcriptPath)
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

export async function querySearchResults(meetingIds: string[], question: string, attachments: ChatAttachment[] = []): Promise<string> {
  if (meetingIds.length === 0) {
    return 'No meetings in the search results to query.'
  }

  const contextParts: string[] = []

  // Process up to 10 meetings (already ordered by search relevance)
  for (const id of meetingIds.slice(0, 10)) {
    const meeting = meetingRepo.getMeeting(id)
    if (!meeting) continue

    const parts: string[] = []
    parts.push(`### "${meeting.title}" (${new Date(meeting.date).toLocaleDateString()})`)

    if (meeting.speakerMap && Object.keys(meeting.speakerMap).length > 0) {
      parts.push(`Participants: ${Object.values(meeting.speakerMap).join(', ')}`)
    }
    parts.push('')

    // Prefer summary (concise, high-signal) over full transcript
    if (meeting.summaryPath) {
      const summary = readSummary(meeting.summaryPath)
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
      const transcript = readTranscript(meeting.transcriptPath)
      if (transcript) {
        const excerptLength = meeting.summaryPath ? 1500 : 3000
        let excerpt = transcript

        if (transcript.length > excerptLength) {
          excerpt = transcript.substring(0, excerptLength) + '...'
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

  if (contextParts.length === 0) {
    return 'I couldn\'t load any data from the search result meetings. Please check that transcripts exist.'
  }

  const context = contextParts.join('\n')

  const enhancedQuestion = injectTextAttachments(question, attachments)
  const imageAtts = attachments.filter((a) => a.type === 'image')

  const userPrompt = `Here are the meetings from the user's search results:

${context}

---

User question: ${enhancedQuestion}

Please answer based on the meeting content above. Cite the meeting title and date when referencing specific information.`

  const provider = getProvider('chat')
  chatAbortController = new AbortController()
  const result = await provider.generateSummary(SEARCH_RESULTS_SYSTEM_PROMPT, userPrompt, sendProgress, chatAbortController.signal, imageAtts)
  chatAbortController = null
  return result
}
