/**
 * CSV Import Service
 *
 * Handles parsing, field mapping suggestions, preview, and bulk import
 * from CSV files into the Cyggie contacts/companies database.
 *
 * Pipeline:
 *
 *   filePath ──▶ parseCSVHeaders()
 *                 │  validate size ≤ 50MB, csv-parse/sync first 6 rows
 *                 └──▶ { headers, sampleRows }
 *
 *   { headers, type,
 *     sampleRows } ──▶ suggestMappings()
 *                       │  try: getProvider().generateSummary(sys, user) ──▶ LLM
 *                       │       JSON.parse(response)
 *                       │  catch any error:
 *                       └──▶ normMatch + FIELD_ALIASES fallback
 *
 *   { filePath,
 *     mappings } ──▶ previewImport()
 *                     │  full async parse pass (streaming)
 *                     │  resolveContactsByEmails() ──▶ DB (1 batch query)
 *                     └──▶ { totalRows, dupContactCount, dupCompanyCount }
 *
 *   { filePath,
 *     mappings,
 *     importType,
 *     onProgress,
 *     signal } ──▶ runImport()
 *                   │  csv-parse async stream
 *                   │  for each row:
 *                   │    createContact() ──────────▶ DB
 *                   │    getOrCreateCompany() ──────▶ DB
 *                   │    setContactPrimaryCompany() ▶ DB
 *                   │    writeCustomFields() ────────▶ DB
 *                   │    check signal.aborted
 *                   │    throttle onProgress (250ms)
 *                   └──▶ ImportResult
 */

import { statSync, readFileSync, createReadStream } from 'fs'
import { parse } from 'csv-parse/sync'
import { parse as parseAsync } from 'csv-parse'
import type {
  FieldMapping,
  FieldDefaultsMap,
  MappingSuggestion,
  ImportType,
  ImportProgress,
  ImportResult,
  PreviewResult,
  CSVFileInfo
} from '../../shared/types/csv-import'
import { getProvider } from '../llm/summarizer'
import { getDatabase } from '../database/connection'
import * as contactRepo from '../database/repositories/contact.repo'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as customFieldRepo from '../database/repositories/custom-fields.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert snake_case to camelCase for repo update calls */
function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

// ─── Field key constants ────────────────────────────────────────────────────

export const CONTACT_FIELD_KEYS = [
  'full_name', 'first_name', 'last_name', 'email', 'phone', 'title',
  'contact_type', 'linkedin_url', 'twitter_handle', 'city', 'state',
  'timezone', 'pronouns', 'birthday', 'university', 'previous_companies',
  'tags', 'notes', 'relationship_strength', 'fund_size',
  'typical_check_size_min', 'typical_check_size_max',
  'investment_stage_focus', 'investment_sector_focus'
]

export const COMPANY_FIELD_KEYS = [
  'canonical_name', 'primary_domain', 'website_url', 'description', 'sector',
  'entity_type', 'city', 'state', 'founding_year', 'employee_count_range',
  'linkedin_company_url', 'twitter_handle', 'crunchbase_url', 'arr',
  'burn_rate', 'runway_months', 'total_funding_raised', 'last_funding_date',
  'pipeline_stage', 'priority', 'round', 'deal_source'
]

const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB

// ─── Alias table fallback ────────────────────────────────────────────────────

