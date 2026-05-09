import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as memoRepo from '../database/repositories/investment-memo.repo'
import * as artifactRepo from '../database/repositories/artifact.repo'
import { makeEntityNotesRepo } from '../database/repositories/notes-base'

const _companyNotesRepo = makeEntityNotesRepo('company_id')
const _contactNotesRepo = makeEntityNotesRepo('contact_id')
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
import { searchCompanyContext } from '../services/exa-research'
import { getFlaggedFiles } from '../database/repositories/company-file-flags.repo'
import type { MemoGenerateMeta } from '../../shared/types/company'
import { runStressTestAgent } from '../llm/agents/thesis-stress-test-agent'
import { startRun, completeRun, makeEventWriter, getRun, listRuns, listRunEvents, averageCostForKind } from '../llm/agents/run-store'
import { bulkInsert as bulkInsertEvidence, listByVersion as listEvidenceByVersion } from '../database/repositories/memo-evidence.repo'
import { getDatabase } from '../database/connection'
import type { AgentEvent } from '../../shared/types/agent-events'

// Module-scope per-runId AbortController map for stress-test concurrency.
// Each kicked-off run lives in this map until it completes or is aborted.
// Allowing concurrent runs across windows/companies is intentional (review
// decision #2). The map gets cleaned up by the run handler itself on
// completion / failure / abort.
const _stressTestAbortControllers = new Map<string, AbortController>()

