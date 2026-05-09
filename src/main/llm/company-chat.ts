/**
 * Thin per-kind dispatcher: chatDispatch({kind:'company'}) lands here.
 *
 * The substantive context-assembly logic — company overview / meeting
 * summaries / transcripts / emails / flagged-files / notes — lives in
 * context-builders.ts ({assembleCompanyContext, buildCompanyContext}).
 * queryCompany is a one-liner that delegates to buildCompanyContext +
 * runChatTurn. abortCompanyChat (kept for the COMPANY_CHAT_ABORT IPC
 * handler) delegates to abortChatTurn — the shared single
 * AbortController invariant.
 */

import * as companyRepo from '../database/repositories/org-company.repo'
import { buildCompanyContext, COMPANY_SYSTEM_PROMPT } from './context-builders'
import { runChatTurn, abortChatTurn } from './chat-runner'
import type { ChatAttachment } from '../../shared/types/chat'

export function abortCompanyChat(): void {
  abortChatTurn()
}

export async function queryCompany(
  companyId: string,
  question: string,
  attachments?: ChatAttachment[]
): Promise<string> {
  const result = await buildCompanyContext({ companyId })

  if (result.kind === 'response') return result.text
  if (result.kind === 'error') throw new Error(result.message)

  // Re-fetch the company name for the user-prompt prefix. assembleCompanyContext
  // already loaded the company once; re-fetching here is one extra SQL row
  // (microseconds). Step 9 collapses this into chatDispatch and we can pass
  // the name through alongside the BuilderResult.
  const companyName = companyRepo.getCompany(companyId)?.canonicalName ?? 'this company'

  return runChatTurn({
    systemPrompt: COMPANY_SYSTEM_PROMPT,
    context: result.markdown,
    question,
    attachments,
    userPromptPrefix: `Here is the available information about ${companyName}:`,
    questionLabel: 'Question',
  })
}
