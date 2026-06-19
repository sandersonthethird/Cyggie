import { describe, it, expect, vi } from 'vitest'
import { stubModule } from './_fixtures/mock-module'

// Mock the same side-effect-heavy modules the producer agent imports at module
// scope, so we can import its PURE helpers (splice / evidence carry-forward /
// triage) without booting SQLite, credentials, or Exa.
vi.mock('../main/security/credentials', () => ({ getCredential: vi.fn(() => null) }))
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({ getSetting: vi.fn(() => null) }))
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () =>
  stubModule({
    getCompany: vi.fn(),
    listCompanyMeetings: vi.fn(() => []),
    listCompanyMeetingSummaryPaths: vi.fn(() => []),
    listCompanyContacts: vi.fn(() => []),
    listCompanyEmails: vi.fn(() => []),
  }),
)
vi.mock('@cyggie/db/sqlite/repositories/investment-memo.repo', () =>
  stubModule({ getMemoLatestVersion: vi.fn(() => null) }),
)
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => stubModule({ getMeeting: vi.fn() }))
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () =>
  stubModule({ getFlaggedFiles: vi.fn(() => []) }),
)
vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: vi.fn(() => []) }),
}))
vi.mock('../main/storage/file-manager', () => ({ readSummary: vi.fn(), readTranscript: vi.fn() }))
vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  }),
}))
vi.mock('@cyggie/services/exa-research', () => ({
  searchCompanyContext: vi.fn(() => Promise.resolve({ queries: [], results: [] })),
}))

import {
  spliceTargetedSections,
  carryForwardEvidence,
  triageSectionsForNewMaterial,
  TRIAGE_FAILED,
} from '@cyggie/services/llm/agents/memo-producer-agent'
import { MEMO_SECTIONS } from '@cyggie/services/llm/memo/sections'
import type { StoredMemoEvidence } from '@shared/types/memo-evidence'

const MEMO = [
  '# Acme — Investment Memo',
  '',
  '## Executive Summary',
  'Original exec summary.',
  '',
  '## Team',
  'Original team body.',
  '',
  '## Risks',
  'Original risks body.',
  '',
].join('\n')

function submitted(entries: Record<string, string>): Map<any, { body: string; submittedAt: number }> {
  const m = new Map<any, { body: string; submittedAt: number }>()
  for (const [heading, body] of Object.entries(entries)) m.set(heading, { body, submittedAt: 0 })
  return m
}

describe('spliceTargetedSections', () => {
  it('replaces only the targeted sections and leaves the rest byte-identical', () => {
    const { merged, applied } = spliceTargetedSections(
      MEMO,
      MEMO_SECTIONS,
      submitted({ Risks: 'Updated risks from the new call.' }),
    )
    expect(applied).toBe(1)
    expect(merged).toContain('Updated risks from the new call.')
    // Untouched sections preserved verbatim.
    expect(merged).toContain('## Executive Summary\nOriginal exec summary.')
    expect(merged).toContain('## Team\nOriginal team body.')
    expect(merged).not.toContain('Original risks body.')
  })

  it('applies multiple targeted sections in roster order', () => {
    const { merged, applied } = spliceTargetedSections(
      MEMO,
      MEMO_SECTIONS,
      submitted({ 'Executive Summary': 'New summary.', Risks: 'New risks.' }),
    )
    expect(applied).toBe(2)
    expect(merged).toContain('New summary.')
    expect(merged).toContain('New risks.')
    expect(merged).toContain('## Team\nOriginal team body.')
  })

  it('SKIPS a targeted heading absent from the memo (no throw) and applies the rest', () => {
    const { merged, applied } = spliceTargetedSections(
      MEMO,
      MEMO_SECTIONS,
      // Valuation is gated and not present in MEMO; Team is.
      submitted({ Valuation: 'Should be skipped.', Team: 'New team body.' }),
    )
    expect(applied).toBe(1)
    expect(merged).toContain('New team body.')
    expect(merged).not.toContain('Should be skipped.')
    expect(merged).not.toContain('## Valuation')
  })

  it('reports applied=0 (no-op) when every targeted heading is absent', () => {
    const { merged, applied } = spliceTargetedSections(
      MEMO,
      MEMO_SECTIONS,
      submitted({ Valuation: 'x', References: 'y' }),
    )
    expect(applied).toBe(0)
    expect(merged).toBe(MEMO) // base returned untouched
  })
})

