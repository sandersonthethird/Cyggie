import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from './provider'

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

  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (onProgress) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })

      if (signal) {
        const onAbort = () => stream.abort()
        signal.addEventListener('abort', onAbort, { once: true })
      }

      stream.on('text', (text) => onProgress(text))

      const finalMessage = await stream.finalMessage()
      const block = finalMessage.content[0]
      return block.type === 'text' ? block.text : ''
    }

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const block = message.content[0]
    return block.type === 'text' ? block.text : ''
  }
}
