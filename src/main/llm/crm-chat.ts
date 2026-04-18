// crm-chat.ts — CRM database chat and unified global query (meetings + CRM)
//
// Data flow for queryAll():
//
// question + attachments
//         │
//         ├─── buildMeetingContext(question) ──────────────────┐
//         │       │                                            │
//         │       ├─ Strategy 0: AND co-person search          │
//         │       ├─ Strategy 1: FTS keyword search            │ meeting
//         │       ├─ Strategy 2: Title LIKE search             │ context
//         │       └─ Strategy 3: Speaker search                │ string
//         │       (empty string if 0 matches → proceed) ───────┘
//         │
//         └─── buildCrmContext(question) ──────────────────────┐
//                 │                                            │
//                 ├─ extractKeywords(question) [search.repo]   │
//                 │   └─ 0 keywords? → investor-signal fallback│
//                 ├─ LIKE query: contacts (LIMIT 200)          │ CRM
//                 ├─ LIKE query: companies (LIMIT 100)         │ context
//                 ├─ Notes linked to matched IDs (LIMIT 50)    │ string
//                 └─ Emails linked to matched IDs (LIMIT 20)   │
//                 (empty string if 0 matches → proceed) ───────┘
//                         │
//                         ▼
//         [meetingCtx, crmCtx].filter(Boolean).join('\n\n---\n\n')
//         if both empty → return graceful no-results message
//                         │
//                         ▼
//                ONE LLM call (QUERY_ALL_SYSTEM_PROMPT)
//                Streaming via CHAT_PROGRESS events

import { getDatabase } from '../database/connection'
import { extractKeywords } from '../database/repositories/search.repo'
import { buildMeetingContext, injectTextAttachments } from './chat'
import { getProvider } from './provider-factory'
import { sendProgress } from './send-progress'
import type { ChatAttachment } from '../../shared/types/chat'

let allChatAbortController: AbortController | null = null

export function abortAllChat(): void {
  allChatAbortController?.abort()
  allChatAbortController = null
}

const CRM_SYSTEM_PROMPT = `You are a research assistant for a venture capital firm.
You have access to the firm's CRM: contacts, companies/funds, emails, and notes.
Answer questions accurately based only on the provided data.
When listing multiple people or organizations, format your answer as a markdown table with the most relevant columns.
If nothing in the database matches the query, say so clearly — do not invent data.`

const QUERY_ALL_SYSTEM_PROMPT = `You are a research assistant for a venture capital firm.
You have access to meeting transcripts/notes AND the firm's full CRM database (contacts, companies, emails, notes).
Synthesize information from both sources to answer the question.
When listing multiple people or organizations, format your answer as a markdown table with the most relevant columns.
Cite sources: for meeting-sourced info, mention the meeting title and date.
If information isn't available in either source, say so clearly — do not invent data.`

const MAX_NOTE_CHARS = 1500
const MAX_EMAIL_CHARS = 1500
const MAX_TOTAL_CHARS = 80_000

