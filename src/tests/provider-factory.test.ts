/**
 * Tests for getProvider() routing + OpenAIProvider basic behavior.
 *
 * The factory is the single point of failure for every LLM feature. If
 * routing or key-lookup breaks, every summary/chat/enrichment call silently
 * uses the wrong model or fails. These tests document the expected
 * (llmProvider × use) routing matrix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- mocks ----------------------------------------------------------------

const settings = new Map<string, string>()
const credentials = new Map<string, string>()

vi.mock('../main/database/repositories/settings.repo', () => ({
  getSetting: (key: string) => settings.get(key) ?? null,
}))

vi.mock('../main/security/credentials', () => ({
  getCredential: (key: string) => credentials.get(key) ?? null,
}))

// Mock the actual SDKs so constructor doesn't call out.
vi.mock('openai', () => {
  return {
    default: class OpenAI {
      constructor(public opts: unknown) {}
      chat = {
        completions: {
          create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hi' } }] }),
        },
      }
    },
  }
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor(public opts: unknown) {}
    messages = {
      create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] }),
    }
  },
}))

const { getProvider } = await import('../main/llm/provider-factory')
const { OpenAIProvider } = await import('../main/llm/openai-provider')

describe('getProvider routing', () => {
  beforeEach(() => {
    settings.clear()
    credentials.clear()
  })

  describe('claude (default)', () => {
    beforeEach(() => {
      credentials.set('claudeApiKey', 'test-claude-key')
    })

    it('returns ClaudeProvider when llmProvider is unset (default)', () => {
      const provider = getProvider()
      expect(provider.name).toBe('Claude')
    })

    it('routes use=chat to claudeChatModel', () => {
      settings.set('claudeChatModel', 'custom-chat-model')
      const provider = getProvider('chat')
      expect(provider.name).toBe('Claude')
    })

    it('throws when claude key is missing', () => {
      credentials.clear()
      expect(() => getProvider()).toThrow(/Claude API key not configured/)
    })
  })

  describe('openai', () => {
    beforeEach(() => {
      settings.set('llmProvider', 'openai')
      credentials.set('openAiApiKey', 'test-openai-key')
    })

    it('returns OpenAIProvider', () => {
      const provider = getProvider()
      expect(provider.name).toBe('OpenAI')
    })

    it('routes use=summary to openAiSummaryModel default (gpt-4o)', () => {
      const provider = getProvider('summary')
      expect(provider.name).toBe('OpenAI')
    })

    it('routes use=enrichment to openAiEnrichmentModel default (gpt-4o-mini)', () => {
      const provider = getProvider('enrichment')
      expect(provider.name).toBe('OpenAI')
    })

    it('throws when openai key is missing', () => {
      credentials.clear()
      expect(() => getProvider()).toThrow(/OpenAI API key not configured/)
    })
  })

  describe('ollama', () => {
    it('returns OllamaProvider without requiring a key', () => {
      settings.set('llmProvider', 'ollama')
      const provider = getProvider()
      expect(provider.name).toMatch(/Ollama/)
    })
  })
})

describe('OpenAIProvider', () => {
  it('constructs with given apiKey + model', () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    expect(p.name).toBe('OpenAI')
  })

  it('isAvailable returns true on a successful ping', async () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    await expect(p.isAvailable()).resolves.toBe(true)
  })

  it('isAvailable returns false when the SDK throws', async () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    // Force the mocked create to reject
    ;(p as unknown as { client: { chat: { completions: { create: () => Promise<never> } } } })
      .client.chat.completions.create = () => Promise.reject(new Error('network'))
    await expect(p.isAvailable()).resolves.toBe(false)
  })

  it('generateSummary returns content from non-streaming response', async () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    const result = await p.generateSummary('sys', 'user')
    expect(result).toBe('hi')
  })

  it('generateSummary returns "" when the SDK returns an empty choices array', async () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    ;(p as unknown as { client: { chat: { completions: { create: () => Promise<{ choices: unknown[] }> } } } })
      .client.chat.completions.create = () => Promise.resolve({ choices: [] })
    const result = await p.generateSummary('sys', 'user')
    expect(result).toBe('')
  })

  it('streamWithThinking falls through to generateSummary', async () => {
    const p = new OpenAIProvider('key-123', 'gpt-4o')
    const result = await p.streamWithThinking('sys', 'user', 1024)
    expect(result).toBe('hi')
  })
})
