import { buildContactContext } from './contact-context-builder'
import { getProvider } from './provider-factory'
import { sendProgress } from './send-progress'

let contactChatAbortController: AbortController | null = null

export function abortContactChat(): void {
  contactChatAbortController?.abort()
  contactChatAbortController = null
}

const SYSTEM_PROMPT = `You are a helpful CRM assistant.
You answer questions about a specific contact using all available context:
meeting notes and transcripts, email correspondence, and contact notes.
Answer accurately based on the provided context. If information isn't available, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

export async function queryContact(contactId: string, question: string): Promise<string> {
  // buildContactContext throws 'Contact not found' if contactId is invalid
  const { context } = buildContactContext(contactId)

  // Note: contact.fullName removed — name is already the first line of context (# Contact: {name})
  const userPrompt = `Here is the available information about this contact:\n\n${context}\n\n---\n\nQuestion: ${question}`

  const provider = getProvider('chat')
  contactChatAbortController = new AbortController()
  const result = await provider.generateSummary(SYSTEM_PROMPT, userPrompt, sendProgress, contactChatAbortController.signal)
  contactChatAbortController = null
  return result
}
