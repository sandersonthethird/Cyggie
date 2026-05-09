import { vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  Message,
  ToolUseBlock,
  TextBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages'

/**
 * Test helpers for scripting Anthropic responses inside agent-loop tests.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  Typical use:                                                    │
 *   │                                                                  │
 *   │    const create = scriptedMessagesCreate([                       │
 *   │      buildToolUseResponse({ toolCalls: [{ name: 'list_meetings',│
 *   │        id: 'tu1', input: {} }] }),                                │
 *   │      buildFinalToolCallResponse({                                │
 *   │        toolName: 'submit_memo',                                   │
 *   │        toolUseId: 'tu99',                                         │
 *   │        toolInput: { markdown: '# Memo', evidence: [] },          │
 *   │      }),                                                          │
 *   │    ])                                                             │
 *   │    const client = { messages: { create } } as unknown as          │
 *   │      Anthropic                                                    │
 *   │    await runAgentLoop({ client, ... })                            │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Helpers return strongly-typed `Message` objects matching the SDK shape, so
 * downstream code that pattern-matches on `content[i].type` works correctly.
 *
 * `usage` defaults are realistic mid-run numbers; pass overrides for caps tests.
 */

const DEFAULT_USAGE: Usage = {
  input_tokens: 5000,
  output_tokens: 200,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  service_tier: null,
  server_tool_use: null,
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

let messageIdCounter = 0
function nextMessageId(): string {
  messageIdCounter += 1
  return `msg_test_${messageIdCounter}`
}

interface BuildToolUseArgs {
  toolCalls: Array<{ id: string; name: string; input: unknown }>
  thinkingText?: string                         // optional preceding text block
  usage?: Partial<Usage>
  model?: string
}

/**
 * Build a Message with stop_reason='tool_use' and the given tool calls.
 * Optionally prepend a text block to simulate the model's thinking.
 */
export function buildToolUseResponse(args: BuildToolUseArgs): Message {
  const content: Array<TextBlock | ToolUseBlock> = []
  if (args.thinkingText) {
    content.push({
      type: 'text',
      text: args.thinkingText,
      citations: null,
    } as TextBlock)
  }
  for (const tc of args.toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    } as ToolUseBlock)
  }
  return {
    id: nextMessageId(),
    type: 'message',
    role: 'assistant',
    model: args.model ?? DEFAULT_MODEL,
    content: content as Message['content'],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { ...DEFAULT_USAGE, ...(args.usage ?? {}) },
    container: null,
    context_management: null,
  } as Message
}

interface BuildFinalToolCallArgs {
  toolName: string                              // typically 'submit_memo'
  toolUseId: string
  toolInput: unknown
  thinkingText?: string
  usage?: Partial<Usage>
  model?: string
}

/**
 * Build a Message representing the agent's terminal tool call. By the
 * "submit_memo as terminal tool" design, the agent's stop condition is a tool
 * use of the configured terminal tool name; the SDK still returns
 * stop_reason='tool_use' for this. The agent loop checks the tool name to
 * decide it's done.
 */
export function buildFinalToolCallResponse(args: BuildFinalToolCallArgs): Message {
  return buildToolUseResponse({
    toolCalls: [{ id: args.toolUseId, name: args.toolName, input: args.toolInput }],
    thinkingText: args.thinkingText,
    usage: args.usage,
    model: args.model,
  })
}

interface BuildFinalTextArgs {
  text: string
  usage?: Partial<Usage>
  model?: string
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence'
}

/**
 * Build a Message with stop_reason='end_turn' (or 'max_tokens') and a single
 * text block. Useful for testing: agent finished without calling the terminal
 * tool (failure case), or agent ran out of output tokens mid-tool-use.
 */
export function buildFinalTextResponse(args: BuildFinalTextArgs): Message {
  return {
    id: nextMessageId(),
    type: 'message',
    role: 'assistant',
    model: args.model ?? DEFAULT_MODEL,
    content: [{ type: 'text', text: args.text, citations: null } as TextBlock] as Message['content'],
    stop_reason: args.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: { ...DEFAULT_USAGE, ...(args.usage ?? {}) },
    container: null,
    context_management: null,
  } as Message
}

interface BuildErrorArgs {
  status: number
  retryAfter?: string                           // value of Retry-After header for 429
  message?: string
}

/**
 * Build a thrown Anthropic-shaped error. The Anthropic SDK throws subclasses
 * of `Anthropic.APIError` whose `.status` is the HTTP status. For our retry
 * tests we just need an object with a `.status` property and (for 429) a
 * `.headers['retry-after']` value.
 */
export function buildAnthropicError(args: BuildErrorArgs): Error {
  const err = new Error(args.message ?? `Anthropic API error: ${args.status}`)
  // Mimic Anthropic.APIError surface
  ;(err as Error & { status: number }).status = args.status
  ;(err as Error & { headers: Record<string, string> }).headers = args.retryAfter
    ? { 'retry-after': args.retryAfter }
    : {}
  err.name = args.status === 429 ? 'RateLimitError' : args.status >= 500 ? 'APIError' : 'APIError'
  return err
}

/**
 * Build an authentication error (401). Used to verify the agent loop fails
 * fast (no retry) when the API key is missing/invalid.
 */
export function buildAuthError(): Error {
  const err = new Error('authentication_error: invalid x-api-key')
  ;(err as Error & { status: number }).status = 401
  err.name = 'AuthenticationError'
  return err
}

interface ScriptItem {
  /** A Message to return on this call, OR an Error to throw. */
  response?: Message
  error?: Error
}

/**
 * Build a `messages.create`-shaped vi.fn() that consumes the script in order.
 * Each call pops the next item; a script item with `response` resolves with
 * that Message; one with `error` rejects with that error.
 *
 * Throws if the script is exhausted — surfaces tests that loop more than expected.
 */
export function scriptedMessagesCreate(
  script: Array<Message | Error>,
): ReturnType<typeof vi.fn> {
  const items: ScriptItem[] = script.map(s =>
    s instanceof Error ? { error: s } : { response: s },
  )
  let i = 0
  return vi.fn(async () => {
    if (i >= items.length) {
      throw new Error(`anthropic-mocks: script exhausted after ${items.length} calls`)
    }
    const item = items[i++]
    if (item.error) throw item.error
    return item.response!
  })
}

/**
 * Convenience: build a fake Anthropic client whose `messages.create` runs
 * the supplied script. Returns the typed client for direct injection.
 */
export function buildScriptedClient(script: Array<Message | Error>): Anthropic {
  const create = scriptedMessagesCreate(script)
  return { messages: { create } } as unknown as Anthropic
}

/** Reset internal counters so tests don't leak ids across each other. */
export function resetMockIds(): void {
  messageIdCounter = 0
}
