import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as repo from '../database/repositories/partner-meeting.repo'
import { getCompany, listCompanyMeetingSummaryPaths, listCompanyContacts } from '../database/repositories/org-company.repo'
import { listCompanyNotes } from '../database/repositories/company-notes.repo'
import { getProvider } from '../llm/provider-factory'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import {
  generateReconciliationProposals,
  applyReconciliationProposals,
} from '../services/partner-meeting-reconcile.service'
import type { AddToSyncInput, UpdateItemInput, ApplyReconciliationInput } from '../../shared/types/partner-meeting'

// AbortController registry for in-flight reconciliation generation
const activeReconcileControllers = new Map<string, AbortController>()

// ─── PDF Export ──────────────────────────────────────────────────────────────

async function exportDigestToPdf(event: Electron.IpcMainInvokeEvent): Promise<void> {
  const pdf = await event.sender.printToPDF({
    printBackground: false,
    pageSize: 'A4',
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
  })
  const tmpPath = path.join(os.tmpdir(), `partner-sync-${Date.now()}.pdf`)
  fs.writeFileSync(tmpPath, pdf)
  await shell.openPath(tmpPath)
}

// ─── AI Brief Generation ─────────────────────────────────────────────────────

/**
 * Gathers context for a company brief and calls the enrichment LLM.
 * Returns null if the LLM fails or returns fewer than 10 characters.
 *
 * Context gathered:
 *   - Company CRM fields (description, round, ARR, traction, etc.)
 *   - Founders: contacts with contactType = 'founder'
 *   - Recent meetings (last 3) with summary text (fs.readFile per summaryPath)
 *   - Recent company notes (last 5)
 */
async function generateBrief(companyId: string): Promise<string | null> {
  const company = getCompany(companyId)
  if (!company) return null

  // Founders from contacts linked to this company
  const allContacts = listCompanyContacts(companyId)
  const founders = allContacts.filter(c => c.contactType === 'founder')

  // Recent meetings + summary text (at most 3)
  const meetingRefs = listCompanyMeetingSummaryPaths(companyId).slice(0, 3)
  const recentMeetings: { title: string; summary: string | null }[] = []
  for (const ref of meetingRefs) {
    let summary: string | null = null
    try {
      summary = fs.readFileSync(ref.summaryPath, 'utf-8')
    } catch {
      // Missing or unreadable summary file — pass null and continue
    }
    recentMeetings.push({ title: ref.title, summary })
  }

  // Recent company notes (at most 5)
  const notes = listCompanyNotes(companyId).slice(0, 5)

  // ─── Build prompt ──────────────────────────────────────────────────────────

  const systemPrompt = [
    'You are a VC analyst writing a pre-meeting company brief.',
    'Use only the provided data. Be concise — 10-15 bullets total.',
    'Format in markdown with bold section headers.',
    'Sections: Company, Founders, Round, Traction, Risks / Questions.',
  ].join(' ')

  const lines: string[] = []

  lines.push(`# Company: ${company.canonicalName}`)
  if (company.description) lines.push(`Description: ${company.description}`)
  if (company.sector) lines.push(`Sector: ${company.sector}`)
  if (company.websiteUrl) lines.push(`Website: ${company.websiteUrl}`)
  if (company.foundingYear) lines.push(`Founded: ${company.foundingYear}`)
  if (company.employeeCountRange) lines.push(`Employees: ${company.employeeCountRange}`)
  if (company.hqAddress) lines.push(`HQ: ${company.hqAddress}`)

  lines.push('\n## Round & Financials')
  if (company.round) lines.push(`Round: ${company.round}`)
  if (company.raiseSize) lines.push(`Raise size: $${(company.raiseSize / 1_000_000).toFixed(1)}M`)
  if (company.postMoneyValuation) lines.push(`Post-money: $${(company.postMoneyValuation / 1_000_000).toFixed(1)}M`)
  if (company.arr) lines.push(`ARR: $${(company.arr / 1_000).toFixed(0)}K`)
  if (company.burnRate) lines.push(`Burn: $${(company.burnRate / 1_000).toFixed(0)}K/mo`)
  if (company.runwayMonths) lines.push(`Runway: ${company.runwayMonths} months`)
  if (company.totalFundingRaised) lines.push(`Total raised: $${(company.totalFundingRaised / 1_000_000).toFixed(1)}M`)
  if (company.leadInvestor) lines.push(`Lead investor: ${company.leadInvestor}`)

  if (founders.length > 0) {
    lines.push('\n## Founders')
    for (const f of founders) {
      const parts = [f.fullName]
      if (f.title) parts.push(`(${f.title})`)
      if (f.linkedinUrl) parts.push(`— ${f.linkedinUrl}`)
      lines.push(`- ${parts.join(' ')}`)
    }
  }

  if (recentMeetings.length > 0) {
    lines.push('\n## Recent Meetings')
    for (const m of recentMeetings) {
      lines.push(`### ${m.title}`)
      if (m.summary) lines.push(m.summary.slice(0, 2000))
      else lines.push('(no summary available)')
    }
  }

  if (notes.length > 0) {
    lines.push('\n## Recent Notes')
    for (const n of notes) {
      if (n.content) lines.push(n.content.slice(0, 500))
    }
  }

  const userPrompt = lines.join('\n')

  let raw: string
  try {
    raw = await getProvider('enrichment').generateSummary(systemPrompt, userPrompt)
  } catch (err) {
    console.error('[partner-brief] LLM call failed:', err)
    return null
  }

  if (!raw || typeof raw !== 'string' || raw.trim().length < 10) {
    console.warn('[partner-brief] LLM returned empty/invalid response')
    return null
  }

  return raw
}

