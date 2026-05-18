// Progress sink — sends streaming LLM events to whichever transport the
// CURRENT context expects. Replaces the desktop's BrowserWindow broadcast
// pattern with an AsyncLocalStorage-based context injection so the same
// service code runs unmodified on desktop (IpcProgressSink) and gateway
// (SseProgressSink). Per plan-eng-review §1.4 + plan-ceo-review §LLM streaming.
//
//   USAGE
//   ─────
//   Caller:
//     await withProgressSink(sink, async () => {
//       await runChatTurn(...)   // internally calls sendProgress(...)
//     })
//
//   Service code (e.g. chat-runner, summarizer):
//     sendProgress('partial text…')        — stream chunk
//     sendClear()                          — clear streaming UI state
//     sendPhase('drafting key takeaways')  — phase label
//
//   If no sink is in scope (which happens during tests or background tasks),
//   the calls are silent no-ops.
//
//   PROPAGATION
//   ───────────
//   ALS context propagates across `await` boundaries automatically. The
//   contract test `packages/services/src/llm/progress.test.ts` (Phase 0.5
//   acceptance) verifies it survives Anthropic SDK's `messages.stream()`
//   and `messages.create()` paths plus nested service calls.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProgressSink {
  /** A partial chunk of streaming text from an LLM. */
  onChunk(text: string): void
  /** Clear any visible streaming state (typically when streaming completes). */
  onClear?(): void
  /** Coarse-grained phase label, e.g. "drafting key takeaways". */
  onPhase?(phase: string): void
}

const als = new AsyncLocalStorage<ProgressSink>()

/**
 * Run `fn` with `sink` available to every `sendProgress` / `sendClear` /
 * `sendPhase` call in its dynamic extent (including across awaits). Nests
 * cleanly — inner `withProgressSink` shadows the outer for its scope only.
 */
export function withProgressSink<T>(sink: ProgressSink, fn: () => Promise<T>): Promise<T> {
  return als.run(sink, fn)
}

/** Send a streaming chunk to the current sink (no-op if none in scope). */
export function sendProgress(text: string): void {
  als.getStore()?.onChunk(text)
}

/** Tell the current sink to clear its streaming UI state (no-op if none). */
export function sendClear(): void {
  als.getStore()?.onClear?.()
}

/** Surface a coarse-grained phase label (no-op if none). */
export function sendPhase(phase: string): void {
  als.getStore()?.onPhase?.(phase)
}

/**
 * For introspection in tests. Don't use in production code — prefer the
 * `with*` wrappers + `send*` calls.
 */
export function currentProgressSink(): ProgressSink | undefined {
  return als.getStore()
}
