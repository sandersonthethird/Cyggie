// Cyggie chat agent — shared service.
//
// Extracted from api-gateway/src/routes/chat.ts in Slice 3 of the External
// Agents V1 plan. This module owns the LLM call boundary: model
// selection, max_tokens, and Anthropic client construction. The in-product
// chat route (chat.ts) and the future MCP-side cyggie_ask wrapper both
// call into the functions here so the model + caching config stay in one
// place.
//
// Slice 5 will extend these functions with tool_use loop semantics (max
// 8 iterations, per-tool 5s timeout, retry-once on Anthropic errors,
// 60s wall-clock cap). For Slice 3 the surface is minimal: identical
// behavior to the previous inline calls in chat.ts.

import Anthropic from '@anthropic-ai/sdk'

export const CHAT_MODEL = 'claude-sonnet-4-5-20250929'
export const CHAT_MAX_TOKENS = 2048

// Shared argument shape for both streaming and blocking Anthropic calls.
// `tools` is optional and reserved for Slice 5; passing it does not
// currently change behavior beyond surfacing tool_use blocks in the
// response (caller must implement the agent loop separately for now).
export interface RunAgentTurnArgs {
  apiKey: string
  messages: Anthropic.MessageParam[]
  systemPrompt: Anthropic.MessageCreateParams['system']
  tools?: Anthropic.Tool[]
  signal?: AbortSignal
  /**
   * Per-user model id (resolved by the caller from user_preferences via
   * resolveUserModel). Falls back to CHAT_MODEL when omitted.
   */
  model?: string
}

// Blocking call — returns the full Anthropic.Message once complete.
// Caller handles error mapping (toGatewayErrorIfAnthropic) and any
// downstream persistence.
export async function runAgentTurn(args: RunAgentTurnArgs): Promise<Anthropic.Message> {
  const client = new Anthropic({ apiKey: args.apiKey })
  return client.messages.create(
    buildCreateParams(args),
    args.signal ? { signal: args.signal } : undefined,
  )
}

// Streaming call — returns the Anthropic stream object. Caller iterates
// for text deltas and awaits stream.finalMessage() for usage telemetry.
// Caller handles abort/error paths and downstream SSE writing.
export function createAgentStream(args: RunAgentTurnArgs) {
  const client = new Anthropic({ apiKey: args.apiKey })
  return client.messages.stream(
    buildCreateParams(args),
    args.signal ? { signal: args.signal } : undefined,
  )
}

function buildCreateParams(args: RunAgentTurnArgs): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: args.model ?? CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    system: args.systemPrompt,
    messages: args.messages,
  }
  if (args.tools && args.tools.length > 0) {
    params.tools = args.tools
  }
  return params
}

// Re-exports so chat.ts and future cyggie_ask wrapper consumers can
// import everything from a single entrypoint.
export {
  BASE_CHAT_SYSTEM_PROMPT,
  buildChatSessionSystemSegments,
} from './system-prompts'

export {
  buildContextForSession,
  collectContextEntities,
  buildCompanyContextForChat,
  buildContactContextForChat,
  buildSelectedCompaniesContext,
  composeMeetingContextBlock,
} from './context-builders'
