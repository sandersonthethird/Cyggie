// Cyggie chat agent — system prompt construction.
//
// Extracted from api-gateway/src/routes/chat.ts in Slice 3 of the External
// Agents V1 plan. The functions here are the single source of truth for the
// Cyggie chat persona and the prompt-cache wiring strategy. Both the
// in-product chat route AND future MCP callers (cyggie_ask wrapper)
// build their system prompts via this module.

import type Anthropic from '@anthropic-ai/sdk'

// Stable base system prompt — identical across every send, so Anthropic's
// prompt cache hits free after the first request per cache window.
export const BASE_CHAT_SYSTEM_PROMPT =
  'You are Cyggie, a helpful AI assistant for venture investors. ' +
  'You are inside an ongoing chat conversation; reference prior turns naturally. ' +
  'Be concise, direct, and concrete. Avoid hedging. ' +
  'If you do not know something, say so plainly.'

// Phase 2.5 — segmented system prompt with cache_control on the context
// segment. Anthropic's prompt-caching layer hashes prefix segments;
// marking the last segment with `cache_control: ephemeral` caches up
// to and including that segment (5-min TTL). Within a session where
// the user keeps the same company selection, the entire system prompt
// is cached after the first send → input cost ≈ 10% of base.
//
// Cache invalidates when the context block bytes change (e.g. user
// adds/removes a company, or the underlying meeting summary updates).
// One fresh send rebuilds the cache; subsequent sends hit again.
//
// cacheEnabled: per-chat user toggle. Default true preserves the cache
// behavior described above. When false, the context segment is emitted
// without `cache_control` so single-turn chats don't pay the 1.25×
// cache-write premium. See chat_sessions.cache_enabled (migration 103
// + Postgres 0020). The break-even is ~1.28 turns per session — below
// that, caching costs more than it saves.
//
// Returned array shape matches Anthropic's Message API:
//   - 1 segment when contextBlock is null (base prompt only)
//   - 2 segments when contextBlock is non-null (base + context, with or
//     without cache_control depending on cacheEnabled)
export function buildChatSessionSystemSegments(
  contextBlock: string | null,
  cacheEnabled = true,
): Anthropic.MessageCreateParams['system'] {
  if (!contextBlock) {
    return [{ type: 'text', text: BASE_CHAT_SYSTEM_PROMPT }]
  }
  const contextSegment: Anthropic.TextBlockParam = {
    type: 'text',
    text: `\n\nGround your answers in the following context when relevant.\n\n${contextBlock}`,
  }
  if (cacheEnabled) {
    contextSegment.cache_control = { type: 'ephemeral' }
  }
  return [
    { type: 'text', text: BASE_CHAT_SYSTEM_PROMPT },
    contextSegment,
  ]
}
