import { describe, it, expect } from 'vitest'
import { parsePriorCompanies } from '../renderer/components/contact/ContactPropertiesPanel'

describe('parsePriorCompanies', () => {
  it('returns empty array for null', () => {
    expect(parsePriorCompanies(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(parsePriorCompanies(undefined)).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(parsePriorCompanies('')).toEqual([])
  })

  it('parses JSON array of strings', () => {
    const raw = JSON.stringify(['Acme Corp', 'Globex'])
    expect(parsePriorCompanies(raw)).toEqual(['Acme Corp', 'Globex'])
  })

  it('parses JSON array of { name, companyId } objects', () => {
    const raw = JSON.stringify([{ name: 'Sequoia Capital', companyId: '42' }])
    expect(parsePriorCompanies(raw)).toEqual([{ name: 'Sequoia Capital', companyId: '42' }])
  })

  it('parses JSON mixed array of strings and objects', () => {
    const raw = JSON.stringify(['Acme', { name: 'Sequoia', companyId: '1' }])
    expect(parsePriorCompanies(raw)).toEqual(['Acme', { name: 'Sequoia', companyId: '1' }])
  })

  it('wraps non-array JSON in a single-item array (backward compat: plain string stored without JSON)', () => {
    // If someone stored just "Acme Corp" without JSON encoding
    expect(parsePriorCompanies('Acme Corp')).toEqual(['Acme Corp'])
  })

  it('wraps non-array valid JSON (e.g. JSON object) in a single-item array', () => {
    // Edge case: stored value is a JSON object (not an array)
    const raw = JSON.stringify({ name: 'Acme', companyId: '1' })
    expect(parsePriorCompanies(raw)).toEqual([raw])
  })

  it('wraps plain invalid JSON in single-item array', () => {
    expect(parsePriorCompanies('not valid json {')).toEqual(['not valid json {'])
  })
})
