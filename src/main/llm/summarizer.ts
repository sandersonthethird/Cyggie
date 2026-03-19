import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getProvider } from './provider-factory'
import { buildPrompt } from './templates'
import { getTemplate } from '../database/repositories/template.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readTranscript, writeSummary } from '../storage/file-manager'
import { updateSummaryIndex } from '../database/repositories/search.repo'
import { hasDriveScope } from '../calendar/google-auth'
import { uploadSummary as uploadSummaryToDrive } from '../drive/google-drive'
import { getSummariesDir } from '../storage/paths'
import { join } from 'path'
import { critiqueText } from './critique'
import { getVcSummaryCompanyUpdateProposals } from '../services/company-summary-sync.service'
import { extractTasksFromSummary } from '../services/task-extraction.service'
import { getContactSummaryUpdateProposals } from '../services/contact-summary-sync.service'
import { listMeetingCompanies } from '../database/repositories/org-company.repo'
import { resolveContactsByEmails } from '../database/repositories/contact.repo'
import { createContactNote } from '../database/repositories/contact-notes.repo'
import { createCompanyNote } from '../database/repositories/company-notes.repo'
import { getUser } from '../database/repositories/user.repo'
import type { SummaryGenerateResult } from '../../shared/types/summary'
import type { TaskExtractionResult } from '../../shared/types/task'

let summaryAbortController: AbortController | null = null

export function abortSummary(): void {
  summaryAbortController?.abort()
  summaryAbortController = null
}


function sendProgress(text: string): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SUMMARY_PROGRESS, text)
    }
  }
}

function sendClear(): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SUMMARY_PROGRESS, null)
    }
  }
}

function sendPhase(phase: string): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SUMMARY_PHASE, phase)
    }
  }
}

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
    attendees: meeting.attendees || undefined,
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

  // Update meeting record
  meetingRepo.updateMeeting(meetingId, {
    summaryPath,
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
  const emailToContactId = (meeting.attendeeEmails?.length ?? 0) > 0
    ? resolveContactsByEmails(meeting.attendeeEmails!)
    : {}

  // Cross-save summary as a note for each linked contact and company
  const noteTitle = meeting.title?.trim() || 'Meeting'
  const noteContent = `${noteTitle}\n${summary}`
  try {
    const linkedCompaniesForNotes = listMeetingCompanies(meetingId)
    for (const company of linkedCompaniesForNotes) {
      createCompanyNote(
        { companyId: company.id, title: noteTitle, content: noteContent, sourceMeetingId: meetingId },
        userId
      )
    }
    const contactIds = [...new Set(Object.values(emailToContactId))]
    for (const contactId of contactIds) {
      createContactNote(
        { contactId, title: noteTitle, content: noteContent, sourceMeetingId: meetingId },
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
