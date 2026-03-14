import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from './provider'
import type { ChatAttachment } from '../../shared/types/chat'

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
    const imageAtts = (attachments ?? []).filter((a) => a.type === 'image')
    if (imageAtts.length === 0) return userPrompt

    const blocks: Anthropic.ContentBlockParam[] = []
    for (const img of imageAtts) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: img.data
        }
      })
    }
    blocks.push({ type: 'text', text: userPrompt })
    return blocks
  }

  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    attachments?: ChatAttachment[]
  ): Promise<string> {
    const userContent = this.buildUserContent(userPrompt, attachments)

    if (onProgress) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
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
      messages: [{ role: 'user', content: userContent }]
    })

    const block = message.content[0]
    return block.type === 'text' ? block.text : ''
  }
}
