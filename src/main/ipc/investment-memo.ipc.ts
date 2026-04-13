import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as memoRepo from '../database/repositories/investment-memo.repo'
import * as artifactRepo from '../database/repositories/artifact.repo'
import * as notesRepo from '../database/repositories/company-notes.repo'
import { exportMemoMarkdownToPdf } from '../services/memo-export.service'
import { exportMemoToGoogleDoc } from '../drive/google-drive'
import { getSetting } from '../database/repositories/settings.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readSummary, readTranscript, readLocalFile } from '../storage/file-manager'
import { generateMemo } from '../llm/memo-generator'
import { basename } from 'path'
import { getCredential } from '../security/credentials'
import { WEB_SHARE_API_URL, WEB_SHARE_API_SECRET } from '../config/web-share.config'
import type { MemoShareResponse, MemoRevokeResponse } from '../../shared/types/web-share'

/**
 * Fetches a company favicon and returns it as a base64 data URL.
 * Used for PDF/GDoc exports where HTML is loaded as a data: URL and
 * cannot reference external resources directly.
 * Returns null on timeout (3s), non-OK response, or any network error.
 */
async function fetchLogoAsDataUrl(domain: string): Promise<string | null> {
  try {
    const url = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') ?? 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

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

    const logoDataUrl = getSetting('brandingLogoDataUrl') || null
    const companyLogoDataUrl = company.primaryDomain
      ? await fetchLogoAsDataUrl(company.primaryDomain)
      : null
    const exported = await exportMemoMarkdownToPdf({
      companyName: company.canonicalName,
      memoTitle: memo.title,
      versionNumber: latest.versionNumber,
      contentMarkdown: latest.contentMarkdown,
      logoDataUrl,
      companyLogoDataUrl,
      companyDetails: {
        round: company.round,
        postMoneyValuation: company.postMoneyValuation
      }
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

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_GOOGLE_DOC, async (_event, memoId: string) => {
    if (!memoId) throw new Error('memoId is required')
    const memo = memoRepo.getMemo(memoId)
    if (!memo) throw new Error('Memo not found')
    const latest = memoRepo.getMemoLatestVersion(memo.id)
    if (!latest) throw new Error('Memo has no versions to export')
    const company = companyRepo.getCompany(memo.companyId)
    if (!company) throw new Error('Company not found')

    const logoDataUrl = getSetting('brandingLogoDataUrl') || null
    const companyLogoDataUrl = company.primaryDomain
      ? await fetchLogoAsDataUrl(company.primaryDomain)
      : null
    const result = await exportMemoToGoogleDoc({
      companyName: company.canonicalName,
      memoTitle: memo.title,
      versionNumber: latest.versionNumber,
      contentMarkdown: latest.contentMarkdown,
      logoDataUrl,
      companyLogoDataUrl,
      companyDetails: {
        round: company.round,
        postMoneyValuation: company.postMoneyValuation
      }
    })

    const userId = getCurrentUserId()
    const artifact = artifactRepo.createArtifact({
      companyId: memo.companyId,
      themeId: memo.themeId,
      artifactType: 'investment_memo_gdoc',
      title: `${memo.title} (v${latest.versionNumber})`,
      mimeType: 'application/vnd.google-apps.document',
      storageUri: result.webViewLink,
      sourceProvider: 'google_drive',
      sourceExternalId: result.docId,
      contentText: latest.contentMarkdown,
      capturedAt: new Date().toISOString()
    })

    memoRepo.recordMemoExport({
      memoVersionId: latest.id,
      artifactId: artifact.id,
      exportFormat: 'google_doc',
      storageUri: result.webViewLink
    })

    logAudit(userId, 'investment_memo', memo.id, 'export', {
      format: 'google_doc',
      docId: result.docId
    })

    return { success: true, url: result.webViewLink }
  })

  ipcMain.handle(
    IPC_CHANNELS.INVESTMENT_MEMO_GENERATE,
    async (
      _event,
      payload: string | { companyId: string; selectedFileIds?: string[]; includeEmails?: boolean }
    ) => {
    const companyId = typeof payload === 'string' ? payload : payload.companyId
    const selectedFileIds = typeof payload === 'string' ? [] : (payload.selectedFileIds ?? [])
    const includeEmails = typeof payload === 'string' ? true : (payload.includeEmails ?? true)
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

    // Gather emails linked to the company
    const emails: Array<{ subject: string | null; from: string; date: string | null; body: string }> = []
    if (includeEmails) {
      const emailRefs = companyRepo.listCompanyEmails(companyId).slice(0, 30)
      for (const e of emailRefs) {
        if (e.bodyText && e.bodyText.trim().length > 50) {
          emails.push({
            subject: e.subject,
            from: e.fromEmail,
            date: e.receivedAt || e.sentAt,
            body: e.bodyText
          })
        }
      }
    }

    // Read selected local files
    const files: Array<{ name: string; content: string }> = []
    for (const fileId of selectedFileIds) {
      const content = await readLocalFile(fileId)
      if (content && content.trim().length > 100) {
        files.push({ name: basename(fileId), content })
      }
    }

    const generated = await generateMemo({
      companyName: company.canonicalName,
      companyDescription: company.description || '',
      summaries,
      transcripts,
      notes: noteTexts,
      existingMemo: existingContent,
      emails,
      files,
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

    return { success: true, contentMarkdown: generated, version }
  })

  ipcMain.handle(
    IPC_CHANNELS.INVESTMENT_MEMO_SHARE_LINK,
    async (_event, memoId: string): Promise<MemoShareResponse> => {
      if (!memoId) return { success: false, error: 'no_content', message: 'memoId is required.' }

      const memo = memoRepo.getMemo(memoId)
      if (!memo) return { success: false, error: 'upload_failed', message: 'Memo not found.' }

      const latest = memoRepo.getMemoLatestVersion(memo.id)
      if (!latest?.contentMarkdown?.trim()) {
        return { success: false, error: 'no_content', message: 'Memo has no content to share.' }
      }

      const claudeApiKey = getCredential('claudeApiKey')
      if (!claudeApiKey) {
        return {
          success: false,
          error: 'no_api_key',
          message: 'Claude API key not configured. Set it in Settings.',
        }
      }

      const company = companyRepo.getCompany(memo.companyId)
      const companyName = company?.canonicalName ?? 'Unknown Company'
      const logoUrl = getSetting('brandingLogoDataUrl') || null
      const firmName = getSetting('brandingFirmName') || null
      const brandColor = getSetting('brandingPrimaryColor') || null
      // Web share uses plain favicon URL (not base64) — the browser loads it directly
      const companyLogoUrl = company?.primaryDomain
        ? `https://www.google.com/s2/favicons?sz=128&domain=${company.primaryDomain}`
        : null

      try {
        const response = await fetch(`${WEB_SHARE_API_URL}/api/memo-share`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${WEB_SHARE_API_SECRET}`,
          },
          body: JSON.stringify({
            title: memo.title,
            companyName,
            contentMarkdown: latest.contentMarkdown,
            claudeApiKey,
            logoUrl,
            firmName,
            brandColor,
            companyLogoUrl,
          }),
          signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
          const errText = await response.text()
          return { success: false, error: 'upload_failed', message: `Server error: ${errText}` }
        }

        const result = await response.json()
        return { success: true, url: result.url, token: result.token }
      } catch (err) {
        return {
          success: false,
          error: 'network_error',
          message: `Failed to create share: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.INVESTMENT_MEMO_REVOKE_SHARE,
    async (_event, token: string): Promise<MemoRevokeResponse> => {
      if (!token) return { success: false, error: 'revoke_failed', message: 'token is required.' }

      try {
        const response = await fetch(`${WEB_SHARE_API_URL}/api/memo-share`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${WEB_SHARE_API_SECRET}`,
          },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          const errText = await response.text()
          return { success: false, error: 'revoke_failed', message: `Server error: ${errText}` }
        }

        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: 'network_error',
          message: `Failed to revoke share: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  )
}
