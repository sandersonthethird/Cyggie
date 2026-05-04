/**
 * Thin shim during the chat-paths refactor.
 *
 * Step 4 of the refactor moved this file's substantive logic — the company
 * overview / meeting summaries / transcripts / emails / flagged-files
 * assembly — into context-builders.ts/{assembleCompanyContext,
 * buildCompanyContext}. This file now only re-exports the IPC-facing
 * functions (queryCompany, abortCompanyChat) so the IPC handler in
 * company-chat.ipc.ts keeps importing from the same place.
 *
 * Step 9 of the refactor will:
 *   - Replace the IPC handler's `runLLM: () => queryCompany(...)` with
 *     `runLLM: () => chatDispatch({ kind: { kind: 'company', companyId }, ... })`
 *   - Delete this file.
 *
 * Until then, queryCompany is a one-liner that delegates to
 * `buildCompanyContext` + `runChatTurn`. abortCompanyChat delegates to
 * `abortChatTurn` (the shared single AbortController).
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
