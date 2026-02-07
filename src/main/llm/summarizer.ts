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
import type { LlmProvider } from '../../shared/types/settings'

function getProvider(): LLMProvider {
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
  return new ClaudeProvider(apiKey)
}

function sendProgress(text: string): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SUMMARY_PROGRESS, text)
    }
  }
}

export async function generateSummary(
  meetingId: string,
  templateId: string
): Promise<string> {
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

  const { systemPrompt, userPrompt } = buildPrompt(template, {
    transcript,
    meetingTitle: meeting.title,
    date: new Date(meeting.date).toLocaleDateString(),
    duration: durationMin,
    speakers,
    notes: meeting.notes || undefined
  })

  const summary = await provider.generateSummary(systemPrompt, userPrompt, (chunk) => {
    sendProgress(chunk)
  })

  // Save summary
  const summaryPath = writeSummary(meetingId, summary, meeting.title, meeting.date, meeting.attendees)

  // Update meeting record
  meetingRepo.updateMeeting(meetingId, {
    summaryPath,
    templateId,
    status: 'summarized'
  })

  // Update search index
  updateSummaryIndex(meetingId, summary)

  // Upload summary to Drive (fire-and-forget)
  if (hasDriveScope()) {
    const fullPath = join(getSummariesDir(), summaryPath)
    uploadSummaryToDrive(fullPath)
      .then(({ driveId }) => {
        meetingRepo.updateMeeting(meetingId, { summaryDriveId: driveId })
        console.log('[Drive] Summary uploaded:', driveId)
      })
      .catch((err) => {
        console.error('[Drive] Failed to upload summary:', err)
      })
  }

  return summary
}
