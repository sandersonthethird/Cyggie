/**
 * Shared chat-turn runner — owns the AbortController, attachment injection,
 * and provider call that every chat path performs identically. The four
 * legacy `query*` functions had this same boilerplate copy-pasted (with
 * subtle drift on the abort path); this file is the single source of truth.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ runChatTurn({ systemPrompt, context, question, attachments }) │
 *   │   1. injectTextAttachments(question, attachments) → enhanced  │
 *   │   2. compose userPrompt = `${context}` + Q&A footer            │
 *   │   3. install fresh AbortController on the shared slot         │
 *   │   4. provider.generateSummary(system, user, sendProgress,     │
 *   │                                signal, imageAttachments)      │
 *   │   5. return response                                           │
 *   └───────────────────────────────────────────────────────────────┘
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ abortChatTurn() — kills whichever turn is currently in flight │
 *   │   on the shared AbortController slot. No-op if none.          │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * INVARIANT: exactly one chat turn is ever in flight at a time. The renderer
 * disables send while `isLoading=true` (see useChatStreaming.ts). This single
 * shared controller is functionally equivalent to today's four per-path
 * controllers (chatAbortController in chat.ts, companyChatAbortController in
 * company-chat.ts, contactChatAbortController in contact-chat.ts,
 * allChatAbortController in crm-chat.ts) but eliminates the drift between
 * their abort paths. If the renderer ever lifts the in-flight gate, this
 * controller would cancel the wrong turn — re-evaluate then.
 */

import { getProvider } from './provider-factory'
import { sendProgress } from './send-progress'
import type { ChatAttachment } from '../../shared/types/chat'

// ── Shared AbortController slot ────────────────────────────────────────

let activeController: AbortController | null = null

export function abortChatTurn(): void {
  if (activeController) {
    activeController.abort()
    activeController = null
  }
}

// ── Attachment injection ───────────────────────────────────────────────

/**
 * Inlines text attachments into the user's question. Image attachments stay
 * separate (they need to ride on the provider's image-attachment channel).
 *
 *   q="Tell me X" + [{type:'text', name:'memo.md', data:'...content...'}]
 *
 *   becomes:
 *
 *   "Tell me X
 *
 *   ## Attached Files
 *   ### memo.md
 *   ```
 *   ...content (truncated to 50K chars)...
 *   ```"
 *
 * Was previously exported from chat.ts. Moves here because every path uses it.
 */
export function injectTextAttachments(question: string, attachments: ChatAttachment[]): string {
  const textAtts = attachments.filter((a) => a.type === 'text')
  if (textAtts.length === 0) return question
  const sections = textAtts
    .map((a) => `### ${a.name}\n\`\`\`\n${a.data.substring(0, 50000)}\n\`\`\``)
    .join('\n\n')
  return `${question}\n\n## Attached Files\n${sections}`
}

// ── runChatTurn ────────────────────────────────────────────────────────

export interface RunChatTurnArgs {
  /** System prompt for this turn. Per-kind today; could unify later. */
  systemPrompt: string
  /**
   * Already-assembled markdown context (whatever the kind's context-builder
   * produced). Wrapped into `userPromptTemplate` below — the runner doesn't
   * inspect it.
   */
  context: string
  /** The user's question, already trimmed. */
  question: string
  /** Optional attachments. Text attachments inlined; images forwarded. */
  attachments?: ChatAttachment[]
  /**
   * The wrapper template the kind expects. Each kind has slightly different
   * leading copy ("Here is the meeting information:" vs. "Here is the
   * available information about <Company>:"). Builders supply the prefix;
   * the runner appends the `\n\n---\n\nQuestion: <q>` (or `User question: <q>`)
   * trailer.
   *
   *   Final user prompt =
   *     `${userPromptPrefix}\n\n${context}\n\n---\n\n${trailer}`
   *
   * `trailer` is composed by the runner using `questionLabel` ("Question" or
   * "User question") and the (attachment-injected) question.
   */
  userPromptPrefix: string
  /**
   * "Question" or "User question" — preserves the existing per-kind wording
   * exactly. queryMeeting / queryAll / querySearchResults use "User question";
   * queryCompany / queryContact use "Question".
   */
  questionLabel: 'Question' | 'User question'
  /**
   * Optional copy appended AFTER the question (e.g. queryAll's
   * "Please answer based on..."). Inserted on a new line.
   */
  questionFooter?: string
}

/**
 * Runs one chat turn end-to-end: composes the prompt, installs an
 * AbortController, calls the provider, returns the assistant text.
 *
 * Throws whatever the provider throws (caller — typically the IPC handler
 * via `withChatPersistence` — surfaces it through to the renderer's
 * `useChatStreaming` error path).
 */
export async function runChatTurn(args: RunChatTurnArgs): Promise<string> {
  const enhancedQuestion = args.attachments?.length
    ? injectTextAttachments(args.question, args.attachments)
    : args.question
  const imageAtts = args.attachments?.filter((a) => a.type === 'image')

  const userPrompt =
    `${args.userPromptPrefix}\n\n${args.context}\n\n---\n\n${args.questionLabel}: ${enhancedQuestion}` +
    (args.questionFooter ? `\n\n${args.questionFooter}` : '')

  const startedAt = Date.now()
  console.info('[chat-dispatch] turn start', {
    systemPromptLen: args.systemPrompt.length,
    contextLen: args.context.length,
    questionLen: args.question.length,
    hasAttachments: (args.attachments?.length ?? 0) > 0,
  })

  const provider = getProvider('chat')
  activeController = new AbortController()
  try {
    const response = await provider.generateSummary(
      args.systemPrompt,
      userPrompt,
      sendProgress,
      activeController.signal,
      imageAtts
    )
    console.info('[chat-dispatch] turn end', {
      ms: Date.now() - startedAt,
      responseLen: response.length,
    })
    return response
  } finally {
    activeController = null
  }
}
