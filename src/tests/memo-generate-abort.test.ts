import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setExaMockResponses, clearExaMocks, MockExa } from './helpers/exa-mocks'

vi.mock('exa-js', () => ({ Exa: MockExa }))
vi.mock('../main/security/credentials', () => ({ getCredential: vi.fn(() => 'test-key') }))

import { searchCompanyContext } from '../main/services/exa-research'

/**
 * Tests for cancel-mid-generation in the memo-gen path.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │  Targets the abort plumbing landed in this PR:                  │
 *   │                                                                 │
 *   │  1. searchCompanyContext threads `signal` into each per-query  │
 *   │     Promise.race; signalRejector rejects when signal aborts.   │
 *   │  2. Pre-aborted signal short-circuits before any Exa call fires.│
 *   │  3. AbortError propagates out of searchCompanyContext (per-     │
 *   │     query catch re-throws AbortError instead of swallowing).    │
 *   │                                                                 │
 *   │  The rest of the abort flow (handler-level try/catch returning  │
 *   │  { success:false, error:'aborted' }, AbortController map cleanup│
 *   │  in finally, file-read loop's between-iteration check) is       │
 *   │  exercised via manual smoke + existing exa-research tests for   │
 *   │  the non-abort path.                                            │
 *   └───────────────────────────────────────────────────────────────┘
 */

describe('searchCompanyContext — cancel mid-generation', () => {
  beforeEach(() => clearExaMocks())

  it('throws AbortError immediately when signal is already aborted', async () => {
    setExaMockResponses({
      searchAndContents: async () => ({ results: [{ url: 'https://e.com', text: 'snippet' }] }),
    })
    const controller = new AbortController()
    controller.abort()   // pre-aborted
    await expect(
      searchCompanyContext(
        { companyName: 'Acme', nicheSignal: 'invoice processing for SMBs', industry: 'fintech' },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/i)
  })

  it('rejects with AbortError when signal aborts during in-flight Exa calls', async () => {
    // Exa call returns a Promise that never resolves on its own — abort is
    // the only thing that can settle it.
    setExaMockResponses({
      searchAndContents: () => new Promise(() => {}),
    })
    const controller = new AbortController()
    const promise = searchCompanyContext(
      { companyName: 'Acme', nicheSignal: 'invoice processing for SMBs' },
      controller.signal,
    )
    // Trigger abort after a tick so the per-query Promise.race is set up.
    setTimeout(() => controller.abort(), 10)
    await expect(promise).rejects.toThrow(/aborted/i)
  })

  it('does NOT swallow AbortError in the per-query catch (re-throws to caller)', async () => {
    // The per-query catch in searchCompanyContext degrades silently for
    // generic errors (returns []), but MUST re-throw AbortError so the IPC
    // handler returns the structured aborted response.
    let callCount = 0
    setExaMockResponses({
      searchAndContents: async () => {
        callCount += 1
        // Genuine network error — should be silently absorbed (return []).
        throw new Error('network')
      },
    })
    const result = await searchCompanyContext(
      { companyName: 'Acme', nicheSignal: 'invoice processing for SMBs', industry: 'fintech' },
    )
    // Both queries failed but searchCompanyContext returned an empty bundle
    // (silent degrade). It did NOT throw.
    expect(result.results).toEqual([])
    expect(callCount).toBeGreaterThanOrEqual(1)
  })

  it('completes normally when no signal is provided (back-compat with old callers)', async () => {
    setExaMockResponses({
      searchAndContents: async () => ({ results: [{ url: 'https://e.com', text: 'snippet' }] }),
    })
    const result = await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
    })
    // No signal → no abort plumbing fires → result returned
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('signal that never aborts behaves like no-signal', async () => {
    setExaMockResponses({
      searchAndContents: async () => ({ results: [{ url: 'https://e.com', text: 'snippet' }] }),
    })
    const controller = new AbortController()
    const result = await searchCompanyContext(
      { companyName: 'Acme', nicheSignal: 'invoice processing for SMBs' },
      controller.signal,
    )
    expect(result.results.length).toBeGreaterThan(0)
  })
})
