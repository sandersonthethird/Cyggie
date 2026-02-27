import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import type { CompanyPipelineStage, CompanyPriority, CompanyRound } from '../../shared/types/company'

export function registerPipelineHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_LIST,
    (_event, filter?: {
      pipelineStage?: CompanyPipelineStage | null
      priority?: CompanyPriority | null
      round?: CompanyRound | null
      query?: string
    }) => {
      return companyRepo.listPipelineCompanies(filter)
    }
  )
}
