// GatewayClaudeProvider — a minimal LLMProvider over the Anthropic SDK so the gateway
// can drive the SHARED resolveCompanyName (packages/services meeting-enrichment/name.ts),
// the same one desktop uses. resolveCompanyName only calls generateSummary; the rest of
// the interface is satisfied minimally (streamWithThinking degrades to generateSummary,
// which name resolution never needs).
//
// Errors are NOT mapped/rethrown here on purpose: resolveCompanyName wraps the LLM call
// in its own try/catch and degrades to the domain heuristic, so a transient Anthropic
// failure just yields a heuristic name instead of crashing the sweep.

import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider } from '@cyggie/services/llm/provider'

// Cheap model — name resolution is a one-line "what's the brand name for this domain".
export const GATEWAY_ENRICHMENT_MODEL = 'claude-haiku-4-5-20251001'

export function makeGatewayClaudeProvider(apiKey: string, model = GATEWAY_ENRICHMENT_MODEL): LLMProvider {
  const client = new Anthropic({ apiKey })

  const generateSummary: LLMProvider['generateSummary'] = async (systemPrompt, userPrompt) => {
    const result = await client.messages.create({
      model,
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    return result.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
  }

  return {
    name: 'gateway-claude',
    isAvailable: async () => true,
    generateSummary,
    // No native extended thinking on this path — pass through.
    streamWithThinking: (systemPrompt, userPrompt) => generateSummary(systemPrompt, userPrompt),
  }
}
