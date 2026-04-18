/**
 * Tests for extractPartnerSyncBrief()
 *
 * This function is the only logic standing between the LLM's raw note output
 * and the brief that appears inline in the partner sync digest. It must handle
 * all the ways the LLM might format or omit the section.
 *
 * Test coverage:
 *   extractPartnerSyncBrief ──► section found → returns content
 *                          ──► section absent → null
 *                          ──► empty/short section → null
 *                          ──► stops at --- delimiter
 *                          ──► stops at next ## heading
 */

import { describe, it, expect } from 'vitest'
import { extractPartnerSyncBrief } from '../main/utils/pitch-deck-brief'
import { ENTITY_TYPE_OPTIONS } from '../shared/types/company'

const FULL_NOTE = `## Partner Sync Summary

Company: Acme Corp
Founder: Jane Smith — previously VP Engineering at Stripe; https://linkedin.com/in/janesmith
Company Description: AI-powered contract management for mid-market legal teams.
Round: $8M Seed at $32M post-money valuation
Location: San Francisco, CA
Key Metrics & Traction: $420K ARR, 3 design partners on 12-month contracts, 40% MoM growth.
Website: https://acmecorp.com

---

## Full Analysis

**Company Overview**
- SaaS platform for contract lifecycle management
- Early-stage, seed round

**Key Metrics & Traction**
- $420K ARR
`

describe('extractPartnerSyncBrief', () => {
  it('extracts content between ## Partner Sync Summary and --- delimiter', () => {
    const result = extractPartnerSyncBrief(FULL_NOTE)
    expect(result).toContain('Company: Acme Corp')
    expect(result).toContain('Founder: Jane Smith')
    expect(result).toContain('Round: $8M Seed')
  })

  it('does not include content from the Full Analysis section', () => {
    const result = extractPartnerSyncBrief(FULL_NOTE)
    // "Full Analysis" and "Company Overview" appear only in the analysis section, not the brief
    expect(result).not.toContain('Full Analysis')
    expect(result).not.toContain('Company Overview')
    // "SaaS platform for contract lifecycle management" is in the Full Analysis, not the summary
    expect(result).not.toContain('SaaS platform for contract lifecycle management')
  })

  it('returns null when the heading is absent', () => {
    const noteWithoutSection = `## Full Analysis\n\n**Company Overview**\n- SaaS platform\n`
    expect(extractPartnerSyncBrief(noteWithoutSection)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractPartnerSyncBrief('')).toBeNull()
  })

  it('returns null when section content is fewer than 10 characters', () => {
    const sparseNote = `## Partner Sync Summary\nShort\n\n---\n\n## Full Analysis\n`
    expect(extractPartnerSyncBrief(sparseNote)).toBeNull()
  })

  it('stops at the next ## heading if no --- delimiter present', () => {
    const noteWithHeadings = `## Partner Sync Summary\nCompany: Widget Inc\nFounder: Bob Jones\n\n## Full Analysis\n\nSome analysis content\n`
    const result = extractPartnerSyncBrief(noteWithHeadings)
    expect(result).toContain('Company: Widget Inc')
    expect(result).not.toContain('Some analysis content')
  })

  it('handles a note with only the summary section (no delimiter, no next heading)', () => {
    const summaryOnly = `## Partner Sync Summary\nCompany: Solo Co\nRound: $2M pre-seed\n`
    const result = extractPartnerSyncBrief(summaryOnly)
    expect(result).toContain('Company: Solo Co')
    expect(result).toContain('Round: $2M pre-seed')
  })

  it('handles CRLF line endings', () => {
    const crlf = `## Partner Sync Summary\r\nCompany: Acme Corp\r\nRound: $5M seed\r\n\r\n---\r\n\r\n## Full Analysis\r\n`
    const result = extractPartnerSyncBrief(crlf)
    expect(result).toContain('Company: Acme Corp')
    expect(result).not.toContain('Full Analysis')
  })

  it('matches heading case-insensitively', () => {
    const lowercase = `## partner sync summary\nCompany: Beta Co\nRound: $3M seed\n\n---\n\n## Full Analysis\n`
    const result = extractPartnerSyncBrief(lowercase)
    expect(result).toContain('Company: Beta Co')
    expect(result).not.toContain('Full Analysis')
  })

  it('extracts from a single # heading', () => {
    const single = `# Partner Sync Summary\nCompany: Acme Inc\nRound: $5M seed\n\n---\n\n## Full Analysis\n`
    const result = extractPartnerSyncBrief(single)
    expect(result).toContain('Company: Acme Inc')
    expect(result).not.toContain('Full Analysis')
  })

  it('extracts from a ### triple-hash heading', () => {
    const triple = `### Partner Sync Summary\nCompany: Gamma Inc\nRound: $10M Series A\n\n---\n\n## Full Analysis\n`
    const result = extractPartnerSyncBrief(triple)
    expect(result).toContain('Company: Gamma Inc')
    expect(result).not.toContain('Full Analysis')
  })

  it('extracts when heading has a trailing colon (## Partner Sync Summary:)', () => {
    const withColon = `## Partner Sync Summary:\nCompany: Delta Co\nRound: $2M pre-seed\n\n---\n\n## Full Analysis\n`
    const result = extractPartnerSyncBrief(withColon)
    expect(result).toContain('Company: Delta Co')
    expect(result).not.toContain('Full Analysis')
  })
})

describe('ENTITY_TYPE_OPTIONS', () => {
  it('includes portfolio', () => {
    expect(ENTITY_TYPE_OPTIONS.map(t => t.value)).toContain('portfolio')
  })

  it('does not include legacy invalid value startup', () => {
    expect(ENTITY_TYPE_OPTIONS.map(t => t.value)).not.toContain('startup')
  })

  it('all values are valid CompanyEntityType members', () => {
    const validValues = ['prospect', 'portfolio', 'pass', 'vc_fund', 'lp', 'customer', 'partner', 'vendor', 'other', 'unknown']
    ENTITY_TYPE_OPTIONS.forEach(t => {
      expect(validValues).toContain(t.value)
    })
  })
})
