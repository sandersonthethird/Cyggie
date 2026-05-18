
import { getProvider } from './provider-factory'
import { buildMemoDocTitle, roundLabel } from '@main/services/memo-export.service'
import type { ExternalResearchBundle } from '@cyggie/services/exa-research'

const MEMO_SYSTEM_PROMPT_TEMPLATE = `You are an experienced venture capital analyst writing investment memos for an investment committee. Write in a professional but direct tone — be specific, data-driven, and opinionated. Avoid vague platitudes.

Your task is to write a comprehensive investment memo based on the information provided. Use the following section structure exactly:

###TITLE###

## Executive Summary
2-3 sentences in paragraph form covering:
- A short business description (what the company does, product, target market)
- How the firm got introduced to or came across this opportunity
- The founder(s) — who they are in one phrase
- Terms of any prior raises (e.g. "raised a $1M pre-seed from angels in 2022")
- Terms of the current raise (e.g. "raising $3M on a $12M post-money SAFE")
Then a single standalone sentence with the investment recommendation (e.g. "We recommend passing at this time." or "We recommend proceeding to a partner meeting.").

## Investment Highlights
3-4 bullet points on what makes this a compelling investment opportunity. Be specific and opinionated.

## Business Description
- What the company does and its core product
- How it makes money (revenue model, pricing)
- Who the target customer is

## Market / Industry
- Description of the industry and competitive landscape
- Market size analysis with TAM/SAM figures where available

## Competition
Bullet points listing the main categories of competitors with specific company names for each.

## Team
One bullet point per founder and key executive. If a LinkedIn URL is available, reference their background from it and explain why their experience is relevant to this business.

## Traction / Financials
- Revenue figures if available
- Key performance indicators (growth rate, customer count, retention, etc.)
- Unit economics (CAC, LTV, margins, etc.)

## Go-To-Market
Description of how the business acquires customers and its sales/distribution strategy.

## Valuation
Analysis of the valuation relative to comparable companies and stage. Only include this section if the company is Seed stage or later (Series A, B, etc.). Omit entirely for pre-seed.

## Risks
3-4 bullet points. Each bullet should name a specific risk followed by a mitigating factor (e.g. "**Regulatory risk** — the FDA approval pathway is uncertain; mitigated by the company's existing 510(k) exemption and regulatory counsel on staff.").

## References
Only include this section if reference calls were conducted. For each reference, provide 3-4 bullet points with key takeaways relevant to evaluating the founder or company. Omit this section entirely if no reference calls are noted in the meeting data.

CRITICAL INSTRUCTIONS:
- Only include sections where you have substantive information. If a section would be empty or purely speculative, include the heading with a brief note like "No data available from current meetings."
- Synthesize across all meetings — don't just summarize each meeting separately.
- Use **bold** for key metrics and important terms.
- Be direct and opinionated — state whether something is a strength or concern.
- If existing memo content is provided, incorporate and improve upon it rather than starting from scratch.
- For any factual claim derived from the External Research block (market size, recent news, funding events, founder background, competitor names you didn't get from internal data), cite the source inline as [source: <url>] right after the claim. Do NOT cite internal sources.
- Output clean markdown only. No preamble or commentary.`

export function buildMemoSystemPrompt(titleLine: string): string {
  return MEMO_SYSTEM_PROMPT_TEMPLATE.replace('###TITLE###', titleLine)
}

function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[...truncated for length]'
}

/**
 * Push items into the prompt parts array, truncating each item and stopping
 * once a collective character cap is reached. Replaces the duplicated
 * `let totalChars = 0; for (...) { if (totalChars > N) break }` pattern that
 * previously appeared inline 4× in this file (transcripts, files, emails, and
 * the new contactNotes block).
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Each item is formatted via `format(item)`; the formatted     │
 *   │  string is then truncated to `perItemCap`. If pushing it      │
 *   │  would exceed `totalCap`, push the `omittedNotice` and stop.  │
 *   └──────────────────────────────────────────────────────────────┘
 */
