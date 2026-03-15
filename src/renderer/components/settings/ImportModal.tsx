import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  ImportType,
  FieldMapping,
  FieldDefaultsMap,
  MappingSuggestion,
  CSVFileInfo,
  ImportProgress,
  ImportResult,
  PreviewResult
} from '../../../shared/types/csv-import'
import styles from './ImportModal.module.css'
import { api } from '../../api'
import { CONTACT_TYPES } from '../contact/contactColumns'
import { ENTITY_TYPES, STAGES } from '../company/companyColumns'

// ─── UI-only type (extends wire format with display fields) ─────────────────

interface UIFieldMapping extends FieldMapping {
  sampleValues: string[]
  confidence?: 'high' | 'medium' | 'low'
  isMultiValue?: boolean // detected: sample values contain commas → multiple items
}

// ─── Source detection ────────────────────────────────────────────────────────

const SOURCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /contact/i, label: 'Mac Contacts export' },
  { pattern: /granola/i, label: 'Granola export' },
  { pattern: /airtable|grid.view/i, label: 'AirTable export' },
  { pattern: /hubspot/i, label: 'HubSpot export' },
  { pattern: /linkedin/i, label: 'LinkedIn export' },
]

function detectSource(filename: string): string | null {
  for (const s of SOURCE_PATTERNS) {
    if (s.pattern.test(filename)) return s.label
  }
  return null
}

// ─── Multi-value detection ───────────────────────────────────────────────────

/** Returns true if sample values suggest this column contains comma-separated lists. */
function detectMultiValue(sampleValues: string[]): boolean {
  return sampleValues.some((v) => {
    const parts = v.split(',').map((p) => p.trim()).filter(Boolean)
    return parts.length > 1
  })
}

/** Extract unique option values from comma-separated sample data. */
function extractOptions(sampleValues: string[]): string[] {
  const seen = new Set<string>()
  for (const v of sampleValues) {
    v.split(',').map((p) => p.trim()).filter(Boolean).forEach((p) => seen.add(p))
  }
  return [...seen].slice(0, 20)
}

// ─── Field display helpers ───────────────────────────────────────────────────

interface FieldDef {
  value: string
  label: string
  isMultiSelect?: true
}