// ─── IPC Registration ─────────────────────────────────────────────────────────

export function registerPartnerMeetingIpc(): void {

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE, () => {
    return repo.getActiveDigest()
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_GET, (_event, id: string) => {
    if (!id) throw new Error('id is required')
    return repo.getDigestById(id)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_LIST, () => {
    return repo.listDigests()
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_CONCLUDE, (_event, digestId: string) => {
    if (!digestId) throw new Error('digestId is required')
    return repo.concludeDigest(digestId)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_EXPORT_PDF, async (event) => {
    return exportDigestToPdf(event)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_ITEM_ADD, (_event, digestId: string, input: AddToSyncInput) => {
    if (!digestId) throw new Error('digestId is required')
    return repo.addItem(digestId, input)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_ITEM_UPDATE, (_event, itemId: string, input: UpdateItemInput) => {
    if (!itemId) throw new Error('itemId is required')
    return repo.updateItem(itemId, input)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_ITEM_DELETE, (_event, itemId: string) => {
    if (!itemId) throw new Error('itemId is required')
    repo.deleteItem(itemId)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_GET_SUGGESTIONS, (_event, digestId: string) => {
    if (!digestId) throw new Error('digestId is required')
    return repo.getSuggestions(digestId)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_DISMISS_SUGGESTION, (_event, digestId: string, companyId: string) => {
    if (!digestId) throw new Error('digestId is required')
    if (!companyId) throw new Error('companyId is required')
    repo.dismissSuggestion(digestId, companyId)
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_GENERATE_BRIEF, async (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    const brief = await generateBrief(companyId)
    return { brief }
  })

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_SET_MEETING,
    (_event, digestId: string, meetingId: string | null) => {
      if (!digestId) throw new Error('digestId is required')
      repo.setDigestMeetingId(digestId, meetingId)
    },
  )

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_GENERATE_RECONCILIATION,
    async (event, digestId: string) => {
      if (!digestId) throw new Error('digestId is required')
      const controller = new AbortController()
      activeReconcileControllers.set(digestId, controller)
      try {
        const digest = repo.getDigestById(digestId)
        if (!digest) throw new Error(`Digest ${digestId} not found`)
        return await generateReconciliationProposals(
          digest,
          getCurrentUserId(),
          getProvider('enrichment'),
          (proposal) => event.sender.send(IPC_CHANNELS.PARTNER_MEETING_RECONCILE_PROPOSAL, proposal),
          controller.signal,
        )
      } finally {
        activeReconcileControllers.delete(digestId)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_RECONCILE_CANCEL,
    (_event, digestId: string) => {
      activeReconcileControllers.get(digestId)?.abort()
      return { cancelled: true }
    },
  )

  ipcMain.handle(IPC_CHANNELS.PARTNER_MEETING_APPLY_RECONCILIATION,
    (_event, input: ApplyReconciliationInput) => {
      if (!input?.digestId) throw new Error('digestId is required')
      const userId = getCurrentUserId()
      const result = applyReconciliationProposals(input, userId)
      logAudit(userId, 'partner-meeting', input.digestId, 'reconcile', result)
      return result
    },
  )
}
