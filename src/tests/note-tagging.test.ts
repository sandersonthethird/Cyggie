/**
 * Unit tests for suggestTitleEntityTag and suggestFolderEntityTag
 * in note-tagging.service.ts
 *
 * Mock boundaries:
 *   - listCompanies / listContactsLight → vi.fn() with seeded return values
 *   - All DB/credential imports → vi.fn() to prevent electron path errors
 *
 * Matching priority per entity:
 *   suggestFolderEntityTag:
 *     1. normalizeToken equality — "acmecorp" == normalizeToken("Acme Corp") → score 1.0
 *     2. Jaro-Winkler            — typos / partial matches
 *     3. FUZZY_THRESHOLD guard   — must exceed 0.88
 *
 *   suggestTitleEntityTag:
 *     1. normalizedTitle.includes(normalizedCompanyName)
 *     2. Min 6 normalized chars for company name (false-positive guard)
 *     3. Longest match wins
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CompanySummary } from '../shared/types/company'

// Mock all DB / electron-dependent imports before loading the service
vi.mock('../main/database/connection', () => ({ getDatabase: vi.fn() }))
vi.mock('../main/database/repositories/org-company.repo', () => ({
  listCompanies: vi.fn(),
}))
vi.mock('../main/database/repositories/contact.repo', () => ({
  listContactsLight: vi.fn(),
}))
vi.mock('../main/database/repositories/settings.repo', () => ({ getSetting: vi.fn() }))
vi.mock('../main/security/credentials', () => ({ getCredential: vi.fn(() => null) }))
vi.mock('../main/llm/claude-provider', () => ({ ClaudeProvider: vi.fn() }))
vi.mock('../main/llm/ollama-provider', () => ({ OllamaProvider: vi.fn() }))

const { listCompanies } = await import('../main/database/repositories/org-company.repo')
const { listContactsLight } = await import('../main/database/repositories/contact.repo')
const { suggestTitleEntityTag, suggestFolderEntityTag } = await import(
  '../main/services/note-tagging.service'
)

// Minimal CompanySummary stub — only the fields accessed by the two functions under test
function makeCompany(id: string, canonicalName: string): CompanySummary {
  return {
    id,
    canonicalName,
    normalizedName: canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, ''),
  } as CompanySummary
}

const ACME_CORP = makeCompany('co1', 'Acme Corp')    // normalizeToken → "acmecorp" (8 chars)
const AI_CO    = makeCompany('co2', 'AI')            // normalizeToken → "ai"        (2 chars, skipped)
const STAR_CO  = makeCompany('co3', 'Star')          // normalizeToken → "star"      (4 chars, skipped)

beforeEach(() => {
  vi.mocked(listContactsLight).mockReturnValue([])
})

// ---------------------------------------------------------------------------
// suggestTitleEntityTag
// ---------------------------------------------------------------------------

describe('suggestTitleEntityTag', () => {
  it('matches when normalized title contains normalized company name (≥6 chars)', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    const result = suggestTitleEntityTag('AcmeCorp Q1 Board')
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co1')
    expect(result!.companyName).toBe('Acme Corp')
    expect(result!.confidence).toBe(90)
  })

  it('returns null for null title', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestTitleEntityTag(null)).toBeNull()
  })

  it('returns null for title shorter than 4 chars', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestTitleEntityTag('abc')).toBeNull()
  })

  it('returns null when title contains no matching company', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestTitleEntityTag('meeting notes')).toBeNull()
  })

  it('skips companies with normalized name < 6 chars (false-positive guard)', () => {
    vi.mocked(listCompanies).mockReturnValue([AI_CO, STAR_CO])
    // "ai" (2) and "star" (4) are both below the 6-char threshold
    expect(suggestTitleEntityTag('daily standup ai star')).toBeNull()
  })

  it('longest match wins when multiple companies match in the title', () => {
    const ACME_CORP_VENTURES = makeCompany('co5', 'Acme Corp Ventures') // "acmecorpventures" = 16
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP, ACME_CORP_VENTURES])
    const result = suggestTitleEntityTag('acmecorpventures board meeting')
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co5')
  })

  it('matches title with extra words and punctuation', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    // "acmecorp q1 board" normalizes to "acmecorpq1board" which contains "acmecorp"
    const result = suggestTitleEntityTag('AcmeCorp Q1 Board')
    expect(result!.companyId).toBe('co1')
  })

  it('returns null on empty company list', () => {
    vi.mocked(listCompanies).mockReturnValue([])
    expect(suggestTitleEntityTag('AcmeCorp Q1 Board')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// suggestFolderEntityTag — normalized equality path (new) + Jaro-Winkler path
// ---------------------------------------------------------------------------

describe('suggestFolderEntityTag', () => {
  it('normalized equality path: "acmecorp" matches "Acme Corp"', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    const result = suggestFolderEntityTag('acmecorp')
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co1')
    expect(result!.confidence).toBe(100) // Math.round(1.0 * 100)
  })

  it('Jaro-Winkler path: "acme corp" (exact match) also returns company', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    const result = suggestFolderEntityTag('acme corp')
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co1')
  })

  it('returns null for empty folder name', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestFolderEntityTag('')).toBeNull()
  })

  it('returns null for whitespace-only folder name', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestFolderEntityTag('   ')).toBeNull()
  })

  it('returns null when folder name does not match any entity', () => {
    vi.mocked(listCompanies).mockReturnValue([ACME_CORP])
    expect(suggestFolderEntityTag('xyzzy')).toBeNull()
  })

  it('returns null on empty company and contact lists', () => {
    vi.mocked(listCompanies).mockReturnValue([])
    expect(suggestFolderEntityTag('acmecorp')).toBeNull()
  })
})
