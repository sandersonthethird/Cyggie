/**
 * Thin per-kind dispatcher: chatDispatch({kind:'contact'}) lands here.
 *
 * The substantive context-assembly logic lives in context-builders.ts
 * ({assembleContactContext, buildContactContext}) per /plan-eng-review
 * Issue 1D. queryContact is a one-liner that delegates to
 * buildContactContext + runChatTurn. abortContactChat (kept for the
 * CONTACT_CHAT_ABORT IPC handler) delegates to abortChatTurn — the
 * shared single AbortController invariant.
 */

import { buildContactContext, CONTACT_SYSTEM_PROMPT } from './context-builders'
import { runChatTurn, abortChatTurn } from './chat-runner'
import type { ChatAttachment } from '@shared/types/chat'

export function abortContactChat(): void {
  abortChatTurn()
}

export async function queryContact(
  contactId: string,
  question: string,
  attachments?: ChatAttachment[]
): Promise<string> {
  const result = buildContactContext({ contactId })

  if (result.kind === 'response') return result.text
  if (result.kind === 'error') throw new Error(result.message)

  return runChatTurn({
    systemPrompt: CONTACT_SYSTEM_PROMPT,
    context: result.markdown,
    question,
    attachments,
    userPromptPrefix: 'Here is the available information about this contact:',
    questionLabel: 'Question',
  })
}
