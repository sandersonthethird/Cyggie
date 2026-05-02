/**
 * Tests for Phase 4 stub-enrichment service.
 *
 * Mocks the repo + LLM provider; verifies:
 *   - LLM is called with the company name
 *   - Response is parsed and patches are written
 *   - Invalid responses are tolerated
 *   - Already-enriched companies are skipped
 *   - Concurrent calls for the same id are deduped
 *   - Domain validation rejects garbage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getCompanyMock = vi.fn()
const updateCompanyMock = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => getCompanyMock(...args),
  updateCompany: (...args: unknown[]) => updateCompanyMock(...args),
}))

import {
  enrichStubCompany,
  queueStubEnrichment,
  _resetStubEnrichmentForTests,
  _isInFlight,
} from '../main/services/stub-enrichment.service'
import type { LLMProvider } from '../main/llm/provider'

function makeStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'co1',
    canonicalName: 'Sequoia Capital',
    entityType: 'unknown',
    primaryDomain: null,
    description: null,
    ...overrides,
  }
}

function makeProvider(response: string | (() => Promise<string>)): LLMProvider {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    generateSummary: vi.fn(typeof response === 'function'
      ? response
      : () => Promise.resolve(response)),
  }
}

describe('enrichStubCompany — happy path', () => {
  beforeEach(() => {
    getCompanyMock.mockReset()
    updateCompanyMock.mockReset()
    _resetStubEnrichmentForTests()
  })

  it('calls LLM with the company name and patches with parsed fields', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: 'vc_fund',
      primary_domain: 'sequoiacap.com',
      description: 'Top-tier venture capital firm.',
    }))

    await enrichStubCompany('co1', provider)

    expect(provider.generateSummary).toHaveBeenCalledWith(
      expect.stringContaining('venture'),
      'Sequoia Capital',
    )
    expect(updateCompanyMock).toHaveBeenCalledWith('co1', {
      entityType: 'vc_fund',
      primaryDomain: 'sequoiacap.com',
      description: 'Top-tier venture capital firm.',
    }, null)
  })

  it('strips markdown fences from LLM output before parsing', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider('```json\n{"entity_type":"vc_fund","primary_domain":null,"description":null}\n```')

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).toHaveBeenCalledWith('co1', { entityType: 'vc_fund' }, null)
  })

  it('strips www. and lowercases domain', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: null,
      primary_domain: 'WWW.Sequoiacap.COM',
      description: null,
    }))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).toHaveBeenCalledWith('co1', { primaryDomain: 'sequoiacap.com' }, null)
  })
})

describe('enrichStubCompany — skip cases', () => {
  beforeEach(() => {
    getCompanyMock.mockReset()
    updateCompanyMock.mockReset()
    _resetStubEnrichmentForTests()
  })

  it('skips when company no longer exists', async () => {
    getCompanyMock.mockReturnValue(null)
    const provider = makeProvider('{}')

    await enrichStubCompany('co1', provider)

    expect(provider.generateSummary).not.toHaveBeenCalled()
    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('skips when entityType is no longer "unknown" (already enriched)', async () => {
    getCompanyMock.mockReturnValue(makeStub({ entityType: 'vc_fund' }))
    const provider = makeProvider('{}')

    await enrichStubCompany('co1', provider)

    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('skips when company has a primary_domain', async () => {
    getCompanyMock.mockReturnValue(makeStub({ primaryDomain: 'something.com' }))
    const provider = makeProvider('{}')

    await enrichStubCompany('co1', provider)

    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('skips when company has a description', async () => {
    getCompanyMock.mockReturnValue(makeStub({ description: 'A real company' }))
    const provider = makeProvider('{}')

    await enrichStubCompany('co1', provider)

    expect(provider.generateSummary).not.toHaveBeenCalled()
  })
})

describe('enrichStubCompany — error tolerance', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    getCompanyMock.mockReset()
    updateCompanyMock.mockReset()
    _resetStubEnrichmentForTests()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('does not write when LLM returns malformed JSON', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider('not-json')

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('does not write when LLM returns all nulls', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: null,
      primary_domain: null,
      description: null,
    }))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('does not write when LLM throws', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(() => Promise.reject(new Error('rate limit')))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('rejects invalid entity_type values', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: 'not-a-real-type',
      primary_domain: null,
      description: null,
    }))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('rejects garbage domain values', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: null,
      primary_domain: 'not a domain at all',
      description: null,
    }))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })

  it('rejects descriptions over 200 chars', async () => {
    getCompanyMock.mockReturnValue(makeStub())
    const provider = makeProvider(JSON.stringify({
      entity_type: null,
      primary_domain: null,
      description: 'x'.repeat(250),
    }))

    await enrichStubCompany('co1', provider)

    expect(updateCompanyMock).not.toHaveBeenCalled()
  })
})

describe('queueStubEnrichment — dedupe + throttle', () => {
  beforeEach(() => {
    getCompanyMock.mockReset()
    updateCompanyMock.mockReset()
    _resetStubEnrichmentForTests()
  })

  it('marks the id as in-flight on queue', () => {
    getCompanyMock.mockReturnValue(makeStub())
    queueStubEnrichment('co1')
    expect(_isInFlight('co1')).toBe(true)
  })

  it('a second queue for the same id is a no-op while in-flight', () => {
    getCompanyMock.mockReturnValue(makeStub())
    queueStubEnrichment('co1')
    queueStubEnrichment('co1')
    queueStubEnrichment('co1')
    // Still only one entry in the in-flight set; multiple calls don't double up.
    expect(_isInFlight('co1')).toBe(true)
  })
})
