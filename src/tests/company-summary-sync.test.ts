/**
 * Regression tests for extractDescription() in company-summary-sync.service.ts.
 *
 * extractDescription() is a pure text-parsing function but lives in a module
 * that imports repos and file-manager. All module dependencies are mocked so the
 * function can be tested without a database.
 *
 * Guards the subLabel ?? [existing logic] fallback path introduced when
 * extractDescriptionSubLabel() was added.
 */

import { describe, it, expect, vi } from 'vitest'

// ─── Mock: database connection ────────────────────────────────────────────────

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn()
}))

// ─── Mock: repos ──────────────────────────────────────────────────────────────

vi.mock('../main/database/repositories/org-company.repo', () => ({}))
vi.mock('../main/database/repositories/meeting.repo', () => ({}))
vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn()
}))
vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: vi.fn(),
  getFieldValuesForEntity: vi.fn()
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn()
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

import { extractDescription } from '../main/services/company-summary-sync.service'

describe('extractDescription — fallback behavior', () => {
  it('returns the first sentence of Executive Summary when no Description sub-label exists', () => {
    const note = `
## Executive Summary

Acme builds AI-powered tools for enterprise sales teams. Founded by Jane Smith, raising $3M. We recommend passing.

## Investment Highlights

- Strong team
`
    expect(extractDescription(note)).toBe('Acme builds AI-powered tools for enterprise sales teams.')
  })
})
