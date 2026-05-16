import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type HTMLAttributes } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
import { useHeaderChipOrder } from '../../hooks/useHeaderChipOrder'
import { useHardcodedFieldOrder } from '../../hooks/useHardcodedFieldOrder'
import { useFieldVisibility } from '../../hooks/useFieldVisibility'
import { useSectionOrder } from '../../hooks/useSectionOrder'
import { useListboxNavigation } from '../../hooks/useListboxNavigation'
import { useTakeaways } from '../../hooks/useTakeaways'
import { useTimedError } from '../../hooks/useTimedError'
import { KeyTakeawaysCard } from '../common/KeyTakeawaysCard'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactDetail, LinkedInWorkEntry, LinkedInEducationEntry } from '../../../shared/types/contact'
import type { CompanySummary } from '../../../shared/types/company'
import type { CustomFieldWithValue, CustomFieldValue } from '../../../shared/types/custom-fields'
import { CONTACT_SECTIONS } from '../../../shared/types/custom-fields'
import ConfirmDialog from '../common/ConfirmDialog'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { PropertyRow, type PropertyRowType } from '../crm/PropertyRow'
import { chipStyle } from '../../utils/colorChip'
import { CreateCustomFieldModal } from '../crm/CreateCustomFieldModal'
import { ChipSelect } from '../crm/ChipSelect'
import { TagPicker } from '../crm/TagPicker'
import { INDUSTRY_OPTIONS } from '../company/companyColumns'
import { SocialsEditor } from '../crm/SocialsEditor'
import { AddFieldDropdown } from '../crm/AddFieldDropdown'
import { computeChipDelta } from '../../utils/chip-delta'
import { usePinnedMigration } from '../../hooks/usePinnedMigration'
import { ContactHeaderCard } from './ContactHeaderCard'
import { saveLayoutPref, propagateLayoutPref, clearPerEntityPref } from '../../utils/layoutPref'
import { CONTACT_HARDCODED_FIELDS } from '../../constants/contactFields'
import { CollapsibleSection } from '../crm/CollapsibleSection'
import { PropertiesCard, PropertiesCardFooter } from '../crm/PropertiesCard'
import { useSectionCollapse } from '../../hooks/useSectionCollapse'
import {
  CONTACT_TYPES,
  CONTACT_COLUMN_DEFS,
} from './contactColumns'
import { EnrichMethodModal } from '../common/EnrichMethodModal'
import { Spinner } from '../common/Spinner'
import styles from './ContactPropertiesPanel.module.css'
import { api } from '../../api'
import { withOptimisticUpdate } from '../../utils/withOptimisticUpdate'

// All pref base keys managed as per-contact layout overrides (contacts have no sub-type tier)
const LAYOUT_PREF_BASE_KEYS = [
  'cyggie:contact-hidden-header-chips',
  'cyggie:contact-header-chip-order',
  'cyggie:contact-added-fields',
  'cyggie:contact-field-placements',
  'cyggie:contact-sections-order',
] as const

const TALENT_PIPELINE_STAGES: { value: string; label: string }[] = [
  { value: 'identified',          label: 'Identified / Passive' },
  { value: 'exploring',           label: 'Exploring'             },
  { value: 'ideating',            label: 'Ideating'              },
  { value: 'fundraising',         label: 'Fundraising'           },
  { value: 'portfolio_candidate', label: 'Portfolio Candidate'   },
  { value: 'internal_candidate',  label: 'Internal Candidate'    },
]

interface ContactPropertiesPanelProps {
  contact: ContactDetail
  lastTouchpoint?: string | null
  onUpdate: (updates: Record<string, unknown>) => void
  showEnrichBanner?: boolean
  enrichMeetingCount?: number
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>
  onEnrichFromMeetings?: () => void
  exaApiKey?: string
  onRequestCreateCompany?: () => void
}

function LastTouchBadge({ lastTouchpoint }: { lastTouchpoint: string | null | undefined }) {
  const days = daysSince(lastTouchpoint ?? null)
  if (days == null) return <span className={`${styles.touchBadge} ${styles.touchNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.touchBadge} ${styles.touchGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.touchBadge} ${styles.touchYellow}`}>{days}d ago</span>
  return <span className={`${styles.touchBadge} ${styles.touchRed}`}>{days}d ago</span>
}

function SectionHeader({
  title,
  collapsible,
  isCollapsed,
  onToggle,
}: {
  title: string
  collapsible?: boolean
  isCollapsed?: boolean
  onToggle?: () => void
}) {
  return (
    <div className={styles.sectionHeader}>
      {title}
      {collapsible && (
        <button
          className={styles.sectionCollapseBtn}
          onClick={onToggle}
          title={isCollapsed ? 'Expand section' : 'Collapse section'}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
      )}
    </div>
  )
}

// Prior Company — storage format supports both plain string and { name, companyId } entries
export type PriorCompanyEntry = string | { name: string; companyId: string }

export function parsePriorCompanies(raw: string | null | undefined): PriorCompanyEntry[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw)
    return Array.isArray(p) ? p : [raw]
  } catch {
    return [raw]
  }
}

function priorCompanyName(entry: PriorCompanyEntry): string {
  return typeof entry === 'string' ? entry : entry.name
}

function parseLinkedInJson<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try { return JSON.parse(raw) as T[] } catch { return [] }
}

function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return ''
  const ms = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatPinnedValue(value: unknown, type: string, options?: { value: string; label: string }[]): string | null {
  if (value == null || value === '') return null
  if (options) {
    const opt = options.find((o) => o.value === String(value))
    if (opt) return opt.label
  }
  switch (type) {
    case 'currency': return formatCurrency(Number(value))
    case 'date': return formatDate(String(value))
    default: return String(value)
  }
}

function filteredOtherSocials(otherSocials: string | null, linkedinUrl: string | null): string | null {
  if (!linkedinUrl || !otherSocials) return otherSocials
  try {
    const obj = JSON.parse(otherSocials) as Record<string, string>
    const filtered = Object.fromEntries(
      Object.entries(obj).filter(([k]) => k.toLowerCase() !== 'linkedin')
    )
    return Object.keys(filtered).length > 0 ? JSON.stringify(filtered) : null
  } catch {
    return otherSocials
  }
}

