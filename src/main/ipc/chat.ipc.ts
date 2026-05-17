import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { abortChat } from '../llm/chat'
import { chatDispatch } from '../llm/chat-dispatch'
import { generateChatTitle } from '../llm/chat-title'
import { withChatPersistence } from '../llm/chat-persistence'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import * as notesRepo from '@cyggie/db/sqlite/repositories/notes.repo'
import { logAudit } from '@cyggie/db/sqlite/repositories/audit.repo'
import { getCurrentUserId } from '../security/current-user'
import type { ChatAttachment } from '../../shared/types/chat'
import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import { getFlaggedFiles } from '@cyggie/db/sqlite/repositories/company-file-flags.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { estimateChatContext } from '../llm/context-size'
import type { ChatContextSizeEstimate } from '../../shared/types/company'

const _chatCompanyNotesRepo = makeEntityNotesRepo('company_id')

function getMeetingTitle(meetingId: string): string | null {
  const db = getDatabase()
  const row = db.prepare(`SELECT title FROM meetings WHERE id = ?`).get(meetingId) as
    | { title: string }
    | undefined
  return row?.title ?? null
}

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
      const ctx = deriveChatContext({ meetingId })
      if (!ctx) throw new Error('Failed to derive chat context')
      return withChatPersistence({
        contextId: ctx.contextId,
        contextKind: ctx.kind,
        contextLabel: getMeetingTitle(meetingId),
        userMessage: { content: question.trim(), attachments },
        userId: getCurrentUserId(),
        runLLM: () => chatDispatch({
          kind: { kind: 'meeting', meetingId },
          question: question.trim(),
          attachments,
        }),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
    async (_event, meetingIds: string[], question: string, attachments?: ChatAttachment[]) => {
      if (!meetingIds || meetingIds.length === 0 || !question) {
        throw new Error('Meeting IDs and question are required')
      }
      // search-results chats are intentionally NOT persisted (out of scope v1)
      return chatDispatch({
        kind: { kind: 'meetings', meetingIds },
        question: question.trim(),
        attachments,
      })
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

      const title = await generateChatTitle(transcript)
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

  /**
   * Pre-flight context-size estimate for the chat panel banner. Cheap (~30ms);
   * called on chat-panel mount, on companyId change, and on COMPANY_FLAGS_CHANGED
   * broadcast (debounced 300ms in the renderer).
   *
   * Banner is only shown for company-scoped chat; this handler returns
   * conservative empty estimates when companyId is missing.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_CONTEXT_SIZE_PREFLIGHT,
    (_event, companyId: string | null): ChatContextSizeEstimate => {
      if (!companyId) {
        return {
          totalChars: 0,
          estTokens: 0,
          estCostUsd: 0,
          willTriggerWarning: false,
          breakdown: { meetings: 0, notes: 0, emails: 0, files: 0, externalResearch: 0, contactProfiles: 0, other: 0 },
          fileBreakdown: [],
          flaggedFileCount: 0,
        }
      }
      const summaryRows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
      const companyNotes = _chatCompanyNotesRepo.list(companyId)
      const flaggedFiles = getFlaggedFiles(companyId)
      const estimate = estimateChatContext({
        flaggedFiles: flaggedFiles.map(f => ({ fileName: f.fileName, sizeBytes: 0, mimeType: f.mimeType })),
        summaryCount: summaryRows.length,
        companyNoteCount: companyNotes.length,
        caps: { perItemCap: 48_000, totalCap: 300_000 },
      })
      return { ...estimate, flaggedFileCount: flaggedFiles.length }
    },
  )
}