const CONTACT_FIELDS: FieldDef[] = [
  { value: 'full_name', label: 'Full Name' },
  { value: 'first_name', label: 'First Name' },
  { value: 'last_name', label: 'Last Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'title', label: 'Title / Job Title' },
  { value: 'contact_type', label: 'Contact Type' },
  { value: 'linkedin_url', label: 'LinkedIn URL' },
  { value: 'twitter_handle', label: 'Twitter Handle' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'timezone', label: 'Timezone' },
  { value: 'pronouns', label: 'Pronouns' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'university', label: 'University' },
  { value: 'previous_companies', label: 'Previous Companies', isMultiSelect: true },
  { value: 'tags', label: 'Tags', isMultiSelect: true },
  { value: 'notes', label: 'Notes' },
  { value: 'relationship_strength', label: 'Relationship Strength' },
  { value: 'fund_size', label: 'Fund Size' },
  { value: 'typical_check_size_min', label: 'Min Check Size' },
  { value: 'typical_check_size_max', label: 'Max Check Size' },
  { value: 'investment_stage_focus', label: 'Investment Stage Focus', isMultiSelect: true },
  { value: 'investment_sector_focus', label: 'Investment Sector Focus', isMultiSelect: true },
]

const COMPANY_FIELDS: FieldDef[] = [
  { value: 'canonical_name', label: 'Company Name' },
  { value: 'primary_domain', label: 'Primary Domain' },
  { value: 'website_url', label: 'Website URL' },
  { value: 'description', label: 'Description' },
  { value: 'sector', label: 'Sector / Industry' },
  { value: 'entity_type', label: 'Entity Type' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'founding_year', label: 'Founding Year' },
  { value: 'employee_count_range', label: 'Employee Count' },
  { value: 'linkedin_company_url', label: 'LinkedIn URL' },
  { value: 'twitter_handle', label: 'Twitter Handle' },
  { value: 'crunchbase_url', label: 'Crunchbase URL' },
  { value: 'arr', label: 'ARR' },
  { value: 'burn_rate', label: 'Burn Rate' },
  { value: 'runway_months', label: 'Runway (months)' },
  { value: 'total_funding_raised', label: 'Total Funding Raised' },
  { value: 'last_funding_date', label: 'Last Funding Date' },
  { value: 'pipeline_stage', label: 'Pipeline Stage', isMultiSelect: true },
  { value: 'priority', label: 'Priority' },
  { value: 'round', label: 'Round', isMultiSelect: true },
  { value: 'deal_source', label: 'Deal Source' },
]

// ─── Defaultable fields (curated subset for the defaults section) ─────────────

const DEFAULTABLE_CONTACT_FIELDS = [
  { key: 'contact_type', label: 'Contact Type', type: 'select' },
  { key: 'title',        label: 'Title',        type: 'text'   },
  { key: 'city',         label: 'City',         type: 'text'   },
  { key: 'state',        label: 'State',        type: 'text'   },
] as const

const DEFAULTABLE_COMPANY_FIELDS = [
  { key: 'entity_type',    label: 'Entity Type',    type: 'select' },
  { key: 'pipeline_stage', label: 'Pipeline Stage', type: 'select' },
] as const

// ─── Component ───────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4

interface Props {
  onClose: () => void
}

export function ImportModal({ onClose }: Props) {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(1)

  // Step 1 state
  const [importType, setImportType] = useState<ImportType>('contacts_and_companies')
  const [fileInfo, setFileInfo] = useState<CSVFileInfo | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sourceLabel, setSourceLabel] = useState<string | null>(null)
  const [step1Error, setStep1Error] = useState<string | null>(null)
  const ignoreNextDropClickRef = useRef(false)

  // Step 2 state
  const [mappings, setMappings] = useState<UIFieldMapping[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestFallback, setSuggestFallback] = useState(false)
  const originalSuggestions = useRef<UIFieldMapping[]>([])
  const [contactDefaults, setContactDefaults] = useState<FieldDefaultsMap>({})
  const [companyDefaults, setCompanyDefaults] = useState<FieldDefaultsMap>({})

  // Step 3 state
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Step 4 state
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  // ── Load file by path (shared by dialog and drag-and-drop) ──────

  const loadFile = useCallback(async (info: CSVFileInfo) => {
    setFileInfo(info)
    const filename = info.filePath.split('/').pop() ?? ''
    setSourceLabel(detectSource(filename))
  }, [])

  // ── Open file dialog ─────────────────────────────────────────────

  const openFileDialog = useCallback(async () => {
    if (ignoreNextDropClickRef.current) return
    setStep1Error(null)
    setFileLoading(true)
    try {
      const info = await api.invoke<CSVFileInfo | null>(IPC_CHANNELS.CSV_OPEN_FILE_DIALOG)
      if (info) await loadFile(info)
    } catch (err) {
      setStep1Error(String(err))
    } finally {
      setFileLoading(false)
    }
  }, [loadFile])

  // ── Handle dropped file (Electron exposes file.path) ────────────

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    setStep1Error(null)
    ignoreNextDropClickRef.current = true
    setTimeout(() => { ignoreNextDropClickRef.current = false }, 250)

    const file = e.dataTransfer.files[0]
    // Electron may expose path directly or via webUtils.getPathForFile
    const filePath = file
      ? ((file as File & { path?: string }).path || api.getPathForFile(file) || undefined)
      : undefined
    if (!filePath) {
      setStep1Error('Could not access the dropped file path. Please use Browse Files.')
      return
    }

    setFileLoading(true)
    try {
      const info = await api.invoke<CSVFileInfo>(IPC_CHANNELS.CSV_PARSE_FILE, filePath)
      if (info) await loadFile(info)
    } catch (err) {
      setStep1Error(String(err))
    } finally {
      setFileLoading(false)
    }
  }, [loadFile, openFileDialog])

  // ── Advance to step 2: get LLM suggestions ───────────────────────

  const goToMapping = useCallback(async () => {
    if (!fileInfo) return
    setStep(2)
    setSuggestLoading(true)
    setSuggestFallback(false)
    try {
      const suggestions = await api.invoke<MappingSuggestion[]>(
        IPC_CHANNELS.CSV_SUGGEST_MAPPINGS,
        fileInfo.headers,
        importType,
        fileInfo.sampleRows
      )
      const initial: UIFieldMapping[] = fileInfo.headers.map((h) => {
        const sug = suggestions.find((s) => s.csvHeader === h)
        const sampleValues = fileInfo.sampleRows.slice(0, 3).map((r) => r[h] ?? '').filter(Boolean)
        const isMultiValue = detectMultiValue(sampleValues)
        return {
          csvHeader: h,
          targetEntity: sug?.targetEntity ?? null,
          targetField: sug?.targetField ?? null,
          customFieldLabel: undefined,
          isMultiSelect: false,
          sampleValues,
          confidence: sug?.confidence ?? 'low',
          isMultiValue
        }
      })
      setMappings(initial)
      originalSuggestions.current = initial
    } catch {
      setSuggestFallback(true)
      const blank: UIFieldMapping[] = fileInfo.headers.map((h) => {
        const sampleValues = fileInfo.sampleRows.slice(0, 3).map((r) => r[h] ?? '').filter(Boolean)
        return {
          csvHeader: h,
          targetEntity: null,
          targetField: null,
          isMultiSelect: false,
          sampleValues,
          confidence: 'low' as const,
          isMultiValue: detectMultiValue(sampleValues)
        }
      })
      setMappings(blank)
      originalSuggestions.current = blank
    } finally {
      setSuggestLoading(false)
    }
  }, [fileInfo, importType])

  // ── Advance to step 3: preview ───────────────────────────────────

  const goToPreview = useCallback(async () => {
    if (!fileInfo) return
    setStep(3)
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const wireMappings: FieldMapping[] = mappings.map((m) => ({
        csvHeader: m.csvHeader,
        targetEntity: m.targetEntity,
        targetField: m.targetField,
        customFieldLabel: m.customFieldLabel,
        isMultiSelect: m.isMultiSelect
      }))
      const result = await api.invoke<PreviewResult>(
        IPC_CHANNELS.CSV_PREVIEW,
        fileInfo.filePath,
        wireMappings
      )
      setPreview(result)
    } catch (err) {
      setPreviewError(String(err))
    } finally {
      setPreviewLoading(false)
    }
  }, [fileInfo, mappings])

  // ── Run import ───────────────────────────────────────────────────

  const startImport = useCallback(async () => {
    if (!fileInfo) return
    setStep(4)
    setImporting(true)
    setProgress(null)
    setResult(null)

    const wireMappings: FieldMapping[] = mappings.map((m) => ({
      csvHeader: m.csvHeader,
      targetEntity: m.targetEntity,
      targetField: m.targetField,
      customFieldLabel: m.customFieldLabel,
      isMultiSelect: m.isMultiSelect
    }))

    const unsubscribe = api.on(IPC_CHANNELS.CSV_IMPORT_PROGRESS, (raw: unknown) => {
      setProgress(raw as ImportProgress)
    })

    try {
      const importResult = await api.invoke<ImportResult>(
        IPC_CHANNELS.CSV_IMPORT,
        fileInfo.filePath,
        wireMappings,
        importType,
        Object.keys(contactDefaults).length > 0 ? contactDefaults : undefined,
        Object.keys(companyDefaults).length > 0 ? companyDefaults : undefined
      )
      setResult(importResult)
    } catch (err) {
      setResult({
        contactsCreated: 0,
        companiesCreated: 0,
        skipped: 0,
        errors: [{ row: 0, message: String(err) }],
        durationMs: 0
      })
    } finally {
      setImporting(false)
      unsubscribe()
    }
  }, [fileInfo, mappings, importType, contactDefaults, companyDefaults])

  const cancelImport = useCallback(() => {
    api.send(IPC_CHANNELS.CSV_IMPORT_CANCEL)
  }, [])

  // ── Mapping row helpers ──────────────────────────────────────────

  const updateMapping = (idx: number, partial: Partial<UIFieldMapping>) => {
    setMappings((prev) => prev.map((m, i) => (i === idx ? { ...m, ...partial } : m)))
  }

  const resetMappings = () => {
    setMappings(originalSuggestions.current.map((m) => ({ ...m })))
  }

  const isValidToImport = mappings.some(
    (m) => m.targetEntity !== null && (m.targetField !== null || (m.customFieldLabel?.trim()))
  )

  // ── Field selector options based on import type ──────────────────

  const contactOptions = importType !== 'companies' ? CONTACT_FIELDS : []
  const companyOptions = importType !== 'contacts' ? COMPANY_FIELDS : []

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  // ── Step labels ──────────────────────────────────────────────────

  const STEP_LABELS: Record<Step, string> = {
    1: 'Step 1 of 4 — Select File',
    2: 'Step 2 of 4 — Map Fields',
    3: 'Step 3 of 4 — Preview',
    4: 'Step 4 of 4 — Import',
  }

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget && !importing) onClose() }}>
      <div className={styles.modal}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h2 className={styles.title}>Import Data</h2>
            <span className={styles.stepLabel}>{STEP_LABELS[step]}</span>
          </div>
          {!importing && (
            <button className={styles.closeBtn} onClick={onClose}>✕</button>
          )}
        </div>

        {/* Body */}
        <div className={styles.body}>

          {/* ── Step 1: Upload ──────────────────────────────────────── */}
          {step === 1 && (
            <>
              <div
                className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
                onClick={() => {
                  if (ignoreNextDropClickRef.current) return
                  openFileDialog()
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <span className={styles.dropIcon}>📄</span>
                <span className={styles.dropText}>
                  {fileLoading ? 'Reading file...' : 'Drop a CSV file here'}
                </span>
                <span className={styles.dropSubtext}>or</span>
                <button
                  className={styles.browseBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (ignoreNextDropClickRef.current) return
                    openFileDialog()
                  }}
                  disabled={fileLoading}
                >
                  Browse Files
                </button>
              </div>

              {fileInfo && (
                <div className={styles.fileSelected}>
                  <span>✓</span>
                  <span className={styles.fileName}>
                    {fileInfo.filePath.split('/').pop()}
                  </span>
                  <span className={styles.fileRows}>
                    {fileInfo.headers.length} columns
                  </span>
                </div>
              )}

              {step1Error && <div className={styles.errorMsg}>{step1Error}</div>}

              <div className={styles.importTypeRow}>
                <span className={styles.importTypeLabel}>Import as</span>
                <div className={styles.importTypeOptions}>
                  {([
                    ['contacts', 'Contacts'],
                    ['companies', 'Companies'],
                    ['contacts_and_companies', 'Contacts + Companies'],
                  ] as [ImportType, string][]).map(([val, label]) => (
                    <button
                      key={val}
                      className={`${styles.importTypeBtn} ${importType === val ? styles.active : ''}`}
                      onClick={() => setImportType(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Step 2: Map Fields ──────────────────────────────────── */}
          {step === 2 && (
            <>
              {sourceLabel && (
                <div className={styles.sourceLabel}>Looks like a {sourceLabel} — mappings pre-configured</div>
              )}

              {suggestLoading && (
                <div className={styles.loadingRow}>
                  <div className={styles.spinner} />
                  Suggesting field mappings...
                </div>
              )}

              {suggestFallback && !suggestLoading && (
                <div className={styles.fallbackNotice}>
                  LLM not available — using automatic field name matching. Review mappings below.
                </div>
              )}

              {!suggestLoading && (
                <>
                  <div className={styles.mappingHint}>
                    Map each CSV column to a Cyggie field, or choose "Create custom field" / "Skip".
                    Green/yellow/red dots show mapping confidence.
                  </div>

                  <div className={styles.mappingTable}>
                    <div className={styles.mappingHeader}>
                      <span>CSV Column</span>
                      <span>Conf.</span>
                      <span>Cyggie Field</span>
                      <span />
                    </div>
                    {mappings.map((m, idx) => {
                      const isFullNameOnly =
                        m.targetField === 'full_name' &&
                        !mappings.some((x) => x.targetField === 'first_name') &&
                        !mappings.some((x) => x.targetField === 'last_name')

                      // Multi-value: suggest existing multi-select fields first
                      const multiSelectContactOptions = contactOptions.filter((f) => f.isMultiSelect)
                      const multiSelectCompanyOptions = companyOptions.filter((f) => f.isMultiSelect)

                      return (
                        <div key={m.csvHeader} className={styles.mappingRow}>
                          {/* CSV column + sample values */}
                          <div className={styles.csvCol}>
                            <span className={styles.csvHeader}>{m.csvHeader}</span>
                            {m.isMultiValue && (
                              <span className={styles.multiValueBadge} title="Multiple comma-separated values detected">
                                multi-value
                              </span>
                            )}
                            {m.sampleValues.length > 0 && (
                              <span className={styles.sampleValues}>
                                {m.sampleValues.join(' · ')}
                              </span>
                            )}
                          </div>

                          {/* Confidence dot */}
                          <div
                            className={`${styles.confidenceDot} ${
                              m.confidence === 'high' ? styles.confidenceHigh :
                              m.confidence === 'medium' ? styles.confidenceMedium :
                              styles.confidenceLow
                            }`}
                          />

                          {/* Field selector */}
                          <div>
                            <select
                              className={styles.fieldSelect}
                              value={
                                m.targetEntity === null ? 'skip' :
                                m.targetField === null ? 'custom' :
                                `${m.targetEntity}:${m.targetField}`
                              }
                              onChange={(e) => {
                                const val = e.target.value
                                if (val === 'skip') {
                                  updateMapping(idx, { targetEntity: null, targetField: null, customFieldLabel: undefined, isMultiSelect: false, confidence: 'low' })
                                } else if (val === 'custom') {
                                  updateMapping(idx, { targetEntity: m.targetEntity ?? 'contact', targetField: null, customFieldLabel: m.csvHeader, isMultiSelect: m.isMultiValue ?? false, confidence: 'low' })
                                } else {
                                  const [entity, field] = val.split(':') as ['contact' | 'company', string]
                                  updateMapping(idx, { targetEntity: entity, targetField: field, customFieldLabel: undefined, isMultiSelect: false, confidence: 'medium' })
                                }
                              }}
                            >
                              <option value="skip">— Skip —</option>

                              {/* For multi-value columns, show matching multi-select fields first */}
                              {m.isMultiValue && (multiSelectContactOptions.length > 0 || multiSelectCompanyOptions.length > 0) && (
                                <optgroup label="Suggested (multi-select fields)">
                                  {multiSelectContactOptions.map((f) => (
                                    <option key={`mv-c-${f.value}`} value={`contact:${f.value}`}>{f.label}</option>
                                  ))}
                                  {multiSelectCompanyOptions.map((f) => (
                                    <option key={`mv-co-${f.value}`} value={`company:${f.value}`}>{f.label}</option>
                                  ))}
                                </optgroup>
                              )}

                              {contactOptions.length > 0 && (
                                <optgroup label="Contact Fields">
                                  {contactOptions.map((f) => (
                                    <option key={f.value} value={`contact:${f.value}`}>{f.label}</option>
                                  ))}
                                </optgroup>
                              )}
                              {companyOptions.length > 0 && (
                                <optgroup label="Company Fields">
                                  {companyOptions.map((f) => (
                                    <option key={f.value} value={`company:${f.value}`}>{f.label}</option>
                                  ))}
                                </optgroup>
                              )}
                              <optgroup label="Custom">
                                <option value="custom">Create custom field…</option>
                              </optgroup>
                            </select>

                            {/* Full Name split hint */}
                            {isFullNameOnly && (
                              <div className={styles.splitHint}>
                                Will auto-split into First Name + Last Name on import
                              </div>
                            )}

                            {/* Custom field config */}
                            {m.targetField === null && m.targetEntity !== null && (
                              <div className={styles.customFieldConfig}>
                                <input
                                  className={styles.customFieldInput}
                                  placeholder="Custom field label"
                                  value={m.customFieldLabel ?? ''}
                                  onChange={(e) => updateMapping(idx, { customFieldLabel: e.target.value })}
                                />
                                {m.isMultiValue && (
                                  <>
                                    <label className={styles.multiSelectToggle}>
                                      <input
                                        type="checkbox"
                                        checked={m.isMultiSelect ?? false}
                                        onChange={(e) => updateMapping(idx, { isMultiSelect: e.target.checked })}
                                      />
                                      Multi-select field
                                    </label>
                                    {m.isMultiSelect && m.sampleValues.length > 0 && (
                                      <div className={styles.optionsPreview}>
                                        <span className={styles.optionsLabel}>Detected options:</span>
                                        <div className={styles.optionChips}>
                                          {extractOptions(m.sampleValues).map((opt) => (
                                            <span key={opt} className={styles.optionChip}>{opt}</span>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>

                          <div />
                        </div>
                      )
                    })}
                  </div>

                  <button className={styles.resetBtn} onClick={resetMappings}>
                    ↺ Reset to suggestions
                  </button>

                  {/* ── Defaults section ─────────────────────────────── */}
                  <DefaultsSection
                    importType={importType}
                    mappings={mappings}
                    contactDefaults={contactDefaults}
                    setContactDefaults={setContactDefaults}
                    companyDefaults={companyDefaults}
                    setCompanyDefaults={setCompanyDefaults}
                  />
                </>
              )}
            </>
          )}

          {/* ── Step 3: Preview ─────────────────────────────────────── */}
          {step === 3 && (
            <>
              {previewLoading && (
                <div className={styles.loadingRow}>
                  <div className={styles.spinner} />
                  Scanning file...
                </div>
              )}

              {previewError && (
                <div className={styles.errorMsg}>{previewError}</div>
              )}

              {preview && !previewLoading && (
                <div className={styles.previewStats}>
                  <div className={styles.statCard}>
                    <span className={styles.statNumber}>{preview.totalRows}</span>
                    <span className={styles.statLabel}>Total rows</span>
                  </div>
                  {importType !== 'companies' && (
                    <div className={styles.statCard}>
                      <span className={`${styles.statNumber} ${preview.duplicateContactCount > 0 ? styles.statWarning : ''}`}>
                        {preview.duplicateContactCount}
                      </span>
                      <span className={styles.statLabel}>
                        {preview.duplicateContactCount === 0
                          ? 'No duplicate contacts'
                          : `Contact${preview.duplicateContactCount > 1 ? 's' : ''} already exist (will be skipped)`
                        }
                      </span>
                    </div>
                  )}
                  {importType !== 'contacts' && (
                    <div className={styles.statCard}>
                      <span className={`${styles.statNumber} ${preview.duplicateCompanyCount > 0 ? styles.statWarning : ''}`}>
                        {preview.duplicateCompanyCount}
                      </span>
                      <span className={styles.statLabel}>
                        {preview.duplicateCompanyCount === 0
                          ? 'No duplicate companies'
                          : `Compan${preview.duplicateCompanyCount > 1 ? 'ies' : 'y'} already exist (will be updated)`
                        }
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Step 4: Importing ────────────────────────────────────── */}
          {step === 4 && (
            <>
              {importing && progress && (
                <div className={styles.progressSection}>
                  <div className={styles.progressLabel}>{progress.message}</div>
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {importing && !progress && (
                <div className={styles.loadingRow}>
                  <div className={styles.spinner} />
                  Starting import...
                </div>
              )}

              {result && (
                <div className={styles.resultSummary}>
                  {result.contactsCreated > 0 && (
                    <div className={styles.resultRow}>
                      <span>Contacts created</span>
                      <span className={styles.resultVal}>{result.contactsCreated}</span>
                    </div>
                  )}
                  {result.companiesCreated > 0 && (
                    <div className={styles.resultRow}>
                      <span>Companies created</span>
                      <span className={styles.resultVal}>{result.companiesCreated}</span>
                    </div>
                  )}
                  {result.skipped > 0 && (
                    <div className={styles.resultRow}>
                      <span>Skipped (already exist)</span>
                      <span className={styles.resultVal}>{result.skipped}</span>
                    </div>
                  )}
                  <div className={styles.resultRow}>
                    <span>Duration</span>
                    <span className={styles.resultVal}>{(result.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                  {result.errors.length > 0 && (
                    <>
                      <div className={`${styles.resultRow} ${styles.resultError}`}>
                        <span>Errors</span>
                        <span className={styles.resultVal}>{result.errors.length}</span>
                      </div>
                      <div className={styles.errorList}>
                        {result.errors.slice(0, 20).map((e, i) => (
                          <div key={i} className={styles.errorItem}>
                            Row {e.row}: {e.message}
                          </div>
                        ))}
                        {result.errors.length > 20 && (
                          <div className={styles.errorItem}>…and {result.errors.length - 20} more</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {step === 1 && (
            <>
              <button className={styles.backBtn} onClick={onClose}>Cancel</button>
              <button
                className={styles.primaryBtn}
                disabled={!fileInfo || fileLoading}
                onClick={goToMapping}
              >
                Continue →
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <button className={styles.backBtn} onClick={() => setStep(1)}>← Back</button>
              <button
                className={styles.primaryBtn}
                disabled={!isValidToImport || suggestLoading}
                onClick={goToPreview}
              >
                Preview →
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <button className={styles.backBtn} onClick={() => setStep(2)}>← Back</button>
              <button
                className={styles.primaryBtn}
                disabled={previewLoading || !!previewError || !preview}
                onClick={startImport}
              >
                Import →
              </button>
            </>
          )}

          {step === 4 && (
            <>
              {importing && (
                <button className={styles.cancelBtn} onClick={cancelImport}>
                  Cancel
                </button>
              )}
              {result && (
                <>
                  {result.contactsCreated > 0 && (
                    <button
                      className={styles.viewImportedBtn}
                      onClick={() => {
                        navigate('/contacts?sortKey=createdAt&sortDir=desc')
                        onClose()
                      }}
                    >
                      View {result.contactsCreated} imported contact{result.contactsCreated !== 1 ? 's' : ''} →
                    </button>
                  )}
                  {result.companiesCreated > 0 && importType !== 'contacts' && (
                    <button
                      className={styles.viewImportedBtn}
                      onClick={() => {
                        navigate('/companies?sortKey=createdAt&sortDir=desc')
                        onClose()
                      }}
                    >
                      View {result.companiesCreated} imported compan{result.companiesCreated !== 1 ? 'ies' : 'y'} →
                    </button>
                  )}
                  <button className={styles.primaryBtn} onClick={onClose}>
                    Done
                  </button>
                </>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  )
}

// ─── DefaultsSection ─────────────────────────────────────────────────────────

interface DefaultsSectionProps {
  importType: ImportType
  mappings: UIFieldMapping[]
  contactDefaults: FieldDefaultsMap
  setContactDefaults: (d: FieldDefaultsMap) => void
  companyDefaults: FieldDefaultsMap
  setCompanyDefaults: (d: FieldDefaultsMap) => void
}

function DefaultsSection({
  importType,
  mappings,
  contactDefaults,
  setContactDefaults,
  companyDefaults,
  setCompanyDefaults,
}: DefaultsSectionProps) {
  const showContactDefaults = importType !== 'companies'
  const showCompanyDefaults = importType !== 'contacts'

  if (!showContactDefaults && !showCompanyDefaults) return null

  const contactTypeAlreadyMapped = mappings.some(
    (m) => m.targetEntity === 'contact' && m.targetField === 'contact_type'
  )

  // Contact default fields to show: contact_type auto-appears if not mapped from CSV
  const contactFieldsToShow = DEFAULTABLE_CONTACT_FIELDS.filter((f) => {
    if (f.key === 'contact_type') return !contactTypeAlreadyMapped
    return f.key in contactDefaults
  })

  const setContactDefault = (key: string, val: string) =>
    setContactDefaults({ ...contactDefaults, [key]: val })
  const removeContactDefault = (key: string) => {
    const next = { ...contactDefaults }
    delete next[key]
    setContactDefaults(next)
  }

  const setCompanyDefault = (key: string, val: string) =>
    setCompanyDefaults({ ...companyDefaults, [key]: val })
  const removeCompanyDefault = (key: string) => {
    const next = { ...companyDefaults }
    delete next[key]
    setCompanyDefaults(next)
  }

  // Available "add" fields (not yet shown)
  // contact_type is always handled specially (auto-shows or is irrelevant) — never in the "add" row
  const availableContactFields = DEFAULTABLE_CONTACT_FIELDS.filter(
    (f) => f.key !== 'contact_type' && !(f.key in contactDefaults)
  )
  const availableCompanyFields = DEFAULTABLE_COMPANY_FIELDS.filter(
    (f) => !(f.key in companyDefaults)
  )

  const activeCompanyFields = DEFAULTABLE_COMPANY_FIELDS.filter((f) => f.key in companyDefaults)

  const hasAnyContent =
    (showContactDefaults && (contactFieldsToShow.length > 0 || availableContactFields.length > 0)) ||
    (showCompanyDefaults && (activeCompanyFields.length > 0 || availableCompanyFields.length > 0))

  if (!hasAnyContent) return null

  return (
    <div className={styles.defaultsSection}>
      <div className={styles.defaultsSectionTitle}>Set defaults for unmapped fields (optional)</div>

      {showContactDefaults && contactFieldsToShow.map((f) => (
        <div key={f.key} className={styles.defaultsRow}>
          <span className={styles.defaultsFieldLabel}>{f.label}</span>
          {f.type === 'select' && f.key === 'contact_type' ? (
            <select
              className={styles.defaultsValueControl}
              value={contactDefaults[f.key] ?? ''}
              onChange={(e) => setContactDefault(f.key, e.target.value)}
            >
              <option value="">— none —</option>
              {CONTACT_TYPES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              maxLength={500}
              className={styles.defaultsValueControl}
              value={contactDefaults[f.key] ?? ''}
              placeholder={`Default ${f.label.toLowerCase()}…`}
              onChange={(e) => setContactDefault(f.key, e.target.value)}
            />
          )}
          {f.key !== 'contact_type' && (
            <button className={styles.defaultsRemoveBtn} onClick={() => removeContactDefault(f.key)} title="Remove">×</button>
          )}
        </div>
      ))}

      {showCompanyDefaults && DEFAULTABLE_COMPANY_FIELDS.filter((f) => f.key in companyDefaults).map((f) => (
        <div key={f.key} className={styles.defaultsRow}>
          <span className={styles.defaultsFieldLabel}>{f.label}</span>
          {f.key === 'entity_type' ? (
            <select
              className={styles.defaultsValueControl}
              value={companyDefaults[f.key] ?? ''}
              onChange={(e) => setCompanyDefault(f.key, e.target.value)}
            >
              <option value="">— none —</option>
              {ENTITY_TYPES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <select
              className={styles.defaultsValueControl}
              value={companyDefaults[f.key] ?? ''}
              onChange={(e) => setCompanyDefault(f.key, e.target.value)}
            >
              <option value="">— none —</option>
              {STAGES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
          <button className={styles.defaultsRemoveBtn} onClick={() => removeCompanyDefault(f.key)} title="Remove">×</button>
        </div>
      ))}

      {/* Add default buttons */}
      <div className={styles.defaultsAddRow}>
        {showContactDefaults && availableContactFields.map((f) => (
          <button
            key={f.key}
            className={styles.defaultsAddBtn}
            onClick={() => setContactDefault(f.key, '')}
          >
            + {f.label}
          </button>
        ))}
        {showCompanyDefaults && availableCompanyFields.map((f) => (
          <button
            key={f.key}
            className={styles.defaultsAddBtn}
            onClick={() => setCompanyDefault(f.key, '')}
          >
            + {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}
