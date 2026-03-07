import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as memoRepo from '../database/repositories/investment-memo.repo'
import * as artifactRepo from '../database/repositories/artifact.repo'
import * as notesRepo from '../database/repositories/company-notes.repo'
import { exportMemoMarkdownToPdf } from '../services/memo-export.service'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readSummary, readTranscript } from '../storage/file-manager'
import { generateMemo } from '../llm/memo-generator'

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

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE, async (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const company = companyRepo.getCompany(companyId)
    if (!company) throw new Error('Company not found')

    const userId = getCurrentUserId()
    const memoData = memoRepo.getOrCreateMemoForCompany(companyId, company.canonicalName, userId)

    const sendProgress = (text: string | null): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE_PROGRESS, text)
        }
      }
    }

    // Gather meeting summaries
    const summaryRows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
    const summaries: Array<{ title: string; date: string; content: string }> = []
    for (const row of summaryRows) {
      const content = readSummary(row.summaryPath)
      if (content) summaries.push({ title: row.title, date: row.date, content })
    }

    // Gather meeting transcripts for meetings without summaries
    const meetings = companyRepo.listCompanyMeetings(companyId)
    const meetingsWithSummary = new Set(summaryRows.map((r) => r.meetingId))
    const transcripts: Array<{ title: string; date: string; content: string }> = []
    for (const meeting of meetings) {
      if (meetingsWithSummary.has(meeting.id)) continue
      const full = meetingRepo.getMeeting(meeting.id)
      if (!full?.transcriptPath) continue
      const content = readTranscript(full.transcriptPath)
      if (content) transcripts.push({ title: meeting.title, date: meeting.date, content })
    }

    // Gather company notes
    const notes = notesRepo.listCompanyNotes(companyId)
    const noteTexts = notes
      .filter((n) => n.content?.trim())
      .map((n) => (n.title ? `**${n.title}**\n${n.content}` : n.content))

    // Get existing memo content for context
    const existingContent = memoData.latestVersion?.contentMarkdown || ''

    const generated = await generateMemo({
      companyName: company.canonicalName,
      companyDescription: company.description || '',
      summaries,
      transcripts,
      notes: noteTexts,
      existingMemo: existingContent,
      companyDetails: {
        stage: company.stage,
        round: company.round,
        raiseSize: company.raiseSize,
        postMoneyValuation: company.postMoneyValuation,
        city: company.city,
        state: company.state,
        industries: company.industries,
        themes: company.themes
      }
    }, (chunk) => {
      sendProgress(chunk)
    })

    sendProgress(null)

    // Save as new version
    const version = memoRepo.saveMemoVersion(memoData.id, {
      contentMarkdown: generated,
      changeNote: 'Generated from meeting data'
    }, userId)

    logAudit(userId, 'investment_memo_version', version.id, 'create', {
      memoId: memoData.id,
      versionNumber: version.versionNumber,
      changeNote: 'Generated from meeting data',
      source: 'llm_generate'
    })

    return { success: true, content: generated }
  })
}
