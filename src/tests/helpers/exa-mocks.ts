import { vi } from 'vitest'

/**
 * Test helpers for stubbing the Exa client used by exa-research.ts.
 *
 * Pattern:
 *
 *   import { setExaMockResponses } from './helpers/exa-mocks'
 *   vi.mock('exa-js')   // hoisted by vitest
 *
 *   beforeEach(() => setExaMockResponses({
 *     search: () => ({ results: [{ url: 'https://x.com', text: 'snippet' }] }),
 *     contents: () => ({ results: [{ url: 'https://x.com', text: 'page body' }] }),
 *   }))
 *
 * `vi.mock('exa-js')` must be at the top of the test file (vitest hoists it).
 * That replaces the `Exa` class with a constructor that returns the object
 * configured here.
 */

type ExaSearchResponse = {
  results: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }>
}

type ExaContentsResponse = {
  results: Array<{ url?: string; title?: string; text?: string }>
}

interface MockHandlers {
  search?: (...args: unknown[]) => ExaSearchResponse | Promise<ExaSearchResponse>
  searchAndContents?: (...args: unknown[]) => ExaSearchResponse | Promise<ExaSearchResponse>
  contents?: (...args: unknown[]) => ExaContentsResponse | Promise<ExaContentsResponse>
  /** If set, ALL methods reject with this error (overrides the per-method stubs). */
  throwError?: Error
}

const handlers: MockHandlers = {}

export function setExaMockResponses(next: MockHandlers): void {
  handlers.search = next.search
  handlers.searchAndContents = next.searchAndContents
  handlers.contents = next.contents
  handlers.throwError = next.throwError
}

export function clearExaMocks(): void {
  handlers.search = undefined
  handlers.searchAndContents = undefined
  handlers.contents = undefined
  handlers.throwError = undefined
}

/**
 * The Exa class shape that exa-research.ts and exa-linkedin-discovery use.
 * Test files do `vi.mock('exa-js', () => ({ Exa: MockExa }))`.
 */
export class MockExa {
  constructor(_apiKey: string) { /* recorded if needed */ }

  search = vi.fn(async (...args: unknown[]) => {
    if (handlers.throwError) throw handlers.throwError
    if (handlers.search) return handlers.search(...args)
    return { results: [] }
  })

  searchAndContents = vi.fn(async (...args: unknown[]) => {
    if (handlers.throwError) throw handlers.throwError
    if (handlers.searchAndContents) return handlers.searchAndContents(...args)
    if (handlers.search) return handlers.search(...args)
    return { results: [] }
  })

  contents = vi.fn(async (...args: unknown[]) => {
    if (handlers.throwError) throw handlers.throwError
    if (handlers.contents) return handlers.contents(...args)
    return { results: [] }
  })

  // The actual Exa SDK method is getContents (not contents); exa-research.ts
  // calls getContents. Mirror to the same handler so tests can keep using
  // setExaMockResponses({ contents: ... }) as a single switch.
  getContents = vi.fn(async (...args: unknown[]) => {
    if (handlers.throwError) throw handlers.throwError
    if (handlers.contents) return handlers.contents(...args)
    return { results: [] }
  })
}

/**
 * Build an Exa-shaped error matching what the SDK throws. statusCode 401 is
 * auth failure; 429 is rate limit. exa-research.ts and exa-linkedin-discovery
 * both branch on statusCode.
 */
export function buildExaError(statusCode: number, message?: string): Error {
  const err = new Error(message ?? `Exa error ${statusCode}`)
  ;(err as Error & { statusCode: number }).statusCode = statusCode
  return err
}
