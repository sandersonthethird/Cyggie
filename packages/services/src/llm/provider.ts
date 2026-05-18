import type { ChatAttachment } from '@shared/types/chat'

export interface LLMProvider {
  name: string
  isAvailable(): Promise<boolean>
  generateSummary(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    attachments?: ChatAttachment[]
  ): Promise<string>
  /**
   * Same shape as generateSummary, but enables Anthropic extended thinking
   * via the `thinking` request param. Thinking blocks are discarded — only
   * the model's `text` content is returned/streamed. Used by the memo
   * producer agent for synthesis sections.
   *
   * Providers without native extended thinking (OpenAI, Ollama) implement
   * this as a pass-through to generateSummary — the prompt-level `<thinking>`
   * block instruction in the system prompt still applies, so output quality
   * degrades gracefully rather than breaking.
   */
  streamWithThinking(
    systemPrompt: string,
    userPrompt: string,
    thinkingBudgetTokens: number,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    attachments?: ChatAttachment[]
  ): Promise<string>
}
