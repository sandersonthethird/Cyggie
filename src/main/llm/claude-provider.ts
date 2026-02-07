import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from './provider'

export class ClaudeProvider implements LLMProvider {
  name = 'Claude'
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
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
    onProgress?: (chunk: string) => void
  ): Promise<string> {
    if (onProgress) {
      const stream = this.client.messages.stream({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })

      stream.on('text', (text) => onProgress(text))

      const finalMessage = await stream.finalMessage()
      const block = finalMessage.content[0]
      return block.type === 'text' ? block.text : ''
    }

    const message = await this.client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const block = message.content[0]
    return block.type === 'text' ? block.text : ''
  }
}
