
import { getProvider } from './provider-factory'
const MEMO_SYSTEM_PROMPT = `You are an experienced venture capital analyst writing investment memos for an investment committee. Write in a professional but direct tone — be specific, data-driven, and opinionated. Avoid vague platitudes.

Your task is to write a comprehensive investment memo based on the information provided. Use the following section structure exactly:

# [Company Name] Investment Memo

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
- Output clean markdown only. No preamble or commentary.`


function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[...truncated for length]'
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
    industries?: string[]
    themes?: string[]
  }
  emails?: Array<{ subject: string | null; from: string; date: string | null; body: string }>
  files?: Array<{ name: string; content: string }>
}

export async function generateMemo(
  input: MemoGenerateInput,
  onProgress?: (chunk: string) => void
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
  if (input.companyDetails.round) detailParts.push(`Round: ${input.companyDetails.round}`)
  if (input.companyDetails.raiseSize) detailParts.push(`Raise: $${(input.companyDetails.raiseSize / 1_000_000).toFixed(1)}M`)
  if (input.companyDetails.postMoneyValuation) detailParts.push(`Post-money: $${(input.companyDetails.postMoneyValuation / 1_000_000).toFixed(1)}M`)
  if (input.companyDetails.stage) detailParts.push(`Stage: ${input.companyDetails.stage}`)
  if (input.companyDetails.industries?.length) detailParts.push(`Industries: ${input.companyDetails.industries.join(', ')}`)
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
    // Limit total transcript context
    let totalChars = 0
    for (const t of input.transcripts) {
      if (totalChars > 30000) {
        parts.push(`\n[Additional transcripts omitted for length — ${input.transcripts.length} total]`)
        break
      }
      const truncated = truncateForContext(t.content, 10000)
      parts.push(`### ${t.title} (${t.date})\n${truncated}\n`)
      totalChars += truncated.length
    }
  }

  // Company notes
  if (input.notes.length > 0) {
    parts.push('\n---\n## Company Notes\n')
    for (const note of input.notes) {
      parts.push(truncateForContext(note, 3000))
      parts.push('')
    }
  }

  // Company files
  if (input.files && input.files.length > 0) {
    parts.push('\n---\n## Company Documents\n')
    let totalFileChars = 0
    for (const file of input.files) {
      if (totalFileChars > 40000) {
        parts.push(`\n[Additional files omitted for length]`)
        break
      }
      const truncated = truncateForContext(file.content, 8000)
      parts.push(`### Document: ${file.name}\n${truncated}\n`)
      totalFileChars += truncated.length
    }
  }

  // Company emails
  if (input.emails && input.emails.length > 0) {
    parts.push('\n---\n## Email Correspondence\n')
    let totalEmailChars = 0
    for (const email of input.emails) {
      if (totalEmailChars > 20000) {
        parts.push(`\n[Additional emails omitted for length]`)
        break
      }
      const header = `**From:** ${email.from} | **Subject:** ${email.subject || '(no subject)'} | **Date:** ${email.date || 'unknown'}`
      const body = truncateForContext(email.body, 3000)
      parts.push(`${header}\n${body}\n`)
      totalEmailChars += body.length
    }
  }

  // Existing memo content
  if (input.existingMemo.trim()) {
    parts.push('\n---\n## Existing Memo Draft (incorporate and improve)\n')
    parts.push(truncateForContext(input.existingMemo, 6000))
  }

  if (input.summaries.length === 0 && input.transcripts.length === 0 && input.notes.length === 0) {
    parts.push('\nNo meeting data or notes available yet. Generate a template memo with placeholders based on any company details above.')
  }

  const userPrompt = parts.join('\n')
  return provider.generateSummary(MEMO_SYSTEM_PROMPT, userPrompt, onProgress)
}