const FIELD_ALIASES: Record<string, { entity: 'contact' | 'company'; field: string }> = {
  // Contact — name
  name: { entity: 'contact', field: 'full_name' },
  fullname: { entity: 'contact', field: 'full_name' },
  firstname: { entity: 'contact', field: 'first_name' },
  first: { entity: 'contact', field: 'first_name' },
  lastname: { entity: 'contact', field: 'last_name' },
  last: { entity: 'contact', field: 'last_name' },
  surname: { entity: 'contact', field: 'last_name' },
  // Contact — email/phone
  email: { entity: 'contact', field: 'email' },
  emailaddress: { entity: 'contact', field: 'email' },
  email1value: { entity: 'contact', field: 'email' }, // Mac Contacts
  email2value: { entity: 'contact', field: 'email' }, // Mac Contacts secondary
  phone: { entity: 'contact', field: 'phone' },
  phonenumber: { entity: 'contact', field: 'phone' },
  mobile: { entity: 'contact', field: 'phone' },
  mob: { entity: 'contact', field: 'phone' },
  cell: { entity: 'contact', field: 'phone' },
  telephone: { entity: 'contact', field: 'phone' },
  // Contact — title/type
  title: { entity: 'contact', field: 'title' },
  jobtitle: { entity: 'contact', field: 'title' },
  role: { entity: 'contact', field: 'title' },
  position: { entity: 'contact', field: 'title' },
  contacttype: { entity: 'contact', field: 'contact_type' },
  type: { entity: 'contact', field: 'contact_type' },
  // Contact — social
  linkedin: { entity: 'contact', field: 'linkedin_url' },
  linkedinurl: { entity: 'contact', field: 'linkedin_url' },
  linkedinprofile: { entity: 'contact', field: 'linkedin_url' },
  twitter: { entity: 'contact', field: 'twitter_handle' },
  twitterhandle: { entity: 'contact', field: 'twitter_handle' },
  // Contact — location
  city: { entity: 'contact', field: 'city' },
  state: { entity: 'contact', field: 'state' },
  timezone: { entity: 'contact', field: 'timezone' },
  // Contact — notes
  notes: { entity: 'contact', field: 'notes' },
  note: { entity: 'contact', field: 'notes' },
  bio: { entity: 'contact', field: 'notes' },
  // Company — name
  company: { entity: 'company', field: 'canonical_name' },
  companyname: { entity: 'company', field: 'canonical_name' },
  organization: { entity: 'company', field: 'canonical_name' },
  organisation: { entity: 'company', field: 'canonical_name' },
  org: { entity: 'company', field: 'canonical_name' },
  employer: { entity: 'company', field: 'canonical_name' },
  // Company — web
  website: { entity: 'company', field: 'website_url' },
  websiteurl: { entity: 'company', field: 'website_url' },
  url: { entity: 'company', field: 'website_url' },
  domain: { entity: 'company', field: 'primary_domain' },
  primarydomain: { entity: 'company', field: 'primary_domain' },
  // Company — financials
  arr: { entity: 'company', field: 'arr' },
  annualrecurringrevenue: { entity: 'company', field: 'arr' },
  burnrate: { entity: 'company', field: 'burn_rate' },
  runway: { entity: 'company', field: 'runway_months' },
  runwaymonths: { entity: 'company', field: 'runway_months' },
  totalfunding: { entity: 'company', field: 'total_funding_raised' },
  totalfundingraised: { entity: 'company', field: 'total_funding_raised' },
  lastfundingdate: { entity: 'company', field: 'last_funding_date' },
  // Company — firmographics
  sector: { entity: 'company', field: 'sector' },
  industry: { entity: 'company', field: 'sector' },
  stage: { entity: 'company', field: 'pipeline_stage' },
  pipelinestage: { entity: 'company', field: 'pipeline_stage' },
  round: { entity: 'company', field: 'round' },
  fundinground: { entity: 'company', field: 'round' },
  employees: { entity: 'company', field: 'employee_count_range' },
  employeecount: { entity: 'company', field: 'employee_count_range' },
  teamsize: { entity: 'company', field: 'employee_count_range' },
  founded: { entity: 'company', field: 'founding_year' },
  foundingyear: { entity: 'company', field: 'founding_year' },
  yearfounded: { entity: 'company', field: 'founding_year' },
  priority: { entity: 'company', field: 'priority' },
  dealsource: { entity: 'company', field: 'deal_source' },
  source: { entity: 'company', field: 'deal_source' },
  description: { entity: 'company', field: 'description' },
  companydescription: { entity: 'company', field: 'description' },
  crunchbase: { entity: 'company', field: 'crunchbase_url' },
  crunchbaseurl: { entity: 'company', field: 'crunchbase_url' }
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s\-_./]+/g, '').replace(/[^a-z0-9]/g, '')
}

