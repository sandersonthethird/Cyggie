/**
 * Tests for memo-export.service.ts utility functions.
 *
 * Coverage:
 *   buildMemoDocTitle  — 5 branches (valuation+round, valuation only, round only,
 *                         neither, unknown round value)
 *   buildHeaderHtml    — 4 logo combos (both, firm only, company only, neither)
 *   roundLabel         — known values, unknown fallback, null/undefined
 *   buildMemoSystemPrompt — placeholder substitution (from memo-generator.ts)
 */

import { describe, it, expect } from 'vitest'
import {
  buildMemoDocTitle,
  buildHeaderHtml,
  roundLabel,
} from '../main/services/memo-export.service'
import { buildMemoSystemPrompt } from '../main/llm/memo-generator'

// ---------------------------------------------------------------------------
// roundLabel
// ---------------------------------------------------------------------------

describe('roundLabel', () => {
  it('maps known DB values to human-readable labels', () => {
    expect(roundLabel('pre_seed')).toBe('Pre-Seed')
    expect(roundLabel('seed')).toBe('Seed')
    expect(roundLabel('seed_extension')).toBe('Seed Extension')
    expect(roundLabel('series_a')).toBe('Series A')
    expect(roundLabel('series_b')).toBe('Series B')
  })

  it('passes through unknown values unchanged', () => {
    expect(roundLabel('series_c')).toBe('series_c')
    expect(roundLabel('future_round')).toBe('future_round')
  })

  it('returns null for null or undefined', () => {
    expect(roundLabel(null)).toBeNull()
    expect(roundLabel(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildMemoDocTitle
// ---------------------------------------------------------------------------

describe('buildMemoDocTitle', () => {
  it('δ — valuation + round → human-readable label in title', () => {
    const title = buildMemoDocTitle('Acme Corp', {
      postMoneyValuation: 50,
      round: 'series_a',
    })
    expect(title).toBe('Acme Corp - Proposed Investment in $50M Post-Money Series A Round')
  })

  it('δ — valuation with round, strips trailing .0 from valuation', () => {
    const title = buildMemoDocTitle('Acme Corp', {
      postMoneyValuation: 12.5,
      round: 'seed',
    })
    expect(title).toBe('Acme Corp - Proposed Investment in $12.5M Post-Money Seed Round')
  })

  it('ε — valuation only (no round) → "Post-Money Round" without label', () => {
    const title = buildMemoDocTitle('Acme Corp', {
      postMoneyValuation: 50,
      round: null,
    })
    expect(title).toBe('Acme Corp - Proposed Investment in $50M Post-Money Round')
  })

  it('ζ — round only (no valuation) → "Series A Round"', () => {
    const title = buildMemoDocTitle('Acme Corp', {
      round: 'series_a',
    })
    expect(title).toBe('Acme Corp - Proposed Investment in Series A Round')
  })

  it('η — neither valuation nor round → fallback suffix', () => {
    const title = buildMemoDocTitle('Acme Corp', {})
    expect(title).toBe('Acme Corp - Proposed Investment')
  })

  it('η — no companyDetails at all → fallback suffix', () => {
    const title = buildMemoDocTitle('Acme Corp')
    expect(title).toBe('Acme Corp - Proposed Investment')
  })

  it('θ — unknown round value → raw value used as fallback', () => {
    const title = buildMemoDocTitle('Acme Corp', {
      round: 'series_c',
    })
    expect(title).toBe('Acme Corp - Proposed Investment in series_c Round')
  })
})

// ---------------------------------------------------------------------------
// buildHeaderHtml
// ---------------------------------------------------------------------------

describe('buildHeaderHtml', () => {
  const DATA_URL = 'data:image/png;base64,abc123'
  const CO_DATA_URL = 'data:image/png;base64,xyz789'

  it('ι — both logos → 3-column with both img tags', () => {
    const html = buildHeaderHtml({
      logoDataUrl: DATA_URL,
      companyLogoDataUrl: CO_DATA_URL,
      title: 'Acme Memo',
      date: 'April 2026',
    })
    expect(html).toContain(`src="${DATA_URL}"`)
    expect(html).toContain(`src="${CO_DATA_URL}"`)
    // title centered (3-column mode)
    expect(html).toContain('text-align:center')
    expect(html).toContain('Acme Memo')
    expect(html).toContain('April 2026')
  })

  it('κ — firm logo only → 3-column, right spacer (no right img)', () => {
    const html = buildHeaderHtml({
      logoDataUrl: DATA_URL,
      companyLogoDataUrl: null,
      title: 'Acme Memo',
      date: 'April 2026',
    })
    expect(html).toContain(`src="${DATA_URL}"`)
    // No company logo img
    expect(html).not.toContain('src="data:image/png;base64,xyz')
    // Still 3-column layout
    expect(html).toContain('text-align:center')
  })

  it('λ — company logo only → 3-column, left spacer (no left img)', () => {
    const html = buildHeaderHtml({
      logoDataUrl: null,
      companyLogoDataUrl: CO_DATA_URL,
      title: 'Acme Memo',
      date: 'April 2026',
    })
    expect(html).toContain(`src="${CO_DATA_URL}"`)
    expect(html).not.toContain('src="data:image/png;base64,abc')
    expect(html).toContain('text-align:center')
  })

  it('μ — neither logo → single-column fallback (no img tags)', () => {
    const html = buildHeaderHtml({
      logoDataUrl: null,
      companyLogoDataUrl: null,
      title: 'Acme Memo',
      date: 'April 2026',
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('Acme Memo')
    expect(html).toContain('April 2026')
    // Single column: left-aligned text
    expect(html).toContain('text-align:left')
  })

  it('escapes HTML special characters in title and date', () => {
    const html = buildHeaderHtml({
      logoDataUrl: null,
      companyLogoDataUrl: null,
      title: '<script>alert("xss")</script>',
      date: 'Q1 & Q2',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Q1 &amp; Q2')
  })
})

// ---------------------------------------------------------------------------
// buildMemoSystemPrompt
// ---------------------------------------------------------------------------

describe('buildMemoSystemPrompt', () => {
  it('replaces ###TITLE### with the provided title line', () => {
    const prompt = buildMemoSystemPrompt('# Acme Corp - Proposed Investment in Series A Round')
    expect(prompt).toContain('# Acme Corp - Proposed Investment in Series A Round')
  })

  it('does not leave ###TITLE### in the output', () => {
    const prompt = buildMemoSystemPrompt('# Acme Corp - Proposed Investment')
    expect(prompt).not.toContain('###TITLE###')
  })

  it('produces a non-empty string with the rest of the system prompt intact', () => {
    const prompt = buildMemoSystemPrompt('# Foo Corp - Proposed Investment')
    expect(prompt).toContain('## Executive Summary')
    expect(prompt).toContain('## Risks')
    expect(prompt.length).toBeGreaterThan(500)
  })
})
