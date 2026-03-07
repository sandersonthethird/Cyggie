import type { LLMProvider } from './provider'
import { ClaudeProvider } from './claude-provider'
import { OllamaProvider } from './ollama-provider'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import type { LlmProvider } from '../../shared/types/settings'

const MEMO_SYSTEM_PROMPT = `You are an experienced venture capital analyst writing investment memos for an investment committee. Write in a professional but direct tone — be specific, data-driven, and opinionated. Avoid vague platitudes.

Your task is to write a comprehensive investment memo based on the information provided. Use the following section structure:

# [Company Name] Investment Memo

## Executive Summary
Two paragraphs only:
- **Paragraph 1:** A concise description of the company (what they do, their product, target market) and the investment opportunity (why this is compelling, key thesis).
- **Paragraph 2:** 1-2 sentences covering the type of security being offered, deal terms under consideration, and round dynamics — e.g. "$2M raise on a $10M post-money SAFE led by Lightspeed Ventures with participation from A16Z and strategic angels." Include specific numbers and investor names where available from the meeting data.

## Investment Highlights
3-5 bullet points on the strongest reasons to invest.

## Business
What the company does, its product, business model, customers, and unit economics. Be specific.

## Market / Industry
Total addressable market, market dynamics, tailwinds. Include numbers where available.

## Team
Key founders and executives, relevant experience, why this team is suited to win.

## Traction
Revenue, growth rates, customer count, retention, pipeline — any quantitative proof points.

## Financials
Current financials, burn rate, runway, revenue projections if available.

## Risks
3-5 specific, honest risks. Not generic "competition exists" — real concerns.

## Checklist
Rate key areas (Market, Team, Product, Traction, Economics) on a 1-5 scale with brief justification.

## Capitalization
Current round details, valuation, existing investors, cap table notes.

## References
Any key references, customer calls, or diligence sources.

## Appendix
Additional data, detailed financials, or supporting information.

CRITICAL INSTRUCTIONS:
- Only include sections where you have substantive information. If a section would be empty or purely speculative, include the heading with a brief note like "No data available from current meetings."
- Synthesize across all meetings — don't just summarize each meeting separately.
- Use **bold** for key metrics and important terms.
- Use bullet points for lists and key facts.
- Be direct and opinionated — state whether something is a strength or concern.
- If existing memo content is provided, incorporate and improve upon it rather than starting from scratch.
- Output clean markdown only. No preamble or commentary.`

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