// buildCrmContext queries contacts and companies matching the user's question via keyword
// pre-filtering, then fetches linked notes and emails. Returns a markdown context string,
// or '' if no records match — callers should proceed with other context sources.
async function buildCrmContext(question: string): Promise<string> {
  const db = getDatabase()

  let contactRows: ContactRow[]
  let companyRows: CompanyRow[]

  try {
    const keywords = extractKeywords(question)

    if (keywords.length > 0) {
      // Build one parameterized query with N×fields OR conditions per keyword.
      // Each keyword becomes %keyword% and is matched against multiple fields.
      const contactConditions = keywords.map(() =>
        '(ct.full_name LIKE ? OR ct.title LIKE ? OR ct.contact_type LIKE ? OR ct.investment_stage_focus LIKE ? OR ct.investment_sector_focus LIKE ? OR oc.canonical_name LIKE ? OR oc.description LIKE ?)'
      ).join(' OR ')

      const contactParams = keywords.flatMap(kw => {
        const w = `%${kw}%`
        return [w, w, w, w, w, w, w]
      })

      contactRows = db.prepare(`
        SELECT ct.id, ct.full_name, ct.title, ct.email, ct.linkedin_url,
               ct.contact_type, ct.investment_stage_focus, ct.investment_sector_focus,
               ct.typical_check_size_min, ct.typical_check_size_max,
               ct.fund_size, ct.city, ct.state,
               oc.canonical_name AS company_name, oc.description AS company_description
        FROM contacts ct
        LEFT JOIN org_companies oc ON oc.id = ct.primary_company_id
        WHERE ${contactConditions}
        LIMIT 200
      `).all(...contactParams) as ContactRow[]

      const companyConditions = keywords.map(() =>
        '(canonical_name LIKE ? OR description LIKE ? OR sector LIKE ? OR stage LIKE ? OR entity_type LIKE ?)'
      ).join(' OR ')

      const companyParams = keywords.flatMap(kw => {
        const w = `%${kw}%`
        return [w, w, w, w, w]
      })

      companyRows = db.prepare(`
        SELECT id, canonical_name, description, sector, stage, entity_type, website_url, lead_investor
        FROM org_companies
        WHERE include_in_companies_view = 1
          AND (${companyConditions})
        LIMIT 100
      `).all(...companyParams) as CompanyRow[]
    } else {
      // No keywords extracted — fall back to contacts with any investor-signal fields set
      contactRows = db.prepare(`
        SELECT ct.id, ct.full_name, ct.title, ct.email, ct.linkedin_url,
               ct.contact_type, ct.investment_stage_focus, ct.investment_sector_focus,
               ct.typical_check_size_min, ct.typical_check_size_max,
               ct.fund_size, ct.city, ct.state,
               oc.canonical_name AS company_name, oc.description AS company_description
        FROM contacts ct
        LEFT JOIN org_companies oc ON oc.id = ct.primary_company_id
        WHERE ct.contact_type = 'investor'
           OR ct.investment_stage_focus IS NOT NULL
           OR ct.typical_check_size_min IS NOT NULL
           OR ct.investment_sector_focus IS NOT NULL
        LIMIT 200
      `).all() as ContactRow[]

      // For companies: all VC funds when no keyword context
      companyRows = db.prepare(`
        SELECT id, canonical_name, description, sector, stage, entity_type, website_url, lead_investor
        FROM org_companies
        WHERE include_in_companies_view = 1
          AND entity_type = 'vc_fund'
        LIMIT 100
      `).all() as CompanyRow[]
    }

    if (contactRows.length === 0 && companyRows.length === 0) return ''

    // Fetch notes linked to matched contacts and companies
    const contactIds = contactRows.map(r => r.id)
    const companyIds = companyRows.map(r => r.id)
    const noteRows = fetchLinkedNotes(db, contactIds, companyIds)

    // Fetch emails linked to matched contacts
    const emailRows = fetchLinkedEmails(db, contactIds)

    return formatCrmContext(contactRows, companyRows, noteRows, emailRows)
  } catch (err) {
    throw new Error(`Unable to load CRM data. Please try again. (${String(err)})`)
  }
}

function fetchLinkedNotes(db: ReturnType<typeof getDatabase>, contactIds: string[], companyIds: string[]): NoteRow[] {
  if (contactIds.length === 0 && companyIds.length === 0) return []

  const conditions: string[] = []
  const params: string[] = []

  if (companyIds.length > 0) {
    conditions.push(`n.company_id IN (${companyIds.map(() => '?').join(',')})`)
    params.push(...companyIds)
  }
  if (contactIds.length > 0) {
    conditions.push(`n.contact_id IN (${contactIds.map(() => '?').join(',')})`)
    params.push(...contactIds)
  }

  return db.prepare(`
    SELECT n.title, n.content, n.updated_at,
           oc.canonical_name AS company_name, ct.full_name AS contact_name
    FROM notes n
    LEFT JOIN org_companies oc ON oc.id = n.company_id
    LEFT JOIN contacts ct ON ct.id = n.contact_id
    WHERE ${conditions.join(' OR ')}
    ORDER BY n.updated_at DESC
    LIMIT 50
  `).all(...params) as NoteRow[]
}