export function aliasTableFallback(
  headers: string[],
  importType: ImportType
): MappingSuggestion[] {
  const allFieldKeys = new Set([...CONTACT_FIELD_KEYS, ...COMPANY_FIELD_KEYS])

  return headers.map((h) => {
    const norm = normalizeHeader(h)

    // Try alias table first
    const alias = FIELD_ALIASES[norm]
    if (alias) {
      // Filter by import type: skip company fields for contacts-only import and vice versa
      if (importType === 'contacts' && alias.entity === 'company') {
        return { csvHeader: h, targetEntity: null, targetField: null, confidence: 'low' }
      }
      if (importType === 'companies' && alias.entity === 'contact') {
        return { csvHeader: h, targetEntity: null, targetField: null, confidence: 'low' }
      }
      return { csvHeader: h, targetEntity: alias.entity, targetField: alias.field, confidence: 'medium' }
    }

    // Try normalized exact match against known field keys
    if (allFieldKeys.has(norm)) {
      const entity = CONTACT_FIELD_KEYS.includes(norm) ? 'contact' : 'company'
      return { csvHeader: h, targetEntity: entity as 'contact' | 'company', targetField: norm, confidence: 'medium' }
    }

    return { csvHeader: h, targetEntity: null, targetField: null, confidence: 'low' }
  })
}

// ─── parseCSVHeaders ─────────────────────────────────────────────────────────

export function parseCSVHeaders(filePath: string): CSVFileInfo {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch {
    throw new Error('File not found. Please select the file again.')
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${Math.round(stat.size / 1024 / 1024)}MB). Maximum is 50MB.`)
  }

  if (stat.size === 0) {
    throw new Error('CSV file has no data rows.')
  }

  let records: Record<string, string>[]
  try {
    const content = readFileSync(filePath, 'utf-8')
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true, // strips UTF-8 BOM automatically
      to: 6, // header row + 5 sample rows
      relax_column_count: true
    }) as Record<string, string>[]
  } catch (err) {
    if (err instanceof Error && err.message.includes('File not found')) throw err
    throw new Error('Could not read CSV. Is this a valid CSV file?')
  }

  if (records.length === 0) {
    throw new Error('CSV file has no data rows.')
  }

  const headers = Object.keys(records[0])
  return { filePath, headers, sampleRows: records.slice(0, 5) }
}

// ─── suggestMappings ─────────────────────────────────────────────────────────

export async function suggestMappings(
  headers: string[],
  importType: ImportType,
  sampleRows: Record<string, string>[]
): Promise<MappingSuggestion[]> {
  const systemPrompt = `You are a CSV field mapping assistant for a CRM called Cyggie.
Map CSV column headers to the appropriate CRM field names.
Return ONLY a valid JSON array. No explanation, no markdown, no code fences.`

  const contactFieldList = importType !== 'companies' ? `CONTACT FIELDS: ${CONTACT_FIELD_KEYS.join(', ')}` : ''
  const companyFieldList = importType !== 'contacts' ? `COMPANY FIELDS: ${COMPANY_FIELD_KEYS.join(', ')}` : ''

  const csvData = headers
    .map((h) => {
      const samples = sampleRows
        .slice(0, 3)
        .map((r) => `"${(r[h] ?? '').replace(/"/g, '\\"')}"`)
        .join(', ')
      return `"${h}": [${samples}]`
    })
    .join('\n')

  const userPrompt = `IMPORT TYPE: ${importType}
${contactFieldList}
${companyFieldList}

CSV HEADERS AND SAMPLE VALUES:
${csvData}

Return JSON array where each element maps one CSV header:
[{ "csvHeader": "...", "targetEntity": "contact"|"company"|null, "targetField": "fieldName"|null, "confidence": "high"|"medium"|"low" }]
Use null for targetEntity if the column should be skipped.
Use null for targetField if the column should become a custom field.`

  try {
    const provider = getProvider()
    const raw = await provider.generateSummary(systemPrompt, userPrompt)
    // Strip any accidental markdown code fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const suggestions = JSON.parse(cleaned) as MappingSuggestion[]
    if (!Array.isArray(suggestions)) throw new Error('LLM did not return an array')
    return suggestions
  } catch {
    // Any failure → fall back to alias table
    return aliasTableFallback(headers, importType)
  }
}

// ─── previewImport ───────────────────────────────────────────────────────────

