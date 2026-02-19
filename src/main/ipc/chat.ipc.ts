import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { queryMeeting, queryGlobal, querySearchResults, abortChat } from '../llm/chat'

export function registerChatHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, () => {
    abortChat()
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_MEETING,
    async (_event, meetingId: string, question: string) => {
      if (!meetingId || !question) {
        throw new Error('Meeting ID and question are required')
      }
      return queryMeeting(meetingId, question.trim())
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_QUERY_GLOBAL, async (_event, question: string) => {
    if (!question) {
      throw new Error('Question is required')
    }
    return queryGlobal(question.trim())
  })

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
    async (_event, meetingIds: string[], question: string) => {
      if (!meetingIds || meetingIds.length === 0 || !question) {
        throw new Error('Meeting IDs and question are required')
      }
      return querySearchResults(meetingIds, question.trim())
    }
  )
}
