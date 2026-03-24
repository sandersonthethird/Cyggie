/**
 * Tests for partner-meeting-reconcile.service.ts
 *
 * Mock boundaries:
 *   - database/connection (getDatabase) → in-memory SQLite
 *   - org-company.repo (getCompany, updateCompany) → vi.fn()
 *   - company-notes.repo (listCompanyNotes) → vi.fn()
 *   - meeting.repo (getMeeting) → vi.fn()
 *   - storage/file-manager (readTranscript) → vi.fn()
 *   - task.repo (bulkCreate) → vi.fn()
 *
 * LLM provider is injected via function parameter (no module mock needed).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// ─── Mock: database connection ────────────────────────────────────────────────

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb,
}))

// ─── Mock: org-company.repo ───────────────────────────────────────────────────

const mockGetCompany = vi.fn()
const mockUpdateCompany = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  updateCompany: (...args: unknown[]) => mockUpdateCompany(...args),
}))

// ─── Mock: company-notes.repo ─────────────────────────────────────────────────

const mockListCompanyNotes = vi.fn()

vi.mock('../main/database/repositories/company-notes.repo', () => ({
  listCompanyNotes: (...args: unknown[]) => mockListCompanyNotes(...args),
}))

// ─── Mock: meeting.repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadTranscript = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readTranscript: (...args: unknown[]) => mockReadTranscript(...args),
}))

// ─── Mock: task.repo ──────────────────────────────────────────────────────────

const mockBulkCreateTasks = vi.fn()

vi.mock('../main/database/repositories/task.repo', () => ({
  bulkCreate: (...args: unknown[]) => mockBulkCreateTasks(...args),
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  extractCompanyExcerpts,
  generateReconciliationProposals,
  applyReconciliationProposals,
} from '../main/services/partner-meeting-reconcile.service'
import type {
  PartnerMeetingDigest,
  PartnerMeetingItem,
  ApplyReconciliationInput,
} from '../shared/types/partner-meeting'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDigest(overrides: Partial<PartnerMeetingDigest> = {}): PartnerMeetingDigest {
  return {
    id: 'digest-1',
    weekOf: '2026-03-18',
    status: 'active',
    dismissedSuggestions: [],
    meetingId: null,
    archivedAt: null,
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
    items: [],
    ...overrides,
  }
}

function makeItem(overrides: Partial<PartnerMeetingItem> = {}): PartnerMeetingItem {
  return {
    id: 'item-1',
    digestId: 'digest-1',
    companyId: 'co-1',
    companyName: 'Acme Corp',
    pipelineStage: 'diligence',
    section: 'priorities',
    position: 1,
    title: null,
    brief: null,
    statusUpdate: 'Good progress',
    meetingNotes: 'Discussed the product roadmap',
    isDiscussed: true,
    carryOver: false,
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
    ...overrides,
  }
}

function makeMockProvider(response: string | null = null) {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    generateSummary: vi.fn().mockResolvedValue(
      response ??
        JSON.stringify({
          noteTitle: 'Partner Meeting — March 18, 2026',
          noteContent: '## Discussion\nGood product meeting.',
          fieldUpdates: [{ field: 'pipelineStage', value: 'decision' }],
          tasks: [
            { title: 'Send intro to fund', category: 'action_item', assignee: 'Sarah', dueDate: null },
          ],
        }),
    ),
  }
}

function makeAbortController() {
  return { signal: new AbortController().signal }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Fresh in-memory DB with minimal notes table
  testDb = new Database(':memory:')
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      contact_id TEXT,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      source_digest_id TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `)

  vi.clearAllMocks()

  // Default stubs
  mockGetCompany.mockReturnValue({
    id: 'co-1',
    canonicalName: 'Acme Corp',
    description: 'A great company',
    pipelineStage: 'diligence',
    entityType: 'prospect',
  })
  mockListCompanyNotes.mockReturnValue([])
  mockGetMeeting.mockReturnValue(null)
  mockReadTranscript.mockReturnValue(null)
  mockBulkCreateTasks.mockReturnValue([])
})

// ─── extractCompanyExcerpts ───────────────────────────────────────────────────

describe('extractCompanyExcerpts', () => {
  it('returns empty string when company name not found in transcript', () => {
    expect(extractCompanyExcerpts('This is about Beta Corp.', 'Acme')).toBe('')
  })

  it('returns ±500 char window around a single mention', () => {
    const padding = 'x'.repeat(600)
    const transcript = `${padding}Acme Corp had a great quarter${padding}`
    const result = extractCompanyExcerpts(transcript, 'Acme Corp')
    expect(result.length).toBeLessThanOrEqual(3000)
    expect(result).toContain('Acme Corp had a great quarter')
    // Should include text from the window
    expect(result.length).toBeGreaterThan('Acme Corp had a great quarter'.length)
  })

  it('concatenates multiple non-overlapping mentions with separator', () => {
    const gap = 'y'.repeat(1200)  // wider than 500*2 = 1000 so no overlap
    const transcript = `mention 1 Acme Corp here${gap}mention 2 Acme Corp there`
    const result = extractCompanyExcerpts(transcript, 'Acme Corp')
    expect(result).toContain('\n---\n')
  })

  it('caps total output at 3000 chars', () => {
    const segment = 'Acme Corp ' + 'z'.repeat(600)
    const transcript = Array.from({ length: 10 }, () => segment).join(' ')
    const result = extractCompanyExcerpts(transcript, 'Acme Corp')
    expect(result.length).toBeLessThanOrEqual(3000)
  })

  it('is case-insensitive', () => {
    const result = extractCompanyExcerpts('We discussed ACME CORP today.', 'acme corp')
    expect(result).toContain('ACME CORP')
  })
})

// ─── generateReconciliationProposals ─────────────────────────────────────────

describe('generateReconciliationProposals', () => {
  it('happy path: generates proposals for all discussed companies with content', async () => {
    const digest = makeDigest({ items: [makeItem()] })
    const provider = makeMockProvider()
    const received: unknown[] = []

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, p => received.push(p), new AbortController().signal,
    )

    expect(results).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(results[0].companyId).toBe('co-1')
    expect(results[0].noteContent).toContain('Source: Partner Meeting')
    expect(results[0].fieldUpdates).toHaveLength(1)
    expect(results[0].fieldUpdates[0].field).toBe('pipelineStage')
    expect(results[0].tasks).toHaveLength(1)
    expect(results[0].tasks[0].category).toBe('action_item')
  })

  it('no transcript linked (meetingId null): proceeds without transcript context', async () => {
    const digest = makeDigest({ meetingId: null, items: [makeItem()] })
    const provider = makeMockProvider()

    await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(mockGetMeeting).not.toHaveBeenCalled()
    expect(mockReadTranscript).not.toHaveBeenCalled()
    expect(provider.generateSummary).toHaveBeenCalled()
  })

  it('getMeeting returns null: logs warning, proceeds without transcript', async () => {
    mockGetMeeting.mockReturnValue(null)
    const digest = makeDigest({ meetingId: 'mtg-1', items: [makeItem()] })
    const provider = makeMockProvider()

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(results).toHaveLength(1)
    expect(results[0].error).toBeUndefined()
    expect(mockReadTranscript).not.toHaveBeenCalled()
  })

  it('transcriptPath is null: proceeds without transcript', async () => {
    mockGetMeeting.mockReturnValue({ id: 'mtg-1', title: 'Partners Sync', transcriptPath: null })
    const digest = makeDigest({ meetingId: 'mtg-1', items: [makeItem()] })
    const provider = makeMockProvider()

    await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(mockReadTranscript).not.toHaveBeenCalled()
    expect(provider.generateSummary).toHaveBeenCalled()
  })

  it('LLM throws: proposal has error set, batch continues for other companies', async () => {
    const item2 = makeItem({ id: 'item-2', companyId: 'co-2', companyName: 'Beta Corp' })
    const digest = makeDigest({ items: [makeItem(), item2] })
    mockGetCompany
      .mockReturnValueOnce({ id: 'co-1', canonicalName: 'Acme Corp', description: null, pipelineStage: null, entityType: null })
      .mockReturnValueOnce({ id: 'co-2', canonicalName: 'Beta Corp', description: null, pipelineStage: null, entityType: null })

    const provider = {
      name: 'mock',
      isAvailable: vi.fn().mockResolvedValue(true),
      generateSummary: vi.fn()
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce(JSON.stringify({
          noteTitle: 'PM', noteContent: '## Notes', fieldUpdates: [], tasks: [],
        })),
    }

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(results).toHaveLength(2)
    const errored = results.find(r => r.companyId === 'co-1')
    const ok = results.find(r => r.companyId === 'co-2')
    expect(errored?.error).toBe('LLM timeout')
    expect(ok?.error).toBeUndefined()
  })

  it('LLM returns invalid JSON: proposal has error set', async () => {
    const provider = {
      name: 'mock',
      isAvailable: vi.fn(),
      generateSummary: vi.fn().mockResolvedValue('here is some prose, not JSON at all'),
    }
    const digest = makeDigest({ items: [makeItem()] })

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(results[0].error).toContain('unparseable')
  })

  it('non-discussed items are filtered out', async () => {
    const item = makeItem({ isDiscussed: false })
    const digest = makeDigest({ items: [item] })
    const provider = makeMockProvider()

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(results).toHaveLength(0)
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('items with no content are filtered out', async () => {
    const item = makeItem({ meetingNotes: null, brief: null, statusUpdate: null })
    const digest = makeDigest({ items: [item] })
    const provider = makeMockProvider()

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, new AbortController().signal,
    )

    expect(results).toHaveLength(0)
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('stops processing remaining companies when signal is aborted', async () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      makeItem({ id: `item-${i}`, companyId: `co-${i}`, companyName: `Company ${i}` }),
    )
    const digest = makeDigest({ items })
    mockGetCompany.mockImplementation((id: string) => ({
      id, canonicalName: `Company ${id.split('-')[1]}`, description: null, pipelineStage: null, entityType: null,
    }))

    const controller = new AbortController()
    let callCount = 0

    const provider = {
      name: 'mock',
      isAvailable: vi.fn(),
      generateSummary: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 2) controller.abort()
        return JSON.stringify({ noteTitle: 'PM', noteContent: '## N', fieldUpdates: [], tasks: [] })
      }),
    }

    const results = await generateReconciliationProposals(
      digest, 'user-1', provider as any, () => {}, controller.signal,
    )

    // With concurrency 3 workers all checking !signal.aborted, abort will stop
    // shortly after it's triggered — not all 6 should be processed
    expect(results.length).toBeLessThan(6)
  })
})

// ─── applyReconciliationProposals ─────────────────────────────────────────────

describe('applyReconciliationProposals', () => {
  function makeInput(overrides: Partial<ApplyReconciliationInput> = {}): ApplyReconciliationInput {
    return {
      digestId: 'digest-1',
      meetingId: 'mtg-1',
      proposals: [
        {
          companyId: 'co-1',
          companyName: 'Acme Corp',
          applyNote: true,
          noteContent: '## Discussion\nContent here.\n\n---\n*Source: Partner Meeting — March 18, 2026*',
          applyFieldUpdates: true,
          fieldUpdates: [{ field: 'pipelineStage', from: 'diligence', to: 'decision' }],
          applyTasks: true,
          tasks: [{ title: 'Send intro', category: 'action_item', assignee: 'Sarah', dueDate: null }],
        },
      ],
      ...overrides,
    }
  }

  it('happy path: creates note + updates fields + creates tasks for accepted proposals', () => {
    const result = applyReconciliationProposals(makeInput(), 'user-1')

    expect(result.applied).toBe(1)
    expect(result.failed).toHaveLength(0)

    // Note created in DB
    const note = testDb.prepare('SELECT * FROM notes WHERE company_id = ? AND source_digest_id = ?')
      .get('co-1', 'digest-1') as Record<string, unknown> | undefined
    expect(note).toBeTruthy()
    expect(note?.content).toContain('Discussion')

    // Field update called
    expect(mockUpdateCompany).toHaveBeenCalledWith(
      'co-1',
      { pipelineStage: 'decision' },
      'user-1',
    )

    // Tasks created
    expect(mockBulkCreateTasks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Send intro',
          category: 'action_item',
          companyId: 'co-1',
          meetingId: 'mtg-1',
          source: 'auto',
        }),
      ]),
      'user-1',
    )
  })

  it('idempotent: second run with same source_digest_id skips note creation', () => {
    applyReconciliationProposals(makeInput(), 'user-1')
    applyReconciliationProposals(makeInput(), 'user-1')

    const count = testDb
      .prepare('SELECT COUNT(*) as n FROM notes WHERE company_id = ? AND source_digest_id = ?')
      .get('co-1', 'digest-1') as { n: number }
    expect(count.n).toBe(1)
  })

  it('rejects invalid pipelineStage value in fieldUpdates', () => {
    const input = makeInput({
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '',
        applyFieldUpdates: true,
        fieldUpdates: [{ field: 'pipelineStage', from: null, to: 'INVALID_STAGE' }],
        applyTasks: false,
        tasks: [],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    expect(mockUpdateCompany).not.toHaveBeenCalled()
  })

  it('partial DB failure: failed company in failed[], others still applied', () => {
    mockUpdateCompany.mockImplementationOnce(() => { throw new Error('DB error') })

    const input = makeInput({
      proposals: [
        {
          companyId: 'co-1',
          companyName: 'Acme',
          applyNote: false,
          noteContent: '',
          applyFieldUpdates: true,
          fieldUpdates: [{ field: 'pipelineStage', from: 'diligence', to: 'decision' }],
          applyTasks: false,
          tasks: [],
        },
        {
          companyId: 'co-2',
          companyName: 'Beta',
          applyNote: true,
          noteContent: '## Beta notes',
          applyFieldUpdates: false,
          fieldUpdates: [],
          applyTasks: false,
          tasks: [],
        },
      ],
    })

    const result = applyReconciliationProposals(input, 'user-1')

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].companyName).toBe('Acme')
    expect(result.applied).toBe(1)

    // Beta note was still created
    const betaNote = testDb
      .prepare('SELECT * FROM notes WHERE company_id = ?')
      .get('co-2') as Record<string, unknown> | undefined
    expect(betaNote).toBeTruthy()
  })

  it('applyNote=false: skips note creation', () => {
    const input = makeInput({
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '## Content',
        applyFieldUpdates: false,
        fieldUpdates: [],
        applyTasks: false,
        tasks: [],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    const note = testDb.prepare('SELECT * FROM notes WHERE company_id = ?').get('co-1')
    expect(note).toBeUndefined()
  })

  it('applyFieldUpdates=false: skips field updates', () => {
    const input = makeInput({
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '',
        applyFieldUpdates: false,
        fieldUpdates: [{ field: 'pipelineStage', from: 'diligence', to: 'decision' }],
        applyTasks: false,
        tasks: [],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    expect(mockUpdateCompany).not.toHaveBeenCalled()
  })

  it('applyTasks=false: skips task creation', () => {
    const input = makeInput({
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '',
        applyFieldUpdates: false,
        fieldUpdates: [],
        applyTasks: false,
        tasks: [{ title: 'Some task', category: 'action_item', assignee: null, dueDate: null }],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    expect(mockBulkCreateTasks).not.toHaveBeenCalled()
  })

  it('tasks get companyId + meetingId + source=auto set correctly', () => {
    const input = makeInput({
      meetingId: 'mtg-xyz',
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '',
        applyFieldUpdates: false,
        fieldUpdates: [],
        applyTasks: true,
        tasks: [
          { title: 'Decision made', category: 'decision', assignee: null, dueDate: null },
        ],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    expect(mockBulkCreateTasks).toHaveBeenCalledWith(
      [expect.objectContaining({
        companyId: 'co-1',
        meetingId: 'mtg-xyz',
        source: 'auto',
        category: 'decision',
      })],
      'user-1',
    )
  })

  it('empty tasks[]: bulkCreate not called', () => {
    const input = makeInput({
      proposals: [{
        companyId: 'co-1',
        companyName: 'Acme',
        applyNote: false,
        noteContent: '',
        applyFieldUpdates: false,
        fieldUpdates: [],
        applyTasks: true,
        tasks: [],
      }],
    })

    applyReconciliationProposals(input, 'user-1')

    expect(mockBulkCreateTasks).not.toHaveBeenCalled()
  })
})
