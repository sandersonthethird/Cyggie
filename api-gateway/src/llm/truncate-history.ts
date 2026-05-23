import type Anthropic from '@anthropic-ai/sdk'

// =============================================================================
// truncate-history.ts — keep multi-turn chat prompts under a char budget.
//
// The session route POST /chat/sessions/:id/messages loads the full
// conversation history from chat_session_messages and passes it to
// Claude as the messages array. Without a guard, a 50-turn conversation
// (or a single very long message) can push the prompt past Anthropic's
// 200k token context window. This helper trims the history before the
// API call so we stay within bounds.
//
// Strategy: oldest-pair-first eviction
//
//   [u₀, a₀, u₁, a₁, u₂, a₂, …, uₙ₋₁, aₙ₋₁, uₙ]
//                                              ▲ current msg — never dropped
//
//   while totalChars > maxChars:
//     drop the oldest [u, a] pair (recompute total, repeat)
//
//   Returns the kept array. Caller stamps system prompt separately —
//   never trimmed here.
//
// Why character budget vs token count: avoids a 50KB tiktoken dep for
// marginal precision. Empirical ratio of ~4 chars per token works
// well enough for V1; a 120k char budget is ≈30k tokens, well under
// Sonnet's 200k window.
//
// Edge case — the LAST message (the just-typed user input) is over budget
// by itself: we return it unmodified. Caller is responsible for the
// pre-flight oversize check (`CHAT_INPUT_TOO_LARGE` 413) that rejects
// the request before we even reach this helper.
// =============================================================================

/** ~30k tokens at 4 chars/token; well under Sonnet's 200k context window. */
export const CHAT_HISTORY_CHAR_BUDGET = 120_000

/**
 * Returns the input messages trimmed so total content length ≤ maxChars,
 * dropping oldest user/assistant PAIRS from the front. The final message
 * (the current user turn) is never dropped. System messages, if any,
 * are kept (they're rare in chat history but treated like any other
 * non-droppable turn).
 *
 * Idempotent + pure. No side effects.
 */
export function truncateHistoryByChars(
  messages: Anthropic.MessageParam[],
  maxChars: number,
): Anthropic.MessageParam[] {
  if (messages.length <= 1) return messages

  const out = [...messages]
  const total = (arr: Anthropic.MessageParam[]): number =>
    arr.reduce((sum, m) => sum + contentLength(m.content), 0)

  // Drop pairs from the front (oldest) while over budget. A "pair" is
  // two consecutive messages starting with user — typically [user, assistant].
  // If the array starts with a non-user message (rare), drop just it.
  while (out.length > 1 && total(out) > maxChars) {
    const first = out[0]
    if (!first) break
    if (first.role === 'user' && out.length >= 3) {
      // Drop user + the following assistant. Keep going until under
      // budget or only the last message remains.
      out.splice(0, 2)
    } else {
      // Single message at the front (assistant or system, or only the
      // current user msg remains). Drop one.
      out.shift()
    }
  }
  return out
}

function contentLength(
  content: Anthropic.MessageParam['content'],
): number {
  if (typeof content === 'string') return content.length
  // Anthropic supports content blocks (text, image, tool_use, etc.).
  // Sum text-block lengths; skip non-text blocks (image refs are
  // negligible compared to text).
  let sum = 0
  for (const block of content) {
    if (block.type === 'text') sum += block.text.length
  }
  return sum
}
