import { Ollama } from 'ollama'
import type { LLMProvider } from './provider'

export class OllamaProvider implements LLMProvider {
  name = 'Ollama (Local)'
  private client: Ollama

  constructor(
    private model: string = 'llama3.1',
    host: string = 'http://127.0.0.1:11434'
  ) {
    this.client = new Ollama({ host })
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.list()
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
      const response = await this.client.chat({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: true,
        options: { num_predict: 8192 }
      })

      let full = ''
      for await (const part of response) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        onProgress(part.message.content)
        full += part.message.content
      }
      return full
    }

    const response = await this.client.chat({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      options: { num_predict: 8192 }
    })

    return response.message.content
  }
}
