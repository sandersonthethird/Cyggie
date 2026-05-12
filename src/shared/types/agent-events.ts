/**
 * Typed event stream emitted by the multi-turn agent loop.
 *
 * The agent emits these events at each turn boundary (and inside, for tool
 * calls). The IPC handler broadcasts them over the `THESIS_STRESS_TEST_PROGRESS`
 * channel to all renderer windows. The renderer's `RunsContext` accumulates
 * them per `runId` and feeds them to `ResearchLog` for streaming display.
 *
 * The discriminated union is the wire format — both shapes are JSON-serializable.
 * Adding a new event type: add a branch to this union, handle it in the agent
 * loop's emit calls, and add a renderer-side handler in `RunsContext`.
 *
 * NOTE: keep payloads compact. Each event is also written to `agent_run_events`
 * via run-store; very large payloads bloat that table.
 */

export type AgentRunMode = 'cold' | 'refine' | 'stress_test'

export type AgentEvent =
  | {
      type: 'started'
      runId: string
      kind: string                  // e.g. 'thesis_stress_test'
      companyId: string
      mode: AgentRunMode
      caps: { iterations: number; webSearches: number; inputTokens: number }
    }
  | {
      type: 'iteration_start'
      runId: string
      n: number
    }
  | {
      type: 'thinking'
      runId: string
      text: string                  // truncated to ~500 chars for transport
    }
  | {
      type: 'tool_call'
      runId: string
      toolUseId: string
      name: string
      input: unknown                // already-validated input
    }
  | {
      type: 'tool_result_summary'
      runId: string
      toolUseId: string
      summary: string               // 1-line "Read meeting: Series A pitch (Apr 12) → 2,400 words"
      bytes: number
      truncated: boolean
      ms: number
    }
  | {
      type: 'tool_error'
      runId: string
      toolUseId: string
      message: string
    }
  | {
      type: 'final_text_chunk'
      runId: string
      text: string                  // streamed memo content as the submit_memo tool call lands
    }
  | {
      type: 'cap_exceeded'
      runId: string
      cap: 'iterations' | 'web_searches' | 'input_tokens' | 'output_tokens'
      limit: number
      used: number
    }
  | {
      type: 'done'
      runId: string
      versionId: string
      durationMs: number
      inputTokens: number
      outputTokens: number
      costEstimateUsd: number
      toolCallCount: number
    }
  | {
      type: 'error'
      runId: string
      errorClass: string            // e.g. 'AnthropicAPIError', 'AbortError'
      message: string
    }
  | {
      type: 'aborted'
      runId: string
    }
  | {
      // Emitted by the memo producer agent when it begins working on a
      // section. The renderer surfaces this in CompanyMemo's section
      // skeleton, switching that section to "in progress" state.
      type: 'section_started'
      runId: string
      heading: string
      ordinal: number
    }
  | {
      // Emitted when the memo producer agent's submit_section tool fires.
      // The renderer fills that section's body in place.
      type: 'section_completed'
      runId: string
      heading: string
      bodyLength: number
    }

export type AgentEventByType = {
  [T in AgentEvent['type']]: Extract<AgentEvent, { type: T }>
}
