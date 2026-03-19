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
  MergeResult,
  RunImportOptions,
  ContactDiff,
  CompanyDiff,
  FieldChange,
  CSVFileInfo
} from '../../shared/types/csv-import'
import { getProvider } from '../llm/provider-factory'
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

// ─── Field labels for diff display ──────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full Name', first_name: 'First Name', last_name: 'Last Name',
  title: 'Title', contact_type: 'Contact Type', linkedin_url: 'LinkedIn URL',
  city: 'City', state: 'State', phone: 'Phone', twitter_handle: 'Twitter',
  canonical_name: 'Company Name', primary_domain: 'Domain',
  entity_type: 'Entity Type', pipeline_stage: 'Stage',
  sector: 'Sector', raise_size: 'Raise ($M)', arr: 'ARR ($M)',
  description: 'Description', website_url: 'Website',
  round: 'Round', priority: 'Priority', deal_source: 'Deal Source',
  founding_year: 'Founded', employee_count_range: 'Employees',
}

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
  // All contact field mappings (for conflict detection)
  const contactFieldMappings = mappings.filter(
    (m) => m.targetEntity === 'contact' && m.targetField !== null
  )
  // All company field mappings (for conflict detection)
  const companyFieldMappings = mappings.filter(
    (m) => m.targetEntity === 'company' && m.targetField !== null
  )

  const emails: string[] = []
  const companyNames: string[] = []
  // email → { fieldKey: csvValue } — collected for conflict detection
  const contactRowData = new Map<string, Record<string, string>>()
  // normalized name → { fieldKey: csvValue } — for rows with no email
  const contactNameRowData = new Map<string, Record<string, string>>()
  // normalized company name → { fieldKey: csvValue }
  const companyRowData = new Map<string, Record<string, string>>()
  let totalRows = 0

  await new Promise<void>((resolve, reject) => {
    const parser = createReadStream(filePath).pipe(
      parseAsync({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })
    )

    parser.on('readable', () => {
      let row: Record<string, string>
      while ((row = parser.read()) !== null) {
        totalRows++

        // Collect email for contact dedup
        let rowEmail: string | null = null
        for (const m of emailMappings) {
          const val = row[m.csvHeader]?.trim()
          if (val) { rowEmail = val.toLowerCase(); emails.push(rowEmail) }
        }

        // Collect all contact field values keyed by email
        if (rowEmail) {
          if (!contactRowData.has(rowEmail)) {
            const fields: Record<string, string> = {}
            for (const fm of contactFieldMappings) {
              const v = row[fm.csvHeader]?.trim()
              if (v) fields[fm.targetField!] = v
            }
            contactRowData.set(rowEmail, fields)
          }
        } else {
          // No email on this row — collect by normalized name for name-based dedup
          const fullNameVal = contactFieldMappings
            .filter((m) => m.targetField === 'full_name' || m.targetField === 'first_name' || m.targetField === 'last_name')
            .map((m) => row[m.csvHeader]?.trim())
            .filter(Boolean)
            .join(' ')
          if (fullNameVal) {
            const normName = fullNameVal.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')
            if (!contactNameRowData.has(normName)) {
              const fields: Record<string, string> = {}
              for (const fm of contactFieldMappings) {
                const v = row[fm.csvHeader]?.trim()
                if (v) fields[fm.targetField!] = v
              }
              contactNameRowData.set(normName, fields)
            }
          }
        }

        // Collect company name + field values
        for (const m of companyNameMappings) {
          const val = row[m.csvHeader]?.trim()
          if (val) {
            const normalizedName = val.toLowerCase()
            companyNames.push(normalizedName)
            if (!companyRowData.has(normalizedName)) {
              const fields: Record<string, string> = {}
              for (const fm of companyFieldMappings) {
                const v = row[fm.csvHeader]?.trim()
                if (v) fields[fm.targetField!] = v
              }
              companyRowData.set(normalizedName, fields)
            }
          }
        }
      }
    })

    parser.on('end', resolve)
    parser.on('error', reject)
  })

  // Batch email dedup: one query regardless of CSV size
  const existingEmailMap = emails.length > 0 ? contactRepo.resolveContactsByEmails(emails) : {}
  // Name-based dedup fallback for rows with no email (unique matches only)
  const existingNameMap = contactNameRowData.size > 0
    ? contactRepo.resolveContactsByNormalizedNames([...contactNameRowData.keys()])
    : {}
  const duplicateContactCount = new Set([
    ...Object.values(existingEmailMap),
    ...Object.values(existingNameMap)
  ]).size

  // Fetch full contact records for conflict detection
  const duplicateContactIds = [...new Set([
    ...Object.values(existingEmailMap),
    ...Object.values(existingNameMap)
  ])]
  const existingContacts = contactRepo.getContactsByIds(duplicateContactIds)

  function buildContactDiff(contactId: string, csvFields: Record<string, string>): ContactDiff | null {
    const existing = existingContacts[contactId]
    if (!existing) return null
    const fieldChanges: FieldChange[] = []
    for (const [field, csvVal] of Object.entries(csvFields)) {
      if (!csvVal?.trim()) continue
      const camelKey = toCamelCase(field) as keyof typeof existing
      const existingVal = existing[camelKey]
      if (existingVal && String(existingVal).trim() !== csvVal.trim()) {
        fieldChanges.push({
          field,
          label: FIELD_LABELS[field] ?? field,
          existingValue: String(existingVal),
          csvValue: csvVal,
        })
      }
    }
    if (fieldChanges.length === 0) return null
    return {
      contactId,
      displayName: String(existing.full_name ?? existing.email ?? contactId),
      fieldChanges,
    }
  }

  // Build per-record contact diffs (email-keyed rows)
  const contactDiffs: ContactDiff[] = []
  for (const [email, csvFields] of contactRowData.entries()) {
    const contactId = existingEmailMap[email]
    if (!contactId) continue
    const diff = buildContactDiff(contactId, csvFields)
    if (diff) contactDiffs.push(diff)
  }
  // Build diffs for name-keyed rows (no email)
  for (const [normName, csvFields] of contactNameRowData.entries()) {
    const contactId = existingNameMap[normName]
    if (!contactId) continue
    const diff = buildContactDiff(contactId, csvFields)
    if (diff) contactDiffs.push(diff)
  }

  // Company dedup and diff
  const existingCompanies = companyRepo.getCompaniesByNormalizedNames(
    [...companyRowData.keys()]
  )
  const duplicateCompanyCount = Object.keys(existingCompanies).length

  const companyDiffs: CompanyDiff[] = []
  for (const [normalizedName, csvFields] of companyRowData.entries()) {
    const existing = existingCompanies[normalizedName]
    if (!existing) continue

    const fieldChanges: FieldChange[] = []
    for (const [field, csvVal] of Object.entries(csvFields)) {
      if (!csvVal?.trim() || field === 'canonical_name') continue
      const camelKey = toCamelCase(field) as keyof typeof existing
      const existingVal = existing[camelKey]
      if (existingVal && String(existingVal).trim() !== csvVal.trim()) {
        fieldChanges.push({
          field,
          label: FIELD_LABELS[field] ?? field,
          existingValue: String(existingVal),
          csvValue: csvVal,
        })
      }
    }
    if (fieldChanges.length > 0) {
      companyDiffs.push({
        companyId: existing.id,
        displayName: existing.canonicalName,
        fieldChanges,
      })
    }
  }

  return { totalRows, duplicateContactCount, duplicateCompanyCount, contactDiffs, companyDiffs }
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

