import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '@cyggie/db/sqlite/repositories'
import type { CompanyPipelineStage, CompanyPriority, CompanyRound } from '../../shared/types/company'

export function registerPipelineHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_LIST,
    (_event, filter?: {
      pipelineStage?: CompanyPipelineStage | null
      priority?: CompanyPriority | null
      round?: CompanyRound | null
      query?: string
      passExpiryBefore?: string | null
    }) => {
      return companyRepo.listPipelineCompanies(filter)
    }
  )
}