function broadcastAgentEvent(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.THESIS_STRESS_TEST_PROGRESS, event)
    }
  }
}

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

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS, (_event, memoId: string, summary?: boolean) => {
    if (!memoId) throw new Error('memoId is required')
    return summary ? memoRepo.listMemoVersionsSummary(memoId) : memoRepo.listMemoVersions(memoId)
  })

  ipcMain.handle(IPC_CHANNELS.INVESTMENT_MEMO_GET_VERSION, (_event, versionId: string) => {
    if (!versionId) throw new Error('versionId is required')
    return memoRepo.getMemoVersion(versionId)
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
    const notes = _companyNotesRepo.list(companyId)
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

    // Linked contacts (sorted most-engaged first via meetingCount DESC) drive
    // three downstream things: contact-notes, contact-key-takeaways, and
    // founder identification for Exa LinkedIn queries.
    const linkedContacts = companyRepo
      .listCompanyContacts(companyId)
      .slice()
      .sort((a, b) => (b.meetingCount ?? 0) - (a.meetingCount ?? 0))

    // Contact-tagged notes (single batched query — no N+1).
    // Dedup against company-tagged notes by note id (a note tagged to BOTH a
    // contact and a company would otherwise appear twice in the prompt).
    const contactIds = linkedContacts.map(c => c.id)
    const allContactNotes = contactIds.length > 0
      ? _contactNotesRepo.listForEntities(contactIds)
      : []
    const seenNoteIds = new Set(notes.map(n => n.id))
    const contactNoteTexts: string[] = []
    // Group notes by their contact_id so we can iterate in the linkedContacts
    // (sorted) order — most-engaged contacts' notes hit the 20k cap first.
    const notesByContact = new Map<string, typeof allContactNotes>()
    for (const n of allContactNotes) {
      if (!n.contactId) continue
      const list = notesByContact.get(n.contactId) ?? []
      list.push(n)
      notesByContact.set(n.contactId, list)
    }
    for (const contact of linkedContacts) {
      const cnotes = notesByContact.get(contact.id) ?? []
      for (const n of cnotes) {
        if (seenNoteIds.has(n.id)) continue
        seenNoteIds.add(n.id)
        if (!n.content?.trim()) continue
        const prefix = `**Contact: ${contact.fullName}${n.title ? ` — ${n.title}` : ''}**`
        contactNoteTexts.push(`${prefix}\n${n.content}`)
      }
    }

    // Contact key takeaways (already on listCompanyContacts via key_takeaways
    // SELECT — no per-contact getContact() round-trip).
    const contactKeyTakeaways: Array<{ name: string; takeaways: string }> = []
    for (const contact of linkedContacts.slice(0, 8)) {
      if (contact.keyTakeaways?.trim()) {
        contactKeyTakeaways.push({ name: contact.fullName, takeaways: contact.keyTakeaways })
      }
    }

    // Drive files: caller-supplied selectedFileIds wins (e.g., a future
    // pick-files UI); otherwise auto-include all flagged files.
    // selectedFileIds was always [] in practice — files were never read until now.
    const flaggedFiles = getFlaggedFiles(companyId)
    const fileIds = selectedFileIds.length > 0
      ? selectedFileIds
      : flaggedFiles.map(f => f.fileId)

    const files: Array<{ name: string; content: string }> = []
    for (const fileId of fileIds) {
      const flagged = flaggedFiles.find(f => f.fileId === fileId)
      const content = await readLocalFile(fileId, flagged?.mimeType ?? undefined)
      if (content && content.trim().length > 100) {
        files.push({ name: flagged?.fileName ?? basename(fileId), content })
      }
    }

    // Niche signal for Exa pre-research: most recent meeting summary's
    // first 500 chars (richest, founder's own words). summaryRows is sorted
    // by datetime(m.date) DESC so summaries[0] is the most recent.
    const nicheSignal = summaries[0]?.content?.trim()
      ? summaries[0].content.slice(0, 500)
      : null

    // Founder identification: title regex; fall back to isPrimary contacts.
    const FOUNDER_TITLE_RE = /founder|ceo|cto|coo|chief/i
    const titledFounders = linkedContacts.filter(c => FOUNDER_TITLE_RE.test(c.title ?? ''))
    const founderNames =
      titledFounders.length > 0
        ? titledFounders.slice(0, 2).map(c => c.fullName)
        : linkedContacts.filter(c => c.isPrimary).slice(0, 2).map(c => c.fullName)

    // Status update with actual counts so the user sees what's being gathered.
    sendProgress(`Gathering ${meetings.length} meetings, ${notes.length + contactNoteTexts.length} notes, ${fileIds.length} files, ${emails.length} emails...`)

    // Structured log for post-hoc debuggability ("why was this memo thin?").
    console.info('[memo-gen] context gathered', {
      companyId,
      meetings: meetings.length,
      summaries: summaries.length,
      transcripts: transcripts.length,
      companyNotes: notes.length,
      contactNotes: contactNoteTexts.length,
      contactKeyTakeaways: contactKeyTakeaways.length,
      emails: emails.length,
      flaggedFiles: fileIds.length,
      hasNicheSignal: !!nicheSignal,
      founderCount: founderNames.length,
    })

    sendProgress('Researching external sources...')
    const externalResearch = await searchCompanyContext({
      companyName: company.canonicalName,
      companyDescription: company.description,
      primaryDomain: company.primaryDomain,
      industry: company.industry,
      themes: company.themes,
      nicheSignal,
      founderNames,
    })
    sendProgress(null)

    const generated = await generateMemo({
      companyName: company.canonicalName,
      companyDescription: company.description || '',
      summaries,
      transcripts,
      notes: noteTexts,
      contactNotes: contactNoteTexts,
      contactKeyTakeaways,
      existingMemo: existingContent,
      emails,
      files,
      externalResearch,
      companyDetails: {
        stage: company.stage,
        round: company.round,
        raiseSize: company.raiseSize,
        postMoneyValuation: company.postMoneyValuation,
        city: company.city,
        state: company.state,
        industry: company.industry,
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

    // Source counts for the renderer's empty-research toast + sources-used footer.
    const meta: MemoGenerateMeta = {
      meetingCount: meetings.length,
      summaryCount: summaries.length,
      transcriptCount: transcripts.length,
      companyNoteCount: notes.length,
      contactNoteCount: contactNoteTexts.length,
      contactKeyTakeawayCount: contactKeyTakeaways.length,
      fileCount: files.length,
      emailCount: emails.length,
      externalResearchQueryCount: externalResearch.queries.length,
      externalResearchResultCount: externalResearch.results.length,
    }

    return { success: true, contentMarkdown: generated, version, meta }
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

      const claudeApiKey = getCredential('webShareApiKey') || getCredential('claudeApiKey')
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
            claudeModel: getSetting('webShareModel') || 'claude-sonnet-4-5-20250929',
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

  // ───── Thesis Stress-Test Agent ──────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.THESIS_STRESS_TEST_START,
    async (
      _event,
      payload: { companyId: string }
    ): Promise<{ runId: string }> => {
      const companyId = payload?.companyId
      if (!companyId) throw new Error('companyId is required')
      const company = companyRepo.getCompany(companyId)
      if (!company) throw new Error('Company not found')

      const memo = memoRepo.getOrCreateMemoForCompany(companyId, company.canonicalName, getCurrentUserId())
      const existingMarkdown = memo.latestVersion?.contentMarkdown ?? ''
      if (existingMarkdown.trim().length < 200) {
        throw new Error('Memo is too short to stress-test (need at least 200 chars). Generate a memo first.')
      }

      const userId = getCurrentUserId()
      const runId = startRun({
        kind: 'thesis_stress_test',
        companyId,
        userId,
        mode: 'stress_test',
      })

      const controller = new AbortController()
      _stressTestAbortControllers.set(runId, controller)

      const eventWriter = makeEventWriter(runId)
      const emit = (event: AgentEvent): void => {
        eventWriter.appendEvent(event)
        broadcastAgentEvent(event)
        // Flush per turn boundary AND per terminal event so the dev dashboard
        // sees up-to-date traces even on a still-running run.
        if (event.type === 'iteration_start' || event.type === 'done' || event.type === 'error' || event.type === 'aborted' || event.type === 'cap_exceeded') {
          eventWriter.flush()
        }
      }

      // Kick off async; return runId immediately so the renderer can subscribe.
      void (async () => {
        try {
          const result = await runStressTestAgent({
            runId,
            companyId,
            companyName: company.canonicalName,
            userId,
            existingMemoMarkdown: existingMarkdown,
            signal: controller.signal,
            emit,
          })

          if (result.scopeLockWarnings.length > 0) {
            console.warn('[thesis-stress-test]', runId, 'scope-lock warnings:', result.scopeLockWarnings)
          }

          if (result.status !== 'success' || !result.submitInput) {
            completeRun(runId, {
              status: result.status,
              iterations: result.iterations,
              inputTokensTotal: result.inputTokensTotal,
              outputTokensTotal: result.outputTokensTotal,
              costEstimateUsd: result.costEstimateUsd,
              toolCallCount: result.toolCallCount,
              webSearchCount: result.webSearchCount,
              errorClass: result.errorClass,
              errorMessage: result.errorMessage,
            })
            return
          }

          // Persist memo version + evidence rows in a single transaction.
          const db = getDatabase()
          let savedVersionId = ''
          const persist = db.transaction(() => {
            const version = memoRepo.saveMemoVersion(memo.id, {
              contentMarkdown: result.submitInput!.markdown,
              changeNote: 'Stress-tested by research agent',
            }, userId)
            savedVersionId = version.id
            const inserted = bulkInsertEvidence(version.id, result.submitInput!.evidence)
            console.log(`[thesis-stress-test] ${runId} saved version ${version.id} + ${inserted} evidence rows`)
          })
          try {
            persist()
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error('[thesis-stress-test]', runId, 'persist failed:', errMsg)
            completeRun(runId, {
              status: 'failed',
              iterations: result.iterations,
              inputTokensTotal: result.inputTokensTotal,
              outputTokensTotal: result.outputTokensTotal,
              costEstimateUsd: result.costEstimateUsd,
              toolCallCount: result.toolCallCount,
              webSearchCount: result.webSearchCount,
              errorClass: 'PersistError',
              errorMessage: errMsg,
            })
            broadcastAgentEvent({ type: 'error', runId, errorClass: 'PersistError', message: errMsg })
            return
          }

          // Re-emit a 'done' event with the persisted versionId so the renderer
          // knows where to navigate. (The agent loop's emit fired with empty
          // versionId since persistence happens here.)
          broadcastAgentEvent({
            type: 'done',
            runId,
            versionId: savedVersionId,
            durationMs: result.durationMs,
            inputTokens: result.inputTokensTotal,
            outputTokens: result.outputTokensTotal,
            costEstimateUsd: result.costEstimateUsd,
            toolCallCount: result.toolCallCount,
          })

          completeRun(runId, {
            status: 'success',
            iterations: result.iterations,
            inputTokensTotal: result.inputTokensTotal,
            outputTokensTotal: result.outputTokensTotal,
            costEstimateUsd: result.costEstimateUsd,
            toolCallCount: result.toolCallCount,
            webSearchCount: result.webSearchCount,
            resultVersionId: savedVersionId,
          })
          logAudit(userId, 'investment_memo_version', savedVersionId, 'create', {
            memoId: memo.id,
            source: 'thesis_stress_test_agent',
            runId,
            costEstimateUsd: result.costEstimateUsd,
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error('[thesis-stress-test]', runId, 'unhandled error:', errMsg)
          completeRun(runId, {
            status: 'failed',
            iterations: 0,
            inputTokensTotal: 0,
            outputTokensTotal: 0,
            costEstimateUsd: 0,
            toolCallCount: 0,
            webSearchCount: 0,
            errorClass: 'UnhandledError',
            errorMessage: errMsg,
          })
          broadcastAgentEvent({ type: 'error', runId, errorClass: 'UnhandledError', message: errMsg })
        } finally {
          eventWriter.flush()
          _stressTestAbortControllers.delete(runId)
        }
      })()

      return { runId }
    }
  )

  ipcMain.handle(IPC_CHANNELS.THESIS_STRESS_TEST_ABORT, (_event, runId: string) => {
    const controller = _stressTestAbortControllers.get(runId)
    if (!controller) return { success: false, error: 'no_such_run' }
    controller.abort()
    return { success: true }
  })

  // ───── Memo evidence (read) ──────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MEMO_EVIDENCE_LIST_BY_VERSION, (_event, versionId: string) => {
    if (!versionId) throw new Error('versionId is required')
    return listEvidenceByVersion(versionId)
  })

  // ───── Agent runs (observability + cost badge) ───────────────────────────

  ipcMain.handle(IPC_CHANNELS.AGENT_RUNS_LIST, (_event, filter?: { companyId?: string; kind?: string; limit?: number }) => {
    return listRuns(filter)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_RUN_GET, (_event, runId: string) => {
    if (!runId) throw new Error('runId is required')
    return getRun(runId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_RUN_LIST_EVENTS, (_event, runId: string) => {
    if (!runId) throw new Error('runId is required')
    return listRunEvents(runId)
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_RUNS_AVERAGE_COST, (_event, payload: { kind: string; companyId?: string; lastN?: number }) => {
    if (!payload?.kind) throw new Error('kind is required')
    return averageCostForKind(payload.kind, payload.companyId, payload.lastN)
  })
}