/**
 * Merge CSV contact data with an existing contact record.
 * resolve() is a pure selector — no side effects, no mutation.
 * Fields in overwriteSetCamel override existing values; others fill blanks only.
 * Returns merged field values + explicit fill/overwrite counters.
 */
function mergeContactData(
  csvData: {
    fullName: string | null
    firstName: string | null
    lastName: string | null
    title: string | null
    contactType: string | null
    linkedinUrl: string | null
  },
  existing: { full_name: string | null; first_name: string | null; last_name: string | null; title: string | null; contact_type: string | null; linkedin_url: string | null },
  overwriteSetCamel: Set<string>
): MergeResult {
  const resolve = (key: string, csvVal: unknown, existingVal: unknown): unknown => {
    if (csvVal == null || (typeof csvVal === 'string' && !csvVal.trim())) return existingVal
    if (overwriteSetCamel.has(key)) return csvVal    // explicit overwrite
    if (!existingVal) return csvVal                   // fill blank
    return existingVal                                // preserve existing
  }

  const merged: MergeResult['merged'] = {
    fullName:    resolve('fullName',    csvData.fullName,    existing.full_name),
    firstName:   resolve('firstName',   csvData.firstName,   existing.first_name),
    lastName:    resolve('lastName',    csvData.lastName,    existing.last_name),
    title:       resolve('title',       csvData.title,       existing.title),
    contactType: resolve('contactType', csvData.contactType, existing.contact_type),
    linkedinUrl: resolve('linkedinUrl', csvData.linkedinUrl, existing.linkedin_url),
  }

  // Count fills and overwrites explicitly (not inside resolve — keep it pure)
  let fieldsFilled = 0
  let fieldsOverwritten = 0
  const pairs: Array<[string, unknown, unknown]> = [
    ['fullName',    csvData.fullName,    existing.full_name],
    ['firstName',   csvData.firstName,   existing.first_name],
    ['lastName',    csvData.lastName,    existing.last_name],
    ['title',       csvData.title,       existing.title],
    ['contactType', csvData.contactType, existing.contact_type],
    ['linkedinUrl', csvData.linkedinUrl, existing.linkedin_url],
  ]
  for (const [key, csvVal, existingVal] of pairs) {
    if (csvVal == null || (typeof csvVal === 'string' && !csvVal.trim())) continue
    if (!existingVal) fieldsFilled++
    else if (overwriteSetCamel.has(key)) fieldsOverwritten++
  }

  return { merged, fieldsFilled, fieldsOverwritten }
}

