import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { getAgentLimits, AGENT_LIMITS_DEFAULTS, AGENT_LIMITS_BOUNDS } from '@cyggie/services/llm/agents/limits'

const mockGet = vi.mocked(settingsRepo.getSetting)

describe('getAgentLimits', () => {
  beforeEach(() => mockGet.mockReset())

  it('returns defaults when no settings are configured', () => {
    mockGet.mockReturnValue(null)
    expect(getAgentLimits()).toEqual(AGENT_LIMITS_DEFAULTS)
  })

  it('uses configured values when within bounds', () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'agent.maxIterations') return '20'
      if (key === 'agent.maxWebSearches') return '8'
      if (key === 'agent.maxInputTokens') return '300000'
      return null
    })
    expect(getAgentLimits()).toEqual({ iterations: 20, webSearches: 8, inputTokens: 300_000 })
  })

  it('clamps values above the upper bound', () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'agent.maxIterations') return '999'
      if (key === 'agent.maxWebSearches') return '100'
      if (key === 'agent.maxInputTokens') return '99999999'
      return null
    })
    const limits = getAgentLimits()
    expect(limits.iterations).toBe(AGENT_LIMITS_BOUNDS.iterations.max)
    expect(limits.webSearches).toBe(AGENT_LIMITS_BOUNDS.webSearches.max)
    expect(limits.inputTokens).toBe(AGENT_LIMITS_BOUNDS.inputTokens.max)
  })

  it('clamps values below the lower bound', () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'agent.maxIterations') return '1'
      if (key === 'agent.maxWebSearches') return '-5'
      if (key === 'agent.maxInputTokens') return '1000'
      return null
    })
    const limits = getAgentLimits()
    expect(limits.iterations).toBe(AGENT_LIMITS_BOUNDS.iterations.min)
    expect(limits.webSearches).toBe(AGENT_LIMITS_BOUNDS.webSearches.min)
    expect(limits.inputTokens).toBe(AGENT_LIMITS_BOUNDS.inputTokens.min)
  })

  it('falls back to defaults on non-numeric values', () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'agent.maxIterations') return 'not-a-number'
      return null
    })
    expect(getAgentLimits().iterations).toBe(AGENT_LIMITS_DEFAULTS.iterations)
  })
})
