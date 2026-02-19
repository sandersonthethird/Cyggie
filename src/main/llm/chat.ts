import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { LLMProvider } from './provider'
import { ClaudeProvider } from './claude-provider'
import { OllamaProvider } from './ollama-provider'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { searchMeetings, extractKeywords, buildOrQuery, searchByTitle, searchBySpeaker } from '../database/repositories/search.repo'
import { readTranscript, readSummary } from '../storage/file-manager'
import { critiqueText } from './critique'
import type { LlmProvider } from '../../shared/types/settings'

let chatAbortController: AbortController | null = null

export function abortChat(): void {
  chatAbortController?.abort()
  chatAbortController = null
}

function getProvider(): LLMProvider {
  const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider

  if (providerType === 'ollama') {
    const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
    const model = getSetting('ollamaModel') || 'llama3.1'
    return new OllamaProvider(model, host)
  }

  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) {
    throw new Error('Claude API key not configured. Go to Settings to add it.')
  }
  return new ClaudeProvider(apiKey)
}

function sendProgress(text: string): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, text)
    }
  }
}

function sendClear(): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, null)
    }
  }
}

const MEETING_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about a meeting transcript.
You have access to the full transcript, any user notes, and the AI-generated summary (if available).
Answer questions accurately based on what was discussed in the meeting.
If the information isn't in the transcript, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

const GLOBAL_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's meeting transcripts.
You have access to relevant excerpts from multiple meetings.
Answer questions accurately based on the content provided.
Always cite which meeting the information comes from using the format: "In [Meeting Title] (Date):".
If the information isn't in any of the provided excerpts, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

const SEARCH_RESULTS_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's meeting search results.
You have access to summaries, notes, and transcript excerpts from the meetings the user found via search.
Answer questions accurately based on the content provided.
Always cite which meeting the information comes from using the format: "In [Meeting Title] (Date):".
If the information isn't in any of the provided meetings, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

export async function queryMeeting(meetingId: string, question: string): Promise<string> {
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

  const userPrompt = `Here is the meeting information:

${context}

---

User question: ${question}`

  const provider = getProvider()
  chatAbortController = new AbortController()
  const draft = await provider.generateSummary(MEETING_SYSTEM_PROMPT, userPrompt, sendProgress, chatAbortController.signal)
  sendClear()
  const refined = await critiqueText(provider, draft, sendProgress, chatAbortController.signal)
  chatAbortController = null
  return refined
}

export async function queryGlobal(question: string): Promise<string> {
  const keywords = extractKeywords(question)
  const seenIds = new Set<string>()
  const searchResults: { meetingId: string; title: string; date: string; snippet: string; rank: number }[] = []

  // Strategy 1: OR-based FTS search — find meetings containing ANY keyword
  if (keywords.length > 0) {
    try {
      const orQuery = buildOrQuery(keywords)
      const ftsResults = searchMeetings(orQuery, 10, true)
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
    const titleMatches = searchByTitle(keywords, 10)
    for (const m of titleMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  // Strategy 3: Speaker/attendee name search
  if (keywords.length > 0) {
    const speakerMatches = searchBySpeaker(keywords, 10)
    for (const m of speakerMatches) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id)
        searchResults.push({ meetingId: m.id, title: m.title, date: m.date, snippet: '', rank: 0 })
      }
    }
  }

  if (searchResults.length === 0) {
    return 'I couldn\'t find any meetings related to your question. Try rephrasing your question or check that you have recorded meetings with transcripts.'
  }

  // Build context from relevant meetings
  const contextParts: string[] = []

  for (const result of searchResults.slice(0, 8)) {
    const meeting = meetingRepo.getMeeting(result.meetingId)
    if (!meeting) continue

    const parts: string[] = []
    parts.push(`### "${meeting.title}" (${new Date(meeting.date).toLocaleDateString()})`)
    if (meeting.speakerMap && Object.keys(meeting.speakerMap).length > 0) {
      parts.push(`Participants: ${Object.values(meeting.speakerMap).join(', ')}`)
    }
    parts.push('')

    // Include summary if available (concise, high-signal)
    if (meeting.summaryPath) {
      const summary = readSummary(meeting.summaryPath)
      if (summary) {
        parts.push('**Summary:**')
        parts.push(summary)
        parts.push('')
      }
    }

    // Include notes if present
    if (meeting.notes) {
      parts.push('**Notes:**')
      parts.push(meeting.notes)
      parts.push('')
    }

    // Include transcript excerpt
    if (meeting.transcriptPath) {
      const transcript = readTranscript(meeting.transcriptPath)
      if (transcript) {
        const excerptLength = meeting.summaryPath ? 1500 : 3000
        let excerpt = transcript

        if (transcript.length > excerptLength) {
          // Try to find the matching content and include context around it
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

  if (contextParts.length === 0) {
    return 'I found some matching meetings but couldn\'t read their content. Please check that the transcript files exist.'
  }

  const context = contextParts.join('\n')

  const userPrompt = `Here are relevant excerpts from the user's meetings:

${context}

---

User question: ${question}

Please answer based on the meeting excerpts above. Cite the meeting title and date when referencing specific information.`

  const provider = getProvider()
  chatAbortController = new AbortController()
  const draft = await provider.generateSummary(GLOBAL_SYSTEM_PROMPT, userPrompt, sendProgress, chatAbortController.signal)
  sendClear()
  const refined = await critiqueText(provider, draft, sendProgress, chatAbortController.signal)
  chatAbortController = null
  return refined
}

export async function querySearchResults(meetingIds: string[], question: string): Promise<string> {
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

    // Include notes if present
    if (meeting.notes) {
      parts.push('**Notes:**')
      parts.push(meeting.notes)
      parts.push('')
    }

    // Include transcript excerpt if no summary, or a shorter one if summary exists
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

  const userPrompt = `Here are the meetings from the user's search results:

${context}

---

User question: ${question}

Please answer based on the meeting content above. Cite the meeting title and date when referencing specific information.`

  const provider = getProvider()
  chatAbortController = new AbortController()
  const draft = await provider.generateSummary(SEARCH_RESULTS_SYSTEM_PROMPT, userPrompt, sendProgress, chatAbortController.signal)
  sendClear()
  const refined = await critiqueText(provider, draft, sendProgress, chatAbortController.signal)
  chatAbortController = null
  return refined
}
