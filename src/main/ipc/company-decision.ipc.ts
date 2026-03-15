import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as decisionRepo from '../database/repositories/company-decision-log.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import type { CompanyDecisionLog } from '../../shared/types/company'

export function registerCompanyDecisionHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPANY_DECISION_LOG_LIST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return decisionRepo.listCompanyDecisionLogs(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_DECISION_LOG_GET, (_event, logId: string) => {
    if (!logId) throw new Error('logId is required')
    return decisionRepo.getCompanyDecisionLog(logId)
  })

  ipcMain.handle(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return decisionRepo.getLatestCompanyDecisionLog(companyId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_DECISION_LOG_CREATE,
    (
      _event,
      data: {
        companyId: string
        decisionType: string
        decisionDate: string
        decisionOwner?: string | null
        amountApproved?: string | null
        targetOwnership?: string | null
        moreIfPossible?: boolean
        structure?: string | null
        rationale?: string[]
        dependencies?: string[]
        nextSteps?: Array<{ what: string; byWhom: string | null; dueDate: string | null }>
        linkedArtifacts?: Array<{ type: string; refId: string | null; label: string }>
      }
    ) => {
      if (!data?.companyId) throw new Error('companyId is required')
      if (!data.decisionType?.trim()) throw new Error('decisionType is required')
      if (!data.decisionDate?.trim()) throw new Error('decisionDate is required')
      const userId = getCurrentUserId()
      const log = decisionRepo.createCompanyDecisionLog(data, userId)
      logAudit(userId, 'company_decision_log', log.id, 'create', data)
      return log
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_DECISION_LOG_UPDATE,
    (_event, logId: string, updates: Partial<CompanyDecisionLog>) => {
      if (!logId) throw new Error('logId is required')
      const userId = getCurrentUserId()
      const log = decisionRepo.updateCompanyDecisionLog(logId, updates || {}, userId)
      if (log) {
        logAudit(userId, 'company_decision_log', logId, 'update', updates || {})
      }
      return log
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_DECISION_LOG_DELETE, (_event, logId: string) => {
    if (!logId) throw new Error('logId is required')
    const userId = getCurrentUserId()
    const deleted = decisionRepo.deleteCompanyDecisionLog(logId)
    if (deleted) {
      logAudit(userId, 'company_decision_log', logId, 'delete', null)
    }
    return deleted
  })
}
