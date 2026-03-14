import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getSetting } from '../database/repositories/settings.repo'
import { getCredential } from '../security/credentials'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { getFlaggedFileIds } from '../database/repositories/company-file-flags.repo'
import { readSummary, readTranscript, readLocalFile } from '../storage/file-manager'
import { basename } from 'path'
import { ClaudeProvider } from './claude-provider'
import { OllamaProvider } from './ollama-provider'
import type { LLMProvider } from './provider'
import type { LlmProvider } from '../../shared/types/settings'

let companyChatAbortController: AbortController | null = null

export function abortCompanyChat(): void {
  companyChatAbortController?.abort()
  companyChatAbortController = null
}

function getProvider(): LLMProvider {
  const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider
  if (providerType === 'ollama') {
    const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
    const model = getSetting('ollamaModel') || 'llama3.1'
    return new OllamaProvider(model, host)
  }
  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) throw new Error('Claude API key not configured. Go to Settings to add it.')
  const model = getSetting('claudeSummaryModel') || 'claude-sonnet-4-5-20250929'
  return new ClaudeProvider(apiKey, model)
}

function sendProgress(text: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, text)
  }
}

const SYSTEM_PROMPT = `You are a helpful research assistant for a venture capital firm.
You answer questions about a specific portfolio company using all available context:
meeting notes and transcripts, email correspondence, and linked documents.
Answer accurately based on the provided context. If information isn't available, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

const MAX_SUMMARY_CHARS = 8000
const MAX_TRANSCRIPT_CHARS = 3000
const MAX_EMAIL_BODY_CHARS = 2000
const MAX_FILE_CHARS = 6000
const MAX_TOTAL_SUMMARIES = 30000
const MAX_TOTAL_EMAILS = 15000
const MAX_TOTAL_FILES = 30000

export async function queryCompany(companyId: string, question: string): Promise<string> {
  const company = companyRepo.getCompany(companyId)
  if (!company) throw new Error('Company not found')

  const parts: string[] = []

  // Company overview
  parts.push(`# Company: ${company.canonicalName}`)
  if (company.description) parts.push(company.description)
  const meta: string[] = []
  if (company.stage) meta.push(`Stage: ${company.stage}`)
  if (company.round) meta.push(`Round: ${company.round}`)
  if (company.industries?.length) meta.push(`Industries: ${company.industries.join(', ')}`)
  if (meta.length) parts.push(meta.join(' | '))
  parts.push('')

  // Meeting summaries
  const summaryRows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
  const meetingsWithSummary = new Set(summaryRows.map((r) => r.meetingId))
  let summaryTotal = 0
  const summaryParts: string[] = []
  for (const row of summaryRows) {
    if (summaryTotal >= MAX_TOTAL_SUMMARIES) break
    const content = readSummary(row.summaryPath)
    if (!content) continue
    const excerpt = content.length > MAX_SUMMARY_CHARS ? content.substring(0, MAX_SUMMARY_CHARS) + '...' : content
    summaryParts.push(`### ${row.title} (${new Date(row.date).toLocaleDateString()})\n${excerpt}`)
    summaryTotal += excerpt.length
  }
  if (summaryParts.length > 0) {
    parts.push('## Meeting Summaries')
    parts.push(summaryParts.join('\n\n'))
    parts.push('')
  }

  // Transcripts for meetings without summaries
  const meetings = companyRepo.listCompanyMeetings(companyId)
  const transcriptParts: string[] = []
  for (const meeting of meetings) {
    if (meetingsWithSummary.has(meeting.id)) continue
    const full = meetingRepo.getMeeting(meeting.id)
    if (!full?.transcriptPath) continue
    const content = readTranscript(full.transcriptPath)
    if (!content) continue
    const excerpt = content.length > MAX_TRANSCRIPT_CHARS ? content.substring(0, MAX_TRANSCRIPT_CHARS) + '...' : content
    transcriptParts.push(`### ${meeting.title} (${new Date(meeting.date).toLocaleDateString()})\n${excerpt}`)
  }
  if (transcriptParts.length > 0) {
    parts.push('## Meeting Transcripts')
    parts.push(transcriptParts.join('\n\n'))
    parts.push('')
  }

  // Emails
  const emailRefs = companyRepo.listCompanyEmails(companyId).slice(0, 20)
  const emailParts: string[] = []
  let emailTotal = 0
  for (const e of emailRefs) {
    if (!e.bodyText || e.bodyText.trim().length < 50) continue
    if (emailTotal >= MAX_TOTAL_EMAILS) break
    const body = e.bodyText.length > MAX_EMAIL_BODY_CHARS ? e.bodyText.substring(0, MAX_EMAIL_BODY_CHARS) + '...' : e.bodyText
    const date = e.receivedAt || e.sentAt || ''
    emailParts.push(`From: ${e.fromEmail}\nSubject: ${e.subject || '(no subject)'}\nDate: ${date}\n\n${body}`)
    emailTotal += body.length
  }
  if (emailParts.length > 0) {
    parts.push('## Email Correspondence')
    parts.push(emailParts.join('\n\n---\n\n'))
    parts.push('')
  }

  // Flagged files
  const flaggedIds = getFlaggedFileIds(companyId)
  const fileParts: string[] = []
  let fileTotal = 0
  for (const fileId of flaggedIds) {
    if (fileTotal >= MAX_TOTAL_FILES) break
    const content = await readLocalFile(fileId)
    if (!content || content.trim().length < 50) continue
    const excerpt = content.length > MAX_FILE_CHARS ? content.substring(0, MAX_FILE_CHARS) + '...' : content
    fileParts.push(`### ${basename(fileId)}\n${excerpt}`)
    fileTotal += excerpt.length
  }
  if (fileParts.length > 0) {
    parts.push('## Linked Documents')
    parts.push(fileParts.join('\n\n'))
    parts.push('')
  }

  const context = parts.join('\n')

  const userPrompt = `Here is the available information about ${company.canonicalName}:

${context}

---

Question: ${question}`

  const provider = getProvider()
  companyChatAbortController = new AbortController()
  const result = await provider.generateSummary(SYSTEM_PROMPT, userPrompt, sendProgress, companyChatAbortController.signal)
  companyChatAbortController = null
  return result
}
