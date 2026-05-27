import { sendClear, sendPhase, sendProgress } from './send-progress'
import { getProvider } from './provider-factory'
import { buildPrompt } from './templates'
import { getTemplate } from '@cyggie/db/sqlite/repositories/template.repo'
// CLAUDE.md: import from the barrel (sync-wrapped) so updateMeeting flows
// through withSync → outbox → Neon. Before 2026-05-22 this was importing
// from meeting.repo directly, which silently bypassed sync — so the
// pre-existing summary_path / summary_drive_id writes never reached Neon.
// Item 2 (mobile summary tab) is the first feature that surfaces this gap.
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import { readTranscript, writeSummary } from '@main/storage/file-manager'
import { updateSummaryIndex } from '@cyggie/db/sqlite/repositories/search.repo'
import { hasDriveScope } from '@main/calendar/google-auth'
import { uploadSummary as uploadSummaryToDrive } from '@main/drive/google-drive'
import { getSummariesDir } from '@main/storage/paths'
import { join } from 'path'
import { critiqueText } from './critique'
import { getVcSummaryCompanyUpdateProposals } from '@cyggie/services/company-summary-sync.service'
import { extractTasksFromSummary } from '@cyggie/services/task-extraction.service'
import { getContactSummaryUpdateProposals } from '@cyggie/services/contact-summary-sync.service'
import { listMeetingCompanies } from '@cyggie/db/sqlite/repositories/org-company.repo'
import { resolveContactsByEmails } from '@cyggie/db/sqlite/repositories/contact.repo'
import { createMeetingCompanionNote } from '@main/services/note-companion-backfill.service'
import { getUser } from '@cyggie/db/sqlite/repositories/user.repo'
import type { SummaryGenerateResult } from '@shared/types/summary'
import type { TaskExtractionResult } from '@shared/types/task'

let summaryAbortController: AbortController | null = null

export function abortSummary(): void {
  summaryAbortController?.abort()
  summaryAbortController = null
}


// Streaming progress now flows through the ALS-injected ProgressSink defined in
// ./send-progress. Desktop's IPC handler wraps with `createIpcProgressSink`
// (BrowserWindow broadcast, channels: SUMMARY_PROGRESS / SUMMARY_PHASE); gateway
// wraps with `createSseProgressSink(reply)`. See [main/lib/ipc-progress-sink.ts]
// and [api-gateway/src/plugins/auth.ts].

