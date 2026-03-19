import OpenAI from 'openai'
import type { LLMProvider } from './provider'

export class OpenAIProvider implements LLMProvider {
  name = 'OpenAI'
  private client: OpenAI
  private model: string

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey })
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 1,
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
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: userPrompt })

    if (onProgress) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 8192,
        messages,
        stream: true
      })

      let result = ''
      for await (const chunk of stream) {
        if (signal?.aborted) break
        const text = chunk.choices[0]?.delta?.content || ''
        if (text) {
          result += text
          onProgress(text)
        }
      }
      return result
    }

    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages,
      ...(signal ? { signal } : {})
    })
    return res.choices[0]?.message?.content || ''
  }
}
