export interface LLMProvider {
  name: string
  isAvailable(): Promise<boolean>
  generateSummary(
    systemPrompt: string,
    userPrompt: string,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string>
}
