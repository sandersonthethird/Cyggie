import { buildContactContext } from './contact-context-builder'
import { getProvider } from './provider-factory'

const SYSTEM_PROMPT = `You are a CRM assistant that summarizes key context about a person for a venture capital team.

Given all available information about a contact — meeting notes, emails, and manual notes — produce exactly 3 to 5 concise bullet points capturing the most important, actionable context a relationship manager needs about this person.

Rules:
- Each bullet is a single sentence, starting with a capital letter, no trailing period
- Prioritize specificity: if they're an investor, state their exact focus (e.g. "Consumer investor focused on seed-stage deals" not "Investor interested in startups")
- Flag concrete investing parameters when present: sector focus, stage focus, check size range, geographic focus, co-investment preferences, or requirements to get excited (e.g. "Requires a technical co-founder", "Only invests post-revenue")
- For non-investors: flag their role, company stage, what they're building or seeking, and any known goals or constraints
- Include recent relationship signals: warm or cold, last meaningful interaction, open asks or follow-ups
- Do NOT invent facts — only state what is in the provided context
- Do NOT include generic observations (e.g. "Has had meetings with you", "Interested in startups")
- Output ONLY the bullet points, one per line, each starting with "• "
- No preamble, no section headers, no markdown beyond the bullet character`

const MAX_OUTPUT_CHARS = 1000

// Module-level AbortController — auto-aborts any in-progress generation when a new one starts.
// Same pattern as abortContactChat() in contact-chat.ts.
let ktAbortController: AbortController | null = null

export function abortKeyTakeaways(): void {
  ktAbortController?.abort()
  ktAbortController = null
}

export async function generateKeyTakeaways(
  contactId: string,
  onProgress: (chunk: string) => void
): Promise<string> {
  // Auto-abort any in-progress generation (e.g. user navigated to a new contact)
  abortKeyTakeaways()
  ktAbortController = new AbortController()
  const signal = ktAbortController.signal

  const { context, hasMeetings, hasEmails, hasNotes } = buildContactContext(contactId)

  if (!hasMeetings && !hasEmails && !hasNotes) {
    ktAbortController = null
    throw new Error('Not enough context — add notes or sync emails first')
  }

  const userPrompt = `Here is the available information about this contact:\n\n${context}`

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
    // Truncate at the last complete bullet so we never show a half-finished line
    const lastNewline = result.lastIndexOf('\n', MAX_OUTPUT_CHARS)
    result = lastNewline > 0 ? result.substring(0, lastNewline) : result.substring(0, MAX_OUTPUT_CHARS)
  }

  return result
}