export async function previewImport(
  filePath: string,
  mappings: FieldMapping[]
): Promise<PreviewResult> {
  const emailMappings = mappings.filter(
    (m) => m.targetEntity === 'contact' && m.targetField === 'email'
  )
  const companyNameMappings = mappings.filter(
    (m) => m.targetEntity === 'company' && m.targetField === 'canonical_name'
  )

  const emails: string[] = []
  const companyNames: string[] = []
  let totalRows = 0

  await new Promise<void>((resolve, reject) => {
    const parser = createReadStream(filePath).pipe(
      parseAsync({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })
    )

    parser.on('readable', () => {
      let row: Record<string, string>
      while ((row = parser.read()) !== null) {
        totalRows++
        for (const m of emailMappings) {
          const val = row[m.csvHeader]?.trim()
          if (val) emails.push(val.toLowerCase())
        }
        for (const m of companyNameMappings) {
          const val = row[m.csvHeader]?.trim()
          if (val) companyNames.push(val.toLowerCase())
        }
      }
    })

    parser.on('end', resolve)
    parser.on('error', reject)
  })

  // Batch email dedup: one query regardless of CSV size
  const existingEmailMap = emails.length > 0 ? contactRepo.resolveContactsByEmails(emails) : {}
  const duplicateContactCount = Object.keys(existingEmailMap).length

  // Company dedup: check by normalized name
  let duplicateCompanyCount = 0
  if (companyNames.length > 0) {
    const db = getDatabase()
    const placeholders = companyNames.map(() => '?').join(', ')
    const existing = db
      .prepare(
        `SELECT normalized_name FROM org_companies WHERE lower(normalized_name) IN (${placeholders})`
      )
      .all(...companyNames) as { normalized_name: string }[]
    duplicateCompanyCount = existing.length
  }

  return { totalRows, duplicateContactCount, duplicateCompanyCount }
}

// ─── runImport ───────────────────────────────────────────────────────────────

function toFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
}

/** Split a full name into firstName / lastName. First word = first name, rest = last name. */
export function splitFullName(fullName: string): { firstName: string; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: null }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * Get or create a custom field definition by field_key, returning its ID.
 * Uses SELECT first to avoid hitting the unique constraint.
 * Pass isMultiSelect=true to create a 'multiselect' field (idempotent — existing
 * definitions are returned as-is regardless of their type).
 */
function getOrCreateCustomFieldId(
  entity: 'contact' | 'company',
  label: string,
  isMultiSelect?: boolean
): string {
  const db = getDatabase()
  const fieldKey = toFieldKey(label)

  const existing = db
    .prepare(`SELECT id FROM custom_field_definitions WHERE entity_type = ? AND field_key = ?`)
    .get(entity, fieldKey) as { id: string } | undefined

  if (existing) return existing.id

  const definition = customFieldRepo.createFieldDefinition({
    entityType: entity as import('../../shared/types/custom-fields').CustomFieldEntityType,
    fieldKey,
    label,
    fieldType: isMultiSelect ? 'multiselect' : 'text',
    isRequired: false,
    sortOrder: 999,
    showInList: false
  })
  return definition.id
}

// Fields handled in Stage 1 (createContact) — skip them in Stage 2 defaults application
const STAGE1_CONTACT_KEYS = new Set([
  'full_name', 'first_name', 'last_name', 'email', 'title', 'contact_type', 'linkedin_url'
])

