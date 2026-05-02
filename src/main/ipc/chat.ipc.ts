import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { queryMeeting, querySearchResults, abortChat } from '../llm/chat'
import { getProvider } from '../llm/provider-factory'
import * as notesRepo from '../database/repositories/notes.repo'
import { logAudit } from '../database/repositories/audit.repo'
import { getCurrentUserId } from '../security/current-user'
import type { ChatAttachment } from '../../shared/types/chat'

export function registerChatHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, () => {
    abortChat()
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_MEETING,
    async (_event, meetingId: string, question: string, attachments?: ChatAttachment[]) => {
      if (!meetingId || !question) {
        throw new Error('Meeting ID and question are required')
      }
      return queryMeeting(meetingId, question.trim(), attachments)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
    async (_event, meetingIds: string[], question: string, attachments?: ChatAttachment[]) => {
      if (!meetingIds || meetingIds.length === 0 || !question) {
        throw new Error('Meeting IDs and question are required')
      }
      return querySearchResults(meetingIds, question.trim(), attachments)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SAVE_AS_NOTE,
    async (
      _event,
      payload: {
        transcriptMarkdown: string
        companyId?: string | null
        contactId?: string | null
        sourceMeetingId?: string | null
      }
    ) => {
      const transcript = payload?.transcriptMarkdown?.trim()
      if (!transcript) throw new Error('transcriptMarkdown is required')
      if (!payload.companyId && !payload.contactId) {
        throw new Error('A company or contact is required to save the chat')
      }

      const title = await generateChatNoteTitle(transcript)
      const userId = getCurrentUserId()
      const note = notesRepo.createNote(
        {
          title,
          content: transcript,
          companyId: payload.companyId ?? null,
          contactId: payload.contactId ?? null,
          sourceMeetingId: payload.sourceMeetingId ?? null,
          folderPath: 'AI Chats'
        },
        userId
      )
      if (note) {
        logAudit(userId, 'note', note.id, 'create', { source: 'chat-save-as-note' })
      }
      return note
    }
  )
}

const TITLE_SYSTEM_PROMPT = `You name AI chat transcripts. Reply with a 4–8 word title in title case.
No quotes, no trailing punctuation, no prefixes like "Title:" — just the title itself.`

async function generateChatNoteTitle(transcript: string): Promise<string> {
  const fallback = `AI Chat — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  try {
    const provider = getProvider('chat')
    const sample = transcript.slice(0, 2000)
    const raw = await provider.generateSummary(
      TITLE_SYSTEM_PROMPT,
      `Transcript:\n\n${sample}`
    )
    const cleaned = raw
      .trim()
      .split('\n')[0]
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^title:\s*/i, '')
      .trim()
    if (!cleaned) return fallback
    // Cap at ~80 chars to keep the Notes list tidy
    return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned
  } catch {
    return fallback
  }
}