export async function runImport(
  filePath: string,
  mappings: FieldMapping[],
  importType: ImportType,
  onProgress: (p: ImportProgress) => void,
  signal?: AbortSignal,
  options: RunImportOptions = {}
): Promise<ImportResult> {
  const startMs = Date.now()
  const userId = getCurrentUserId()

  const {
    contactDefaults,
    companyDefaults,
    contactOverwriteFields = [],
    companyOverwriteFields = [],
    contactSkipIds = [],
    companySkipIds = [],
  } = options

  const contactOverwriteSetCamel = new Set(contactOverwriteFields.map(toCamelCase))
  const companyOverwriteSetCamel = new Set(companyOverwriteFields.map(toCamelCase))
  const contactSkipSet = new Set(contactSkipIds)
  const companySkipSet = new Set(companySkipIds)

  // Build lookup maps for custom field definition IDs (cached per label to avoid N lookups)
  const customFieldIdCache = new Map<string, string>()

  const contactMappings = mappings.filter((m) => m.targetEntity === 'contact' && m.targetField !== null && !m.targetField.startsWith('custom:'))
  const companyMappings = mappings.filter((m) => m.targetEntity === 'company' && m.targetField !== null && !m.targetField.startsWith('custom:'))
  const contactCustomMappings = mappings.filter((m) => m.targetEntity === 'contact' && m.targetField === null && m.customFieldLabel)
  const companyCustomMappings = mappings.filter((m) => m.targetEntity === 'company' && m.targetField === null && m.customFieldLabel)
  // Mappings pointing to existing custom field definitions (targetField = 'custom:{defId}')
  const contactExistingCustomMappings = mappings.filter((m) => m.targetEntity === 'contact' && m.targetField?.startsWith('custom:'))
  const companyExistingCustomMappings = mappings.filter((m) => m.targetEntity === 'company' && m.targetField?.startsWith('custom:'))

  const hasContactFields = importType !== 'companies' && (contactMappings.length > 0 || contactCustomMappings.length > 0 || contactExistingCustomMappings.length > 0)
  const hasCompanyFields = importType !== 'contacts' && (companyMappings.length > 0 || companyCustomMappings.length > 0 || companyExistingCustomMappings.length > 0)

  let contactsCreated = 0
  let companiesCreated = 0
  let contactsUpdated = 0
  let totalFieldsFilled = 0
  let totalFieldsOverwritten = 0
  const errors: Array<{ row: number; message: string }> = []

  // Pre-load existing IDs to detect new vs existing during import (mirrors company pattern)
  const db = getDatabase()
  const preExistingContactIds = new Set<string>(
    (db.prepare('SELECT id FROM contacts').all() as { id: string }[]).map((r) => r.id)
  )
  const preExistingCompanyIds = new Set<string>(
    (db.prepare('SELECT id FROM org_companies').all() as { id: string }[]).map((r) => r.id)
  )
  // Track companies created during this import (avoid double-counting if same name appears multiple times)
  const createdCompanyIds = new Set<string>()

  // First pass: count rows and collect emails + names for batch dedup queries
  onProgress({ stage: 'parsing', current: 0, total: 0, message: 'Scanning file...' })
  let totalRows = 0
  const allEmailsInCSV: string[] = []
  // Collect derived names for rows that have no email — used for name-based dedup fallback
  const noEmailNamesInCSV: string[] = []
  const emailMappingsForScan = mappings.filter(
    (m) => m.targetEntity === 'contact' && m.targetField === 'email'
  )
  const nameMappingsForScan = mappings.filter(
    (m) => m.targetEntity === 'contact' && (
      m.targetField === 'full_name' || m.targetField === 'first_name' || m.targetField === 'last_name'
    )
  )
  await new Promise<void>((resolve, reject) => {
    const counter = createReadStream(filePath).pipe(
      parseAsync({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })
    )
    counter.on('readable', () => {
      let row: Record<string, string>
      while ((row = counter.read()) !== null) {
        totalRows++
        let rowEmail: string | null = null
        for (const m of emailMappingsForScan) {
          const val = row[m.csvHeader]?.trim().toLowerCase()
          if (val) { rowEmail = val; allEmailsInCSV.push(val) }
        }
        // Collect name for name-based dedup (only for rows with no email)
        if (!rowEmail) {
          const fullName = nameMappingsForScan
            .map((m) => row[m.csvHeader]?.trim())
            .filter(Boolean)
            .join(' ')
          if (fullName) noEmailNamesInCSV.push(fullName.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' '))
        }
      }
    })
    counter.on('end', resolve)
    counter.on('error', reject)
  })

  // Batch dedup check — one query for all emails in the CSV
  const emailToContactId = allEmailsInCSV.length > 0
    ? contactRepo.resolveContactsByEmails(allEmailsInCSV)
    : {}
  // Fetch full contact records for fill-blanks/overwrite merge logic
  const preExistingContactsByEmail = allEmailsInCSV.length > 0
    ? (() => {
        const byId = contactRepo.getContactsByIds(Object.values(emailToContactId))
        const byEmail: Record<string, typeof byId[string]> = {}
        for (const [email, id] of Object.entries(emailToContactId)) {
          if (byId[id]) byEmail[email] = byId[id]
        }
        return byEmail
      })()
    : {} as Record<string, ReturnType<typeof contactRepo.getContactsByIds>[string]>

  // Name-based dedup fallback — used when a row has no email.
  // Only resolves unique matches (ambiguous names are excluded).
  const nameToContactId = noEmailNamesInCSV.length > 0
    ? contactRepo.resolveContactsByNormalizedNames(noEmailNamesInCSV)
    : {}
  const preExistingContactsByName = noEmailNamesInCSV.length > 0
    ? (() => {
        const byId = contactRepo.getContactsByIds(Object.values(nameToContactId))
        const byName: Record<string, ReturnType<typeof contactRepo.getContactsByIds>[string]> = {}
        for (const [name, id] of Object.entries(nameToContactId)) {
          if (byId[id]) byName[name] = byId[id]
        }
        return byName
      })()
    : {} as Record<string, ReturnType<typeof contactRepo.getContactsByIds>[string]>

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

              // Apply other mapped company fields with fill-blanks/overwrite logic
              const updateData: Record<string, unknown> = {}
              for (const m of companyMappings) {
                if (m.targetField === 'canonical_name') continue
                const val = row[m.csvHeader]?.trim()
                if (!val) continue
                const camelKey = toCamelCase(m.targetField!)
                if (isNew || companySkipSet.has(company.id)) {
                  // New company: apply all values. Skipped company: no updates.
                  if (!companySkipSet.has(company.id)) updateData[camelKey] = val
                } else {
                  const existingVal = (company as Record<string, unknown>)[camelKey]
                  if (!existingVal || companyOverwriteSetCamel.has(camelKey)) {
                    updateData[camelKey] = val
                  }
                }
              }
              // Apply company defaults for fields not already set from CSV
              if (!companySkipSet.has(company.id)) {
                for (const [key, val] of Object.entries(companyDefaults ?? {})) {
                  if (!val.trim()) continue
                  const camelKey = toCamelCase(key)
                  if (!updateData[camelKey]) updateData[camelKey] = val
                }
              }
              if (Object.keys(updateData).length > 0) {
                companyRepo.updateCompany(company.id, updateData as Parameters<typeof companyRepo.updateCompany>[1], userId)
              }

              // Write company custom fields (new definitions created on-the-fly)
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
              // Write company custom fields (existing definitions — targetField = 'custom:{defId}')
              for (const m of companyExistingCustomMappings) {
                const val = row[m.csvHeader]?.trim()
                if (!val) continue
                const defId = m.targetField!.slice(7)  // strip 'custom:'
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
              title: getValue('title') || contactDefaults?.['title'] || null,
              contactType: getValue('contact_type') || contactDefaults?.['contact_type'] || null,
              linkedinUrl: getValue('linkedin_url') || contactDefaults?.['linkedin_url'] || null
            }

            // Use pre-fetched dedup map (no per-row DB query).
            // Fall back to name-based dedup when row has no email (unique match only).
            const existingContact = emailVal
              ? preExistingContactsByEmail[emailVal.toLowerCase()]
              : (() => {
                  const norm = derivedFullName.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ')
                  return preExistingContactsByName[norm]
                })()
            const wasNew = !existingContact

            // If user explicitly excluded this contact, skip entirely
            if (existingContact && contactSkipSet.has(existingContact.id)) {
              emitProgress()
              continue
            }

            // Apply stage-1 merge: fill-blanks-only unless field is in overwrite set
            let mergedData = contactData
            let mfilled = 0
            let moverwritten = 0
            if (existingContact) {
              const { merged, fieldsFilled, fieldsOverwritten } = mergeContactData(
                contactData, existingContact, contactOverwriteSetCamel
              )
              mergedData = {
                fullName: (merged.fullName as string | null) ?? contactData.fullName,
                firstName: merged.firstName as string | null,
                lastName: merged.lastName as string | null,
                email: contactData.email,
                title: merged.title as string | null,
                contactType: merged.contactType as string | null,
                linkedinUrl: merged.linkedinUrl as string | null,
              }
              mfilled = fieldsFilled
              moverwritten = fieldsOverwritten
            }

            // When deduped by name (no email on row), createContact would INSERT a new record
            // since it only deduplicates by email. Bypass it and update directly instead.
            let actuallyNew: boolean
            if (existingContact && !emailVal) {
              contactId = existingContact.id
              actuallyNew = false
              // Apply stage-1 field updates directly via updateContact
              const stage1Updates: Record<string, unknown> = {}
              if (mergedData.fullName !== existingContact.full_name) stage1Updates.fullName = mergedData.fullName
              if (mergedData.firstName !== existingContact.first_name) stage1Updates.firstName = mergedData.firstName
              if (mergedData.lastName !== existingContact.last_name) stage1Updates.lastName = mergedData.lastName
              if (mergedData.title && mergedData.title !== existingContact.title) stage1Updates.title = mergedData.title
              if (mergedData.contactType && mergedData.contactType !== existingContact.contact_type) stage1Updates.contactType = mergedData.contactType
              if (mergedData.linkedinUrl && mergedData.linkedinUrl !== existingContact.linkedin_url) stage1Updates.linkedinUrl = mergedData.linkedinUrl
              if (Object.keys(stage1Updates).length > 0) {
                contactRepo.updateContact(existingContact.id, stage1Updates as Parameters<typeof contactRepo.updateContact>[1], userId)
              }
            } else {
              const contact = contactRepo.createContact(mergedData, userId)
              contactId = contact.id
              // Determine new vs existing from pre-loaded ID set — handles all dedup paths
              // (email match, contact_emails table match, etc.) not just our pre-fetch map
              actuallyNew = !preExistingContactIds.has(contact.id)
            }
            totalFieldsFilled += mfilled
            totalFieldsOverwritten += moverwritten

            // Stage-2: update remaining fields with fill-blanks/overwrite logic
            const extraFields: Record<string, unknown> = {}
            for (const m of contactMappings) {
              if (STAGE1_CONTACT_KEYS.has(m.targetField!)) continue
              const val = row[m.csvHeader]?.trim()
              if (!val) continue
              const camelKey = toCamelCase(m.targetField!)
              if (actuallyNew) {
                extraFields[camelKey] = val
              } else {
                const existingVal = (existingContact as Record<string, unknown>)[camelKey]
                if (!existingVal) {
                  extraFields[camelKey] = val
                  totalFieldsFilled++
                } else if (contactOverwriteSetCamel.has(camelKey)) {
                  extraFields[camelKey] = val
                  totalFieldsOverwritten++
                }
              }
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

            // Write contact custom fields (new definitions created on-the-fly)
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
            // Write contact custom fields (existing definitions — targetField = 'custom:{defId}')
            for (const m of contactExistingCustomMappings) {
              const val = row[m.csvHeader]?.trim()
              if (!val) continue
              const defId = m.targetField!.slice(7)  // strip 'custom:'
              customFieldRepo.setFieldValue({ fieldDefinitionId: defId, entityType: 'contact', entityId: contactId, valueText: val })
            }

            if (actuallyNew) contactsCreated++
            else contactsUpdated++
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
    contactsUpdated,
    contactFieldsFilled: totalFieldsFilled,
    contactFieldsOverwritten: totalFieldsOverwritten,
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

  return {
    contactsCreated,
    companiesCreated,
    contactsUpdated,
    contactFieldsFilled: totalFieldsFilled,
    contactFieldsOverwritten: totalFieldsOverwritten,
    errors,
    durationMs
  }
}
