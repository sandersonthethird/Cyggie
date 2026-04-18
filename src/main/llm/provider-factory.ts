import type { LLMProvider } from './provider'
import { ClaudeProvider } from './claude-provider'
import { OllamaProvider } from './ollama-provider'
import { OpenAIProvider } from './openai-provider'
import { getCredential } from '../security/credentials'
import { getSetting } from '../database/repositories/settings.repo'
import type { LlmProvider } from '../../shared/types/settings'

export function getProvider(use: 'summary' | 'enrichment' | 'chat' = 'summary'): LLMProvider {
  const providerType = (getSetting('llmProvider') || 'claude') as LlmProvider

  if (providerType === 'ollama') {
    const host = getSetting('ollamaHost') || 'http://127.0.0.1:11434'
    const model = getSetting('ollamaModel') || 'llama3.1'
    return new OllamaProvider(model, host)
  }

  if (providerType === 'openai') {
    const apiKey = getCredential('openAiApiKey')
    if (!apiKey) throw new Error('OpenAI API key not configured. Go to Settings to add it.')
    const model =
      use === 'chat'
        ? getSetting('openAiChatModel') || 'gpt-4o'
        : use === 'enrichment'
          ? getSetting('openAiEnrichmentModel') || 'gpt-4o-mini'
          : getSetting('openAiSummaryModel') || 'gpt-4o'
    return new OpenAIProvider(apiKey, model)
  }

  // claude (default)
  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) throw new Error('Claude API key not configured. Go to Settings to add it.')
  const model =
    use === 'chat'
      ? getSetting('claudeChatModel') || 'claude-sonnet-4-5-20250929'
      : use === 'enrichment'
        ? getSetting('claudeEnrichmentModel') || 'claude-haiku-4-5-20251001'
        : getSetting('claudeSummaryModel') || 'claude-sonnet-4-5-20250929'
  return new ClaudeProvider(apiKey, model)
}
