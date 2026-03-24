/**
 * Partner meeting reconciliation service.
 *
 * Generates per-company proposals (note + field updates + tasks) by combining:
 *   - Digest item content (meetingNotes, brief, statusUpdate)
 *   - Recent company notes (last 5, to avoid duplication)
 *   - Transcript excerpts filtered to this company (±500 chars around mentions)
 *
 * Pipeline:
 *
 *  digest.items (isDiscussed=true + has content)
 *       │
 *       ├─ [concurrency 3, cursor/worker pattern, checks signal.aborted]
 *       │   ├─ getCompany() + listCompanyNotes().slice(0,5)
 *       │   ├─ extractCompanyExcerpts(transcript, companyName)
 *       │   ├─ LLM single-shot JSON → safeParseJson
 *       │   │    { noteTitle, noteContent, fieldUpdates[], tasks[] }
 *       │   └─ onProposal(proposal) ← streamed to IPC caller
 *       │
 *       └─ return ReconcileProposal[]
 *
 *  applyReconciliationProposals:
 *       ├─ per accepted proposal:
 *       │   ├─ idempotency check: notes WHERE company_id=? AND source_digest_id=?
 *       │   ├─ INSERT note (if applyNote + not exists)
 *       │   ├─ validate + updateCompany (if applyFieldUpdates)
 *       │   └─ taskRepo.bulkCreate (if applyTasks + tasks.length > 0)
 *       └─ return { applied, failed[] }
 */

import { randomUUID } from 'crypto'
import { getDatabase } from '../database/connection'
import { getCompany, updateCompany } from '../database/repositories/org-company.repo'
import { listCompanyNotes } from '../database/repositories/company-notes.repo'
import { getMeeting } from '../database/repositories/meeting.repo'
import { bulkCreate as bulkCreateTasks } from '../database/repositories/task.repo'
import { readTranscript } from '../storage/file-manager'
import { safeParseJson } from '../utils/json-utils'
import type { LLMProvider } from '../llm/provider'
import type {
  PartnerMeetingDigest,
  ReconcileProposal,
  ReconcileProposalTask,
  ApplyReconciliationInput,
  ApplyReconciliationResult,
} from '../../shared/types/partner-meeting'

const VALID_PIPELINE_STAGES = new Set(['screening', 'diligence', 'decision', 'documentation', 'pass'])
const VALID_TASK_CATEGORIES = new Set(['action_item', 'decision', 'follow_up'])

// ─── Transcript excerpt extraction ───────────────────────────────────────────

/**
 * Extracts windows of text around mentions of `companyName` in a transcript.
 *
 * - Case-insensitive search
 * - ±500 chars around each mention
 * - Overlapping windows are merged
 * - Concatenated with '\n---\n'
 * - Total output capped at 3000 chars
 * - Returns '' if company name not found
 */
export function extractCompanyExcerpts(transcript: string, companyName: string): string {
  if (!transcript || !companyName) return ''

  const WINDOW = 500
  const CAP = 3000
  const lower = transcript.toLowerCase()
  const name = companyName.toLowerCase()

  // Find all mention positions
  const positions: number[] = []
  let idx = 0
  while (true) {
    const found = lower.indexOf(name, idx)
    if (found === -1) break
    positions.push(found)
    idx = found + 1
  }
  if (positions.length === 0) return ''

  // Build non-overlapping windows
  const windows: Array<{ start: number; end: number }> = []
  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW)
    const end = Math.min(transcript.length, pos + name.length + WINDOW)
    const last = windows[windows.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)  // merge overlapping
    } else {
      windows.push({ start, end })
    }
  }

  // Concatenate and cap
  const parts = windows.map(w => transcript.slice(w.start, w.end).trim())
  let result = parts.join('\n---\n')
  if (result.length > CAP) result = result.slice(0, CAP)
  return result
}

// ─── LLM prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a CRM note writer for a venture capital firm.',
  'Given partner meeting notes and optional transcript excerpts,',
  'produce a structured note, identify CRM field updates, and extract action items.',
  'Return ONLY valid JSON — no prose, no markdown fences.',
].join(' ')

