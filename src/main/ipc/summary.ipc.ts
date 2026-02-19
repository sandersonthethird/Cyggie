import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { generateSummary, abortSummary } from '../llm/summarizer'

export function registerSummaryHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SUMMARY_ABORT, () => {
    abortSummary()
  })

  ipcMain.handle(
    IPC_CHANNELS.SUMMARY_GENERATE,
    async (_event, meetingId: string, templateId: string) => {
      return generateSummary(meetingId, templateId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SUMMARY_REGENERATE,
    async (_event, meetingId: string, templateId: string) => {
      return generateSummary(meetingId, templateId)
    }
  )
}
