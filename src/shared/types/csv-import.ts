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

export interface PreviewResult {
  totalRows: number
  duplicateContactCount: number
  duplicateCompanyCount: number
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
  skipped: number
  errors: Array<{ row: number; message: string }>
  durationMs: number
}
