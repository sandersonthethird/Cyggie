import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { LLMProvider } from './provider'
import { ClaudeProvider } from './claude-provider'
import { OllamaProvider } from './ollama-provider'
import { buildPrompt } from './templates'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import { getTemplate } from '../database/repositories/template.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { readTranscript, writeSummary } from '../storage/file-manager'
import { updateSummaryIndex } from '../database/repositories/search.repo'
import { hasDriveScope } from '../calendar/google-auth'
import { uploadSummary as uploadSummaryToDrive } from '../drive/google-drive'
import { getSummariesDir } from '../storage/paths'
import { join } from 'path'
import { critiqueText } from './critique'
import type { LlmProvider } from '../../shared/types/settings'
import { getVcSummaryCompanyUpdateProposals } from '../services/company-summary-sync.service'
import { extractTasksFromSummary } from '../services/task-extraction.service'
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

export function getProvider(): LLMProvider {
  const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider

  if (providerType === 'ollama') {
    const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
    const model = getSetting('ollamaModel') || 'llama3.1'
    return new OllamaProvider(model, host)
  }

  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) {
    throw new Error('Claude API key not configured. Go to Settings to add it.')
  }
  const model = getSetting('claudeSummaryModel') || 'claude-sonnet-4-5-20250929'
  return new ClaudeProvider(apiKey, model)
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
    const attendeeEmails = meeting.attendeeEmails || []
    if (attendeeEmails.length > 0) {
      const emailToContactId = resolveContactsByEmails(attendeeEmails)
      const contactIds = [...new Set(Object.values(emailToContactId))]
      for (const contactId of contactIds) {
        createContactNote(
          { contactId, title: noteTitle, content: noteContent, sourceMeetingId: meetingId },
          userId
        )
      }
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

  return { summary, companyUpdateProposals, taskExtractionResult }
}
