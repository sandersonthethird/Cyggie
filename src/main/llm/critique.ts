import type { LLMProvider } from './provider'

const CRITIQUE_SYSTEM_PROMPT = `You are a veteran copy editor at a respected newspaper. You believe deeply in respecting the reader's time.

Rewrite the following text to be clearer and more concise. Your target is 500–800 words — never exceed 800 words. Cut unnecessary words. Prefer active voice. Make every sentence earn its place. Tighten lists — remove redundant bullets that restate the same point. Collapse verbose explanations into single sharp sentences. Preserve all factual content and important details but ruthlessly trim filler, redundancy, and meandering qualifiers.

Return only the improved text. Do not add commentary, preamble, or explain your edits. Match the original format (markdown, bullets, etc).`

export async function critiqueText(
  provider: LLMProvider,
  text: string,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return provider.generateSummary(CRITIQUE_SYSTEM_PROMPT, text, onProgress, signal)
}