function fetchLinkedEmails(db: ReturnType<typeof getDatabase>, contactIds: string[]): EmailRow[] {
  if (contactIds.length === 0) return []

  const placeholders = contactIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT em.subject, em.from_email, em.body_text,
           COALESCE(em.received_at, em.sent_at) AS email_date,
           ct.full_name AS contact_name
    FROM email_messages em
    JOIN email_contact_links ecl ON ecl.message_id = em.id
    JOIN contacts ct ON ct.id = ecl.contact_id
    WHERE ecl.contact_id IN (${placeholders})
      AND em.body_text IS NOT NULL
      AND LENGTH(em.body_text) > 50
    ORDER BY email_date DESC
    LIMIT 20
  `).all(...contactIds) as EmailRow[]
}

function formatCrmContext(
  contacts: ContactRow[],
  companies: CompanyRow[],
  notes: NoteRow[],
  emails: EmailRow[]
): string {
  const parts: string[] = []
  let totalChars = 0

  // Contacts section
  if (contacts.length > 0) {
    parts.push('## Contacts & People')
    for (const ct of contacts) {
      const lines: string[] = []
      const nameAndFirm = ct.company_name
        ? `### ${ct.full_name} — ${ct.title || 'N/A'} at ${ct.company_name}`
        : `### ${ct.full_name}${ct.title ? ` — ${ct.title}` : ''}`
      lines.push(nameAndFirm)

      const meta: string[] = []
      if (ct.contact_type) meta.push(`Type: ${ct.contact_type}`)
      if (ct.investment_stage_focus) meta.push(`Stage focus: ${ct.investment_stage_focus}`)
      if (ct.investment_sector_focus) meta.push(`Sector: ${ct.investment_sector_focus}`)
      if (meta.length) lines.push(`- ${meta.join(' | ')}`)

      const financial: string[] = []
      if (ct.typical_check_size_min != null || ct.typical_check_size_max != null) {
        const min = ct.typical_check_size_min != null ? `$${(ct.typical_check_size_min / 1_000_000).toFixed(1)}M` : '?'
        const max = ct.typical_check_size_max != null ? `$${(ct.typical_check_size_max / 1_000_000).toFixed(1)}M` : '?'
        financial.push(`Check size: ${min}–${max}`)
      }
      if (ct.fund_size != null) financial.push(`Fund: $${(ct.fund_size / 1_000_000).toFixed(0)}M`)
      if (ct.city || ct.state) financial.push(`Location: ${[ct.city, ct.state].filter(Boolean).join(', ')}`)
      if (financial.length) lines.push(`- ${financial.join(' | ')}`)

      const contact: string[] = []
      if (ct.email) contact.push(`Email: ${ct.email}`)
      if (ct.linkedin_url) contact.push(`LinkedIn: ${ct.linkedin_url}`)
      if (contact.length) lines.push(`- ${contact.join(' | ')}`)

      const block = lines.join('\n') + '\n'
      if (totalChars + block.length < MAX_TOTAL_CHARS) {
        parts.push(block)
        totalChars += block.length
      }
    }
    parts.push('')
  }

  // Companies section
  if (companies.length > 0) {
    parts.push('## Companies & Funds')
    const tableRows = companies.map(c => {
      const desc = c.description ? c.description.substring(0, 100) : ''
      return `| ${c.canonical_name} | ${c.entity_type || ''} | ${c.sector || ''} | ${c.stage || ''} | ${desc} |`
    })
    const tableBlock = '| Name | Type | Sector | Stage | Description |\n|------|------|--------|-------|-------------|\n' + tableRows.join('\n') + '\n'
    if (totalChars + tableBlock.length < MAX_TOTAL_CHARS) {
      parts.push(tableBlock)
      totalChars += tableBlock.length
    }
    parts.push('')
  }

  // Emails section (truncate first if over budget)
  if (emails.length > 0 && totalChars < MAX_TOTAL_CHARS) {
    parts.push('## Related Emails')
    for (const em of emails) {
      const date = em.email_date ? new Date(em.email_date).toLocaleDateString() : ''
      const body = em.body_text ? em.body_text.substring(0, MAX_EMAIL_CHARS) : ''
      const block = `**From:** ${em.from_email}${em.contact_name ? ` (re: ${em.contact_name})` : ''} | **Subject:** ${em.subject || '(no subject)'} | **Date:** ${date}\n${body}\n`
      if (totalChars + block.length < MAX_TOTAL_CHARS) {
        parts.push(block)
        totalChars += block.length
      }
    }
    parts.push('')
  }

  // Notes section (truncate first if over budget)
  if (notes.length > 0 && totalChars < MAX_TOTAL_CHARS) {
    parts.push('## Related Notes')
    for (const n of notes) {
      const label = n.company_name || n.contact_name || ''
      const title = n.title ? `**${n.title}**${label ? ` (${label})` : ''}` : label
      const content = n.content.substring(0, MAX_NOTE_CHARS)
      const block = `${title}\n${content}\n`
      if (totalChars + block.length < MAX_TOTAL_CHARS) {
        parts.push(block)
        totalChars += block.length
      }
    }
  }

  return parts.join('\n')
}