export async function generateSummary(
  meetingId: string,
  templateId: string,
  userId: string | null = null
): Promise<SummaryGenerateResult> {
  const meeting = meetingRepo.getMeeting(meetingId)
  if (!meeting) throw new Error('Meeting not found')
  if (!meeting.transcriptPath) throw new Error('No transcript available')

  const transcript = readTranscript(meeting.transcriptPath)
  if (!transcript) throw new Error('Could not read transcript file')

  const template = getTemplate(templateId)
  if (!template) throw new Error('Template not found')

  const provider = getProvider()

  const durationMin = meeting.durationSeconds
    ? `${Math.round(meeting.durationSeconds / 60)} minutes`
    : 'Unknown'

  const speakers = Object.values(meeting.speakerMap)
  if (speakers.length === 0) {
    speakers.push('Unknown participants')
  }

  // Load user profile for task attribution context
  let userIdentity: { displayName: string; email: string | null; title: string | null; jobFunction: string | null } | undefined
  if (userId) {
    const userProfile = getUser(userId)
    if (userProfile) {
      userIdentity = {
        displayName: [userProfile.firstName, userProfile.lastName].filter(Boolean).join(' ') || userProfile.displayName,
        email: userProfile.email,
        title: userProfile.title,
        jobFunction: userProfile.jobFunction
      }
    }
  }

  const { systemPrompt, userPrompt } = buildPrompt(template, {
    transcript,
    meetingTitle: meeting.title,
    date: new Date(meeting.date).toLocaleDateString(),
    duration: durationMin,
    speakers,
    notes: meeting.notes || undefined,
    companies: meeting.companies || undefined,
    // Pass meeting.attendees through directly (null preserved, distinct
    // from undefined) so buildPrompt's null vs [] vs has-items branching
    // can distinguish "no calendar event" from "calendar event with no
    // other attendees".
    attendees: meeting.attendees,
    selfName: meeting.selfName,
    userIdentity
  })

  summaryAbortController = new AbortController()
  sendPhase('generating')
  const draft = await provider.generateSummary(systemPrompt, userPrompt, (chunk) => {
    sendProgress(chunk)
  }, summaryAbortController.signal)
  sendClear()
  sendPhase('refining')
  const summary = await critiqueText(provider, draft, sendProgress, summaryAbortController.signal)
  summaryAbortController = null

  // Save summary
  const summaryPath = writeSummary(meetingId, summary, meeting.title, meeting.date, meeting.attendees)

  // Update meeting record.
  //
  // Dual-write: the summary markdown lives BOTH at `summary_path` (file on
  // disk; legacy desktop UX reads it from there) AND in the `summary`
  // column (Item 2 — propagates to Neon via the outbox so mobile can
  // render it in the Summary tab via GET /meetings/:id). The two paths
  // are intentionally redundant during the cloud-canonical migration —
  // once the column is the source of truth everywhere, the file write
  // can be retired.
  meetingRepo.updateMeeting(meetingId, {
    summaryPath,
    summary,
    templateId,
    status: 'summarized'
  }, userId)

  // Update search index
  updateSummaryIndex(meetingId, summary)

  let companyUpdateProposals: SummaryGenerateResult['companyUpdateProposals'] = []
  if (template.category === 'vc_pitch') {
    try {
      companyUpdateProposals = getVcSummaryCompanyUpdateProposals(meetingId, summary, {
        attendees: meeting.attendees,
        attendeeEmails: meeting.attendeeEmails
      })
    } catch (err) {
      console.error('[Company AutoFill] Failed to parse VC summary fields:', err)
    }
  }

  // Hoist emailToContactId — built once, reused for cross-save notes and contact proposals
  // resolveContactsByEmails returns { id, fullName } objects; extract just ids for downstream use
  const emailToContactId: Record<string, string> = (meeting.attendeeEmails?.length ?? 0) > 0
    ? Object.fromEntries(
        Object.entries(resolveContactsByEmails(meeting.attendeeEmails!)).map(([email, { id }]) => [email, id])
      )
    : {}

  // Cross-save summary as a note for each linked contact and company
  const noteTitle = meeting.title?.trim() || 'Meeting'
  const noteContent = `${noteTitle}\n${summary}`
  try {
    const linkedCompaniesForNotes = listMeetingCompanies(meetingId)
    for (const company of linkedCompaniesForNotes) {
      createMeetingCompanionNote(
        { entityType: 'company', entityId: company.id, title: noteTitle, content: noteContent, sourceMeetingId: meetingId },
        userId
      )
    }
    const contactIds = [...new Set(Object.values(emailToContactId))]
    for (const contactId of contactIds) {
      createMeetingCompanionNote(
        { entityType: 'contact', entityId: contactId, title: noteTitle, content: noteContent, sourceMeetingId: meetingId },
        userId
      )
    }
  } catch (err) {
    console.error('[Notes] Failed to cross-save summary as contact/company notes:', err)
  }

  // Extract tasks from summary
  let taskExtractionResult: TaskExtractionResult | undefined
  try {
    const linkedCompanies = listMeetingCompanies(meetingId)
    const primaryCompanyId = linkedCompanies[0]?.id || null
    taskExtractionResult = extractTasksFromSummary(meetingId, summary, primaryCompanyId, userId)
    if (taskExtractionResult.proposed.length > 0) {
      console.log(`[Tasks] Proposed ${taskExtractionResult.proposed.length} tasks from meeting ${meetingId}`)
    }
  } catch (err) {
    console.error('[Tasks] Failed to extract tasks from summary:', err)
  }

  // Extract contact field proposals from summary (parallel with task extraction, non-blocking)
  let contactUpdateProposals: SummaryGenerateResult['contactUpdateProposals'] = []
  try {
    contactUpdateProposals = await getContactSummaryUpdateProposals(
      summary,
      emailToContactId,
      provider,
      meetingId
    )
    if (contactUpdateProposals.length > 0) {
      console.log(`[Contact AutoFill] ${contactUpdateProposals.length} proposals for meeting ${meetingId}`)
    }
  } catch (err) {
    console.error('[Contact AutoFill] Failed to extract contact fields:', err)
  }

  // Upload summary to Drive (fire-and-forget)
  if (hasDriveScope()) {
    const fullPath = join(getSummariesDir(), summaryPath)
    uploadSummaryToDrive(fullPath)
      .then(({ driveId }) => {
        meetingRepo.updateMeeting(meetingId, { summaryDriveId: driveId }, userId)
        console.log('[Drive] Summary uploaded:', driveId)
      })
      .catch((err) => {
        console.error('[Drive] Failed to upload summary:', err)
      })
  }

  return { summary, companyUpdateProposals, taskExtractionResult, contactUpdateProposals }
}
