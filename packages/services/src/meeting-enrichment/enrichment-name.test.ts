import { describe, it, expect } from 'vitest'
import {
  humanizeDomainName,
  domainToTitleCase,
  extractDomainFromEmail,
  extractDomainsFromEmails,
  parseCompanyName,
  isPlausibleCompanyName,
} from '@cyggie/db/meeting-enrichment/helpers'
import { resolveCompanyName, type ResolveCompanyNameDeps } from './name'
import type { LLMProvider } from '../llm/provider'

// A minimal LLMProvider whose generateSummary returns a scripted string (or throws).
function fakeLLM(reply: string | (() => Promise<string>)): LLMProvider {
  return {
    name: 'fake',
    isAvailable: async () => true,
    generateSummary: async () => (typeof reply === 'function' ? reply() : reply),
    streamWithThinking: async () => (typeof reply === 'function' ? reply() : reply),
  }
}

describe('meeting-enrichment helpers', () => {
  it('humanizeDomainName: camelCase, domain-words, and passthrough', () => {
    expect(humanizeDomainName('AcmeCorp')).toBe('Acme Corp')
    expect(humanizeDomainName('redswanventures')).toBe('Red Swan Ventures')
    expect(humanizeDomainName('bowley')).toBe('Bowley')
  })

  it('domainToTitleCase strips the TLD then humanizes', () => {
    // 'cap' isn't a known segment word, so 'caphub' stays whole (faithful to the
    // desktop heuristic — only fully-segmentable strings split).
    expect(domainToTitleCase('caphub.com')).toBe('Caphub')
    expect(domainToTitleCase('redswanventures.com')).toBe('Red Swan Ventures')
  })

  it('extractDomainFromEmail filters free providers, keeps company domains', () => {
    expect(extractDomainFromEmail('a@gmail.com')).toBeNull()
    expect(extractDomainFromEmail('caitlin@redswanventures.com')).toBe('redswanventures.com')
    expect(extractDomainFromEmail('not-an-email')).toBeNull()
  })

  it('extractDomainsFromEmails dedupes and drops free providers', () => {
    expect(
      extractDomainsFromEmails([
        'a@acme.com',
        'b@acme.com',
        'c@gmail.com',
        'd@beta.io',
      ]).sort(),
    ).toEqual(['acme.com', 'beta.io'])
  })

  it('parseCompanyName precedence: og:site_name → application-name → title', () => {
    expect(
      parseCompanyName('<meta property="og:site_name" content="Stripe">'),
    ).toBe('Stripe')
    expect(
      parseCompanyName('<meta name="application-name" content="Plaid">'),
    ).toBe('Plaid')
    expect(parseCompanyName('<title>Acme — Official Site</title>')).toBe('Acme')
    expect(parseCompanyName('<html><body>no name here</body></html>')).toBeNull()
  })

  it('isPlausibleCompanyName: keeps real names, rejects taglines', () => {
    expect(isPlausibleCompanyName('Stripe')).toBe(true)
    expect(isPlausibleCompanyName('Bank of America Merrill Lynch')).toBe(true)
    expect(isPlausibleCompanyName('Streamlining The Middle-Market Deal Landscape')).toBe(false)
    expect(isPlausibleCompanyName('We help founders win.')).toBe(false) // trailing period
    expect(isPlausibleCompanyName('x')).toBe(false) // too short
  })
})

describe('resolveCompanyName precedence', () => {
  const llmReturns = (s: string): ResolveCompanyNameDeps => ({
    fetchHtml: async () => null,
    llm: fakeLLM(s),
  })

  it('homepage parse wins when plausible', async () => {
    const deps: ResolveCompanyNameDeps = {
      fetchHtml: async () => '<meta property="og:site_name" content="Stripe">',
      llm: fakeLLM('SHOULD NOT BE USED'),
    }
    expect(await resolveCompanyName('stripe.com', deps)).toBe('Stripe')
  })

  it('falls to LLM when homepage missing', async () => {
    expect(await resolveCompanyName('caphub.com', llmReturns('CapHub'))).toBe('CapHub')
  })

  it('falls to LLM when homepage name is an implausible tagline', async () => {
    const deps: ResolveCompanyNameDeps = {
      fetchHtml: async () => '<title>Streamlining The Middle-Market Deal Landscape</title>',
      llm: fakeLLM('CapHub'),
    }
    expect(await resolveCompanyName('caphub.com', deps)).toBe('CapHub')
  })

  it('falls to deterministic heuristic when both fail', async () => {
    expect(await resolveCompanyName('redswanventures.com', llmReturns('UNKNOWN'))).toBe(
      'Red Swan Ventures',
    )
  })

  it('LLM tier is skipped when llm is null', async () => {
    const deps: ResolveCompanyNameDeps = { fetchHtml: async () => null, llm: null }
    expect(await resolveCompanyName('redswanventures.com', deps)).toBe('Red Swan Ventures')
  })

  it('a throwing fetchHtml degrades to the LLM/heuristic, never throws', async () => {
    const deps: ResolveCompanyNameDeps = {
      fetchHtml: async () => {
        throw new Error('SSRF blocked / timeout')
      },
      llm: fakeLLM('Acme'),
    }
    expect(await resolveCompanyName('acme.com', deps)).toBe('Acme')
  })

  it('an implausible LLM reply (gerund-led tagline) is rejected → heuristic', async () => {
    // isPlausibleCompanyName rejects gerund-led multi-word taglines.
    expect(
      await resolveCompanyName('redswanventures.com', llmReturns('Empowering founders to win')),
    ).toBe('Red Swan Ventures')
  })

  it('a throwing LLM degrades to heuristic', async () => {
    const deps: ResolveCompanyNameDeps = {
      fetchHtml: async () => null,
      llm: fakeLLM(async () => {
        throw new Error('429')
      }),
    }
    expect(await resolveCompanyName('redswanventures.com', deps)).toBe('Red Swan Ventures')
  })
})
