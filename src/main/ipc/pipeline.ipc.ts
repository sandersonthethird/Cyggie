import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as dealRepo from '../database/repositories/deal.repo'
import * as pipelineConfigRepo from '../database/repositories/pipeline-config.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit, logAppEvent } from '../database/repositories/audit.repo'

export function registerPipelineHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PIPELINE_GET_BOARD, (_event, configId?: string) => {
    return dealRepo.getPipelineBoard(configId)
  })

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_CREATE_DEAL,
    (
      _event,
      data: {
        companyId: string
        stageId?: string | null
        pipelineConfigId?: string | null
        amountTargetUsd?: number | null
      }
    ) => {
      if (!data?.companyId) throw new Error('companyId is required')
      const userId = getCurrentUserId()
      const deal = dealRepo.createDeal(data, userId)
      logAudit(userId, 'deal', deal.id, 'create', data)
      logAppEvent(userId, 'pipeline.deal_created', {
        dealId: deal.id,
        companyId: deal.companyId,
        stageId: deal.stageId
      })
      return deal
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_MOVE_DEAL,
    (_event, dealId: string, toStageId: string, note?: string | null) => {
      if (!dealId?.trim()) throw new Error('dealId is required')
      if (!toStageId?.trim()) throw new Error('toStageId is required')
      const userId = getCurrentUserId()
      const event = dealRepo.moveDealStage(dealId, toStageId, note ?? null, 'manual', userId)
      logAudit(userId, 'deal_stage_event', event.id, 'stage_change', {
        dealId,
        fromStage: event.fromStage,
        toStage: event.toStage,
        note: note ?? null
      })
      logAppEvent(userId, 'pipeline.deal_moved', {
        dealId,
        fromStage: event.fromStage,
        toStage: event.toStage
      })
      return event
    }
  )

  ipcMain.handle(IPC_CHANNELS.PIPELINE_GET_COMPANY_ACTIVE_DEAL, (_event, companyId: string) => {
    if (!companyId?.trim()) throw new Error('companyId is required')
    return dealRepo.getCompanyActiveDeal(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.PIPELINE_GET_CONFIG, () => {
    const config = pipelineConfigRepo.getDefaultPipelineConfig()
    const stages = pipelineConfigRepo.listPipelineStages(config.id)
    return { config, stages }
  })

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_UPSERT_STAGE,
    (
      _event,
      data: {
        id?: string
        pipelineConfigId?: string
        label: string
        slug?: string
        sortOrder?: number
        color?: string | null
        isTerminal?: boolean
      }
    ) => {
      if (!data?.label?.trim()) throw new Error('label is required')
      const userId = getCurrentUserId()
      const stage = pipelineConfigRepo.upsertPipelineStage({ ...data, userId })
      logAudit(userId, 'pipeline_stage', stage.id, data.id ? 'update' : 'create', data)
      return stage
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_DELETE_STAGE,
    (_event, stageId: string, fallbackStageId?: string | null) => {
      if (!stageId?.trim()) throw new Error('stageId is required')
      const userId = getCurrentUserId()
      const stages = pipelineConfigRepo.deletePipelineStage(stageId, fallbackStageId ?? null, userId)
      logAudit(userId, 'pipeline_stage', stageId, 'delete', { fallbackStageId: fallbackStageId ?? null })
      return stages
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PIPELINE_REORDER_STAGES,
    (_event, pipelineConfigId: string, orderedStageIds: string[]) => {
      if (!pipelineConfigId?.trim()) throw new Error('pipelineConfigId is required')
      if (!Array.isArray(orderedStageIds) || orderedStageIds.length === 0) {
        throw new Error('orderedStageIds is required')
      }
      const userId = getCurrentUserId()
      const stages = pipelineConfigRepo.reorderPipelineStages(pipelineConfigId, orderedStageIds)
      logAudit(userId, 'pipeline_stage', pipelineConfigId, 'update', {
        reorderedStageIds: orderedStageIds
      })
      return stages
    }
  )
}