function pushUntilCap<T>(
  parts: string[],
  items: T[],
  format: (item: T) => string,
  options: { perItemCap: number; totalCap: number; omittedNotice: string },
): void {
  let totalChars = 0
  for (const item of items) {
    if (totalChars > options.totalCap) {
      parts.push(options.omittedNotice)
      break
    }
    const truncated = truncateForContext(format(item), options.perItemCap)
    parts.push(truncated)
    parts.push('')
    totalChars += truncated.length
  }
}

export interface MemoGenerateInput {
  companyName: string
  companyDescription: string
  summaries: Array<{ title: string; date: string; content: string }>
  transcripts: Array<{ title: string; date: string; content: string }>
  notes: string[]
  existingMemo: string
  companyDetails: {
    stage?: string | null
    round?: string | null
    raiseSize?: number | null
    postMoneyValuation?: number | null
    city?: string | null
    state?: string | null
    industry?: string | null
    themes?: string[]
  }
  emails?: Array<{ subject: string | null; from: string; date: string | null; body: string }>
  files?: Array<{ name: string; content: string }>
  /**
   * Notes tagged to a contact who works at this company (NOT the same as the
   * company-tagged notes in `notes`). Each entry is already prefixed with
   * `**Contact: {name}**` by the caller for header context.
   */
  contactNotes?: string[]
  /** LinkedIn-derived background summaries per linked contact (≤8 contacts). */
  contactKeyTakeaways?: Array<{ name: string; takeaways: string }>
  /**
   * Exa pre-research bundle. Optional; when present, the user prompt will
   * include an "## External Research" block with truncated snippets and the
   * model is required to inline-cite [source: <url>] on any external claim.
   * The bundle is best-effort: callers (investment-memo IPC) call
   * `searchCompanyContext()` which silently degrades to empty on Exa failure.
   */
  externalResearch?: ExternalResearchBundle
}

function buildTitleLine(companyName: string, details: MemoGenerateInput['companyDetails']): string {
  return `# ${buildMemoDocTitle(companyName, details)}`
}

