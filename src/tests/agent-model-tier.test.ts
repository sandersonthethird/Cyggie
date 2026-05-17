import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: vi.fn(),
}))

import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import {
  getAgentModelId,
  getCacheTtl,
  SONNET_MODEL_ID,
  HAIKU_MODEL_ID,
  EXTENDED_CACHE_TTL_BETA,
} from '../main/llm/agents/model-tier'

const mockGet = vi.mocked(settingsRepo.getSetting)

describe('getAgentModelId', () => {
  beforeEach(() => mockGet.mockReset())

  it('returns Sonnet when the setting is unset', () => {
    mockGet.mockReturnValue(null)
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
  })

  it('returns Haiku when agent.modelTier === "haiku"', () => {
    mockGet.mockImplementation((key) => (key === 'agent.modelTier' ? 'haiku' : null))
    expect(getAgentModelId()).toBe(HAIKU_MODEL_ID)
  })

  it('returns Sonnet when agent.modelTier === "sonnet" explicitly', () => {
    mockGet.mockImplementation((key) => (key === 'agent.modelTier' ? 'sonnet' : null))
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
  })

  it('falls back to Sonnet with a console.warn on unknown values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGet.mockImplementation((key) => (key === 'agent.modelTier' ? 'opus-9' : null))
    expect(getAgentModelId()).toBe(SONNET_MODEL_ID)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('opus-9'))
    warn.mockRestore()
  })
})

describe('getCacheTtl', () => {
  beforeEach(() => mockGet.mockReset())

  it('returns "5m" when the setting is unset', () => {
    mockGet.mockReturnValue(null)
    expect(getCacheTtl()).toBe('5m')
  })

  it('returns "5m" when agent.cacheTtl === "5m"', () => {
    mockGet.mockImplementation((key) => (key === 'agent.cacheTtl' ? '5m' : null))
    expect(getCacheTtl()).toBe('5m')
  })

  it('returns "1h" when agent.cacheTtl === "1h"', () => {
    mockGet.mockImplementation((key) => (key === 'agent.cacheTtl' ? '1h' : null))
    expect(getCacheTtl()).toBe('1h')
  })

  it('falls back to "5m" with a console.warn on unknown values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGet.mockImplementation((key) => (key === 'agent.cacheTtl' ? '2h' : null))
    expect(getCacheTtl()).toBe('5m')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2h'))
    warn.mockRestore()
  })
})

describe('exported constants', () => {
  it('exposes the correct model IDs', () => {
    expect(SONNET_MODEL_ID).toBe('claude-sonnet-4-5-20250929')
    expect(HAIKU_MODEL_ID).toBe('claude-haiku-4-5-20251001')
  })

  it('exposes the extended-cache-ttl beta header value', () => {
    expect(EXTENDED_CACHE_TTL_BETA).toBe('extended-cache-ttl-2025-04-11')
  })
})
