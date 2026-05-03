import * as companyRepo from '../database/repositories/org-company.repo'
import { makeEntityNotesRepo } from '../database/repositories/notes-base'

const _companyNotesRepo = makeEntityNotesRepo('company_id')
import { readSummary } from '../storage/file-manager'
import { getProvider } from './provider-factory'

const SYSTEM_PROMPT = `You are a CRM assistant that summarizes key context about a company for a venture capital team.

Given all available information about a company — meeting notes, emails, and manual notes — produce exactly 4 to 6 concise bullet points capturing the most important, actionable context an investment team needs about this company.

Rules:
- Each bullet is a single sentence, starting with a capital letter, no trailing period
- Prioritize specificity: state concrete metrics (ARR, growth rate, customer count) over vague descriptions
- Include key business details: what they build, for whom, core technology or differentiation
- Flag traction signals: customer wins, pilot results, benchmarks, revenue growth
- Include financial context when present: raise size, valuation, burn rate, runway
- Highlight risks or open questions that need resolution
- Note founder/team background if relevant (ex-FAANG, domain expert, repeat founder)
- Include lead investor or notable backers if mentioned
- Do NOT invent facts — only state what is in the provided context
- Do NOT include generic observations (e.g. "An interesting company", "Has had meetings")
- Output ONLY the bullet points, one per line, each starting with "• "
- No preamble, no section headers, no markdown beyond the bullet character`

const MAX_OUTPUT_CHARS = 1500
const MAX_SUMMARY_CHARS = 6000
const MAX_EMAIL_BODY_CHARS = 1500
const MAX_TOTAL_CONTEXT = 30000

let ktAbortController: AbortController | null = null

export function abortCompanyKeyTakeaways(): void {
  ktAbortController?.abort()
  ktAbortController = null
}

export async function generateCompanyKeyTakeaways(
  companyId: string,
  onProgress: (chunk: string) => void
): Promise<string> {
  abortCompanyKeyTakeaways()
  ktAbortController = new AbortController()
  const signal = ktAbortController.signal

  const company = companyRepo.getCompany(companyId)
  if (!company) {
    ktAbortController = null
    throw new Error('Company not found')
  }

  const parts: string[] = []
  let totalChars = 0

  // Company overview
  parts.push(`# Company: ${company.canonicalName}`)
  if (company.description) parts.push(company.description)
  const meta: string[] = []
  if (company.pipelineStage) meta.push(`Stage: ${company.pipelineStage}`)
  if (company.round) meta.push(`Round: ${company.round}`)
  if (company.raiseSize) meta.push(`Raise: $${company.raiseSize}`)
  if (company.arr) meta.push(`ARR: $${company.arr}`)
  if (company.industry) meta.push(`Industry: ${company.industry}`)
  if (meta.length) parts.push(meta.join(' | '))
  parts.push('')

  // Meeting summaries
  const summaryRows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
  const summaryParts: string[] = []
  for (const row of summaryRows) {
    if (totalChars >= MAX_TOTAL_CONTEXT) break
    const content = readSummary(row.summaryPath)
    if (!content) continue
    const excerpt = content.length > MAX_SUMMARY_CHARS ? content.substring(0, MAX_SUMMARY_CHARS) + '...' : content
    summaryParts.push(`### ${row.title} (${new Date(row.date).toLocaleDateString()})\n${excerpt}`)
    totalChars += excerpt.length
  }
  if (summaryParts.length > 0) {
    parts.push('## Meeting Summaries')
    parts.push(summaryParts.join('\n\n'))
    parts.push('')
  }

  // Company notes
  const notes = _companyNotesRepo.list(companyId)
  const noteParts: string[] = []
  for (const note of notes) {
    if (totalChars >= MAX_TOTAL_CONTEXT) break
    if (!note.content) continue
    const excerpt = note.content.length > 2000 ? note.content.substring(0, 2000) + '...' : note.content
    noteParts.push(`### Note: ${note.title ?? 'Untitled'} (${new Date(note.createdAt).toLocaleDateString()})\n${excerpt}`)
    totalChars += excerpt.length
  }
  if (noteParts.length > 0) {
    parts.push('## Notes')
    parts.push(noteParts.join('\n\n'))
    parts.push('')
  }

  // Emails
  const allEmails = companyRepo.listCompanyEmails(companyId)
  const emails = allEmails.slice(0, 20) // limit context size
  const emailParts: string[] = []
  for (const email of emails) {
    if (totalChars >= MAX_TOTAL_CONTEXT) break
    const body = email.bodyText ?? email.snippet ?? ''
    if (!body) continue
    const excerpt = body.length > MAX_EMAIL_BODY_CHARS ? body.substring(0, MAX_EMAIL_BODY_CHARS) + '...' : body
    const date = email.receivedAt ?? email.sentAt ?? ''
    emailParts.push(`### ${email.subject ?? '(no subject)'} (${date ? new Date(date).toLocaleDateString() : 'unknown date'})\nFrom: ${email.fromName ?? email.fromEmail}\n${excerpt}`)
    totalChars += excerpt.length
  }
  if (emailParts.length > 0) {
    parts.push('## Emails')
    parts.push(emailParts.join('\n\n'))
    parts.push('')
  }

  const hasMeetings = summaryParts.length > 0
  const hasNotes = noteParts.length > 0
  const hasEmails = emailParts.length > 0

  if (!hasMeetings && !hasNotes && !hasEmails) {
    ktAbortController = null
    throw new Error('Not enough context — add notes, sync emails, or record meetings first')
  }

  const userPrompt = `Here is the available information about this company:\n\n${parts.join('\n')}`

  const provider = getProvider()
  let result: string
  try {
    result = await provider.generateSummary(SYSTEM_PROMPT, userPrompt, onProgress, signal)
  } finally {
    ktAbortController = null
  }

  if (!result || result.trim() === '') {
    throw new Error('Generation returned empty content — try again')
  }

  if (result.length > MAX_OUTPUT_CHARS) {
    const lastNewline = result.lastIndexOf('\n', MAX_OUTPUT_CHARS)
    result = lastNewline > 0 ? result.substring(0, lastNewline) : result.substring(0, MAX_OUTPUT_CHARS)
  }

  return result
}
