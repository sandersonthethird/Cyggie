// IPC wire format — these types are shared between main and renderer.
// UI-only fields (sampleValues, confidence) live in ImportModal.tsx as UIFieldMapping.

export type ImportType = 'contacts' | 'companies' | 'contacts_and_companies'

export type FieldDefaultsMap = Record<string, string> // targetField (snake_case) → value

export interface FieldMapping {
  csvHeader: string
  targetEntity: 'contact' | 'company' | null // null = skip
  targetField: string | null // null = create custom field
  customFieldLabel?: string // required when targetField is null
  isMultiSelect?: boolean // create custom field as multiselect type
}

export interface MappingSuggestion {
  csvHeader: string
  targetEntity: 'contact' | 'company' | null
  targetField: string | null
  confidence: 'high' | 'medium' | 'low'
}

export interface CSVFileInfo {
  filePath: string
  headers: string[]
  sampleRows: Record<string, string>[]
}

export interface FieldChange {
  field: string        // snake_case field name
  label: string        // Human-readable: 'Full Name', 'Title', etc.
  existingValue: string
  csvValue: string
}

export interface ContactDiff {
  contactId: string
  displayName: string  // existing full_name (or email) for row label
  fieldChanges: FieldChange[]
}

export interface CompanyDiff {
  companyId: string
  displayName: string  // existing canonical_name for row label
  fieldChanges: FieldChange[]
}

export interface MergeResult {
  merged: {
    fullName: unknown
    firstName: unknown
    lastName: unknown
    title: unknown
    contactType: unknown
    linkedinUrl: unknown
  }
  fieldsFilled: number
  fieldsOverwritten: number
}

export interface RunImportOptions {
  contactDefaults?: FieldDefaultsMap
  companyDefaults?: FieldDefaultsMap
  contactOverwriteFields?: string[]   // snake_case field names where CSV wins
  companyOverwriteFields?: string[]
  contactSkipIds?: string[]           // contact IDs to exclude from any update
  companySkipIds?: string[]
}

export interface PreviewResult {
  totalRows: number
  duplicateContactCount: number
  duplicateCompanyCount: number
  contactDiffs: ContactDiff[]
  companyDiffs: CompanyDiff[]
}

export interface ImportProgress {
  stage: 'parsing' | 'importing' | 'done'
  current: number
  total: number
  message: string
}

export interface ImportResult {
  contactsCreated: number
  companiesCreated: number
  contactsUpdated: number
  contactFieldsFilled: number
  contactFieldsOverwritten: number
  errors: Array<{ row: number; message: string }>
  durationMs: number
}
