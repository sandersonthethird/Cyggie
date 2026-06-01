// Unit tests for slice 2 (External Agents V1) — formatSearchAsMrkdwn
// and the mrkdwn helpers. Pure-function coverage; the HTTP roundtrip
// (Slack → /slack/events → search → DB → mrkdwn reply) is in
// slack-search-smoke.test.ts.

import { describe, expect, test } from 'vitest'
import { formatSearchAsMrkdwn } from '../src/slack/handlers/search'
import {
  bold,
  bullet,
  escapeMrkdwn,
  italic,
  link,
} from '../src/slack/format-mrkdwn'
import type { SearchResults } from '../src/mcp/tools/search'

const EMPTY: SearchResults = {
  query: 'acme',
  companies: { items: [], total: 0 },
  contacts: { items: [], total: 0 },
  meetings: { items: [], total: 0 },
  notes: { items: [], total: 0 },
}

describe('format-mrkdwn: helpers', () => {
  test('bold uses single asterisks (Slack mrkdwn, not standard markdown)', () => {
    expect(bold('Acme')).toBe('*Acme*')
  })

  test('bold escapes HTML control chars in the inner text', () => {
    expect(bold('<Acme & Co>')).toBe('*&lt;Acme &amp; Co&gt;*')
  })

  test('italic uses underscores', () => {
    expect(italic('soon')).toBe('_soon_')
  })

  test('link with display uses <url|display> syntax', () => {
    expect(link('cyggie://company/abc', 'Acme Corp')).toBe(
      '<cyggie://company/abc|Acme Corp>',
    )
  })

  test('link without display is just <url>', () => {
    expect(link('https://example.com')).toBe('<https://example.com>')
  })

  test('link replaces pipe in display to avoid breaking the separator', () => {
    // Real-world: a company named "Acme | Holdings"
    const result = link('cyggie://company/abc', 'Acme | Holdings')
    expect(result).not.toContain('|H')
    expect(result).toContain('∣') // U+2223
    expect(result).toMatch(/^<cyggie:\/\/company\/abc\|Acme ∣ Holdings>$/)
  })

  test('bullet prefixes with • + double space', () => {
    expect(bullet('hello')).toBe('•  hello')
  })

  test('escapeMrkdwn does not touch * _ ` (Slack treats unpaired as literal)', () => {
    expect(escapeMrkdwn('rate *was* 8%')).toBe('rate *was* 8%')
  })
})

describe('formatSearchAsMrkdwn: empty results', () => {
  test('zero hits returns "No matches" with the bolded query', () => {
    expect(formatSearchAsMrkdwn(EMPTY)).toBe('No matches for *"acme"*.')
  })
})

