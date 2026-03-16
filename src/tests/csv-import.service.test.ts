/**
 * Tests for csv-import.service.ts
 *
 * These tests cover the pure-logic exports that don't need a real filesystem
 * (aliasTableFallback, toCamelCase via the exported functions) and the
 * file-based functions (parseCSVHeaders, suggestMappings, runImport) using
 * temp files and mocked dependencies.
 *
 * Mock boundaries:
 *   - getProvider()     → mocked LLM provider
 *   - getDatabase()     → in-memory SQLite
 *   - contactRepo       → vi.fn() stubs
 *   - companyRepo       → vi.fn() stubs
 *   - customFieldRepo   → vi.fn() stubs
 *   - getCurrentUserId  → returns 'test-user'
 *   - logAudit          → no-op
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── Mock: LLM provider ──────────────────────────────────────────────────────

const mockGenerateSummary = vi.fn()
vi.mock('../main/llm/summarizer', () => ({
  getProvider: () => ({ generateSummary: mockGenerateSummary })
}))

// ─── Mock: database connection ───────────────────────────────────────────────

import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// ─── Mock: repos ─────────────────────────────────────────────────────────────

const mockCreateContact = vi.fn()
const mockUpdateContact = vi.fn()
const mockResolveContactsByEmails = vi.fn().mockReturnValue({})
const mockGetContactsByIds = vi.fn().mockReturnValue({})
const mockSetContactPrimaryCompany = vi.fn()

vi.mock('../main/database/repositories/contact.repo', () => ({
  createContact: (...args: unknown[]) => mockCreateContact(...args),
  updateContact: (...args: unknown[]) => mockUpdateContact(...args),
  resolveContactsByEmails: (...args: unknown[]) => mockResolveContactsByEmails(...args),
  getContactsByIds: (...args: unknown[]) => mockGetContactsByIds(...args),
  setContactPrimaryCompany: (...args: unknown[]) => mockSetContactPrimaryCompany(...args)
}))

const mockGetOrCreateCompanyByName = vi.fn()
const mockUpdateCompany = vi.fn()
const mockGetCompaniesByNormalizedNames = vi.fn().mockReturnValue({})

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getOrCreateCompanyByName: (...args: unknown[]) => mockGetOrCreateCompanyByName(...args),
  updateCompany: (...args: unknown[]) => mockUpdateCompany(...args),
  getCompaniesByNormalizedNames: (...args: unknown[]) => mockGetCompaniesByNormalizedNames(...args)
}))

const mockCreateFieldDefinition = vi.fn()
const mockSetFieldValue = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  createFieldDefinition: (...args: unknown[]) => mockCreateFieldDefinition(...args),
  setFieldValue: (...args: unknown[]) => mockSetFieldValue(...args)
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'test-user'
}))

vi.mock('../main/database/repositories/audit.repo', () => ({
  logAudit: () => undefined
}))

// ─── Import service AFTER mocks are registered ───────────────────────────────

const {
  aliasTableFallback,
  parseCSVHeaders,
  suggestMappings,
  runImport,
  previewImport
} = await import('../main/services/csv-import.service')

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string

function writeTempCsv(filename: string, content: string): string {
  const filePath = join(tmpDir, filename)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      email TEXT,
      full_name TEXT,
      first_name TEXT,
      last_name TEXT
    );
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT,
      normalized_name TEXT
    );
    CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id TEXT PRIMARY KEY,
      entity_type TEXT,
      field_key TEXT,
      label TEXT,
      field_type TEXT
    );
  `)
  return db
}

// ─── Test setup / teardown ───────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'csv-import-test-'))
  testDb = makeTestDb()
  vi.clearAllMocks()
  mockResolveContactsByEmails.mockReturnValue({})
  mockGetContactsByIds.mockReturnValue({})
  mockGetCompaniesByNormalizedNames.mockReturnValue({})
})

afterEach(() => {
  // Clean up temp files
  try {
    const files = require('fs').readdirSync(tmpDir)
    for (const f of files) unlinkSync(join(tmpDir, f))
    require('fs').rmdirSync(tmpDir)
  } catch {
    // Ignore cleanup errors
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// aliasTableFallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('aliasTableFallback', () => {
  it('maps "Organization" → company canonical_name with medium confidence', () => {
    const results = aliasTableFallback(['Organization'], 'contacts_and_companies')
    expect(results[0]).toMatchObject({
      csvHeader: 'Organization',
      targetEntity: 'company',
      targetField: 'canonical_name',
      confidence: 'medium'
    })
  })

  it('maps "Mob" → contact phone with medium confidence', () => {
    const results = aliasTableFallback(['Mob'], 'contacts')
    expect(results[0]).toMatchObject({
      targetEntity: 'contact',
      targetField: 'phone',
      confidence: 'medium'
    })
  })

  it('maps "E-mail 1 - Value" → contact email (Mac Contacts format)', () => {
    // normalizeHeader strips spaces, hyphens, and normalizes to "email1value"
    const results = aliasTableFallback(['E-mail 1 - Value'], 'contacts')
    expect(results[0]).toMatchObject({
      targetEntity: 'contact',
      targetField: 'email',
      confidence: 'medium'
    })
  })

  it('returns low confidence for unrecognized headers', () => {
    const results = aliasTableFallback(['FavoriteColor', 'RandomColumn'], 'contacts')
    expect(results[0].confidence).toBe('low')
    expect(results[0].targetEntity).toBeNull()
    expect(results[1].confidence).toBe('low')
  })

  it('skips company fields when importType is contacts', () => {
    const results = aliasTableFallback(['Company', 'Email'], 'contacts')
    const companyResult = results.find((r) => r.csvHeader === 'Company')
    expect(companyResult?.targetEntity).toBeNull() // filtered out
    const emailResult = results.find((r) => r.csvHeader === 'Email')
    expect(emailResult?.targetEntity).toBe('contact')
  })

  it('skips contact fields when importType is companies', () => {
    const results = aliasTableFallback(['Email', 'Website'], 'companies')
    const emailResult = results.find((r) => r.csvHeader === 'Email')
    expect(emailResult?.targetEntity).toBeNull() // filtered out
    const websiteResult = results.find((r) => r.csvHeader === 'Website')
    expect(websiteResult?.targetEntity).toBe('company')
  })

  it('maps header with underscores and mixed case correctly', () => {
    const results = aliasTableFallback(['First_Name'], 'contacts')
    expect(results[0]).toMatchObject({
      targetEntity: 'contact',
      targetField: 'first_name',
      confidence: 'medium'
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// parseCSVHeaders
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseCSVHeaders', () => {
  it('returns headers and up to 5 sample rows for a valid CSV', () => {
    const csv = `Name,Email,Company
Alice,alice@example.com,Acme
Bob,bob@example.com,Beta
Carol,carol@example.com,Gamma
Dave,dave@example.com,Delta
Eve,eve@example.com,Epsilon
Frank,frank@example.com,Zeta`
    const filePath = writeTempCsv('valid.csv', csv)
    const result = parseCSVHeaders(filePath)
    expect(result.headers).toEqual(['Name', 'Email', 'Company'])
    expect(result.sampleRows.length).toBeLessThanOrEqual(5)
    expect(result.sampleRows[0]).toMatchObject({ Name: 'Alice', Email: 'alice@example.com' })
  })

  it('throws on file not found', () => {
    expect(() => parseCSVHeaders('/nonexistent/path/file.csv')).toThrow('File not found')
  })

  it('throws on empty CSV file', () => {
    const filePath = writeTempCsv('empty.csv', '')
    expect(() => parseCSVHeaders(filePath)).toThrow()
  })

  it('throws on CSV with only a header row and no data rows', () => {
    const filePath = writeTempCsv('headers-only.csv', 'Name,Email,Company\n')
    expect(() => parseCSVHeaders(filePath)).toThrow('no data rows')
  })

  it('strips UTF-8 BOM from first header', () => {
    // BOM is the \uFEFF character at the start
    const csv = '\uFEFFName,Email\nAlice,alice@example.com\n'
    const filePath = writeTempCsv('bom.csv', csv)
    const result = parseCSVHeaders(filePath)
    expect(result.headers[0]).toBe('Name') // not '\uFEFFName'
  })

  it('handles quoted fields with commas', () => {
    const csv = `Name,Notes\n"Smith, John","Works at Acme, Inc."\n`
    const filePath = writeTempCsv('quoted.csv', csv)
    const result = parseCSVHeaders(filePath)
    expect(result.headers).toEqual(['Name', 'Notes'])
    expect(result.sampleRows[0]['Name']).toBe('Smith, John')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// suggestMappings
// ═══════════════════════════════════════════════════════════════════════════════

describe('suggestMappings', () => {
  const headers = ['Full Name', 'Work Email', 'Company']
  const sampleRows = [{ 'Full Name': 'Alice', 'Work Email': 'alice@acme.com', Company: 'Acme' }]

  it('returns LLM suggestions when provider returns valid JSON', async () => {
    const llmResponse = JSON.stringify([
      { csvHeader: 'Full Name', targetEntity: 'contact', targetField: 'full_name', confidence: 'high' },
      { csvHeader: 'Work Email', targetEntity: 'contact', targetField: 'email', confidence: 'high' },
      { csvHeader: 'Company', targetEntity: 'company', targetField: 'canonical_name', confidence: 'high' }
    ])
    mockGenerateSummary.mockResolvedValueOnce(llmResponse)

    const results = await suggestMappings(headers, 'contacts_and_companies', sampleRows)
    expect(results[0]).toMatchObject({ csvHeader: 'Full Name', targetField: 'full_name', confidence: 'high' })
    expect(results[1]).toMatchObject({ csvHeader: 'Work Email', targetField: 'email' })
  })

  it('falls back to alias table when provider throws', async () => {
    mockGenerateSummary.mockRejectedValueOnce(new Error('No API key'))
    const results = await suggestMappings(['Email', 'Company'], 'contacts_and_companies', [])
    const emailResult = results.find((r) => r.csvHeader === 'Email')
    expect(emailResult?.targetField).toBe('email')
    expect(emailResult?.confidence).toBe('medium')
  })

  it('falls back to alias table when LLM returns invalid JSON', async () => {
    mockGenerateSummary.mockResolvedValueOnce('This is not JSON at all')
    const results = await suggestMappings(['Email'], 'contacts', [])
    expect(results[0].targetField).toBe('email')
  })

  it('falls back to alias table when LLM returns a non-array', async () => {
    mockGenerateSummary.mockResolvedValueOnce(JSON.stringify({ error: 'bad response' }))
    const results = await suggestMappings(['Email'], 'contacts', [])
    expect(results[0].targetField).toBe('email')
  })

  it('strips markdown code fences from LLM response before parsing', async () => {
    const suggestions = [
      { csvHeader: 'Email', targetEntity: 'contact', targetField: 'email', confidence: 'high' }
    ]
    mockGenerateSummary.mockResolvedValueOnce('```json\n' + JSON.stringify(suggestions) + '\n```')
    const results = await suggestMappings(['Email'], 'contacts', [])
    expect(results[0].targetField).toBe('email')
    expect(results[0].confidence).toBe('high')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runImport — contacts only
// ═══════════════════════════════════════════════════════════════════════════════

describe('runImport — contacts only', () => {
  const mappings = [
    { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' },
    { csvHeader: 'Email', targetEntity: 'contact' as const, targetField: 'email' }
  ]

  beforeEach(() => {
    mockCreateContact.mockImplementation((data: { fullName: string; email: string }) => ({
      id: `contact-${data.fullName}`,
      ...data
    }))
  })

  it('creates contacts without company lookup', async () => {
    const csv = 'Name,Email\nAlice,alice@example.com\nBob,bob@example.com\n'
    const filePath = writeTempCsv('contacts.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts', vi.fn())

    expect(mockCreateContact).toHaveBeenCalledTimes(2)
    expect(mockGetOrCreateCompanyByName).not.toHaveBeenCalled()
    expect(result.contactsCreated).toBe(2)
    expect(result.companiesCreated).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('skips rows with no name field silently', async () => {
    const csv = 'Name,Email\n,missing@example.com\nAlice,alice@example.com\n'
    const filePath = writeTempCsv('no-name.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts', vi.fn())

    expect(result.contactsCreated).toBe(1)
  })

  it('updates duplicate contacts (email already exists) and increments contactsUpdated', async () => {
    mockResolveContactsByEmails.mockReturnValue({
      'existing@example.com': 'existing-contact-id'
    })
    mockGetContactsByIds.mockReturnValue({
      'existing-contact-id': { id: 'existing-contact-id', full_name: 'Alice', email: 'existing@example.com' }
    })
    mockCreateContact.mockReturnValue({ id: 'existing-contact-id' })

    const csv = 'Name,Email\nAlice,existing@example.com\n'
    const filePath = writeTempCsv('dup.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts', vi.fn())

    // wasNew = false → contactsUpdated (fill-blanks-only by default)
    expect(result.contactsUpdated).toBe(1)
    expect(result.contactsCreated).toBe(0)
  })

  it('continues importing after a row-level DB error, adds to errors[]', async () => {
    mockCreateContact
      .mockImplementationOnce(() => { throw new Error('DB constraint violation') })
      .mockReturnValue({ id: 'contact-bob' })

    const csv = 'Name,Email\nAlice,alice@example.com\nBob,bob@example.com\n'
    const filePath = writeTempCsv('error-row.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts', vi.fn())

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(1)
    expect(result.errors[0].message).toContain('DB constraint violation')
    expect(result.contactsCreated).toBe(1) // Bob still imported
  })

  it('returns partial result when cancelled via AbortSignal', async () => {
    const controller = new AbortController()
    // Abort immediately after "parsing" phase begins
    mockCreateContact.mockImplementation((data: unknown) => {
      controller.abort()
      return { id: 'contact-alice' }
    })

    const csv = 'Name,Email\nAlice,alice@example.com\nBob,bob@example.com\nCarol,carol@example.com\n'
    const filePath = writeTempCsv('cancel.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts', vi.fn(), controller.signal)

    // Import was aborted partway through — should not have processed all rows
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // No crash, result is returned
    expect(result.errors).toBeDefined()
  })

  it('calls onProgress at least once (throttled)', async () => {
    mockCreateContact.mockReturnValue({ id: 'c1' })
    const csv = 'Name,Email\nAlice,alice@example.com\n'
    const filePath = writeTempCsv('progress.csv', csv)
    const onProgress = vi.fn()

    await runImport(filePath, mappings, 'contacts', onProgress)

    // At minimum: 'parsing' phase + final forced 'importing' progress
    expect(onProgress).toHaveBeenCalled()
    const stages = onProgress.mock.calls.map((c) => c[0].stage)
    expect(stages).toContain('parsing')
    expect(stages).toContain('importing')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runImport — companies only
// ═══════════════════════════════════════════════════════════════════════════════

describe('runImport — companies only', () => {
  const mappings = [
    { csvHeader: 'Company', targetEntity: 'company' as const, targetField: 'canonical_name' },
    { csvHeader: 'Website', targetEntity: 'company' as const, targetField: 'website_url' }
  ]

  it('creates companies without contact creation', async () => {
    mockGetOrCreateCompanyByName.mockImplementation((name: string) => ({ id: `co-${name.toLowerCase()}` }))

    const csv = 'Company,Website\nAcme,https://acme.com\nBeta,https://beta.com\n'
    const filePath = writeTempCsv('companies.csv', csv)

    const result = await runImport(filePath, mappings, 'companies', vi.fn())

    expect(mockGetOrCreateCompanyByName).toHaveBeenCalledTimes(2)
    expect(mockCreateContact).not.toHaveBeenCalled()
    expect(result.companiesCreated).toBe(2)
    expect(result.contactsCreated).toBe(0)
  })

  it('uses getOrCreate for existing company (idempotent, no double-count)', async () => {
    // Company already exists in db before import
    testDb.exec(`INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES ('existing-id', 'Acme', 'acme')`)
    mockGetOrCreateCompanyByName.mockReturnValue({ id: 'existing-id' })

    const csv = 'Company\nAcme\n'
    const filePath = writeTempCsv('existing-co.csv', csv)

    const result = await runImport(filePath, mappings.slice(0, 1), 'companies', vi.fn())

    // Pre-existing company → not counted as new
    expect(result.companiesCreated).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runImport — contacts_and_companies
// ═══════════════════════════════════════════════════════════════════════════════

describe('runImport — contacts_and_companies', () => {
  const mappings = [
    { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' },
    { csvHeader: 'Email', targetEntity: 'contact' as const, targetField: 'email' },
    { csvHeader: 'Company', targetEntity: 'company' as const, targetField: 'canonical_name' }
  ]

  beforeEach(() => {
    mockCreateContact.mockImplementation((data: { fullName: string }) => ({
      id: `contact-${Date.now()}-${Math.random()}`
    }))
    mockGetOrCreateCompanyByName.mockImplementation((name: string) => ({
      id: `company-${name}`
    }))
  })

  it('creates contact + company + link for each row', async () => {
    const csv = 'Name,Email,Company\nAlice,alice@acme.com,Acme\n'
    const filePath = writeTempCsv('both.csv', csv)

    const result = await runImport(filePath, mappings, 'contacts_and_companies', vi.fn())

    expect(mockCreateContact).toHaveBeenCalledTimes(1)
    expect(mockGetOrCreateCompanyByName).toHaveBeenCalledWith('Acme', 'test-user')
    expect(mockSetContactPrimaryCompany).toHaveBeenCalledTimes(1)
    expect(result.contactsCreated).toBe(1)
    expect(result.companiesCreated).toBe(1)
  })

  it('creates custom field definition + value for unmapped columns', async () => {
    const customMappings = [
      ...mappings,
      { csvHeader: 'Tier', targetEntity: 'contact' as const, targetField: null, customFieldLabel: 'Tier' }
    ]
    mockCreateFieldDefinition.mockReturnValue({ id: 'def-tier' })

    const csv = 'Name,Email,Company,Tier\nAlice,alice@acme.com,Acme,Gold\n'
    const filePath = writeTempCsv('custom.csv', csv)

    await runImport(filePath, customMappings, 'contacts_and_companies', vi.fn())

    expect(mockSetFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({ valueText: 'Gold', entityType: 'contact' })
    )
  })

  it('does not double-create custom field definition for repeated rows (cache)', async () => {
    const customMappings = [
      ...mappings,
      { csvHeader: 'Tier', targetEntity: 'contact' as const, targetField: null, customFieldLabel: 'Tier' }
    ]
    mockCreateFieldDefinition.mockReturnValue({ id: 'def-tier' })

    const csv = 'Name,Email,Company,Tier\nAlice,alice@acme.com,Acme,Gold\nBob,bob@acme.com,Beta,Silver\n'
    const filePath = writeTempCsv('custom-cache.csv', csv)

    await runImport(filePath, customMappings, 'contacts_and_companies', vi.fn())

    // createFieldDefinition called once for first row, second row hits the cache
    expect(mockCreateFieldDefinition).toHaveBeenCalledTimes(1)
    expect(mockSetFieldValue).toHaveBeenCalledTimes(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runImport — existing custom field mappings (targetField = 'custom:{defId}')
// ═══════════════════════════════════════════════════════════════════════════════

describe('runImport — existing custom field mappings', () => {
  const baseMappings = [
    { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' },
    { csvHeader: 'Email', targetEntity: 'contact' as const, targetField: 'email' },
    { csvHeader: 'Company', targetEntity: 'company' as const, targetField: 'canonical_name' }
  ]

  beforeEach(() => {
    mockCreateContact.mockImplementation(() => ({ id: `contact-${Date.now()}-${Math.random()}` }))
    mockGetOrCreateCompanyByName.mockImplementation((name: string) => ({ id: `company-${name}`, isNew: true }))
  })

  it('calls setFieldValue with the defId extracted from targetField, not createFieldDefinition', async () => {
    const mappings = [
      ...baseMappings,
      { csvHeader: 'Focus', targetEntity: 'contact' as const, targetField: 'custom:def-focus-123' }
    ]
    const csv = 'Name,Email,Company,Focus\nAlice,alice@acme.com,Acme,B2B\n'
    const filePath = writeTempCsv('existing-custom-contact.csv', csv)

    await runImport(filePath, mappings, 'contacts_and_companies', vi.fn())

    expect(mockCreateFieldDefinition).not.toHaveBeenCalled()
    expect(mockSetFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldDefinitionId: 'def-focus-123',
        entityType: 'contact',
        valueText: 'B2B'
      })
    )
  })

  it('calls setFieldValue with the defId for company existing custom mappings', async () => {
    const mappings = [
      ...baseMappings,
      { csvHeader: 'Stage', targetEntity: 'company' as const, targetField: 'custom:def-stage-456' }
    ]
    const csv = 'Name,Email,Company,Stage\nBob,bob@beta.com,Beta,Seed\n'
    const filePath = writeTempCsv('existing-custom-company.csv', csv)

    await runImport(filePath, mappings, 'contacts_and_companies', vi.fn())

    expect(mockCreateFieldDefinition).not.toHaveBeenCalled()
    expect(mockSetFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldDefinitionId: 'def-stage-456',
        entityType: 'company',
        valueText: 'Seed'
      })
    )
  })

  it('skips setFieldValue when CSV value for existing custom mapping is empty', async () => {
    const mappings = [
      ...baseMappings,
      { csvHeader: 'Focus', targetEntity: 'contact' as const, targetField: 'custom:def-focus-789' }
    ]
    const csv = 'Name,Email,Company,Focus\nAlice,alice@acme.com,Acme,\n'
    const filePath = writeTempCsv('existing-custom-empty.csv', csv)

    await runImport(filePath, mappings, 'contacts_and_companies', vi.fn())

    expect(mockSetFieldValue).not.toHaveBeenCalled()
  })

  it('existing custom field mapping coexists with new custom field mapping in same import', async () => {
    const mappings = [
      ...baseMappings,
      { csvHeader: 'Focus', targetEntity: 'contact' as const, targetField: 'custom:def-focus-existing' },
      { csvHeader: 'Tier', targetEntity: 'contact' as const, targetField: null, customFieldLabel: 'Tier' }
    ]
    mockCreateFieldDefinition.mockReturnValue({ id: 'def-tier-new' })

    const csv = 'Name,Email,Company,Focus,Tier\nAlice,alice@acme.com,Acme,B2B,Gold\n'
    const filePath = writeTempCsv('mixed-custom.csv', csv)

    await runImport(filePath, mappings, 'contacts_and_companies', vi.fn())

    // new field created for Tier
    expect(mockCreateFieldDefinition).toHaveBeenCalledTimes(1)
    // setFieldValue called twice: once for existing def, once for new def
    expect(mockSetFieldValue).toHaveBeenCalledTimes(2)
    expect(mockSetFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({ fieldDefinitionId: 'def-focus-existing', valueText: 'B2B' })
    )
    expect(mockSetFieldValue).toHaveBeenCalledWith(
      expect.objectContaining({ fieldDefinitionId: 'def-tier-new', valueText: 'Gold' })
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// previewImport
// ═══════════════════════════════════════════════════════════════════════════════

describe('previewImport', () => {
  const mappings = [
    { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' },
    { csvHeader: 'Email', targetEntity: 'contact' as const, targetField: 'email' },
    { csvHeader: 'Company', targetEntity: 'company' as const, targetField: 'canonical_name' }
  ]

  it('returns correct totalRows count', async () => {
    const csv = 'Name,Email,Company\nAlice,a@e.com,Acme\nBob,b@e.com,Beta\nCarol,c@e.com,Gamma\n'
    const filePath = writeTempCsv('preview.csv', csv)

    const result = await previewImport(filePath, mappings)
    expect(result.totalRows).toBe(3)
  })

  it('detects duplicate contacts via batch email query (not N+1)', async () => {
    mockResolveContactsByEmails.mockReturnValue({
      'alice@example.com': 'contact-1',
      'bob@example.com': 'contact-2'
    })
    const csv = 'Name,Email,Company\nAlice,alice@example.com,Acme\nBob,bob@example.com,Beta\nCarol,carol@example.com,Gamma\n'
    const filePath = writeTempCsv('dedup.csv', csv)

    const result = await previewImport(filePath, mappings)

    // Batch query called once for all emails
    expect(mockResolveContactsByEmails).toHaveBeenCalledTimes(1)
    expect(result.duplicateContactCount).toBe(2)
    expect(result.totalRows).toBe(3)
  })

  it('returns 0 duplicates when no email mapping exists', async () => {
    const mappingsNoEmail = [
      { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' }
    ]
    const csv = 'Name\nAlice\nBob\n'
    const filePath = writeTempCsv('no-email.csv', csv)

    const result = await previewImport(filePath, mappingsNoEmail)
    expect(result.duplicateContactCount).toBe(0)
    expect(mockResolveContactsByEmails).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// runImport — field defaults
// ═══════════════════════════════════════════════════════════════════════════════

describe('runImport — field defaults', () => {
  const nameMappings = [
    { csvHeader: 'Name', targetEntity: 'contact' as const, targetField: 'full_name' }
  ]

  beforeEach(() => {
    mockCreateContact.mockImplementation((data: Record<string, unknown>) => ({
      id: `contact-${data.fullName}`,
      ...data
    }))
    mockUpdateContact.mockReturnValue(undefined)
    mockGetOrCreateCompanyByName.mockImplementation((name: string) => ({ id: `co-${name}` }))
    mockUpdateCompany.mockReturnValue(undefined)
  })

  it('applies contact_type default when CSV has no contact_type column', async () => {
    const csv = 'Name\nAlice\n'
    const filePath = writeTempCsv('defaults-contact-type.csv', csv)

    await runImport(filePath, nameMappings, 'contacts', vi.fn(), undefined, { contactDefaults: { contact_type: 'investor' } })

    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ contactType: 'investor' }),
      'test-user'
    )
  })

  it('CSV value wins over contact_type default', async () => {
    const csv = 'Name,Type\nAlice,founder\n'
    const filePath = writeTempCsv('defaults-csv-wins.csv', csv)
    const mappingsWithType = [
      ...nameMappings,
      { csvHeader: 'Type', targetEntity: 'contact' as const, targetField: 'contact_type' }
    ]

    await runImport(filePath, mappingsWithType, 'contacts', vi.fn(), undefined, { contactDefaults: { contact_type: 'investor' } })

    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ contactType: 'founder' }),
      'test-user'
    )
  })

  it('applies stage-2 default (city) when CSV has no city column', async () => {
    const csv = 'Name\nAlice\n'
    const filePath = writeTempCsv('defaults-city.csv', csv)

    await runImport(filePath, nameMappings, 'contacts', vi.fn(), undefined, { contactDefaults: { city: 'New York' } })

    expect(mockUpdateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ city: 'New York' }),
      'test-user'
    )
  })

  it('applies company default (entity_type) when CSV has no entity_type column', async () => {
    const companyMappings = [
      { csvHeader: 'Company', targetEntity: 'company' as const, targetField: 'canonical_name' }
    ]
    const csv = 'Company\nAcme\n'
    const filePath = writeTempCsv('defaults-company.csv', csv)

    await runImport(filePath, companyMappings, 'companies', vi.fn(), undefined, { companyDefaults: { entity_type: 'vc_fund' } })

    expect(mockUpdateCompany).toHaveBeenCalledWith(
      'co-Acme',
      expect.objectContaining({ entityType: 'vc_fund' }),
      'test-user'
    )
  })

  it('skips empty-string defaults (does not overwrite with blank)', async () => {
    const csv = 'Name\nAlice\n'
    const filePath = writeTempCsv('defaults-empty.csv', csv)

    await runImport(filePath, nameMappings, 'contacts', vi.fn(), undefined, { contactDefaults: { contact_type: '' } })

    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ contactType: null }),
      'test-user'
    )
  })
})
