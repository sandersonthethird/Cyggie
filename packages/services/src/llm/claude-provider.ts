import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from './provider'
import type { ChatAttachment } from '@shared/types/chat'

export class ClaudeProvider implements LLMProvider {
  name = 'Claude'
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model = 'claude-sonnet-4-5-20250929') {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      })
      return true
    } catch {
      return false
    }
  }

  private buildUserContent(
    userPrompt: string,
    attachments?: ChatAttachment[]
  ): Anthropic.MessageParam['content'] {
    const atts = (attachments ?? []).filter((a) => a.type === 'image' || a.type === 'pdf')
    if (atts.length === 0) return userPrompt

    const blocks: Anthropic.ContentBlockParam[] = []
    for (const att of atts) {
      if (att.type === 'pdf') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data } } as any)
      } else {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: att.data
          }
        })
      }
    }
    blocks.push({ type: 'text', text: userPrompt })
    return blocks
  }

  /**
   * Builds the messages.stream request payload. Centralizes the shared
   * construction so generateSummary and streamWithThinking don't duplicate
   * the model/max_tokens/system/messages wiring.
   *
   * `thinking`, when supplied, enables Anthropic extended thinking. The
   * caller is responsible for ignoring the `thinking_delta` events and
   * keeping only `text` blocks from finalMessage.
   */
  private buildStreamRequest(args: {
    systemPrompt: string
    userPrompt: string
    attachments?: ChatAttachment[]
    thinking?: { type: 'enabled'; budget_tokens: number }
  }): Anthropic.MessageStreamParams {
    const userContent = this.buildUserContent(args.userPrompt, args.attachments)
    const req: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: 8192,
      system: args.systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }
    if (args.thinking) {
      // The Anthropic SDK types extended thinking under message params.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(req as any).thinking = args.thinking
    }
    return req
  }

  /**
   * Drives a stream to completion. Forwards text deltas to onProgress and
   * returns the concatenated text from the final message's `text` blocks
   * (skipping any `thinking` blocks). Abort plumbing identical for both
   * streaming methods.
   */
  private async runStream(
    stream: ReturnType<Anthropic['messages']['stream']>,
    onProgress: ((chunk: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (signal) {
      const onAbort = () => stream.abort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (onProgress) {
      stream.on('text', (text) => onProgress(text))
    }
    const finalMessage = await stream.finalMessage()
    // Concatenate all `text` content blocks; ignore `thinking` blocks.
    return finalMessage.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
  }

  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    attachments?: ChatAttachment[]
  ): Promise<string> {
    if (onProgress) {
      const stream = this.client.messages.stream(
        this.buildStreamRequest({ systemPrompt, userPrompt, attachments })
      )
      return this.runStream(stream, onProgress, signal)
    }

    const userContent = this.buildUserContent(userPrompt, attachments)
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })

    const block = message.content[0]
    return block.type === 'text' ? block.text : ''
  }

  async streamWithThinking(
    systemPrompt: string,
    userPrompt: string,
    thinkingBudgetTokens: number,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    attachments?: ChatAttachment[]
  ): Promise<string> {
    // Anthropic requires budget_tokens >= 1024 when thinking is enabled.
    const budget = Math.max(1024, thinkingBudgetTokens)
    const stream = this.client.messages.stream(
      this.buildStreamRequest({
        systemPrompt,
        userPrompt,
        attachments,
        thinking: { type: 'enabled', budget_tokens: budget },
      })
    )
    return this.runStream(stream, onProgress, signal)
  }
}