function buildUserPrompt(params: {
  companyName: string
  description: string | null
  pipelineStage: string | null
  entityType: string | null
  existingNotes: Array<{ title: string | null; content: string }>
  weekOf: string
  statusUpdate: string | null
  brief: string | null
  meetingNotes: string | null
  transcriptExcerpts: string
}): string {
  const lines: string[] = []

  lines.push(`Company: ${params.companyName}`)
  lines.push(`Current CRM: description="${params.description ?? ''}", pipelineStage="${params.pipelineStage ?? ''}", entityType="${params.entityType ?? ''}"`)

  if (params.existingNotes.length > 0) {
    lines.push('\nExisting notes (do not duplicate):')
    for (const note of params.existingNotes) {
      const preview = note.content.slice(0, 200).replace(/\n/g, ' ')
      lines.push(`- ${note.title ?? '(untitled)'}: ${preview}`)
    }
  }

  lines.push(`\nPartner meeting content (week of ${params.weekOf}):`)
  if (params.statusUpdate) lines.push(`statusUpdate: ${params.statusUpdate}`)
  if (params.brief) lines.push(`brief: ${params.brief.slice(0, 500)}`)
  if (params.meetingNotes) lines.push(`meetingNotes: ${params.meetingNotes.slice(0, 1000)}`)

  lines.push('\nTranscript excerpts mentioning this company:')
  lines.push(params.transcriptExcerpts || 'No transcript linked')

  // Format the target week for the note title
  const weekDate = new Date(params.weekOf)
  const noteTitle = `Partner Meeting — ${weekDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  lines.push(`\nReturn JSON:`)
  lines.push(`{`)
  lines.push(`  "noteTitle": "${noteTitle}",`)
  lines.push(`  "noteContent": "## Discussion\\n...",`)
  lines.push(`  "fieldUpdates": [{ "field": "description", "value": "..." }],`)
  lines.push(`  "tasks": [`)
  lines.push(`    { "title": "...", "category": "action_item", "assignee": null, "dueDate": null }`)
  lines.push(`  ]`)
  lines.push(`}`)

  lines.push('\nRules:')
  lines.push('- noteContent is concise markdown (not a transcript dump)')
  lines.push('- fieldUpdates.field: "description" or "pipelineStage" only')
  lines.push('- pipelineStage valid values: screening, diligence, decision, documentation, pass')
  lines.push('- fieldUpdates: [] if no meaningful CRM changes warranted')
  lines.push('- tasks: action items, decisions, and follow-ups for this company specifically; [] if none')
  lines.push('- tasks[].category: "action_item", "decision", or "follow_up" only')
  lines.push('- tasks[].assignee: name of person responsible, or null if not mentioned')
  lines.push('- tasks[].dueDate: ISO date string only if explicitly mentioned, otherwise null')

  return lines.join('\n')
}

// ─── Generation ───────────────────────────────────────────────────────────────

export async function generateReconciliationProposals(
  digest: PartnerMeetingDigest,
  userId: string,
  provider: LLMProvider,
  onProposal: (proposal: ReconcileProposal) => void,
  signal: AbortSignal,
): Promise<ReconcileProposal[]> {
  // Filter to items with content that were discussed
  const items = (digest.items ?? []).filter(
    item =>
      item.isDiscussed &&
      item.companyId &&
      (item.meetingNotes || item.brief || item.statusUpdate),
  )

  console.log(
    `[ReconcileService] start digest=${digest.id} companies=${items.length} hasTranscript=${!!digest.meetingId}`,
  )

  // Optionally load transcript
  let transcript = ''
  if (digest.meetingId) {
    const meeting = getMeeting(digest.meetingId)
    if (!meeting) {
      console.warn(`[ReconcileService] meetingId=${digest.meetingId} not found — proceeding without transcript`)
    } else if (meeting.transcriptPath) {
      transcript = readTranscript(meeting.transcriptPath) ?? ''
    }
  }

  const proposals: ReconcileProposal[] = []

  async function processItem(item: typeof items[number]): Promise<ReconcileProposal> {
    const companyId = item.companyId!
    const companyName = item.companyName ?? 'Unknown Company'

    // Load company context
    const company = getCompany(companyId)
    if (!company) {
      return {
        companyId,
        companyName,
        noteTitle: '',
        noteContent: '',
        fieldUpdates: [],
        tasks: [],
        error: 'Company not found',
      }
    }

    const existingNotes = listCompanyNotes(companyId).slice(0, 5)
    const excerpts = extractCompanyExcerpts(transcript, companyName)

    console.log(
      `[ReconcileService] company=${companyName} excerptChars=${excerpts.length} existingNotes=${existingNotes.length}`,
    )

    const userPrompt = buildUserPrompt({
      companyName,
      description: company.description ?? null,
      pipelineStage: company.pipelineStage ?? null,
      entityType: company.entityType ?? null,
      existingNotes,
      weekOf: digest.weekOf,
      statusUpdate: item.statusUpdate ?? null,
      brief: item.brief ?? null,
      meetingNotes: item.meetingNotes ?? null,
      transcriptExcerpts: excerpts,
    })

    let raw: string
    try {
      raw = await provider.generateSummary(SYSTEM_PROMPT, userPrompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ReconcileService] company=${companyName} LLM error: ${msg}`)
      return {
        companyId,
        companyName,
        noteTitle: '',
        noteContent: '',
        fieldUpdates: [],
        tasks: [],
        error: msg,
      }
    }

    const parsed = safeParseJson(raw)
    if (!parsed) {
      console.error(`[ReconcileService] company=${companyName} error="LLM returned unparseable response"`)
      return {
        companyId,
        companyName,
        noteTitle: '',
        noteContent: '',
        fieldUpdates: [],
        tasks: [],
        error: 'LLM returned unparseable response',
      }
    }

    // Extract and validate noteTitle
    const noteTitle = typeof parsed.noteTitle === 'string' ? parsed.noteTitle : `Partner Meeting — ${digest.weekOf}`

    // Extract noteContent and append source footer
    let noteContent = typeof parsed.noteContent === 'string' ? parsed.noteContent : ''
    const weekDate = new Date(digest.weekOf)
    const formattedDate = weekDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    noteContent = noteContent.trim() + `\n\n---\n*Source: Partner Meeting — ${formattedDate}*`

    // Extract and validate fieldUpdates
    const rawFieldUpdates = Array.isArray(parsed.fieldUpdates) ? parsed.fieldUpdates : []
    const fieldUpdates: ReconcileProposal['fieldUpdates'] = []
    for (const fu of rawFieldUpdates) {
      if (!fu || typeof fu !== 'object') continue
      const field = typeof fu.field === 'string' ? fu.field : null
      const value = typeof fu.value === 'string' ? fu.value : null
      if (!field || !value) continue
      if (field !== 'description' && field !== 'pipelineStage') continue
      if (field === 'pipelineStage' && !VALID_PIPELINE_STAGES.has(value)) continue

      // Get current value for "from"
      const from = field === 'description'
        ? (company.description ?? null)
        : (company.pipelineStage ?? null)

      fieldUpdates.push({ field, from, to: value })
    }

    // Extract and validate tasks (filter out invalid categories)
    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
    const tasks: ReconcileProposalTask[] = []
    for (const t of rawTasks) {
      if (!t || typeof t !== 'object') continue
      const title = typeof t.title === 'string' ? t.title.trim() : null
      const category = typeof t.category === 'string' ? t.category : null
      if (!title || !category) continue
      if (!VALID_TASK_CATEGORIES.has(category)) continue
      tasks.push({
        title,
        category: category as ReconcileProposalTask['category'],
        assignee: typeof t.assignee === 'string' ? t.assignee : null,
        dueDate: typeof t.dueDate === 'string' ? t.dueDate : null,
      })
    }

    console.log(
      `[ReconcileService] company=${companyName} ok noteChars=${noteContent.length} fieldUpdates=${fieldUpdates.length} tasks=${tasks.length}`,
    )

    return { companyId, companyName, noteTitle, noteContent, fieldUpdates, tasks }
  }

  // Concurrency 3 — cursor/worker pattern
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length && !signal.aborted) {
      const item = items[cursor++]
      if (!item) break
      const proposal = await processItem(item)
      proposals.push(proposal)
      onProposal(proposal)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker))

  return proposals
}

