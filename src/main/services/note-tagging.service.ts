/**
 * AI-powered note tagging service.
 *
 * Given note content, suggests a company and/or contact to tag the note to,
 * by sending a short prompt to the configured LLM.
 *
 * Returns null (no banner shown) when:
 *   - Note content is empty
 *   - Both company and contact lists are empty
 *   - LLM is not configured
 *   - LLM returns malformed JSON or a confidence < 40
 *   - Any error occurs (fail-safe — never blocks the UI)
 *
 * Flow:
 *   note content (≤2000 chars)
 *       │
 *       ▼
 *   load companies (limit 200) + contacts (limit 200)
 *       │
 *       ▼
 *   build prompt ──► LLM call ──► JSON.parse
 *       │                              │
 *       │                        confidence < 40?
 *       │                              │ yes → return null
 *       │                              ▼
 *       └──────────────────────► TagSuggestion
 */

import { getSetting } from '../database/repositories/settings.repo'
import { getCredential } from '../security/credentials'
import { ClaudeProvider } from '../llm/claude-provider'
import { OllamaProvider } from '../llm/ollama-provider'
import type { LLMProvider } from '../llm/provider'
import type { LlmProvider } from '../../shared/types/settings'
import type { TagSuggestion } from '../../shared/types/note'
import { listCompanies } from '../database/repositories/org-company.repo'
import { listContactsLight } from '../database/repositories/contact.repo'

const CONFIDENCE_THRESHOLD = 40
const MAX_CONTENT_CHARS = 2000

function getProvider(): LLMProvider | null {
  try {
    const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider
    if (providerType === 'ollama') {
      const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
      const model = getSetting('ollamaModel') || 'llama3.1'
      return new OllamaProvider(model, host)
    }
    const apiKey = getCredential('claudeApiKey')
    if (!apiKey) return null
    const model = getSetting('claudeSummaryModel') || 'claude-sonnet-4-5-20250929'
    return new ClaudeProvider(apiKey, model)
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `You are a CRM assistant. Given a note, suggest which company and/or contact it should be tagged to.
Respond ONLY with valid JSON — no markdown, no explanation, no text outside the JSON object.`

function buildUserPrompt(
  content: string,
  companies: { id: string; name: string }[],
  contacts: { id: string; name: string; companyName?: string | null }[]
): string {
  const companiesList =
    companies.length > 0
      ? companies.map((c) => `  - id: "${c.id}", name: "${c.name}"`).join('\n')
      : '  (none)'

  const contactsList =
    contacts.length > 0
      ? contacts
          .map(
            (c) =>
              `  - id: "${c.id}", name: "${c.name}"${c.companyName ? `, company: "${c.companyName}"` : ''}`
          )
          .join('\n')
      : '  (none)'

  return `NOTE CONTENT:
${content.slice(0, MAX_CONTENT_CHARS)}

AVAILABLE COMPANIES:
${companiesList}

AVAILABLE CONTACTS:
${contactsList}

Respond ONLY with valid JSON matching this exact schema:
{
  "companyId": string | null,
  "contactId": string | null,
  "companyName": string | null,
  "contactName": string | null,
  "confidence": number,
  "reasoning": string
}

Rules:
- confidence is 0–100 (your certainty that this tagging is correct)
- If the note doesn't clearly relate to any company or contact, return companyId: null, contactId: null, confidence: 0
- Only suggest IDs from the provided lists
- reasoning is a single sentence explaining your choice`
}

export async function suggestNoteTag(noteContent: string): Promise<TagSuggestion | null> {
  try {
    if (!noteContent?.trim()) return null

    const provider = getProvider()
    if (!provider) return null

    const companySummaries = listCompanies({ limit: 200 })
    const contactSummaries = listContactsLight({ limit: 200 })

    if (companySummaries.length === 0 && contactSummaries.length === 0) return null

    const companies = companySummaries.map((c) => ({ id: c.id, name: c.canonicalName }))
    const contacts = contactSummaries.map((c) => ({
      id: c.id,
      name: c.fullName,
      companyName: c.primaryCompanyName ?? null
    }))

    const userPrompt = buildUserPrompt(noteContent, companies, contacts)
    const response = await provider.generateSummary(SYSTEM_PROMPT, userPrompt)

    let parsed: TagSuggestion
    try {
      parsed = JSON.parse(response) as TagSuggestion
    } catch {
      return null
    }

    if (
      typeof parsed.confidence !== 'number' ||
      parsed.confidence < CONFIDENCE_THRESHOLD
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}