function evidence(section: string | null, claim: string): StoredMemoEvidence {
  return {
    id: `e-${claim}`,
    versionId: 'v1',
    claimText: claim,
    claimCategory: null,
    sourceType: 'internal',
    sourceId: 'm1',
    sourceUrl: null,
    snippet: claim,
    confidence: 'high',
    severity: null,
    isCritique: false,
    section,
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('carryForwardEvidence', () => {
  it('keeps rows for non-targeted sections and section-less rows, drops targeted-section rows', () => {
    const prev = [
      evidence('Risks', 'targeted-claim'),
      evidence('Team', 'untouched-claim'),
      evidence(null, 'critique-claim'),
    ]
    const carried = carryForwardEvidence(prev, new Set(['Risks']))
    const claims = carried.map((c) => c.claimText).sort()
    expect(claims).toEqual(['critique-claim', 'untouched-claim'])
    // Carried rows are version-agnostic EvidenceRows (no versionId/id).
    expect((carried[0] as any).versionId).toBeUndefined()
  })

  it('returns empty when all prior evidence belongs to targeted sections', () => {
    const carried = carryForwardEvidence([evidence('Team', 'a')], new Set(['Team']))
    expect(carried).toEqual([])
  })
})

function fakeClient(text: string | (() => never)) {
  return {
    messages: {
      create: vi.fn(async () => {
        if (typeof text === 'function') text()
        return { content: [{ type: 'text', text }] }
      }),
    },
  } as any
}

const HEADINGS = ['Executive Summary', 'Team', 'Risks'] as any

describe('triageSectionsForNewMaterial', () => {
  const baseArgs = { existingHeadings: HEADINGS, newTranscripts: [{ title: 'Call', date: '2026-06-18', content: 'metrics up' }] }

  it('intersects model output with present headings and always includes Executive Summary', async () => {
    const out = await triageSectionsForNewMaterial(fakeClient('["Risks"]'), baseArgs)
    expect(out).not.toBe(TRIAGE_FAILED)
    expect(new Set(out as string[])).toEqual(new Set(['Risks', 'Executive Summary']))
  })

  it('tolerates code fences / surrounding prose around the JSON array', async () => {
    const out = await triageSectionsForNewMaterial(fakeClient('Here:\n```json\n["Team"]\n```'), baseArgs)
    expect(new Set(out as string[])).toEqual(new Set(['Team', 'Executive Summary']))
  })

  it('returns TRIAGE_FAILED on an empty array', async () => {
    expect(await triageSectionsForNewMaterial(fakeClient('[]'), baseArgs)).toBe(TRIAGE_FAILED)
  })

  it('returns TRIAGE_FAILED when all headings are unknown', async () => {
    expect(await triageSectionsForNewMaterial(fakeClient('["Bogus","Nope"]'), baseArgs)).toBe(TRIAGE_FAILED)
  })

  it('returns TRIAGE_FAILED on unparseable output', async () => {
    expect(await triageSectionsForNewMaterial(fakeClient('not json at all'), baseArgs)).toBe(TRIAGE_FAILED)
  })

  it('returns TRIAGE_FAILED when the API call throws', async () => {
    const client = fakeClient(() => { throw new Error('429 rate limited') })
    expect(await triageSectionsForNewMaterial(client, baseArgs)).toBe(TRIAGE_FAILED)
  })
})