describe('formatSearchAsMrkdwn: companies', () => {
  test('renders a single company with bullet + link + metadata', () => {
    const r: SearchResults = {
      ...EMPTY,
      companies: {
        items: [
          {
            id: 'co_abc123',
            name: 'Acme Corp',
            industry: 'AI',
            pipelineStage: 'Series A',
            primaryDomain: 'acme.com',
          },
        ],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    expect(out).toContain('*Search results for "acme"*')
    expect(out).toContain('*Companies (1)*')
    expect(out).toContain('•')
    expect(out).toContain('<cyggie://company/co_abc123|Acme Corp>')
    expect(out).toContain('(acme.com)')
    expect(out).toContain('AI · Series A')
  })

  test('renders "shown of total" when more results than shown', () => {
    const r: SearchResults = {
      ...EMPTY,
      companies: {
        items: [
          {
            id: 'co_a',
            name: 'A',
            industry: null,
            pipelineStage: null,
            primaryDomain: null,
          },
        ],
        total: 8,
      },
    }
    expect(formatSearchAsMrkdwn(r)).toContain('*Companies (1 of 8)*')
  })

  test('omits metadata gracefully when fields are null', () => {
    const r: SearchResults = {
      ...EMPTY,
      companies: {
        items: [
          {
            id: 'co_x',
            name: 'X',
            industry: null,
            pipelineStage: null,
            primaryDomain: null,
          },
        ],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    expect(out).toContain('<cyggie://company/co_x|X>')
    // No trailing " — ..." metadata
    expect(out).not.toContain('— ')
  })
})

describe('formatSearchAsMrkdwn: contacts', () => {
  test('renders contact with @ company + title + email', () => {
    const r: SearchResults = {
      ...EMPTY,
      contacts: {
        items: [
          {
            id: 'ct_001',
            fullName: 'Jane Smith',
            title: 'CEO',
            email: 'jane@acme.com',
            primaryCompanyName: 'Acme Corp',
          },
        ],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    expect(out).toContain('*Contacts (1)*')
    expect(out).toContain('<cyggie://contact/ct_001|Jane Smith>')
    expect(out).toContain('@ Acme Corp')
    expect(out).toContain('CEO · jane@acme.com')
  })

  test('contact without company omits the @ prefix', () => {
    const r: SearchResults = {
      ...EMPTY,
      contacts: {
        items: [
          {
            id: 'ct_002',
            fullName: 'Solo Person',
            title: null,
            email: null,
            primaryCompanyName: null,
          },
        ],
        total: 1,
      },
    }
    expect(formatSearchAsMrkdwn(r)).not.toContain(' @ ')
  })
})

describe('formatSearchAsMrkdwn: meetings', () => {
  test('renders meeting with date + relative time', () => {
    const date = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14) // 2 weeks ago
    const r: SearchResults = {
      ...EMPTY,
      meetings: {
        items: [{ id: 'mtg_xyz', title: 'Q4 strategy with Acme', date }],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    expect(out).toContain('*Meetings (1)*')
    expect(out).toContain('<cyggie://meeting/mtg_xyz|Q4 strategy with Acme>')
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/) // ISO date present
    expect(out).toContain('2 weeks ago')
  })
})

describe('formatSearchAsMrkdwn: notes', () => {
  test('renders note with two lines (header + italicised preview)', () => {
    const r: SearchResults = {
      ...EMPTY,
      notes: {
        items: [
          {
            id: 'nt_001',
            title: 'Pricing discussion',
            contentPreview: 'They want enterprise pricing for the SOC2 tier.',
            companyName: 'Acme Corp',
            contactName: null,
            updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
          },
        ],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    expect(out).toContain('<cyggie://note/nt_001|Pricing discussion>')
    expect(out).toContain('Acme Corp')
    expect(out).toContain('3 days ago')
    expect(out).toContain('_They want enterprise pricing for the SOC2 tier._')
  })

  test('untitled note labelled (untitled note)', () => {
    const r: SearchResults = {
      ...EMPTY,
      notes: {
        items: [
          {
            id: 'nt_002',
            title: null,
            contentPreview: 'short.',
            companyName: null,
            contactName: null,
            updatedAt: new Date(),
          },
        ],
        total: 1,
      },
    }
    expect(formatSearchAsMrkdwn(r)).toContain('|(untitled note)>')
  })
})

describe('formatSearchAsMrkdwn: all sections combined', () => {
  test('renders sections in fixed order: companies, contacts, meetings, notes', () => {
    const r: SearchResults = {
      query: 'acme',
      companies: {
        items: [{ id: 'c1', name: 'Acme', industry: null, pipelineStage: null, primaryDomain: null }],
        total: 1,
      },
      contacts: {
        items: [{ id: 'ct1', fullName: 'Jane', title: null, email: null, primaryCompanyName: null }],
        total: 1,
      },
      meetings: {
        items: [{ id: 'm1', title: 'Mtg', date: new Date() }],
        total: 1,
      },
      notes: {
        items: [
          {
            id: 'n1',
            title: 'Note',
            contentPreview: 'p',
            companyName: null,
            contactName: null,
            updatedAt: new Date(),
          },
        ],
        total: 1,
      },
    }
    const out = formatSearchAsMrkdwn(r)
    const idxCompanies = out.indexOf('*Companies')
    const idxContacts = out.indexOf('*Contacts')
    const idxMeetings = out.indexOf('*Meetings')
    const idxNotes = out.indexOf('*Notes')
    expect(idxCompanies).toBeGreaterThan(-1)
    expect(idxContacts).toBeGreaterThan(idxCompanies)
    expect(idxMeetings).toBeGreaterThan(idxContacts)
    expect(idxNotes).toBeGreaterThan(idxMeetings)
  })
})
