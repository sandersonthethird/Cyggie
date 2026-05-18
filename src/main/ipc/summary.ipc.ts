import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { generateSummary, abortSummary } from '@cyggie/services/llm/summarizer'
import { withProgressSink } from '@cyggie/services/llm/send-progress'
import { createSummaryProgressSink } from '../lib/ipc-progress-sink'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '@cyggie/db/sqlite/repositories/audit.repo'
import type { SummaryGenerateResult } from '../../shared/types/summary'

export function registerSummaryHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SUMMARY_ABORT, () => {
    abortSummary()
  })

  ipcMain.handle(
    IPC_CHANNELS.SUMMARY_GENERATE,
    async (_event, meetingId: string, templateId: string): Promise<SummaryGenerateResult> => {
      const userId = getCurrentUserId()
      const result = await withProgressSink(createSummaryProgressSink(), () =>
        generateSummary(meetingId, templateId, userId),
      )
      logAudit(userId, 'meeting', meetingId, 'update', {
        summaryGenerated: true,
        templateId
      })
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SUMMARY_REGENERATE,
    async (_event, meetingId: string, templateId: string): Promise<SummaryGenerateResult> => {
      const userId = getCurrentUserId()
      const result = await withProgressSink(createSummaryProgressSink(), () =>
        generateSummary(meetingId, templateId, userId),
      )
      logAudit(userId, 'meeting', meetingId, 'update', {
        summaryRegenerated: true,
        templateId
      })
      return result
    }
  )
}