export async function runImport(
  filePath: string,
  mappings: FieldMapping[],
  importType: ImportType,
  onProgress: (p: ImportProgress) => void,
  signal?: AbortSignal,
  contactDefaults?: FieldDefaultsMap,
  companyDefaults?: FieldDefaultsMap
): Promise<ImportResult> {
  const startMs = Date.now()
  const userId = getCurrentUserId()

  // Build lookup maps for custom field definition IDs (cached per label to avoid N lookups)
  const customFieldIdCache = new Map<string, string>()

  const contactMappings = mappings.filter((m) => m.targetEntity === 'contact' && m.targetField !== null)
  const companyMappings = mappings.filter((m) => m.targetEntity === 'company' && m.targetField !== null)
  const contactCustomMappings = mappings.filter((m) => m.targetEntity === 'contact' && m.targetField === null && m.customFieldLabel)
  const companyCustomMappings = mappings.filter((m) => m.targetEntity === 'company' && m.targetField === null && m.customFieldLabel)

  const hasContactFields = importType !== 'companies' && (contactMappings.length > 0 || contactCustomMappings.length > 0)
  const hasCompanyFields = importType !== 'contacts' && (companyMappings.length > 0 || companyCustomMappings.length > 0)

  let contactsCreated = 0
  let companiesCreated = 0
  let skipped = 0
  const errors: Array<{ row: number; message: string }> = []

  // Pre-load existing company IDs to detect new vs existing during import
  const db = getDatabase()
  const preExistingCompanyIds = new Set<string>(
    (db.prepare('SELECT id FROM org_companies').all() as { id: string }[]).map((r) => r.id)
  )
  // Track companies created during this import (avoid double-counting if same name appears multiple times)
  const createdCompanyIds = new Set<string>()

  // First pass: count rows and collect emails for batch dedup query
  onProgress({ stage: 'parsing', current: 0, total: 0, message: 'Scanning file...' })
  let totalRows = 0
  const allEmailsInCSV: string[] = []
  const emailMappingsForScan = mappings.filter(
    (m) => m.targetEntity === 'contact' && m.targetField === 'email'
  )
  await new Promise<void>((resolve, reject) => {
    const counter = createReadStream(filePath).pipe(
      parseAsync({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })
    )
    counter.on('readable', () => {
      let row: Record<string, string>
      while ((row = counter.read()) !== null) {
        totalRows++
        for (const m of emailMappingsForScan) {
          const val = row[m.csvHeader]?.trim().toLowerCase()
          if (val) allEmailsInCSV.push(val)
        }
      }
    })
    counter.on('end', resolve)
    counter.on('error', reject)
  })

  // Batch dedup check — one query for all emails in the CSV
  const preExistingContactsByEmail = allEmailsInCSV.length > 0
    ? contactRepo.resolveContactsByEmails(allEmailsInCSV)
    : {}

  let processedRows = 0
  let lastProgressTime = 0

  const emitProgress = (force = false) => {
    const now = Date.now()
    if (force || now - lastProgressTime > 250) {
      onProgress({
        stage: 'importing',
        current: processedRows,
        total: totalRows,
        message: `Importing ${processedRows} / ${totalRows}...`
      })
      lastProgressTime = now
    }
  }

  // Second pass: import rows
  await new Promise<void>((resolve, reject) => {
    const parser = createReadStream(filePath).pipe(
      parseAsync({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })
    )

    parser.on('readable', () => {
      let row: Record<string, string>
      while ((row = parser.read()) !== null) {
        if (signal?.aborted) {
          parser.destroy()
          resolve()
          return
        }

        processedRows++
        const rowNum = processedRows

        try {
          let contactId: string | null = null
          let companyId: string | null = null

          // ── Create company ──────────────────────────────────────────────
          if (hasCompanyFields) {
            const nameMappings = companyMappings.filter((m) => m.targetField === 'canonical_name')
            const companyName = nameMappings
              .map((m) => row[m.csvHeader]?.trim())
              .find(Boolean)

            if (companyName) {
              const company = companyRepo.getOrCreateCompanyByName(companyName, userId)
              const isNew = !preExistingCompanyIds.has(company.id) && !createdCompanyIds.has(company.id)
              if (isNew) createdCompanyIds.add(company.id)

              // Apply other mapped company fields (convert snake_case → camelCase for updateCompany)
              const updateData: Record<string, unknown> = {}
              for (const m of companyMappings) {
                if (m.targetField === 'canonical_name') continue
                const val = row[m.csvHeader]?.trim()
                if (val) updateData[toCamelCase(m.targetField!)] = val
              }
              // Apply company defaults for fields not already set from CSV
              for (const [key, val] of Object.entries(companyDefaults ?? {})) {
                if (!val.trim()) continue
                const camelKey = toCamelCase(key)
                if (!updateData[camelKey]) updateData[camelKey] = val
              }
              if (Object.keys(updateData).length > 0) {
                companyRepo.updateCompany(company.id, updateData as Parameters<typeof companyRepo.updateCompany>[1], userId)
              }

              // Write company custom fields
              for (const m of companyCustomMappings) {
                const val = row[m.csvHeader]?.trim()
                if (!val) continue
                const cacheKey = `company:${m.customFieldLabel}`
                let defId = customFieldIdCache.get(cacheKey)
                if (!defId) {
                  defId = getOrCreateCustomFieldId('company', m.customFieldLabel!, m.isMultiSelect)
                  customFieldIdCache.set(cacheKey, defId)
                }
                customFieldRepo.setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: company.id, valueText: val })
              }

              if (isNew) companiesCreated++
              companyId = company.id
            }
          }

          // ── Create contact ──────────────────────────────────────────────
          if (hasContactFields) {
            const getValue = (field: string) =>
              contactMappings.find((m) => m.targetField === field)
              ? row[contactMappings.find((m) => m.targetField === field)!.csvHeader]?.trim() || null
              : null

            const fullNameVal = getValue('full_name')
            const firstNameVal = getValue('first_name')
            const lastNameVal = getValue('last_name')
            const emailVal = getValue('email')

            const derivedFullName =
              fullNameVal ||
              ([firstNameVal, lastNameVal].filter(Boolean).join(' ')) ||
              null

            if (!derivedFullName) {
              skipped++
              emitProgress()
              continue
            }

            // If only full_name is mapped (no separate first/last), split it automatically
            let derivedFirstName = firstNameVal
            let derivedLastName = lastNameVal
            if (fullNameVal && !firstNameVal && !lastNameVal) {
              const split = splitFullName(fullNameVal)
              derivedFirstName = split.firstName
              derivedLastName = split.lastName
            }

            const contactData = {
              fullName: derivedFullName,
              firstName: derivedFirstName,
              lastName: derivedLastName,
              email: emailVal,
              title: getValue('title') ?? contactDefaults?.['title'] ?? null,
              contactType: getValue('contact_type') ?? contactDefaults?.['contact_type'] ?? null,
              linkedinUrl: getValue('linkedin_url') ?? contactDefaults?.['linkedin_url'] ?? null
            }

            // Use pre-fetched dedup map (no per-row DB query)
            const wasNew = !emailVal || !preExistingContactsByEmail[emailVal.toLowerCase()]
            const contact = contactRepo.createContact(contactData, userId)
            contactId = contact.id

            // Update remaining contact fields (convert snake_case → camelCase for updateContact)
            const extraFields: Record<string, unknown> = {}
            for (const m of contactMappings) {
              if (STAGE1_CONTACT_KEYS.has(m.targetField!)) continue
              const val = row[m.csvHeader]?.trim()
              if (val) extraFields[toCamelCase(m.targetField!)] = val
            }
            // Apply stage-2 defaults for fields not already set from CSV
            for (const [key, val] of Object.entries(contactDefaults ?? {})) {
              if (STAGE1_CONTACT_KEYS.has(key)) continue
              if (!val.trim()) continue
              const camelKey = toCamelCase(key)
              if (!extraFields[camelKey]) extraFields[camelKey] = val
            }
            if (Object.keys(extraFields).length > 0) {
              contactRepo.updateContact(contactId, extraFields as Parameters<typeof contactRepo.updateContact>[1], userId)
            }

            // Write contact custom fields
            for (const m of contactCustomMappings) {
              const val = row[m.csvHeader]?.trim()
              if (!val) continue
              const cacheKey = `contact:${m.customFieldLabel}`
              let defId = customFieldIdCache.get(cacheKey)
              if (!defId) {
                defId = getOrCreateCustomFieldId('contact', m.customFieldLabel!, m.isMultiSelect)
                customFieldIdCache.set(cacheKey, defId)
              }
              customFieldRepo.setFieldValue({ fieldDefinitionId: defId, entityType: 'contact', entityId: contactId, valueText: val })
            }

            if (wasNew) contactsCreated++
            else skipped++
          }

          // ── Link contact → company ──────────────────────────────────────
          if (contactId && companyId) {
            contactRepo.setContactPrimaryCompany(contactId, companyId, userId)
          }
        } catch (err) {
          errors.push({ row: rowNum, message: err instanceof Error ? err.message : String(err) })
        }

        emitProgress()
      }
    })

    parser.on('end', resolve)
    parser.on('error', reject)
  })

  emitProgress(true)

  const durationMs = Date.now() - startMs
  logAudit(userId, 'import', 'csv', 'create', {
    file: filePath,
    contactsCreated,
    companiesCreated,
    skipped,
    errorCount: errors.length,
    durationMs,
    ...(contactDefaults && Object.keys(contactDefaults).length > 0
      ? { contactDefaultsApplied: Object.keys(contactDefaults).join(',') }
      : {}),
    ...(companyDefaults && Object.keys(companyDefaults).length > 0
      ? { companyDefaultsApplied: Object.keys(companyDefaults).join(',') }
      : {})
  })

  onProgress({ stage: 'done', current: totalRows, total: totalRows, message: 'Import complete.' })

  return { contactsCreated, companiesCreated, skipped, errors, durationMs }
}
