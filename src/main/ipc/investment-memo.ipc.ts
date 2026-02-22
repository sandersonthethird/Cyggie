import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as memoRepo from '../database/repositories/investment-memo.repo'
import * as artifactRepo from '../database/repositories/artifact.repo'
import { exportMemoMarkdownToPdf } from '../services/memo-export.service'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

export function registerInvestmentMemoHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const company = companyRepo.getCompany(companyId)
    if (!company) throw new Error('Company not found')
    return memoRepo.getOrCreateMemoForCompany(companyId, company.canonicalName, getCurrentUserId())
  })

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS, (_event, memoId: string) => {
    if (!memoId) throw new Error('memoId is required')
    return memoRepo.listMemoVersions(memoId)
  })

  ipcMain.handle(
    IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
    (
      _event,
      memoId: string,
      data: {
        contentMarkdown: string
        structuredJson?: string | null
        changeNote?: string | null
        createdBy?: string | null
      }
    ) => {
      if (!memoId) throw new Error('memoId is required')
      if (!data?.contentMarkdown?.trim()) throw new Error('contentMarkdown is required')
      const userId = getCurrentUserId()
      const version = memoRepo.saveMemoVersion(memoId, data, userId)
      logAudit(userId, 'investment_memo_version', version.id, 'create', {
        memoId,
        versionNumber: version.versionNumber,
        changeNote: data.changeNote ?? null
      })
      return version
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.INVESTMENT_MEMO_SET_STATUS,
    (_event, memoId: string, status: 'draft' | 'review' | 'final' | 'archived') => {
      if (!memoId) throw new Error('memoId is required')
      const userId = getCurrentUserId()
      const updated = memoRepo.updateMemoStatus(memoId, status, userId)
      if (updated) {
        logAudit(userId, 'investment_memo', memoId, 'update', { status })
      }
      return updated
    }
  )

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_PDF, async (_event, memoId: string) => {
    if (!memoId) throw new Error('memoId is required')
    const memo = memoRepo.getMemo(memoId)
    if (!memo) {
      throw new Error('Memo not found')
    }
    const latest = memoRepo.getMemoLatestVersion(memo.id)
    if (!latest) {
      throw new Error('Memo has no versions to export')
    }

    const company = companyRepo.getCompany(memo.companyId)
    if (!company) {
      throw new Error('Company not found')
    }

    const exported = await exportMemoMarkdownToPdf({
      companyName: company.canonicalName,
      memoTitle: memo.title,
      versionNumber: latest.versionNumber,
      contentMarkdown: latest.contentMarkdown
    })

    const artifact = artifactRepo.createArtifact({
      companyId: memo.companyId,
      themeId: memo.themeId,
      artifactType: 'investment_memo_pdf',
      title: `${memo.title} (v${latest.versionNumber})`,
      mimeType: 'application/pdf',
      storageUri: exported.absolutePath,
      sourceProvider: 'local',
      sourceExternalId: `${memo.id}:v${latest.versionNumber}:pdf`,
      contentText: latest.contentMarkdown,
      capturedAt: new Date().toISOString()
    })

    memoRepo.recordMemoExport({
      memoVersionId: latest.id,
      artifactId: artifact.id,
      exportFormat: 'pdf',
      storageUri: exported.absolutePath
    })

    return {
      success: true,
      path: exported.absolutePath
    }
  })
}