export async function generateMemo(
  input: MemoGenerateInput,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const provider = getProvider()

  const parts: string[] = []

  // Company overview
  parts.push(`# Company: ${input.companyName}`)
  if (input.companyDescription) {
    parts.push(`Description: ${input.companyDescription}`)
  }
  const detailParts: string[] = []
  if (input.companyDetails.city || input.companyDetails.state) {
    detailParts.push(`Location: ${[input.companyDetails.city, input.companyDetails.state].filter(Boolean).join(', ')}`)
  }
  if (input.companyDetails.round) detailParts.push(`Round: ${roundLabel(input.companyDetails.round) ?? input.companyDetails.round}`)
  if (input.companyDetails.raiseSize) detailParts.push(`Raise: $${input.companyDetails.raiseSize.toFixed(1)}M`)
  if (input.companyDetails.postMoneyValuation) detailParts.push(`Post-money: $${input.companyDetails.postMoneyValuation.toFixed(1)}M`)
  if (input.companyDetails.stage) detailParts.push(`Stage: ${input.companyDetails.stage}`)
  if (input.companyDetails.industry) detailParts.push(`Industry: ${input.companyDetails.industry}`)
  if (input.companyDetails.themes?.length) detailParts.push(`Themes: ${input.companyDetails.themes.join(', ')}`)
  if (detailParts.length > 0) parts.push(detailParts.join(' | '))

  // Meeting summaries (most valuable data)
  if (input.summaries.length > 0) {
    parts.push('\n---\n## Meeting Summaries\n')
    for (const s of input.summaries) {
      parts.push(`### ${s.title} (${s.date})\n${truncateForContext(s.content, 8000)}\n`)
    }
  }

  // Transcripts for meetings without summaries
  if (input.transcripts.length > 0) {
    parts.push('\n---\n## Meeting Transcripts (no summary available)\n')
    pushUntilCap(
      parts,
      input.transcripts,
      t => `### ${t.title} (${t.date})\n${t.content}\n`,
      {
        perItemCap: 10000,
        totalCap: 30000,
        omittedNotice: `\n[Additional transcripts omitted for length — ${input.transcripts.length} total]`,
      },
    )
  }

  // Company notes (no collective cap historically — preserved)
  if (input.notes.length > 0) {
    parts.push('\n---\n## Company Notes\n')
    for (const note of input.notes) {
      parts.push(truncateForContext(note, 3000))
      parts.push('')
    }
  }

  // Contact-tagged notes (notes attached to a contact who works at this company).
  // Different source than the company-tagged notes above; complements them.
  if (input.contactNotes && input.contactNotes.length > 0) {
    parts.push('\n---\n## Contact Notes\n')
    pushUntilCap(
      parts,
      input.contactNotes,
      note => note,
      {
        perItemCap: 3000,
        totalCap: 20000,
        omittedNotice: `\n[Additional contact notes omitted for length]`,
      },
    )
  }

  // Contact key takeaways (LinkedIn-derived founder/operator backgrounds).
  // Capped at 8 contacts; per-contact 800-char truncation.
  if (input.contactKeyTakeaways && input.contactKeyTakeaways.length > 0) {
    parts.push('\n---\n## Contact Profiles\n')
    for (const ct of input.contactKeyTakeaways.slice(0, 8)) {
      parts.push(`### ${ct.name}\n${truncateForContext(ct.takeaways, 800)}\n`)
    }
  }

  // Company files (drive files flagged as relevant to this company)
  // Company files (drive files flagged as relevant to this company).
  // Caps tuned for full-deck / full-model inclusion: a 30-page pitch deck
  // produces ~50-60k chars after extraction and now fits whole. Total cap
  // accommodates ~6 large decks or ~25 short files; combined with the rest
  // of the prompt context this stays well under Sonnet 4.5's 200k token
  // window. The renderer warns the user (LargeContextWarningModal) when the
  // estimated total prompt size > LARGE_CONTEXT_WARNING_CHARS.
  if (input.files && input.files.length > 0) {
    parts.push('\n---\n## Company Documents\n')
    pushUntilCap(
      parts,
      input.files,
      file => `### Document: ${file.name}\n${file.content}\n`,
      {
        perItemCap: 64_000,    // was 8_000 — pitch decks now fit whole
        totalCap: 400_000,     // was 40_000 — ~6 large decks or ~25 short files
        omittedNotice: `\n[Additional files omitted for length]`,
      },
    )
  }

  // Company emails
  if (input.emails && input.emails.length > 0) {
    parts.push('\n---\n## Email Correspondence\n')
    pushUntilCap(
      parts,
      input.emails,
      email => {
        const header = `**From:** ${email.from} | **Subject:** ${email.subject || '(no subject)'} | **Date:** ${email.date || 'unknown'}`
        return `${header}\n${email.body}\n`
      },
      {
        perItemCap: 3000,   // historical body cap
        totalCap: 20000,
        omittedNotice: `\n[Additional emails omitted for length]`,
      },
    )
  }

  // Existing memo content
  if (input.existingMemo.trim()) {
    parts.push('\n---\n## Existing Memo Draft (incorporate and improve)\n')
    parts.push(truncateForContext(input.existingMemo, 6000))
  }

  // External research from Exa pre-research pass. Per-result snippets are
  // already truncated by exa-research.ts; we just structure them here.
  if (input.externalResearch && input.externalResearch.results.length > 0) {
    parts.push('\n---\n## External Research (web — cite inline as [source: url])\n')
    // Group results by query so the model sees what was searched.
    const byQuery = new Map<string, typeof input.externalResearch.results>()
    for (const r of input.externalResearch.results) {
      const list = byQuery.get(r.query) ?? []
      list.push(r)
      byQuery.set(r.query, list)
    }
    for (const [query, results] of byQuery) {
      parts.push(`### Search: "${query}"\n`)
      for (const r of results) {
        parts.push(`**${r.title ?? r.url}** ${r.publishedDate ? `(${r.publishedDate})` : ''}\n${r.url}\n${r.text}\n`)
      }
    }
  }

  if (input.summaries.length === 0 && input.transcripts.length === 0 && input.notes.length === 0) {
    parts.push('\nNo meeting data or notes available yet. Generate a template memo with placeholders based on any company details above.')
  }

  const userPrompt = parts.join('\n')
  const titleLine = buildTitleLine(input.companyName, input.companyDetails)
  return provider.generateSummary(buildMemoSystemPrompt(titleLine), userPrompt, onProgress, signal)
}
