import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getAgentModelId() reads settings via this module — mock it so each test can
// control the stored (key → value) pairs.
const settings = new Map<string, string>()
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: (key: string): string | undefined => settings.get(key),
}))

import { getAgentModelId, getAgentPricing, SONNET_MODEL_ID, HAIKU_MODEL_ID } from './model-tier'
import { getPricingForModel } from '@shared/constants/claude-models'

describe('getAgentModelId', () => {
  beforeEach(() => settings.clear())
  afterEach(() => vi.restoreAllMocks())

  it('returns the agent.model value when it is a known model id', () => {
    settings.set('agent.model', 'claude-opus-4-6')
    expect(getAgentModelId()).toBe('claude-opus-4-6')
  })

  it('warns and falls back to Sonnet when agent.model is an unknown id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    settings.set('agent.model', 'gpt-4o')
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('honors the legacy agent.modelTier=haiku when agent.model is unset', () => {
    settings.set('agent.modelTier', 'haiku')
    expect(getAgentModelId()).toBe(HAIKU_MODEL_ID)
  })

  it('honors the legacy agent.modelTier=sonnet when agent.model is unset', () => {
    settings.set('agent.modelTier', 'sonnet')
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
  })

  it('prefers agent.model over a legacy agent.modelTier', () => {
    settings.set('agent.modelTier', 'haiku')
    settings.set('agent.model', 'claude-sonnet-4-6')
    expect(getAgentModelId()).toBe('claude-sonnet-4-6')
  })

  it('defaults to Sonnet when nothing is set', () => {
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
  })

  it('warns and defaults to Sonnet on an unknown legacy tier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    settings.set('agent.modelTier', 'opus')
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('getAgentPricing', () => {
  beforeEach(() => settings.clear())
  afterEach(() => vi.restoreAllMocks())

  it('returns pricing for the selected model', () => {
    settings.set('agent.model', HAIKU_MODEL_ID)
    expect(getAgentPricing()).toEqual(getPricingForModel(HAIKU_MODEL_ID))
  })

  it('defaults to Sonnet pricing when nothing is set', () => {
    expect(getAgentPricing()).toEqual(getPricingForModel(SONNET_MODEL_ID))
  })

  it('honors the legacy haiku tier', () => {
    settings.set('agent.modelTier', 'haiku')
    expect(getAgentPricing()).toEqual(getPricingForModel(HAIKU_MODEL_ID))
  })
})