// ─── Application ─────────────────────────────────────────────────────────────

export function applyReconciliationProposals(
  input: ApplyReconciliationInput,
  userId: string,
): ApplyReconciliationResult {
  const db = getDatabase()
  let applied = 0
  const failed: ApplyReconciliationResult['failed'] = []

  for (const proposal of input.proposals) {
    try {
      // ── Note ────────────────────────────────────────────────────────────────
      if (proposal.applyNote && proposal.noteContent) {
        // Idempotency check: skip if we already created a note for this digest+company
        const existing = db
          .prepare('SELECT id FROM notes WHERE company_id = ? AND source_digest_id = ?')
          .get(proposal.companyId, input.digestId)

        if (!existing) {
          const noteId = randomUUID()
          db.prepare(`
            INSERT INTO notes (
              id, company_id, title, content, source_digest_id,
              is_pinned, created_by_user_id, updated_by_user_id,
              created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), datetime('now'))
          `).run(
            noteId,
            proposal.companyId,
            proposal.noteContent.split('\n')[0].replace(/^#+\s*/, '').slice(0, 200) || 'Partner Meeting Note',
            proposal.noteContent,
            input.digestId,
            userId,
            userId,
          )
        }
      }

      // ── Field updates ────────────────────────────────────────────────────────
      if (proposal.applyFieldUpdates && proposal.fieldUpdates.length > 0) {
        const updates: Record<string, unknown> = {}
        for (const fu of proposal.fieldUpdates) {
          if (fu.field === 'description') {
            updates.description = fu.to.slice(0, 2000)
          } else if (fu.field === 'pipelineStage' && VALID_PIPELINE_STAGES.has(fu.to)) {
            updates.pipelineStage = fu.to
          }
        }
        if (Object.keys(updates).length > 0) {
          updateCompany(proposal.companyId, updates, userId)
        }
      }

      // ── Tasks ────────────────────────────────────────────────────────────────
      if (proposal.applyTasks && proposal.tasks.length > 0) {
        const validTasks = proposal.tasks.filter(t => VALID_TASK_CATEGORIES.has(t.category))
        if (validTasks.length > 0) {
          bulkCreateTasks(
            validTasks.map(t => ({
              title: t.title,
              companyId: proposal.companyId,
              meetingId: input.meetingId,
              category: t.category,
              assignee: t.assignee ?? null,
              dueDate: t.dueDate ?? null,
              source: 'auto' as const,
            })),
            userId,
          )
        }
      }

      applied++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ReconcileService] apply failed company=${proposal.companyName}: ${msg}`)
      failed.push({ companyId: proposal.companyId, companyName: proposal.companyName, error: msg })
    }
  }

  console.log(`[ReconcileService] apply applied=${applied} failed=${failed.length}`)
  return { applied, failed }
}