export function ContactPropertiesPanel({
  contact,
  lastTouchpoint,
  onUpdate,
  showEnrichBanner,
  enrichMeetingCount,
  fieldSources,
  onEnrichFromMeetings,
  exaApiKey = '',
  onRequestCreateCompany
}: ContactPropertiesPanelProps) {
  const navigate = useNavigate()
  // back button now lives in ContactDetail
  const [enrichMethodModalOpen, setEnrichMethodModalOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [firstNameDraft, setFirstNameDraft] = useState(contact.firstName ?? '')
  const [lastNameDraft, setLastNameDraft] = useState(contact.lastName ?? '')
  const [emailDraft, setEmailDraft] = useState(contact.emails[0] || contact.email || '')
  const [linkedinDraft, setLinkedinDraft] = useState(contact.linkedinUrl || '')
  const [phoneDraft, setPhoneDraft] = useState(contact.phone || '')
  const [cityDraft, setCityDraft] = useState(contact.city || '')
  const [stateDraft, setStateDraft] = useState(contact.state || '')
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [mergePickerOpen, setMergePickerOpen] = useState(false)
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeResults, setMergeResults] = useState<{ id: string; name: string }[]>([])
  const [mergeTarget, setMergeTarget] = useState<{ id: string; name: string } | null>(null)
  const [merging, setMerging] = useState(false)
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const [createFieldSection, setCreateFieldSection] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [linkedinEnriching, setLinkedinEnriching] = useState(false)
  const [linkedinError, setLinkedinError] = useState<{ code: string; message: string } | null>(null)
  const metaSaveError = useTimedError()
  const optionError = useTimedError(4000)
  const [isSearchingLinkedIn, setIsSearchingLinkedIn] = useState(false)
  const [linkedInFoundUrl, setLinkedInFoundUrl] = useState<string | null>(null)
  const [showLinkedInConfirm, setShowLinkedInConfirm] = useState(false)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editingFieldLabel, setEditingFieldLabel] = useState('')
  const [addFieldDropdownOpen, setAddFieldDropdownOpen] = useState(false)
  // Primary company edit state
  const [companyDraft, setCompanyDraft] = useState(contact.primaryCompany?.canonicalName ?? '')
  const [companyAutocomplete, setCompanyAutocomplete] = useState<CompanySummary[] | null>(null)
  const companyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const companyAutocompleteItems = useMemo(() => companyAutocomplete ?? [], [companyAutocomplete])
  const {
    activeIndex: companyActiveIdx,
    setActiveIndex: setCompanyActiveIdx,
    onKeyDown: companyAutocompleteKeyDown,
    listRef: companyAutocompleteRef,
  } = useListboxNavigation(companyAutocompleteItems, {
    initialIndex: 0,
    onSelect: (c) => {
      setCompanyDraft(c.canonicalName)
      setCompanyAutocomplete(null)
      void saveCompany(c.canonicalName)
    },
    onEscape: () => setCompanyAutocomplete(null),
  })

  // Prior Company multi-value state
  const [priorCompanyDrafts, setPriorCompanyDrafts] = useState<PriorCompanyEntry[]>(() => parsePriorCompanies(contact.previousCompanies))
  const [priorCompanyAutocomplete, setPriorCompanyAutocomplete] = useState<{ index: number; results: CompanySummary[] } | null>(null)
  const priorCompanyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const priorCompanyAutocompleteItems = useMemo(
    () => priorCompanyAutocomplete?.results ?? [],
    [priorCompanyAutocomplete]
  )
  const {
    activeIndex: priorCompanyActiveIdx,
    setActiveIndex: setPriorCompanyActiveIdx,
    onKeyDown: priorCompanyAutocompleteKeyDown,
    listRef: priorCompanyAutocompleteRef,
  } = useListboxNavigation(priorCompanyAutocompleteItems, {
    initialIndex: 0,
    onSelect: (c) => {
      selectPriorCompanyAutocomplete({ name: c.canonicalName, companyId: c.id })
    },
    onEscape: () => setPriorCompanyAutocomplete(null),
  })
  const firstNameInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [sessionNewFields, setSessionNewFields] = useState<string[] | null>(null)
  const sessionChanges = useRef(false)
  const sessionAddedFields = useRef<string[]>([])
  const markChanged = useCallback(() => { sessionChanges.current = true }, [])

  // Key Takeaways — shared hook handles all state + streaming + persistence
  const kt = useTakeaways({
    entityType: 'contact',
    entityId: contact.id,
    savedText: contact.keyTakeaways ?? null,
    onUpdate: (updates) => onUpdate(updates),
    hasNewDataSince: (generatedAt) =>
      contact.meetings.some((m) => m.date > generatedAt),
  })

  const [copiedMeta, setCopiedMeta] = useState<string | null>(null)
  const copiedMetaTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { contactDefs, refresh, loaded: defsLoaded, load: loadDefs, version: defsVersion } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:contact-summary-fields', [])
  const hiddenFields = getJSON<string[]>('cyggie:contact-hidden-fields', [])
  const hiddenHeaderChips = getJSON<string[]>('cyggie:contact-hidden-header-chips', [])

  const contactTypeDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'contactType')
  const contactTypeOptions = mergeBuiltinOptions(CONTACT_TYPES, contactTypeDef?.optionsJson ?? null)

  const talentPipelineDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'talentPipeline')
  const talentPipelineOptions = mergeBuiltinOptions(TALENT_PIPELINE_STAGES, talentPipelineDef?.optionsJson ?? null)

  const sectorFocusDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'investmentSectorFocus')
  const sectorFocusOptions = mergeBuiltinOptions(INDUSTRY_OPTIONS, sectorFocusDef?.optionsJson ?? null)

  const fieldVisibility = useFieldVisibility(
    'contact',
    CONTACT_HARDCODED_FIELDS,
    hiddenFields,
    showAllFields,
    isEditing,
    { entityId: contact.id, profileKey: null, onLayoutChange: markChanged },
  )

  const sectionOrder = useSectionOrder(
    'contact',
    CONTACT_SECTIONS.filter(s => s.key !== 'summary').map(s => s.key),
    contact.id,
    null,
    markChanged,
  )

  // Per-entity collapsed sections (Change 10)
  // Variant C: persistence machinery moved to useSectionCollapse hook.
  const sectionCollapse = useSectionCollapse('contact', contact.id)
  const isCollapsed = sectionCollapse.isCollapsed
  const _toggleSectionFromHook = sectionCollapse.toggle

  // Variant C: track which sections the user has manually toggled (suppresses auto-collapse).
  const [userToggledSections, setUserToggledSections] = useState<Set<string>>(new Set())
  const hasUserToggledSection = (key: string) => userToggledSections.has(key)
  function toggleSectionUser(key: string) {
    setUserToggledSections((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev); next.add(key); return next
    })
    _toggleSectionFromHook(key)
  }
  // Variant C: per-section "+ Add" support.
  const [addFieldSection, setAddFieldSection] = useState<string | null>(null)
  function openAddFieldDropdown(section: string | null) {
    setAddFieldSection(section)
    setAddFieldDropdownOpen(true)
  }

  // toggleSection is the user-facing toggle (records manual interaction for auto-collapse logic).
  const toggleSection = toggleSectionUser

  function togglePinnedKey(key: string, force?: boolean) {
    const next = force === true
      ? (pinnedKeys.includes(key) ? pinnedKeys : [...pinnedKeys, key])
      : force === false
        ? pinnedKeys.filter((k) => k !== key)
        : (pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [...pinnedKeys, key])
    setJSON('cyggie:contact-summary-fields', next)
  }

  function hideHeaderChip(key: string) {
    if (!hiddenHeaderChips.includes(key)) {
      saveLayoutPref(setJSON, 'cyggie:contact-hidden-header-chips', contact.id, [...hiddenHeaderChips, key])
      markChanged()
    }
  }

  function restoreHeaderChip(key: string) {
    saveLayoutPref(setJSON, 'cyggie:contact-hidden-header-chips', contact.id, hiddenHeaderChips.filter(k => k !== key))
    markChanged()
  }

  const sectionableFields = useMemo(() => customFields.filter(f => !f.isBuiltin), [customFields])
  const { draggingFieldId, setDraggingFieldId, dragOverSection, draggingOverFieldId, setDraggingOverFieldId, sectionedFields, nullSectionFields, handleWithinSectionDrop, sectionDragProps } =
    useCustomFieldSection('contact', contact.id, sectionableFields, setCustomFields)

  const hfOrder = useHardcodedFieldOrder('contact')

  // Deduplicate: custom fields in 'summary' section + pinned builtin keys
  const customSummaryIds = customFields.filter(f => f.section === 'summary').map(f => `custom:${f.id}`)
  const allChipIds = [...new Set(['contactType', ...pinnedKeys, ...customSummaryIds])]
  const { effectiveOrder, chipDragProps, chipDropZoneProps, chipDragOverIndex } =
    useHeaderChipOrder('contact', allChipIds, contact.id, null, markChanged)

  // Migrate old 'Pinned' section fields to 'Header' section (Change 4)
  usePinnedMigration('contact')

  async function handlePinnedFieldSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, contact.id)
      setCustomFields(prev => prev.map(f => f.id === field.id ? { ...f, value: null } : f))
      return
    }
    // Build optimistic CustomFieldValue so PropertyRow displays the new value immediately
    // after edit mode exits (without waiting for the IPC round-trip).
    const optimisticValue: CustomFieldValue = {
      id: field.value?.id ?? '',
      fieldDefinitionId: field.id,
      entityType: 'contact',
      entityId: contact.id,
      valueText: null, valueNumber: null, valueBoolean: null,
      valueDate: null, valueRefId: null, resolvedLabel: null,
      createdAt: field.value?.createdAt ?? '',
      updatedAt: new Date().toISOString(),
      ...(field.fieldType === 'number' || field.fieldType === 'currency'
        ? { valueNumber: Number(newValue) }
        : field.fieldType === 'boolean'
        ? { valueBoolean: Boolean(newValue) }
        : field.fieldType === 'date'
        ? { valueDate: String(newValue) }
        : field.fieldType === 'contact_ref' || field.fieldType === 'company_ref'
        ? { valueRefId: String(newValue) }
        : { valueText: String(newValue) })
    }
    const input: import('../../../shared/types/custom-fields').SetCustomFieldValueInput = {
      fieldDefinitionId: field.id,
      entityId: contact.id,
      entityType: 'contact',
    }
    switch (field.fieldType) {
      case 'number': case 'currency': input.valueNumber = Number(newValue); break
      case 'boolean': input.valueBoolean = Boolean(newValue); break
      case 'date': input.valueDate = String(newValue); break
      case 'contact_ref': case 'company_ref': input.valueRefId = String(newValue); break
      default: input.valueText = String(newValue)
    }
    const prev = customFields
    return withOptimisticUpdate(
      () => setCustomFields(fs => fs.map(f => f.id === field.id ? { ...f, value: optimisticValue } : f)),
      () => api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input),
      () => setCustomFields(prev),
    )
  }

  function getPinnedFieldValue(field: CustomFieldWithValue): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number': case 'currency': return field.value.valueNumber
      case 'boolean': return field.value.valueBoolean
      case 'date': return field.value.valueDate
      case 'contact_ref': case 'company_ref': return field.value.valueRefId
      default: return field.value.valueText
    }
  }

  // Inline field label rename (Change 11)
  async function handleFieldLabelSave(fieldId: string, newLabel: string) {
    const trimmed = newLabel.trim()
    if (!trimmed) { setEditingFieldId(null); return }
    const prev = customFields
    setCustomFields(fs => fs.map(f => f.id === fieldId ? { ...f, label: trimmed } : f))
    setEditingFieldId(null)
    try {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, fieldId, { label: trimmed })
    } catch {
      setCustomFields(prev) // rollback on failure
    }
  }

  // Wrap sectionDragProps to also sync pinnedKeys when a field crosses the 'summary' boundary
  // and to handle section reorder drops when a section drag is in flight.
  function syncedSectionDragProps(sectionKey: string): HTMLAttributes<HTMLDivElement> {
    const base = sectionDragProps(sectionKey)
    return {
      ...base,
      onDrop: (e) => {
        if (sectionOrder.draggingSectionKey) {
          // Section reorder drop — only one drag type can be in flight at a time
          sectionOrder.reorder(sectionOrder.draggingSectionKey, sectionKey)
          sectionOrder.setDraggingSectionKey(null)
          sectionOrder.setDragOverSectionKey(null)
          return
        }
        if (draggingFieldId) {
          const draggingField = customFields.find(f => f.id === draggingFieldId)
          const fromSection = draggingField?.section ?? null
          const chipId = `custom:${draggingFieldId}`
          const newPinnedKeys = computeChipDelta(fromSection, sectionKey, chipId, pinnedKeys)
          if (newPinnedKeys !== pinnedKeys) {
            setJSON('cyggie:contact-summary-fields', newPinnedKeys)
          }
        }
        base.onDrop?.(e)
      },
    }
  }

  useEffect(() => {
    if (!defsLoaded) loadDefs()
  }, [defsLoaded, loadDefs])

  useEffect(() => {
    if (!defsLoaded) return
    window.api
      .invoke<{ success: boolean; data?: CustomFieldWithValue[] }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
        'contact',
        contact.id
      )
      .then((res) => { if (res.success && res.data) setCustomFields(res.data) })
      .catch(console.error)
  }, [contact.id, defsLoaded, defsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset sessionChanges flag when entering Edit View
  useEffect(() => {
    if (isEditing) sessionChanges.current = false
  }, [isEditing])

  // Sync field drafts when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setFirstNameDraft(contact.firstName ?? '')
      setLastNameDraft(contact.lastName ?? '')
      setCompanyDraft(contact.primaryCompany?.canonicalName ?? '')
      setPriorCompanyDrafts(parsePriorCompanies(contact.previousCompanies))
      setEmailDraft(contact.emails[0] || contact.email || '')
      setLinkedinDraft(contact.linkedinUrl || '')
      setPhoneDraft(contact.phone || '')
      setCityDraft(contact.city || '')
      setStateDraft(contact.state || '')
      setTimeout(() => firstNameInputRef.current?.focus(), 0)
    }
    // Meta field drafts (email, linkedin, phone, city, state) are intentionally
    // NOT in the dep array — we only sync them on edit mode entry, not on every
    // contact prop change, to avoid clobbering user input mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, contact.firstName, contact.lastName, contact.previousCompanies])

  // Keyboard shortcut: E to enter edit mode, Esc to exit (guard against inputs)
  const handleDoneRef = useRef(handleDone)
  handleDoneRef.current = handleDone
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as Element | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLButtonElement ||
        target instanceof HTMLSelectElement ||
        // TipTap / ProseMirror editing surfaces are <div contenteditable="true">.
        // Without this guard, typing a word containing 'e' inside any inline
        // editor on the page (NoteCreator, etc.) would trigger the panel's
        // edit-mode shortcut.
        (target instanceof HTMLElement && target.isContentEditable)
      ) return
      if ((e.key === 'e' || e.key === 'E') && !isEditing) setIsEditing(true)
      if (e.key === 'Escape' && isEditing) void handleDoneRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isEditing])

  // Auto-generate on first visit when contact has data but no saved takeaways —
  // gated on the `autoGenerateKeyTakeaways` setting (default OFF).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let v: string | null = null
      try {
        v = await api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'autoGenerateKeyTakeaways')
      } catch (err) {
        console.warn('[KT] settings read failed; defaulting auto-generate OFF:', err)
        return
      }
      if (cancelled) return
      if (v !== 'true') return
      const hasData = contact.meetings.length > 0 || contact.emailCount > 0 || contact.noteCount > 0
      if (!contact.keyTakeaways && hasData) {
        kt.generate()
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id]) // only run when contact changes, not on every render

  function copyMeta(value: string, key: string) {
    if (copiedMetaTimeoutRef.current) clearTimeout(copiedMetaTimeoutRef.current)
    navigator.clipboard.writeText(value).then(() => {
      setCopiedMeta(key)
      copiedMetaTimeoutRef.current = setTimeout(() => {
        setCopiedMeta(null)
        copiedMetaTimeoutRef.current = null
      }, 1500)
    }).catch(() => { /* clipboard unavailable */ })
  }

  function handleCompanyInput(value: string) {
    setCompanyDraft(value)
    setCompanyAutocomplete(null)
    if (companyDebounceRef.current) clearTimeout(companyDebounceRef.current)
    if (value.trim().length < 1) return
    companyDebounceRef.current = setTimeout(async () => {
      try {
        const results = await api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, { query: value.trim(), limit: 6 })
        setCompanyAutocomplete(results ?? [])
        setCompanyActiveIdx(0)
      } catch { /* ignore */ }
    }, 200)
  }

  async function saveCompany(name: string) {
    const trimmed = name.trim()
    if (trimmed === (contact.primaryCompany?.canonicalName ?? '')) return
    const prevCompany = contact.primaryCompany
    try {
      const updated = await api.invoke<ContactDetail>(IPC_CHANNELS.CONTACT_SET_COMPANY, contact.id, trimmed || null)
      onUpdate(updated)
    } catch (e) {
      console.error('[ContactPropertiesPanel] saveCompany failed:', e)
      setCompanyDraft(prevCompany?.canonicalName ?? '')
    }
  }

  function handlePriorCompanyInput(index: number, value: string) {
    setPriorCompanyDrafts(prev => prev.map((e, i) => i === index ? value : e))
    setPriorCompanyAutocomplete(null)
    if (priorCompanyDebounceRef.current) clearTimeout(priorCompanyDebounceRef.current)
    if (value.trim().length < 1) return
    priorCompanyDebounceRef.current = setTimeout(async () => {
      try {
        const results = await api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, { query: value.trim(), limit: 6 })
        setPriorCompanyAutocomplete({ index, results: results ?? [] })
        setPriorCompanyActiveIdx(0)
      } catch { /* ignore */ }
    }, 200)
  }

  function selectPriorCompanyAutocomplete(entry: { name: string; companyId: string }) {
    if (priorCompanyAutocomplete == null) return
    const { index } = priorCompanyAutocomplete
    setPriorCompanyDrafts(prev => prev.map((e, i) => i === index ? entry : e))
    setPriorCompanyAutocomplete(null)
    save('previousCompanies', JSON.stringify(
      priorCompanyDrafts.map((e, i) => i === index ? entry : e).filter(e => priorCompanyName(e).trim())
    ))
  }

  function savePriorCompanies(drafts: PriorCompanyEntry[]) {
    const filtered = drafts.filter(e => priorCompanyName(e).trim())
    save('previousCompanies', filtered.length ? JSON.stringify(filtered) : null)
  }

  async function save(field: string, value: unknown) {
    const prev = (contact as Record<string, unknown>)[field]
    return withOptimisticUpdate(
      () => onUpdate({ [field]: value }),
      () => window.api.invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { [field]: value }),
      () => onUpdate({ [field]: prev }),
    )
  }

  async function saveEmail(oldEmail: string, newEmail: string) {
    const isPrimary = oldEmail === contact.email
    const optimisticEmails = contact.emails.map(e => e === oldEmail ? newEmail : e)
    await withOptimisticUpdate(
      () => onUpdate({ emails: optimisticEmails, ...(isPrimary ? { email: newEmail } : {}) }),
      () => isPrimary
        ? window.api.invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { email: newEmail })
        : window.api.invoke(IPC_CHANNELS.CONTACT_UPDATE_EMAIL, { contactId: contact.id, oldEmail, newEmail }),
      () => onUpdate({ emails: contact.emails, ...(isPrimary ? { email: contact.email } : {}) }),
      (updated) => onUpdate(updated),
    )
  }

  async function addEmail(email: string) {
    const isFirst = contact.emails.length === 0
    await withOptimisticUpdate(
      () => onUpdate({ emails: [...contact.emails, email], ...(isFirst ? { email } : {}) }),
      () => window.api.invoke(IPC_CHANNELS.CONTACT_ADD_EMAIL, contact.id, email),
      () => onUpdate({ emails: contact.emails, ...(isFirst ? { email: contact.email } : {}) }),
      (updated) => onUpdate(updated as Record<string, unknown>),
    )
  }

  async function removeEmail(email: string) {
    const isPrimary = email === contact.email
    try {
      await withOptimisticUpdate(
        () => onUpdate({
          emails: contact.emails.filter(e => e !== email),
          ...(isPrimary ? { email: null } : {}),
        }),
        () => window.api.invoke(IPC_CHANNELS.CONTACT_REMOVE_EMAIL, contact.id, email),
        () => onUpdate({
          emails: contact.emails,
          ...(isPrimary ? { email: contact.email } : {}),
        }),
        (updated) => onUpdate(updated),
      )
    } catch (err) {
      console.error('[ContactPropertiesPanel] removeEmail failed:', err)
    }
  }

  async function handleDone() {
    metaSaveError.clear()

    const firstName = firstNameDraft.trim()
    const lastName = lastNameDraft.trim()
    const fullName = [firstName, lastName].filter(Boolean).join(' ')
    if (fullName && fullName !== contact.fullName) {
      await window.api
        .invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { firstName: firstName || null, lastName: lastName || null })
        .then(() => { onUpdate({ firstName: firstName || null, lastName: lastName || null, fullName }) })
        .catch(console.error)
    }

    // Save meta fields from draft state
    try {
      const trimmedEmail = emailDraft.trim()
      const existingEmail = contact.emails[0] || contact.email || ''
      if (trimmedEmail && trimmedEmail !== existingEmail) {
        if (existingEmail) {
          await saveEmail(existingEmail, trimmedEmail)
        } else {
          await addEmail(trimmedEmail)
        }
      } else if (!trimmedEmail && existingEmail) {
        await removeEmail(existingEmail)
      }

      const trimmedLinkedin = linkedinDraft.trim()
      if (trimmedLinkedin !== (contact.linkedinUrl || '')) {
        await save('linkedinUrl', trimmedLinkedin || null)
      }

      const trimmedPhone = phoneDraft.trim()
      if (trimmedPhone !== (contact.phone || '')) {
        await save('phone', trimmedPhone || null)
      }

      const trimmedCity = cityDraft.trim()
      if (trimmedCity !== (contact.city || '')) {
        await save('city', trimmedCity || null)
      }

      const trimmedState = stateDraft.trim()
      if (trimmedState !== (contact.state || '')) {
        await save('state', trimmedState || null)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save'
      metaSaveError.show(msg)
      return // Stay in edit mode so user can fix the issue
    }

    // Clean up any explicitly-added empty fields from the addedFields pref
    const emptyKeys = fieldVisibility.addedFields.filter(key => {
      if (key.startsWith('custom:')) {
        const fieldId = key.slice(7)
        return !customFields.find(f => f.id === fieldId)?.value
      }
      if (key === 'previousCompanies') return parsePriorCompanies(contact.previousCompanies as string | null).length === 0
      const value = contact[key as keyof ContactDetail]
      return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    })
    // Compute newly-added fields BEFORE cleanupOnDone (reads stable closure value),
    // manually excluding empty keys that cleanupOnDone is about to strip.
    const newlyAdded = fieldVisibility.addedFields
      .filter(f => !sessionAddedFields.current.includes(f))
      .filter(f => !emptyKeys.includes(f))
    fieldVisibility.cleanupOnDone(emptyKeys)
    if (sessionChanges.current) {
      setSessionNewFields(newlyAdded)
    } else {
      setIsEditing(false)
    }
  }

  function handleApplyToAll() {
    for (const baseKey of LAYOUT_PREF_BASE_KEYS) {
      propagateLayoutPref(getJSON, setJSON, baseKey, contact.id, null)
    }
    setSessionNewFields(null)
    setIsEditing(false)
  }

  function handleJustThisContact() {
    setSessionNewFields(null)
    setIsEditing(false)
  }

  function handleResetLayout() {
    for (const baseKey of LAYOUT_PREF_BASE_KEYS) {
      clearPerEntityPref(setJSON, baseKey, contact.id)
    }
    setIsEditing(false)
    sessionChanges.current = false
  }

  function handleCancel() {
    setFirstNameDraft(contact.firstName ?? '')
    setLastNameDraft(contact.lastName ?? '')
    setCompanyDraft(contact.primaryCompany?.canonicalName ?? '')
    setEmailDraft(contact.emails[0] || contact.email || '')
    setLinkedinDraft(contact.linkedinUrl || '')
    setPhoneDraft(contact.phone || '')
    setCityDraft(contact.city || '')
    setStateDraft(contact.state || '')
    setSessionNewFields(null)
    setIsEditing(false)
  }

  async function handleLinkedInEnrich() {
    if (linkedinEnriching) return
    setLinkedinEnriching(true)
    setLinkedinError(null)
    try {
      const result = await api.invoke<{
        success: boolean
        errorCode?: string
        message?: string
        contact?: ContactDetail
        summary?: { positionCount: number; schoolCount: number; skillCount: number; companiesLinked: number }
      }>(IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN, contact.id)
      if (result.success && result.contact) {
        onUpdate(result.contact)
      } else {
        setLinkedinError({ code: result.errorCode ?? 'unknown', message: result.message ?? 'Enrichment failed' })
      }
    } catch (err) {
      setLinkedinError({ code: 'unknown', message: String(err) })
    } finally {
      setLinkedinEnriching(false)
    }
  }

  async function handleLinkedInOpenLogin() {
    await api.invoke(IPC_CHANNELS.CONTACT_LINKEDIN_OPEN_LOGIN)
    setLinkedinError(null)
  }

  async function handleFindOnLinkedIn() {
    if (isSearchingLinkedIn || linkedinEnriching) return
    setIsSearchingLinkedIn(true)
    setLinkedinError(null)
    try {
      const result = await api.invoke<{
        success: boolean
        foundUrl: string | null
        contactName: string
        alreadyHadUrl?: boolean
        errorCode?: string
        message?: string
      }>(IPC_CHANNELS.CONTACT_FIND_LINKEDIN_URL, contact.id)
      if (!result.success) {
        setLinkedinError({ code: result.errorCode ?? 'unknown', message: result.message ?? 'Search failed' })
      } else if (result.alreadyHadUrl) {
        void handleLinkedInEnrich()
      } else if (result.foundUrl) {
        setLinkedInFoundUrl(result.foundUrl)
        setShowLinkedInConfirm(true)
      } else {
        setLinkedinError({ code: 'not_found', message: 'No LinkedIn profile found for this contact' })
      }
    } catch (err) {
      setLinkedinError({ code: 'unknown', message: String(err) })
    } finally {
      setIsSearchingLinkedIn(false)
    }
  }

  async function handleConfirmLinkedInUrl() {
    if (!linkedInFoundUrl) return
    setShowLinkedInConfirm(false)
    await api.invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { linkedinUrl: linkedInFoundUrl })
    onUpdate({ ...contact, linkedinUrl: linkedInFoundUrl })
    const enrichResult = await api.invoke<{ success: boolean; errorCode?: string }>(
      IPC_CHANNELS.CONTACT_ENRICH_LINKEDIN, contact.id
    )
    if (enrichResult?.errorCode === 'in_flight') {
      setLinkedinError({ code: 'in_flight', message: 'LinkedIn URL saved — enrichment is busy, try again shortly' })
    } else if (enrichResult?.success === false) {
      setLinkedinError({ code: enrichResult.errorCode ?? 'unknown', message: (enrichResult as { message?: string }).message ?? 'Enrichment failed' })
    }
    setLinkedInFoundUrl(null)
  }

  async function handleDeleteContact() {
    if (deleting) return
    setDeleting(true)
    try {
      await api.invoke(IPC_CHANNELS.CONTACT_DELETE, contact.id)
      navigate('/contacts')
    } catch (err) {
      console.error('[ContactPropertiesPanel] delete failed:', err)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // Merge picker — search contacts as the user types
  useEffect(() => {
    if (!mergePickerOpen) return
    api.invoke<{ id: string; fullName: string }[]>(IPC_CHANNELS.CONTACT_LIST, {
      query: mergeQuery || undefined,
      limit: 10,
    })
      .then(res => setMergeResults(
        (res ?? [])
          .filter(c => c.id !== contact.id)
          .map(c => ({ id: c.id, name: c.fullName }))
      ))
      .catch(() => setMergeResults([]))
  }, [mergeQuery, mergePickerOpen, contact.id])

  async function handleMergeInto() {
    if (!mergeTarget || merging) return
    setMerging(true)
    try {
      await api.invoke(IPC_CHANNELS.CONTACT_MERGE, mergeTarget.id, contact.id)
      navigate(`/contact/${mergeTarget.id}`)
    } catch (err) {
      console.error('[ContactPropertiesPanel] merge failed:', err)
    } finally {
      setMerging(false)
      setMergeTarget(null)
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') void handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  function showField(key: string, value: unknown): boolean {
    // previousCompanies needs parsed-emptiness check (JSON array vs raw string)
    if (key === 'previousCompanies') {
      const hasEntries = parsePriorCompanies(value as string | null).length > 0
      return fieldVisibility.showField(key, hasEntries ? 'has-value' : null)
    }
    return fieldVisibility.showField(key, value)
  }

  function hideField(key: string) {
    setJSON('cyggie:contact-hidden-fields', [...hiddenFields, key])
  }

  function restoreField(key: string) {
    setJSON('cyggie:contact-hidden-fields', hiddenFields.filter(k => k !== key))
  }

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: (typeof customFields)[0]) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return sectionedFields(sectionKey).map((field) => {
      const fieldKey = `custom:${field.id}`
      if (hiddenFields.includes(fieldKey) && !isEditing && !showAllFields) return null
      const isDropTarget = draggingOverFieldId === field.id && draggingFieldId !== field.id
      return (
        <div
          key={field.id}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
          onDragStart={() => setDraggingFieldId(field.id)}
          onDragEnd={() => { setDraggingFieldId(null); setDraggingOverFieldId(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && draggingOverFieldId !== field.id) setDraggingOverFieldId(field.id)
          }}
          onDrop={(e) => {
            e.stopPropagation() // prevent cross-section drop handler from also firing
            if (isEditing) handleWithinSectionDrop(field.id)
          }}
        >
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
          {isEditing && editingFieldId === field.id ? (
            <input
              className={styles.inlineRenameInput}
              autoFocus
              value={editingFieldLabel}
              onChange={(e) => setEditingFieldLabel(e.target.value)}
              onBlur={() => handleFieldLabelSave(field.id, editingFieldLabel)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleFieldLabelSave(field.id, editingFieldLabel)
                if (e.key === 'Escape') setEditingFieldId(null)
              }}
            />
          ) : (
          <HideableRow fieldKey={fieldKey}>
            <PropertyRow
              label={field.label}
              value={getPinnedFieldValue(field)}
              type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
              options={opts(field)}
              editMode={isEditing}
              onSave={(val) => handlePinnedFieldSave(field, val)}
              onAddOption={
                (field.fieldType === 'select' || field.fieldType === 'multiselect')
                  ? async (newOption) => {
                      const opt = newOption.trim().slice(0, 200)
                      await addCustomFieldOption(field.id, field.optionsJson, opt)
                      setCustomFields(prev => prev.map(f => {
                        if (f.id !== field.id) return f
                        const cur: string[] = (() => { try { return JSON.parse(f.optionsJson ?? '[]') } catch { return [] } })()
                        return { ...f, optionsJson: JSON.stringify([...cur, opt]) }
                      }))
                    }
                  : undefined
              }
            />
            {isEditing && (
              <button
                className={styles.renameFieldBtn}
                title="Rename field"
                onClick={() => { setEditingFieldId(field.id); setEditingFieldLabel(field.label) }}
              >✎</button>
            )}
          </HideableRow>
          )}
        </div>
      )
    })
  }

  function renderHardcodedSection(
    fields: Array<{ key: string; visible: boolean; render: () => ReactNode }>,
    sectionKey: string
  ) {
    const ordered = hfOrder.applyOrder(fields, sectionKey)
    return ordered.map((field) => {
      if (!field.visible) return null
      const isDropTarget = hfOrder.draggingOverKey === field.key && hfOrder.draggingKey !== field.key
      return (
        <div
          key={field.key}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
          onDragStart={() => hfOrder.setDraggingKey(field.key)}
          onDragEnd={() => { hfOrder.setDraggingKey(null); hfOrder.setDraggingOverKey(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && hfOrder.draggingOverKey !== field.key) hfOrder.setDraggingOverKey(field.key)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            if (isEditing && hfOrder.draggingKey) {
              hfOrder.reorder(sectionKey, hfOrder.draggingKey, field.key, ordered.map((f) => f.key))
            }
          }}
        >
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
          <div style={{ flex: 1, minWidth: 0 }}>{field.render()}</div>
        </div>
      )
    })
  }

  function HideableRow({ fieldKey, isEmpty, children, onHide }: { fieldKey: string; isEmpty?: boolean; children: ReactNode; onHide?: () => void }) {
    const isHidden = hiddenFields.includes(fieldKey)
    return (
      <div className={`${styles.hideable} ${isHidden ? styles.fieldHidden : ''}`}>
        <div className={styles.hideableContent}>{children}</div>
        {(showAllFields || isEditing) && (
          isHidden
            ? <button className={styles.restoreBtn} title="Restore field" onClick={() => restoreField(fieldKey)}>↺</button>
            : <button
                className={styles.hideBtn}
                title="Hide field"
                onClick={() => {
                  onHide?.()
                  if (isEmpty && fieldVisibility.addedFields.includes(fieldKey)) {
                    fieldVisibility.removeFromAddedFields(fieldKey)
                  } else {
                    hideField(fieldKey)
                  }
                }}
              >×</button>
        )}
      </div>
    )
  }

  function renderPinnedChip(key: string) {
    if (key.startsWith('custom:')) {
      const id = key.slice(7)
      const def = contactDefs.find((d) => d.id === id)
      if (!def) return null
      const fieldWithValue = customFields.find((f) => f.id === id)
      if (!fieldWithValue?.value) return null
      let display = ''
      const v = fieldWithValue.value
      switch (def.fieldType) {
        case 'currency': display = formatCurrency(v.valueNumber ?? 0); break
        case 'date': display = v.valueDate ? formatDate(v.valueDate) : ''; break
        case 'boolean': display = v.valueBoolean != null ? (v.valueBoolean ? 'Yes' : 'No') : ''; break
        case 'contact_ref':
        case 'company_ref': display = v.resolvedLabel ?? v.valueRefId ?? ''; break
        default: display = v.valueText ?? ''
      }
      if (!display) return null

      if (def.fieldType === 'multiselect') {
        const vals = display.split(',').map(s => s.trim()).filter(Boolean)
        if (vals.length === 0) return null
        return (
          <span key={key} className={styles.pinnedChips} title={def.label}>
            <span className={styles.pinnedChipLabel}>{def.label}:</span>
            {vals.map(v => (
              <span key={v} className={styles.pinnedChip} style={chipStyle(v)}>{v}</span>
            ))}
          </span>
        )
      }

      return (
        <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={def.label}>
          {def.label}: {display}
        </span>
      )
    }

    // Built-in field
    const col = CONTACT_COLUMN_DEFS.find((c) => c.key === key)
    if (!col || !col.field) return null
    const value = (contact as Record<string, unknown>)[col.field]
    const display = formatPinnedValue(value, col.type, col.options as { value: string; label: string }[] | undefined)
    if (!display) return null
    return (
      <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={col.label}>
        {col.label}: {display}
      </span>
    )
  }

  const CHIP_LABELS: Record<string, string> = {
    contactType: 'Type',
    talentPipeline: 'Pipeline',
  }

  function linkedinErrorMessage(err: { code: string; message: string }): string {
    switch (err.code) {
      case 'login_required':     return 'LinkedIn sign-in required'
      case 'no_data':            return 'No profile data found'
      case 'profile_timeout':    return 'Profile load timed out'
      case 'profile_load_failed': return 'Failed to load profile'
      case 'llm_failed':         return 'Extraction failed'
      case 'llm_bad_json':       return 'Extraction failed'
      case 'no_linkedin_url':    return 'No LinkedIn URL set'
      case 'not_found':          return 'No LinkedIn profile found'
      case 'no_exa_key':         return 'Add Exa API key in Settings'
      case 'exa_auth':           return 'Invalid Exa API key'
      case 'in_flight':          return err.message
      default:                   return err.message || 'Enrichment failed'
    }
  }

  function renderChipById(id: string) {
    if (id === 'contactType') {
      return (
        <ChipSelect
          value={contact.contactType ?? ''}
          options={[{ value: '', label: '—' }, ...contactTypeOptions]}
          isEditing={isEditing}
          onSave={(v) => save('contactType', v || null)}
          className={styles.badge}
          data-contact-type={contact.contactType ?? undefined}
          allowEmpty={true}
          onAddOption={contactTypeDef ? async (opt) => addCustomFieldOption(contactTypeDef.id, contactTypeDef.optionsJson, opt) : undefined}
          onError={optionError.show}
        />
      )
    }
    if (id === 'talentPipeline') {
      return (
        <ChipSelect
          value={contact.talentPipeline ?? ''}
          options={[{ value: '', label: '—' }, ...talentPipelineOptions]}
          isEditing={isEditing}
          onSave={(v) => save('talentPipeline', v || null)}
          className={styles.badge}
          data-talent-pipeline={contact.talentPipeline ?? undefined}
          allowEmpty={true}
          onAddOption={talentPipelineDef ? async (opt) => addCustomFieldOption(talentPipelineDef.id, talentPipelineDef.optionsJson, opt) : undefined}
          onError={optionError.show}
        />
      )
    }
    return renderPinnedChip(id)
  }

  // LinkedIn enrichment data parsed from JSON columns
  const liWorkEntries = parseLinkedInJson<LinkedInWorkEntry>(contact.workHistory)
  const liEduEntries = parseLinkedInJson<LinkedInEducationEntry>(contact.educationHistory)
  const liSkills = parseLinkedInJson<string>(contact.linkedinSkills)

  // Count of explicitly-hidden fields + empty hardcoded fields (Change 6)
  const hiddenFieldCount = !isEditing && !showAllFields ? (
    hiddenFields.length +
    ([contact.phone, contact.twitterHandle, contact.city, contact.state,
      contact.timezone, contact.previousCompanies, contact.university, contact.tags, contact.pronouns]
      .filter(v => !v).length) +
    customFields.filter(f => !f.value && f.section !== 'summary').length
  ) : 0

  return (
    <div ref={panelRef} className={styles.panel}>
      <div className={styles.headerCard}>
      <EnrichMethodModal
        open={enrichMethodModalOpen}
        onClose={() => setEnrichMethodModalOpen(false)}
        title="Enrich contact"
        subtitle="Choose a source to enrich this contact's profile."
        methods={[
          ...(showEnrichBanner && onEnrichFromMeetings ? [{
            icon: '✨',
            label: 'From meetings',
            description: `${enrichMeetingCount ?? 0} new meeting${(enrichMeetingCount ?? 0) !== 1 ? 's' : ''} available`,
            onClick: () => onEnrichFromMeetings(),
          }] : []),
          ...(contact.linkedinUrl ? [{
            icon: '🔗',
            label: contact.linkedinEnrichedAt ? 'Re-enrich from LinkedIn' : 'Enrich from LinkedIn',
            description: contact.linkedinEnrichedAt ? `Last enriched ${formatRelativeTime(contact.linkedinEnrichedAt)}` : 'Pull profile data from LinkedIn',
            onClick: () => void handleLinkedInEnrich(),
          }] : exaApiKey ? [{
            icon: '🔍',
            label: 'Find on LinkedIn',
            description: 'Search for this contact on LinkedIn',
            onClick: () => void handleFindOnLinkedIn(),
          }] : []),
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete contact?"
        message={`This will permanently delete ${contact.fullName}.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        onConfirm={handleDeleteContact}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={!!mergeTarget}
        title="Merge contacts?"
        message={`Merge "${contact.fullName}" into "${mergeTarget?.name ?? ''}"? All meetings, emails, and notes will be relinked and this contact will be deleted.`}
        confirmLabel={merging ? 'Merging…' : 'Merge'}
        variant="danger"
        onConfirm={handleMergeInto}
        onCancel={() => setMergeTarget(null)}
      />

      {mergePickerOpen && (
        <div className={styles.mergePickerOverlay} onClick={() => setMergePickerOpen(false)}>
          <div className={styles.mergePicker} onClick={e => e.stopPropagation()}>
            <p className={styles.mergePickerTitle}>
              Merge &ldquo;{contact.fullName}&rdquo; into:
            </p>
            <input
              autoFocus
              className={styles.mergePickerInput}
              placeholder="Search contacts…"
              value={mergeQuery}
              onChange={e => setMergeQuery(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setMergePickerOpen(false)}
            />
            <div className={styles.mergePickerList}>
              {mergeResults.map(r => (
                <button
                  key={r.id}
                  className={styles.mergePickerOption}
                  onClick={() => { setMergeTarget(r); setMergePickerOpen(false) }}
                >
                  {r.name}
                </button>
              ))}
              {mergeResults.length === 0 && (
                <span className={styles.mergePickerEmpty}>
                  {mergeQuery ? 'No contacts found' : 'Start typing to search…'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header — extracted to ContactHeaderCard */}
      <ContactHeaderCard
        contact={contact}
        isEditing={isEditing}
        lastTouchpoint={lastTouchpoint}
        fieldSources={fieldSources}
        customFields={customFields}
        firstNameDraft={firstNameDraft}
        setFirstNameDraft={setFirstNameDraft}
        lastNameDraft={lastNameDraft}
        setLastNameDraft={setLastNameDraft}
        emailDraft={emailDraft}
        setEmailDraft={setEmailDraft}
        linkedinDraft={linkedinDraft}
        setLinkedinDraft={setLinkedinDraft}
        phoneDraft={phoneDraft}
        setPhoneDraft={setPhoneDraft}
        cityDraft={cityDraft}
        setCityDraft={setCityDraft}
        stateDraft={stateDraft}
        setStateDraft={setStateDraft}
        companyDraft={companyDraft}
        setCompanyDraft={setCompanyDraft}
        companyAutocomplete={companyAutocomplete}
        setCompanyAutocomplete={setCompanyAutocomplete}
        companyActiveIdx={companyActiveIdx}
        setCompanyActiveIdx={setCompanyActiveIdx}
        handleCompanyInput={handleCompanyInput}
        companyAutocompleteKeyDown={companyAutocompleteKeyDown}
        companyAutocompleteRef={companyAutocompleteRef}
        saveCompany={saveCompany}
        firstNameInputRef={firstNameInputRef}
        handleNameKeyDown={handleNameKeyDown}
        onStartEditing={() => { sessionAddedFields.current = [...fieldVisibility.addedFields]; setIsEditing(true) }}
        onEnrichClick={() => setEnrichMethodModalOpen(true)}
        onMergeStart={() => { setMergeQuery(''); setMergePickerOpen(true) }}
        onDeleteClick={() => setConfirmDelete(true)}
        handleDone={handleDone}
        handleCancel={handleCancel}
        handleApplyToAll={handleApplyToAll}
        handleJustThisContact={handleJustThisContact}
        handleResetLayout={handleResetLayout}
        sessionNewFields={sessionNewFields}
        metaSaveError={metaSaveError.error}
        copyMeta={copyMeta}
        copiedMeta={copiedMeta}
        contactTypeChip={renderChipById('contactType')}
      />
      </div>

      {/* Key Takeaways card — shared component (collapsible, useTakeaways hook) */}
      <KeyTakeawaysCard
        kt={kt}
        collapsed={isCollapsed('key_takeaways')}
        onToggleCollapsed={() => toggleSection('key_takeaways')}
      />

      <div className={styles.bodyCard}>
      {/* LinkedIn status row: enriching / refreshed-ago / errors / login-required sign-in */}
      {contact.linkedinUrl && (contact.linkedinEnrichedAt || linkedinError || linkedinEnriching) && (
        <div className={styles.linkedinStatusRow}>
          {linkedinEnriching ? (
            <span className={styles.linkedinEnrichingStatus}>
              <Spinner />
              Enriching from LinkedIn…
            </span>
          ) : contact.linkedinEnrichedAt && !linkedinError ? (
            <span className={styles.linkedinEnrichedAgo}>
              Refreshed {formatRelativeTime(contact.linkedinEnrichedAt)}
            </span>
          ) : null}
          {linkedinError?.code === 'login_required' ? (
            <>
              <span className={styles.linkedinErrorMsg}>LinkedIn sign-in required</span>
              <button className={styles.linkedinLoginBtn} onClick={() => void handleLinkedInOpenLogin()}>
                Sign in to LinkedIn
              </button>
            </>
          ) : linkedinError ? (
            <span className={styles.linkedinErrorMsg} title={linkedinError.message}>
              {linkedinErrorMessage(linkedinError)}
            </span>
          ) : null}
        </div>
      )}

      {/* Exa "profile found" confirmation modal */}
      {!contact.linkedinUrl && exaApiKey && showLinkedInConfirm && linkedInFoundUrl && (
        <div className={styles.linkedinStatusRow}>
          <div className={styles.linkedinConfirmModal}>
            <span className={styles.linkedinConfirmTitle}>LinkedIn profile found</span>
            <a
              className={styles.linkedinConfirmUrl}
              href={linkedInFoundUrl}
              target="_blank"
              rel="noreferrer"
            >
              {linkedInFoundUrl.replace('https://', '')}
            </a>
            <div className={styles.linkedinConfirmActions}>
              <button
                className={styles.linkedinEnrichBtn}
                onClick={() => void handleConfirmLinkedInUrl()}
              >
                Use this profile
              </button>
              <button
                className={styles.linkedinCancelBtn}
                onClick={() => { setShowLinkedInConfirm(false); setLinkedInFoundUrl(null) }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Exa search error (no URL, has exaApiKey) */}
      {!contact.linkedinUrl && exaApiKey && linkedinError && !showLinkedInConfirm && (
        <div className={styles.linkedinStatusRow}>
          <span className={styles.linkedinErrorMsg} title={linkedinError.message}>
            {linkedinErrorMessage(linkedinError)}
          </span>
        </div>
      )}

      {/* Chips row — relocated outside .header so it scrolls with content */}
      <div
        className={`${styles.headerBadge} ${isEditing && dragOverSection === 'summary' ? styles.dropTarget : ''}`}
        {...(isEditing ? syncedSectionDragProps('summary') : {})}
      >
        {effectiveOrder.filter((id) => id !== 'contactType').map((id, i) => {
          const isCustom = id.startsWith('custom:')
          // Custom chips: skip entirely if no value (no UUID placeholder, no ×)
          if (isCustom && renderPinnedChip(id) === null) return null

          const isHidden = hiddenHeaderChips.includes(id)
          if (!isEditing && isHidden) return null

          // Resolve label for hidden-chip placeholder (avoid raw UUID fallback)
          const chipDisplayLabel = CHIP_LABELS[id] ?? (isCustom
            ? (contactDefs.find((d) => d.id === id.slice(7))?.label ?? id)
            : id)

          return (
            <div
              key={id}
              className={`${styles.headerChipDraggable} ${chipDragOverIndex === i ? styles.chipDropIndicator : ''} ${isEditing && isHidden ? styles.hiddenHeaderChip : ''}`}
              {...chipDragProps(id)}
              {...chipDropZoneProps(i)}
            >
              {isEditing && isHidden ? (
                <span className={styles.hiddenChipPlaceholder}>
                  {chipDisplayLabel}
                  <button className={styles.restoreChipBtn} title="Restore chip" onClick={() => restoreHeaderChip(id)}>↺</button>
                </span>
              ) : (
                <>
                  {isEditing && CHIP_LABELS[id] ? (
                    <div className={styles.editChipField}>
                      <span className={styles.editChipLabel}>{CHIP_LABELS[id]}</span>
                      {renderChipById(id)}
                    </div>
                  ) : (
                    renderChipById(id)
                  )}
                  {isEditing && (
                    <button className={styles.hideChipBtn} title="Hide chip" onClick={() => hideHeaderChip(id)}>×</button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {optionError.error && (
        <div style={{ color: '#c0392b', fontSize: '12px', padding: '4px 12px' }}>
          {optionError.error}
        </div>
      )}

      {/* Variant C: legacy sticky '+ Add field' bar removed.
          PropertiesCard footer "+ Add property" handles this affordance. */}

      <PropertiesCard
        topBand={
          <div className={styles.strengthRow}>
            <span className={styles.strengthLabel}>Strength</span>
            <div className={styles.segmented}>
              {(['cold', 'warm', 'hot'] as const).map((s) => (
                <button
                  key={s}
                  className={`${styles.segmentBtn} ${contact.relationshipStrength === s ? styles[s] : ''}`}
                  onClick={() => save('relationshipStrength', s)}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
        }
        footer={
          <PropertiesCardFooter
            hiddenCount={showAllFields ? 0 : hiddenFieldCount}
            onShowHidden={hiddenFieldCount > 0 ? () => setShowAllFields(true) : undefined}
            onAddProperty={() => openAddFieldDropdown(null)}
          />
        }
      >
      {sectionOrder.orderedSections.map(sectionKey => {
        const baseDragProps = syncedSectionDragProps(sectionKey)
        const isDraggingThisSection = sectionOrder.draggingSectionKey === sectionKey
        const isDropTargetForSection = sectionOrder.dragOverSectionKey === sectionKey && !isDraggingThisSection
        const sectionContainerProps: HTMLAttributes<HTMLDivElement> = {
          ...baseDragProps,
          className: [
            isDraggingThisSection ? styles.sectionDragging : '',
            isDropTargetForSection || (isEditing && dragOverSection === sectionKey) ? styles.dropTarget : '',
          ].filter(Boolean).join(' '),
          ...(isEditing ? {
            draggable: true,
            onDragStart: (e) => { e.stopPropagation(); sectionOrder.setDraggingSectionKey(sectionKey) },
            onDragEnd: () => { sectionOrder.setDraggingSectionKey(null); sectionOrder.setDragOverSectionKey(null) },
            onDragOver: (e) => {
              e.preventDefault()
              sectionOrder.setDragOverSectionKey(sectionKey)
              baseDragProps.onDragOver?.(e)
            },
          } : {}),
        }

        switch (sectionKey) {
          case 'contact_info': return (
            <div key="contact_info" {...sectionContainerProps}>
              <CollapsibleSection
                title="Contact Info"
                count={1 /* placeholder; see TODO below for non-empty count */}
                isCollapsed={isCollapsed('contact_info')}
                onToggle={() => toggleSection('contact_info')}
                hasUserToggled={hasUserToggledSection('contact_info')}
                onAdd={() => openAddFieldDropdown('contact_info')}
              >
              {renderHardcodedSection([
                { key: 'twitterHandle', visible: showField('twitterHandle', contact.twitterHandle), render: () => (
                  <HideableRow fieldKey="twitterHandle" isEmpty={!contact.twitterHandle}>
                    <PropertyRow label="Twitter/X" value={contact.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />
                  </HideableRow>
                )},
                { key: 'timezone', visible: showField('timezone', contact.timezone), render: () => (
                  <HideableRow fieldKey="timezone" isEmpty={!contact.timezone}>
                    <PropertyRow label="Timezone" value={contact.timezone} type="text" editMode={isEditing} onSave={(v) => save('timezone', v)} />
                  </HideableRow>
                )},
              ], 'contact_info')}
              {renderSectionedFields('contact_info')}

              {nullSectionFields().map((field) => {
                const opts = (() => { try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] } })()
                return (
                  <div
                    key={field.id}
                    className={styles.sectionedFieldRow}
                    title="No section assigned — drag to reassign"
                    draggable={isEditing}
                    onDragStart={() => setDraggingFieldId(field.id)}
                    onDragEnd={() => setDraggingFieldId(null)}
                  >
                    {isEditing && <span className={styles.dragHandle}>⠿</span>}
                    <PropertyRow
                      label={field.label}
                      value={getPinnedFieldValue(field)}
                      type={field.fieldType as PropertyRowType}
                      options={opts}
                      editMode={isEditing}
                      onSave={(val) => handlePinnedFieldSave(field, val)}
                    />
                  </div>
                )
              })}
              </CollapsibleSection>
            </div>
          )

          case 'professional': return (
            <div key="professional" {...sectionContainerProps}>
              <CollapsibleSection
                title="Professional"
                count={1 /* placeholder */}
                isCollapsed={isCollapsed('professional')}
                onToggle={() => toggleSection('professional')}
                hasUserToggled={hasUserToggledSection('professional')}
                onAdd={() => openAddFieldDropdown('professional')}
              >
              {renderHardcodedSection([
                { key: 'previousCompanies', visible: showField('previousCompanies', contact.previousCompanies), render: () => (
                  <HideableRow fieldKey="previousCompanies" isEmpty={parsePriorCompanies(contact.previousCompanies).length === 0}>
                    <div className={styles.priorCompanyField}>
                      <div className={styles.priorCompanyLabel}>Prior Company</div>
                      {isEditing ? (
                        <div className={styles.priorCompanyList}>
                          {priorCompanyDrafts.map((entry, i) => (
                            <div key={i} className={styles.priorCompanyEntry}>
                              <input
                                className={styles.priorCompanyInput}
                                value={priorCompanyName(entry)}
                                placeholder="Company name"
                                onChange={(e) => handlePriorCompanyInput(i, e.target.value)}
                                onKeyDown={priorCompanyAutocomplete?.index === i ? priorCompanyAutocompleteKeyDown : undefined}
                                onBlur={() => {
                                  setTimeout(() => setPriorCompanyAutocomplete(null), 150)
                                  savePriorCompanies(priorCompanyDrafts)
                                }}
                              />
                              <button
                                className={styles.priorCompanyRemoveBtn}
                                onClick={() => {
                                  const next = priorCompanyDrafts.filter((_, j) => j !== i)
                                  setPriorCompanyDrafts(next)
                                  savePriorCompanies(next)
                                }}
                              >×</button>
                              {priorCompanyAutocomplete?.index === i && priorCompanyAutocomplete.results.length > 0 && (
                                <div
                                  className={styles.priorCompanyAutocomplete}
                                  ref={priorCompanyAutocompleteRef as React.RefObject<HTMLDivElement>}
                                >
                                  {priorCompanyAutocomplete.results.map((c, idx) => (
                                    <div
                                      key={c.id}
                                      className={`${styles.priorCompanyAutocompleteItem} ${idx === priorCompanyActiveIdx ? styles.priorCompanyAutocompleteItemActive : ''}`}
                                      onMouseEnter={() => setPriorCompanyActiveIdx(idx)}
                                      onMouseDown={(e) => { e.preventDefault(); selectPriorCompanyAutocomplete({ name: c.canonicalName, companyId: c.id }) }}
                                    >{c.canonicalName}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                          <button
                            className={styles.priorCompanyAddBtn}
                            onClick={() => setPriorCompanyDrafts(prev => [...prev, ''])}
                          >+ Add Prior Company</button>
                        </div>
                      ) : (
                        <div className={styles.priorCompanyViewList}>
                          {parsePriorCompanies(contact.previousCompanies).map((entry, i) => {
                            const name = priorCompanyName(entry)
                            const companyId = typeof entry === 'object' ? entry.companyId : null
                            return (
                              <span key={i} className={styles.priorCompanyViewEntry}>
                                {companyId ? (
                                  <button className={styles.companyLink} onClick={() => navigate(`/company/${companyId}`, { state: { backLabel: contact.fullName } })}>{name}</button>
                                ) : name}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </HideableRow>
                )},
                { key: 'university', visible: showField('university', contact.university) && liEduEntries.length === 0, render: () => (
                  <HideableRow fieldKey="university" isEmpty={!contact.university}>
                    <PropertyRow label="University" value={contact.university} type="text" editMode={isEditing} onSave={(v) => save('university', v)} />
                  </HideableRow>
                )},
                { key: 'tags', visible: showField('tags', contact.tags), render: () => (
                  <HideableRow fieldKey="tags" isEmpty={!contact.tags}>
                    <PropertyRow label="Tags" value={contact.tags} type="tags" editMode={isEditing} onSave={(v) => save('tags', v)} />
                  </HideableRow>
                )},
                { key: 'pronouns', visible: showField('pronouns', contact.pronouns), render: () => (
                  <HideableRow fieldKey="pronouns" isEmpty={!contact.pronouns}>
                    <PropertyRow label="Pronouns" value={contact.pronouns} type="text" editMode={isEditing} onSave={(v) => save('pronouns', v)} />
                  </HideableRow>
                )},
              ], 'professional')}
              {renderSectionedFields('professional')}

              {(isEditing || contact.otherSocials) && (
                <>
                  <div className={styles.socialsLabel}>Other Socials</div>
                  <SocialsEditor
                    value={filteredOtherSocials(contact.otherSocials, contact.linkedinUrl)}
                    onSave={(json) => save('otherSocials', json)}
                  />
                </>
              )}
              </CollapsibleSection>
            </div>
          )

          case 'relationship': return (
            <div key="relationship" {...sectionContainerProps}>
              <CollapsibleSection
                title="Relationship"
                count={1 /* placeholder */}
                isCollapsed={isCollapsed('relationship')}
                onToggle={() => toggleSection('relationship')}
                hasUserToggled={hasUserToggledSection('relationship')}
                onAdd={() => openAddFieldDropdown('relationship')}
              >
              {/* Variant C: relationship-strength control lifted to PropertiesCard topBand. */}
              {renderHardcodedSection([
                { key: 'talentPipeline', visible: showField('talentPipeline', contact.talentPipeline), render: () => (
                  <HideableRow fieldKey="talentPipeline" isEmpty={!contact.talentPipeline}>
                    <PropertyRow
                      label="Talent Pipeline"
                      value={contact.talentPipeline}
                      type="select"
                      editMode={isEditing}
                      options={[{ value: '', label: '—' }, ...talentPipelineOptions]}
                      onSave={(v) => save('talentPipeline', v || null)}
                      onAddOption={talentPipelineDef ? async (opt) => addCustomFieldOption(talentPipelineDef.id, talentPipelineDef.optionsJson, opt) : undefined}
                    />
                  </HideableRow>
                )},
                { key: 'lastMetEvent', visible: showField('lastMetEvent', contact.lastMetEvent), render: () => (
                  <HideableRow fieldKey="lastMetEvent" isEmpty={!contact.lastMetEvent}>
                    <PropertyRow label="Last Met At" value={contact.lastMetEvent} type="text" editMode={isEditing} onSave={(v) => save('lastMetEvent', v)} />
                  </HideableRow>
                )},
                { key: 'warmIntroPath', visible: showField('warmIntroPath', contact.warmIntroPath), render: () => (
                  <HideableRow fieldKey="warmIntroPath" isEmpty={!contact.warmIntroPath}>
                    <PropertyRow label="Warm Intro Path" value={contact.warmIntroPath} type="textarea" editMode={isEditing} onSave={(v) => save('warmIntroPath', v)} />
                  </HideableRow>
                )},
                { key: 'notes', visible: showField('notes', contact.notes), render: () => (
                  <HideableRow fieldKey="notes" isEmpty={!contact.notes}>
                    <PropertyRow label="Notes" value={contact.notes} type="textarea" editMode={isEditing} onSave={(v) => save('notes', v)} />
                  </HideableRow>
                )},
              ], 'relationship')}
              {contact.talentPipeline === 'fundraising' && onRequestCreateCompany && (
                <div className={styles.fundraisingCallout}>
                  <span>Ready to move to pipeline?</span>
                  <button className={styles.fundraisingCalloutBtn} onClick={onRequestCreateCompany}>
                    Create company record &rarr;
                  </button>
                </div>
              )}
              {renderSectionedFields('relationship')}

              </CollapsibleSection>
            </div>
          )

          case 'investor_info':
            if (contact.contactType !== 'investor' && sectionedFields('investor_info').length === 0) return null
            return (
              <div key="investor_info" {...sectionContainerProps}>
                <CollapsibleSection
                  title="Investor Info"
                  count={1 /* placeholder */}
                  isCollapsed={isCollapsed('investor_info')}
                  onToggle={() => toggleSection('investor_info')}
                  hasUserToggled={hasUserToggledSection('investor_info')}
                  onAdd={() => openAddFieldDropdown('investor_info')}
                >
                {contact.contactType === 'investor' && renderHardcodedSection([
                  { key: 'fundSize', visible: showField('fundSize', contact.fundSize), render: () => (
                    <HideableRow fieldKey="fundSize" isEmpty={!contact.fundSize}>
                      <PropertyRow label="Fund Size" value={contact.fundSize} type="currency" editMode={isEditing} onSave={(v) => save('fundSize', v)} />
                    </HideableRow>
                  )},
                  { key: 'typicalCheckSizeMin', visible: showField('typicalCheckSizeMin', contact.typicalCheckSizeMin), render: () => (
                    <HideableRow fieldKey="typicalCheckSizeMin" isEmpty={!contact.typicalCheckSizeMin}>
                      <PropertyRow label="Check Size Min" value={contact.typicalCheckSizeMin} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMin', v)} />
                    </HideableRow>
                  )},
                  { key: 'typicalCheckSizeMax', visible: showField('typicalCheckSizeMax', contact.typicalCheckSizeMax), render: () => (
                    <HideableRow fieldKey="typicalCheckSizeMax" isEmpty={!contact.typicalCheckSizeMax}>
                      <PropertyRow label="Check Size Max" value={contact.typicalCheckSizeMax} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMax', v)} />
                    </HideableRow>
                  )},
                  { key: 'investmentStageFocus', visible: showField('investmentStageFocus', contact.investmentStageFocus), render: () => (
                    <HideableRow fieldKey="investmentStageFocus" isEmpty={!contact.investmentStageFocus}>
                      <PropertyRow label="Stage Focus" value={contact.investmentStageFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentStageFocus', v)} />
                    </HideableRow>
                  )},
                  { key: 'investmentSectorFocus', visible: showField('investmentSectorFocus', contact.investmentSectorFocus), render: () => (
                    <HideableRow fieldKey="investmentSectorFocus" isEmpty={!contact.investmentSectorFocus}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ minWidth: 120, color: 'var(--text-muted)' }}>Sector Focus</span>
                        <TagPicker
                          value={contact.investmentSectorFocus}
                          options={sectorFocusOptions}
                          isEditing={isEditing}
                          onSave={(v) => save('investmentSectorFocus', v)}
                          onAddOption={sectorFocusDef ? async (opt) => addCustomFieldOption(sectorFocusDef.id, sectorFocusDef.optionsJson, opt) : undefined}
                        />
                      </div>
                    </HideableRow>
                  )},
                  { key: 'investmentSectorFocusNotes', visible: showField('investmentSectorFocusNotes', contact.investmentSectorFocusNotes), render: () => (
                    <HideableRow fieldKey="investmentSectorFocusNotes" isEmpty={!contact.investmentSectorFocusNotes}>
                      <PropertyRow label="Sector Focus Notes" value={contact.investmentSectorFocusNotes} type="text" editMode={isEditing} onSave={(v) => save('investmentSectorFocusNotes', v)} />
                    </HideableRow>
                  )},
                  { key: 'investorStage', visible: showField('investorStage', contact.investorStage), render: () => (
                    <HideableRow fieldKey="investorStage" isEmpty={!contact.investorStage}>
                      <PropertyRow label="Investor Stage" value={contact.investorStage} type="text" editMode={isEditing} onSave={(v) => save('investorStage', v)} />
                    </HideableRow>
                  )},
                  { key: 'proudPortfolioCompanies', visible: showField('proudPortfolioCompanies', contact.proudPortfolioCompanies), render: () => (
                    <HideableRow fieldKey="proudPortfolioCompanies" isEmpty={!contact.proudPortfolioCompanies}>
                      <PropertyRow label="Portfolio Cos" value={contact.proudPortfolioCompanies} type="text" editMode={isEditing} onSave={(v) => save('proudPortfolioCompanies', v)} />
                    </HideableRow>
                  )},
                ], 'investor_info')}
                {renderSectionedFields('investor_info')}

                </CollapsibleSection>
              </div>
            )

          default: return null
        }
      })}
      </PropertiesCard>

      {/* AddFieldDropdown — opened from PropertiesCard footer "+ Add property"
          and per-section "+ Add" buttons (Variant C). No edit-mode gate. */}
      {addFieldDropdownOpen && (
        <div className={styles.addFieldFloating}>
          <AddFieldDropdown
            entityType="contact"
            hardcodedDefs={CONTACT_HARDCODED_FIELDS}
            customFields={customFields.filter(f => !f.isBuiltin)}
            addedFields={fieldVisibility.addedFields}
            hiddenFields={hiddenFields}
            entityData={contact as Record<string, unknown>}
            fieldPlacements={fieldVisibility.fieldPlacements}
            sections={CONTACT_SECTIONS.filter(s => s.key !== 'summary')}
            defaultSection={addFieldSection ?? undefined}
            onToggleField={(key, checked) => {
              if (checked) fieldVisibility.addToAddedFields([key])
              else fieldVisibility.removeFromAddedFields(key)
            }}
            onSetSection={(key, section) => fieldVisibility.setFieldPlacement(key, section)}
            onCreateCustomField={() => { setCreateFieldOpen(true); setAddFieldDropdownOpen(false) }}
            onClose={() => { setAddFieldDropdownOpen(false); setAddFieldSection(null) }}
          />
        </div>
      )}

      {liWorkEntries.length > 0 && (
        <div className={styles.linkedinSection}>
          <SectionHeader title="Work History" />
          {liWorkEntries.map((e, i) => (
            <div key={i} className={styles.linkedinWorkEntry}>
              <div className={styles.linkedinEntryTitle}>{e.title}</div>
              <div className={styles.linkedinEntryCompany}>
                {e.companyId ? (
                  <button
                    className={styles.linkedinCompanyLink}
                    onClick={() => navigate(`/company/${e.companyId}`, { state: { backLabel: contact.fullName } })}
                  >
                    {e.company}
                  </button>
                ) : e.company}
              </div>
              <div className={styles.linkedinEntryDates}>
                {[e.startDate, e.isCurrent ? 'Present' : e.endDate].filter(Boolean).join(' – ')}
              </div>
              {e.description && <div className={styles.linkedinEntryDesc}>{e.description}</div>}
            </div>
          ))}
        </div>
      )}

      {liEduEntries.length > 0 && (
        <div className={styles.linkedinSection}>
          <SectionHeader title="Education" />
          {liEduEntries.map((e, i) => (
            <div key={i} className={styles.linkedinEduEntry}>
              <div className={styles.linkedinEntryTitle}>{e.school}</div>
              {(e.degree || e.field) && (
                <div className={styles.linkedinEntryCompany}>{[e.degree, e.field].filter(Boolean).join(', ')}</div>
              )}
              {(e.startYear || e.endYear) && (
                <div className={styles.linkedinEntryDates}>{[e.startYear, e.endYear].filter(Boolean).join(' – ')}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {liSkills.length > 0 && (
        <div className={styles.linkedinSection}>
          <SectionHeader title="Skills" />
          <div className={styles.linkedinSkillsList}>{liSkills.join(' · ')}</div>
        </div>
      )}

      {/* Variant C: hidden-fields toggle is in PropertiesCard footer. */}
      {showAllFields && !isEditing && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
          Hide empty fields
        </button>
      )}

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="contact"
          defaultSection={createFieldSection}
          onSaved={(def) => {
            void refresh().then(() => {
              setCreateFieldOpen(false)
              setCreateFieldSection(undefined)
              // Auto-add to pinnedKeys if created in Header section
              if (def.section === 'summary') {
                togglePinnedKey(`custom:${def.id}`, true)
              }
            })
          }}
          onClose={() => { setCreateFieldOpen(false); setCreateFieldSection(undefined) }}
        />
      )}


      {isEditing && (
        <div className={styles.deleteSection}>
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            Delete Contact
          </button>
        </div>
      )}
      </div>
    </div>
  )
}
