/**
 * Tests for contact-summary-sync.service.ts
 *
 * Mock boundaries:
 *   - contact.repo (getContact, resolveContactsByEmails) → vi.fn() stubs
 *   - org-company.repo (getDatabase) → in-memory SQLite via connection mock
 *   - file-manager (readSummary) → vi.fn() stub
 *   - meeting.repo (getMeeting) → vi.fn() stub
 *   - database/connection (getDatabase) → in-memory SQLite
 *
 * The LLM provider is injected directly into getContactSummaryUpdateProposals,
 * so no module-level mock is needed for it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// ─── Mock: database connection ────────────────────────────────────────────────

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// ─── Mock: contact repo ───────────────────────────────────────────────────────

const mockGetContact = vi.fn()
const mockResolveContactsByEmails = vi.fn()

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: (...args: unknown[]) => mockGetContact(...args),
  resolveContactsByEmails: (...args: unknown[]) => mockResolveContactsByEmails(...args)
}))

// ─── Mock: custom-fields repo ─────────────────────────────────────────────────

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args)
}))

// ─── Mock: meeting repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args)
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args)
}))

// ─── Import service under test (after mocks) ─────────────────────────────────

const {
  getContactSummaryUpdateProposals,
  getContactSummaryUpdateProposalsFromMeetingId,
  findCompanyByName,
  matchSelectOption
} = await import('../main/services/contact-summary-sync.service')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    fullName: 'Alice Smith',
    title: null,
    phone: null,
    linkedinUrl: null,
    primaryCompanyId: null,
    fieldSources: null,
    fundSize: null,
    typicalCheckSizeMin: null,
    typicalCheckSizeMax: null,
    investmentStageFocus: null,
    investmentSectorFocus: null,
    ...overrides
  }
}

function makeMockProvider(responseJson: string) {
  return {
    name: 'mock',
    isAvailable: () => true,
    generateSummary: vi.fn().mockResolvedValue(responseJson)
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  testDb = makeTestDb()
  vi.clearAllMocks()
  // Default: no custom fields, no field values
  mockListFieldDefinitions.mockReturnValue([])
  mockGetFieldValuesForEntity.mockReturnValue([])
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getContactSummaryUpdateProposals', () => {
  it('test 1: happy path — extracts title from summary', async () => {
    const contact = makeContact()
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    const response = JSON.stringify({
      'alice@example.com': { title: 'Head of Product', phone: null, linkedinUrl: null, company: null }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice is Head of Product at Acme.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.updates.title).toBe('Head of Product')
    expect(proposals[0]!.changes).toHaveLength(1)
    expect(proposals[0]!.changes[0]!.field).toBe('title')
    expect(provider.generateSummary).toHaveBeenCalledOnce()
  })

  it('test 2: diff guard — no proposal when contact already has matching title', async () => {
    const contact = makeContact({ title: 'Head of Product' })
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    const response = JSON.stringify({
      'alice@example.com': { title: 'Head of Product', phone: null, linkedinUrl: null, company: null }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice is Head of Product.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 3: null contact guard — skips contact when getContact returns null', async () => {
    mockGetContact.mockReturnValue(null)

    const emailToContactId = { 'ghost@example.com': 'no-such-contact' }
    const response = JSON.stringify({
      'ghost@example.com': { title: 'CEO', phone: null, linkedinUrl: null, company: null }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Some summary text.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 4: malformed JSON — safeParseJson returns null → empty proposals, no crash', async () => {
    const provider = makeMockProvider("Sorry, I can't help with that.")

    const proposals = await getContactSummaryUpdateProposals(
      'Some meeting summary.',
      { 'alice@example.com': 'c1' },
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 5: LinkedIn URL validation — invalid format discarded', async () => {
    const contact = makeContact()
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    // Invalid: missing /in/ segment
    const response = JSON.stringify({
      'alice@example.com': { title: null, phone: null, linkedinUrl: 'linkedin.com/alice', company: null }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice Smith on LinkedIn.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 5b: LinkedIn URL validation — valid format accepted', async () => {
    const contact = makeContact()
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    const response = JSON.stringify({
      'alice@example.com': { title: null, phone: null, linkedinUrl: 'https://linkedin.com/in/alice-smith', company: null }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice Smith linkedin.com/in/alice-smith.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.updates.linkedinUrl).toContain('alice-smith')
  })

  it('test 6a: company link — matched company added as companyLink', async () => {
    testDb.prepare('INSERT INTO org_companies VALUES (?, ?)').run('co-1', 'Acme Corp')
    const contact = makeContact({ primaryCompanyId: null })
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    const response = JSON.stringify({
      'alice@example.com': { title: 'CEO', phone: null, linkedinUrl: null, company: 'Acme Corp' }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice is CEO at Acme Corp.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.companyLink).toBeDefined()
    expect(proposals[0]!.companyLink!.companyName).toBe('Acme Corp')
  })

  it('test 6b: company link — no proposal when company not found in DB', async () => {
    const contact = makeContact({ primaryCompanyId: null })
    mockGetContact.mockReturnValue(contact)

    const emailToContactId = { 'alice@example.com': 'c1' }
    const response = JSON.stringify({
      'alice@example.com': { title: null, phone: null, linkedinUrl: null, company: 'Unknown Co' }
    })
    const provider = makeMockProvider(response)

    const proposals = await getContactSummaryUpdateProposals(
      'Alice works at Unknown Co.',
      emailToContactId,
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 7: empty emailToContactId — returns [] immediately, no LLM call', async () => {
    const provider = makeMockProvider('{}')

    const proposals = await getContactSummaryUpdateProposals(
      'Some summary.',
      {},
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('test 8: provider.generateSummary throws — returns [], logs error', async () => {
    const contact = makeContact()
    mockGetContact.mockReturnValue(contact)

    const provider = {
      name: 'mock',
      isAvailable: () => true,
      generateSummary: vi.fn().mockRejectedValue(new Error('API timeout'))
    }

    const proposals = await getContactSummaryUpdateProposals(
      'Some summary.',
      { 'alice@example.com': 'c1' },
      provider,
      'meeting-1'
    )

    expect(proposals).toHaveLength(0)
  })
})

describe('getContactSummaryUpdateProposalsFromMeetingId', () => {
  it('test 9: null summaryPath — readSummary returns null → return []', async () => {
    mockGetMeeting.mockReturnValue({
      id: 'meeting-1',
      summaryPath: null,
      attendeeEmails: ['alice@example.com']
    })

    const provider = makeMockProvider('{}')

    const proposals = await getContactSummaryUpdateProposalsFromMeetingId('meeting-1', provider)

    expect(proposals).toHaveLength(0)
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('test 9b: meeting not found — returns []', async () => {
    mockGetMeeting.mockReturnValue(null)
    const provider = makeMockProvider('{}')

    const proposals = await getContactSummaryUpdateProposalsFromMeetingId('nonexistent', provider)

    expect(proposals).toHaveLength(0)
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })
})

describe('investor field enrichment', () => {
  it('test 10: fundSize extracted and proposed when not hidden', async () => {
    testDb.prepare(`INSERT INTO user_preferences VALUES ('cyggie:contact-hidden-fields', '[]')`).run()
    const contact = makeContact({ fundSize: null })
    mockGetContact.mockReturnValue(contact)

    const response = JSON.stringify({
      'alice@example.com': {
        title: null, phone: null, linkedinUrl: null, company: null,
        fundSize: 50000000, typicalCheckSizeMin: null, typicalCheckSizeMax: null,
        investmentStageFocus: null, investmentSectorFocus: null
      }
    })
    const proposals = await getContactSummaryUpdateProposals(
      'Alice runs a $50M fund.', { 'alice@example.com': 'c1' }, makeMockProvider(response), 'mtg-1'
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.updates.fundSize).toBe(50000000)
    expect(proposals[0]!.changes[0]!.field).toBe('fundSize')
  })

  it('test 11: hidden field guard — fundSize not proposed when hidden', async () => {
    testDb.prepare(`INSERT INTO user_preferences VALUES ('cyggie:contact-hidden-fields', '["fundSize"]')`).run()
    const contact = makeContact({ fundSize: null })
    mockGetContact.mockReturnValue(contact)

    const response = JSON.stringify({
      'alice@example.com': {
        title: null, phone: null, linkedinUrl: null, company: null, fundSize: 50000000
      }
    })
    const proposals = await getContactSummaryUpdateProposals(
      'Alice runs a $50M fund.', { 'alice@example.com': 'c1' }, makeMockProvider(response), 'mtg-1'
    )

    expect(proposals).toHaveLength(0)
  })

  it('test 12: investor-only change produces proposal — guard runs after investor blocks', async () => {
    testDb.prepare(`INSERT INTO user_preferences VALUES ('cyggie:contact-hidden-fields', '[]')`).run()
    const contact = makeContact({ title: null, phone: null, fundSize: null })
    mockGetContact.mockReturnValue(contact)

    // Only fundSize in LLM response — no title/phone/linkedin changes
    const response = JSON.stringify({
      'alice@example.com': {
        title: null, phone: null, linkedinUrl: null, company: null,
        fundSize: 25000000, investmentStageFocus: null, investmentSectorFocus: null
      }
    })
    const proposals = await getContactSummaryUpdateProposals(
      'Fund is $25M.', { 'alice@example.com': 'c1' }, makeMockProvider(response), 'mtg-1'
    )

    expect(proposals).toHaveLength(1) // would be 0 if guard ran before investor extraction
    expect(proposals[0]!.updates.fundSize).toBe(25000000)
  })
})

describe('matchSelectOption', () => {
  it('exact match returns canonical option', () => {
    expect(matchSelectOption('Seed', ['Pre-Seed', 'Seed', 'Series A'])).toBe('Seed')
  })

  it('fuzzy match "seed" returns "Seed"', () => {
    expect(matchSelectOption('seed', ['Pre-Seed', 'Seed', 'Series A'])).toBe('Seed')
  })

  it('no confident match returns null', () => {
    expect(matchSelectOption('completely unrelated text xyz', ['Pre-Seed', 'Seed', 'Series A'])).toBeNull()
  })
})

describe('select custom field enrichment', () => {
  it('test 14: select field fuzzy matched to canonical option', async () => {
    testDb.prepare(`INSERT INTO user_preferences VALUES ('cyggie:contact-hidden-fields', '[]')`).run()
    const contact = makeContact()
    mockGetContact.mockReturnValue(contact)
    mockListFieldDefinitions.mockReturnValue([{
      id: 'def-1',
      entityType: 'contact',
      fieldKey: 'investment_stage',
      label: 'Investment Stage',
      fieldType: 'select',
      optionsJson: '["Pre-Seed","Seed","Series A"]',
      isBuiltin: false,
      isRequired: false,
      sortOrder: 0,
      showInList: false,
      section: null,
      createdAt: '',
      updatedAt: ''
    }])
    mockGetFieldValuesForEntity.mockReturnValue([{
      id: 'def-1',
      entityType: 'contact',
      fieldKey: 'investment_stage',
      label: 'Investment Stage',
      fieldType: 'select',
      optionsJson: '["Pre-Seed","Seed","Series A"]',
      isBuiltin: false,
      isRequired: false,
      sortOrder: 0,
      showInList: false,
      section: null,
      createdAt: '',
      updatedAt: '',
      value: null
    }])

    const response = JSON.stringify({
      'alice@example.com': {
        title: null, phone: null, linkedinUrl: null, company: null,
        investment_stage: 'seed'
      }
    })
    const proposals = await getContactSummaryUpdateProposals(
      'Alice invests at seed stage.', { 'alice@example.com': 'c1' }, makeMockProvider(response), 'mtg-1'
    )

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.customFieldUpdates).toHaveLength(1)
    expect(proposals[0]!.customFieldUpdates![0]!.toDisplay).toBe('Seed') // canonical, not 'seed'
  })
})

describe('findCompanyByName', () => {
  it('finds exact match case-insensitively', () => {
    testDb.prepare('INSERT INTO org_companies VALUES (?, ?)').run('co-1', 'Acme Corp')

    const result = findCompanyByName('ACME CORP')
    expect(result).toBeDefined()
    expect(result!.id).toBe('co-1')
  })

  it('returns null for unknown company name', () => {
    const result = findCompanyByName('Totally Unknown Company XYZ')
    expect(result).toBeNull()
  })
})