// queryCrm answers a question using only CRM context (no meeting transcripts).
export async function queryCrm(question: string): Promise<string> {
  const crmCtx = await buildCrmContext(question)

  if (!crmCtx) {
    return "I couldn't find any matching contacts, companies, or notes in your CRM database. Try rephrasing your question."
  }

  const userPrompt = `Here is the relevant CRM data:\n\n${crmCtx}\n\n---\n\nUser question: ${question}`

  const provider = getProvider('chat')
  allChatAbortController = new AbortController()
  const result = await provider.generateSummary(CRM_SYSTEM_PROMPT, userPrompt, sendProgress, allChatAbortController.signal)
  allChatAbortController = null
  return result
}

// queryAll answers a question using both meeting transcripts and CRM data.
// Either source may be empty — the function proceeds with whatever data is available.
export async function queryAll(question: string, attachments: ChatAttachment[] = []): Promise<string> {
  const meetingCtx = buildMeetingContext(question)
  const crmCtx = await buildCrmContext(question)

  if (!meetingCtx && !crmCtx) {
    return "I couldn't find any relevant information in your meetings or CRM data. Try rephrasing your question."
  }

  const sections = [
    meetingCtx ? `# Meeting Context\n${meetingCtx}` : '',
    crmCtx ? `# CRM Context\n${crmCtx}` : '',
  ].filter(Boolean)

  const combined = sections.join('\n\n---\n\n')
  const enhancedQuestion = injectTextAttachments(question, attachments)
  const imageAtts = attachments.filter(a => a.type === 'image')

  const userPrompt = `${combined}\n\n---\n\nUser question: ${enhancedQuestion}`

  const provider = getProvider('chat')
  allChatAbortController = new AbortController()
  const result = await provider.generateSummary(QUERY_ALL_SYSTEM_PROMPT, userPrompt, sendProgress, allChatAbortController.signal, imageAtts)
  allChatAbortController = null
  return result
}

// ─── Row types (internal) ──────────────────────────────────────────────────

interface ContactRow {
  id: string
  full_name: string
  title: string | null
  email: string | null
  linkedin_url: string | null
  contact_type: string | null
  investment_stage_focus: string | null
  investment_sector_focus: string | null
  typical_check_size_min: number | null
  typical_check_size_max: number | null
  fund_size: number | null
  city: string | null
  state: string | null
  company_name: string | null
  company_description: string | null
}

interface CompanyRow {
  id: string
  canonical_name: string
  description: string | null
  sector: string | null
  stage: string | null
  entity_type: string | null
  website_url: string | null
  lead_investor: string | null
}

interface NoteRow {
  title: string | null
  content: string
  updated_at: string | null
  company_name: string | null
  contact_name: string | null
}

interface EmailRow {
  subject: string | null
  from_email: string
  body_text: string | null
  email_date: string | null
  contact_name: string | null
}
