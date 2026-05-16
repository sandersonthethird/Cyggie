import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
import { useHeaderChipOrder } from '../../hooks/useHeaderChipOrder'
import { useHardcodedFieldOrder } from '../../hooks/useHardcodedFieldOrder'
import { useFieldVisibility } from '../../hooks/useFieldVisibility'
import { useSectionOrder } from '../../hooks/useSectionOrder'
import { useTimedError } from '../../hooks/useTimedError'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { CreateCustomFieldModal } from '../crm/CreateCustomFieldModal'
import type { CompanyDecisionLog, CompanyDetail } from '../../../shared/types/company'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import ConfirmDialog from '../common/ConfirmDialog'
import { MergeReviewModal } from './MergeReviewModal'
import { shouldPromptDecisionLog, defaultDecisionType } from '../../utils/decisionLogTrigger'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { COMPANY_SECTIONS } from '../../../shared/types/custom-fields'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { ChipSelect } from '../crm/ChipSelect'
import { AddFieldDropdown } from '../crm/AddFieldDropdown'
import { computeChipDelta } from '../../utils/chip-delta'
import { usePinnedMigration } from '../../hooks/usePinnedMigration'
import { COMPANY_HARDCODED_FIELDS } from '../../constants/companyFields'
import { resolveLayoutPref, saveLayoutPref, propagateLayoutPref, clearPerEntityPref } from '../../utils/layoutPref'
import {
  COLUMN_DEFS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  EMPLOYEE_RANGES,
  TARGET_CUSTOMERS,
  BUSINESS_MODELS,
  PRODUCT_STAGES,
  INDUSTRY_OPTIONS,
} from './companyColumns'
import { useTakeaways } from '../../hooks/useTakeaways'
import { KeyTakeawaysCard } from '../common/KeyTakeawaysCard'
import { ScorecardStrip, type ScorecardMetric } from '../common/ScorecardStrip'
import { PipelineStepper, COMPANY_PIPELINE_STAGES } from '../common/PipelineStepper'
import { AddTaskModal as AddTaskModalCommon } from '../common/AddTaskModal'
import { EnrichMethodModal } from '../common/EnrichMethodModal'
import { CompanyHeaderCard } from './CompanyHeaderCard'
import { CompanyFieldSections } from './CompanyFieldSections'
import { PropertiesCard, PropertiesCardFooter } from '../crm/PropertiesCard'
import { useSectionCollapse } from '../../hooks/useSectionCollapse'
import styles from './CompanyPropertiesPanel.module.css'
import { api } from '../../api'
import { withOptimisticUpdate } from '../../utils/withOptimisticUpdate'
import type { CustomFieldValue } from '../../../shared/types/custom-fields'
import type { ContactSummary } from '../../../shared/types/contact'

const ENTITY_LABELS: Record<string, string> = {
  prospect: 'Prospects',
  portfolio: 'Portfolio',
  pass: 'Passes',
  vc_fund: 'Investors',
  lp: 'LPs',
  customer: 'Customers',
  partner: 'Partners',
  vendor: 'Vendors',
  unknown: 'Unknown',
  other: 'Other',
}

// Chips hidden by default for specific entity types (no per-company override stored yet)
const DEFAULT_ENTITY_HIDDEN_CHIPS: Partial<Record<string, string[]>> = {
  vc_fund: ['pipelineStage', 'priority', 'round'],
  lp: ['pipelineStage', 'priority', 'round'],
}

// All pref base keys managed as per-company layout overrides
const LAYOUT_PREF_BASE_KEYS = [
  'cyggie:company-hidden-header-chips',
  'cyggie:company-header-chip-order',
  'cyggie:company-added-fields',
  'cyggie:company-field-placements',
  'cyggie:company-sections-order',
] as const

interface CompanyPropertiesPanelProps {
  company: CompanyDetail
  onUpdate: (updates: Record<string, unknown>) => void
  showEnrichBanner?: boolean
  enrichMeetingCount?: number
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>
  /** Unified enrichment callback — source determines which flow to trigger */
  onEnrich?: (source: 'pdf' | 'url' | 'meetings' | 'notes' | 'emails') => void
  isLoadingEnrich?: boolean
  /** Called when "Add to Partner Sync" or the sync status row is clicked */
  onOpenSync?: () => void
}

function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return `${Math.floor(diffH / 24)}d ago`
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

// ── CompanyPropertiesPanel ─────────────────────────────────────────────────

export function CompanyPropertiesPanel({
  company,
  onUpdate,
  showEnrichBanner,
  enrichMeetingCount,
  fieldSources,
  onEnrich,
  isLoadingEnrich,
  onOpenSync,
}: CompanyPropertiesPanelProps) {
  const navigate = useNavigate()
  const [enrichMethodModalOpen, setEnrichMethodModalOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [descriptionClamped, setDescriptionClamped] = useState(false)
  const [nameDraft, setNameDraft] = useState(company.canonicalName)
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [latestDecision, setLatestDecision] = useState<CompanyDecisionLog | null>(null)
  const [keyContacts, setKeyContacts] = useState<ContactSummary[]>([])
  const [showDecisionModal, setShowDecisionModal] = useState(false)
  const [decisionTriggerType, setDecisionTriggerType] = useState<string | undefined>(undefined)
  const [editDecisionId, setEditDecisionId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const deleteError = useTimedError()
  const optionError = useTimedError(4000)
  const [mergePickerOpen, setMergePickerOpen] = useState(false)
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeResults, setMergeResults] = useState<{ id: string; name: string }[]>([])
  const [mergeTarget, setMergeTarget] = useState<{ id: string; name: string } | null>(null)
  // merging state lives inside MergeReviewModal now; we just hold the target.
  const nameError = useTimedError()
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const [createFieldSection, setCreateFieldSection] = useState<string | undefined>(undefined)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editingFieldLabel, setEditingFieldLabel] = useState('')
  const [addFieldDropdownOpen, setAddFieldDropdownOpen] = useState(false)

  // Partner Sync status row
  const [digestItem, setDigestItem] = useState<{ brief?: string | null; section?: string } | null | 'loading'>('loading')

  const nameInputRef = useRef<HTMLInputElement>(null)
  const headerBadgesRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [sessionNewFields, setSessionNewFields] = useState<string[] | null>(null)
  const [templateIndicator, setTemplateIndicator] = useState(false)
  const sessionChanges = useRef(false)
  const sessionAddedFields = useRef<string[]>([])
  const prevEntityType = useRef(company.entityType)
  const descriptionRef = useRef<HTMLParagraphElement>(null)
  const markChanged = useCallback(() => { sessionChanges.current = true }, [])

  const { getJSON, setJSON } = usePreferencesStore()
  const { companyDefs, refresh, loaded: defsLoaded, load: loadDefs, version: defsVersion } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:company-summary-fields', [])
  const hiddenFields = getJSON<string[]>('cyggie:company-hidden-fields', [])
  const hiddenHeaderChips = resolveLayoutPref(
    getJSON,
    'cyggie:company-hidden-header-chips',
    company.id,
    company.entityType ?? null,
    DEFAULT_ENTITY_HIDDEN_CHIPS[company.entityType ?? ''] ?? [],
  )

  const fieldVisibility = useFieldVisibility(
    'company',
    COMPANY_HARDCODED_FIELDS,
    hiddenFields,
    showAllFields,
    isEditing,
    { entityId: company.id, profileKey: company.entityType ?? null, onLayoutChange: markChanged },
  )

  const sectionOrder = useSectionOrder(
    'company',
    COMPANY_SECTIONS.filter(s => s.key !== 'summary').map(s => s.key),
    company.id,
    company.entityType ?? null,
    markChanged,
  )

  const entityTypeDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'entityType')
  const stageDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'pipelineStage')
  const priorityDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'priority')
  const roundDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'round')
  const targetCustomerDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'targetCustomer')
  const businessModelDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'businessModel')
  const productStageDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'productStage')
  const employeeCountDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'employeeCountRange')
  const industryDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'industry')

  const entityTypeOptions = mergeBuiltinOptions(ENTITY_TYPES, entityTypeDef?.optionsJson ?? null)
  const stageOptions = mergeBuiltinOptions(STAGES, stageDef?.optionsJson ?? null)
  const priorityOptions = mergeBuiltinOptions(PRIORITIES, priorityDef?.optionsJson ?? null)
  const roundOptions = mergeBuiltinOptions(ROUNDS, roundDef?.optionsJson ?? null)
  const targetCustomerOptions = mergeBuiltinOptions(TARGET_CUSTOMERS, targetCustomerDef?.optionsJson ?? null)
  const businessModelOptions = mergeBuiltinOptions(BUSINESS_MODELS, businessModelDef?.optionsJson ?? null)
  const productStageOptions = mergeBuiltinOptions(PRODUCT_STAGES, productStageDef?.optionsJson ?? null)
  const industryOptions = mergeBuiltinOptions(INDUSTRY_OPTIONS, industryDef?.optionsJson ?? null)
  const employeeRangeOptions = mergeBuiltinOptions(
    EMPLOYEE_RANGES.map(v => ({ value: v, label: v })),
    employeeCountDef?.optionsJson ?? null
  )

  // Per-entity collapsed sections (extracted into shared useSectionCollapse hook)
  const sectionCollapse = useSectionCollapse('company', company.id)
  const isCollapsed = sectionCollapse.isCollapsed
  const toggleSection = sectionCollapse.toggle

  // Variant C: track which sections the user has manually toggled this session,
  // so empty sections can auto-collapse without overriding manual expands.
  const [userToggledSections, setUserToggledSections] = useState<Set<string>>(new Set())
  function toggleSectionUser(key: string) {
    setUserToggledSections((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev); next.add(key); return next
    })
    toggleSection(key)
  }
  const hasUserToggledSection = (key: string) => userToggledSections.has(key)

  // Variant C: per-section "+ Add" support — track the section the dropdown
  // is scoped to. When set, the AddFieldDropdown defaults its section selector to it.
  const [addFieldSection, setAddFieldSection] = useState<string | null>(null)
  function openAddFieldDropdown(section: string | null) {
    setAddFieldSection(section)
    setAddFieldDropdownOpen(true)
  }

  // Key Takeaways (AI summary)
  const kt = useTakeaways({
    entityType: 'company',
    entityId: company.id,
    savedText: company.keyTakeaways ?? null,
    onUpdate: (updates) => onUpdate(updates),
    hasNewDataSince: (generatedAt) => {
      // Stale if any timeline event is newer than last generation
      const lastTouch = company.lastTouchpoint
      return lastTouch != null && lastTouch > generatedAt
    },
  })

  // Scorecard metrics
  const scorecardMetrics: ScorecardMetric[] = useMemo(() => {
    const touchpoints = (company.meetingCount || 0) + (company.emailCount || 0)
    return [
      {
        label: 'Touchpoints',
        value: touchpoints,
        delta: touchpoints > 0 ? `+${Math.min(touchpoints, 3)} this wk` : undefined,
        deltaDir: touchpoints > 0 ? 'up' as const : undefined,
      },
      {
        label: 'Open Tasks',
        value: 0, // TODO: wire openTaskCount from COMPANY_GET LEFT JOIN
        detail: '—',
      },
      {
        label: 'Contacts',
        value: company.contactCount || 0,
      },
    ]
  }, [company.meetingCount, company.emailCount, company.contactCount])

  // Pipeline stepper — days in current stage
  const daysInStage = useMemo(() => {
    if (!latestDecision) return 0
    return daysSince(latestDecision.createdAt) ?? 0
  }, [latestDecision])

  function togglePinnedKey(key: string, force?: boolean) {
    const next = force === true
      ? (pinnedKeys.includes(key) ? pinnedKeys : [...pinnedKeys, key])
      : force === false
        ? pinnedKeys.filter((k) => k !== key)
        : (pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [...pinnedKeys, key])
    setJSON('cyggie:company-summary-fields', next)
  }

  function hideHeaderChip(key: string) {
    if (!hiddenHeaderChips.includes(key)) {
      saveLayoutPref(setJSON, 'cyggie:company-hidden-header-chips', company.id, [...hiddenHeaderChips, key])
      markChanged()
    }
  }

  function restoreHeaderChip(key: string) {
    saveLayoutPref(setJSON, 'cyggie:company-hidden-header-chips', company.id, hiddenHeaderChips.filter(k => k !== key))
    markChanged()
  }

  // Migrate old 'Pinned' section fields to 'Header' section (Change 4)
  usePinnedMigration('company')

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

  async function handlePinnedFieldSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, company.id)
      setCustomFields(prev => prev.map(f => f.id === field.id ? { ...f, value: null } : f))
      return
    }
    const optimisticValue: CustomFieldValue = {
      id: field.value?.id ?? '',
      fieldDefinitionId: field.id,
      entityType: 'company',
      entityId: company.id,
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
      entityId: company.id,
      entityType: 'company',
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

  const sectionableFields = useMemo(() => customFields.filter(f => !f.isBuiltin), [customFields])
  const { draggingFieldId, setDraggingFieldId, dragOverSection, draggingOverFieldId, setDraggingOverFieldId, sectionedFields, nullSectionFields, handleWithinSectionDrop, sectionDragProps } =
    useCustomFieldSection('company', company.id, sectionableFields, setCustomFields)

  const hfOrder = useHardcodedFieldOrder('company')

  const customSummaryIds = customFields.filter(f => f.section === 'summary').map(f => `custom:${f.id}`)
  const allChipIds = [...new Set(['entityType', 'pipelineStage', 'priority', 'round', ...pinnedKeys, ...customSummaryIds])]
  const { effectiveOrder, chipDragProps, chipDropZoneProps, chipDragOverIndex } =
    useHeaderChipOrder('company', allChipIds, company.id, company.entityType ?? null, markChanged)

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
            setJSON('cyggie:company-summary-fields', newPinnedKeys)
          }
        }
        base.onDrop?.(e)
      },
    }
  }

  // Reset sessionChanges flag when entering Edit View
  useEffect(() => {
    if (isEditing) sessionChanges.current = false
  }, [isEditing])

  // Template indicator: show for 3s when entity type changes and a template exists
  useEffect(() => {
    if (prevEntityType.current !== company.entityType) {
      prevEntityType.current = company.entityType
      const pk = company.entityType
      const hasTemplate = pk && LAYOUT_PREF_BASE_KEYS.some(
        (baseKey) => getJSON(`${baseKey}:entity:${pk}`, null) !== null
      )
      if (hasTemplate) {
        setTemplateIndicator(true)
        setTimeout(() => setTemplateIndicator(false), 3000)
      }
    }
  }, [company.entityType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync name draft when entering edit mode; clear any prior error.
  // Intentionally omit company.canonicalName from deps — this effect should only
  // fire on enter/exit of edit mode. If it also ran when company.canonicalName
  // changes mid-edit (e.g. optimistic-update revert after a failed save), it
  // would wipe the user's typed input and force a second Done click to exit.
  useEffect(() => {
    if (isEditing) {
      setNameDraft(company.canonicalName)
      nameError.clear()
      setTimeout(() => nameInputRef.current?.focus(), 0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

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
        // editor on the page (NoteCreator, summary editor, etc.) would trigger
        // the panel's edit-mode shortcut.
        (target instanceof HTMLElement && target.isContentEditable)
      ) return
      if ((e.key === 'e' || e.key === 'E') && !isEditing) setIsEditing(true)
      if (e.key === 'Escape' && isEditing) void handleDoneRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isEditing])

  useEffect(() => {
    if (!defsLoaded) loadDefs()
  }, [defsLoaded, loadDefs])

  // Reset description expanded state when navigating to a different company
  useEffect(() => {
    setDescriptionExpanded(false)
  }, [company.id])

  // Detect whether description text overflows its 3-line clamp.
  // Early return when expanded: don't measure (no clamp CSS applied),
  // and don't reset descriptionClamped — we need it true to show "less".
  //
  // State machine:
  //   company.id changes ──▶ descriptionExpanded=false ──▶ effect re-runs ──▶ re-measures
  //   panel resize (collapsed) ──▶ ResizeObserver fires ──▶ re-measures
  //   user clicks "more" ──▶ descriptionExpanded=true ──▶ effect skips (early return)
  //   user clicks "less" ──▶ descriptionExpanded=false ──▶ effect re-runs ──▶ re-measures ✓
  //   isEditing goes false ──▶ <p> remounts ──▶ effect re-runs ──▶ re-measures ✓
  useEffect(() => {
    if (descriptionExpanded) return
    if (isEditing) return
    const el = descriptionRef.current
    if (!el) return
    const check = () => setDescriptionClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [company.description, descriptionExpanded, isEditing])

  useEffect(() => {
    if (!defsLoaded) return
    window.api
      .invoke<{ success: boolean; data?: CustomFieldWithValue[] }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
        'company',
        company.id
      )
      .then((res) => { if (res.success && res.data) setCustomFields(res.data) })
      .catch(console.error)
  }, [company.id, defsLoaded, defsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.api
      .invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id)
      .then((d) => setLatestDecision(d ?? null))
      .catch(() => {})
  }, [company.id])

  useEffect(() => {
    window.api
      .invoke<ContactSummary[]>(IPC_CHANNELS.COMPANY_CONTACTS, company.id)
      .then((data) => setKeyContacts(Array.isArray(data) ? data.slice(0, 3) : []))
      .catch(() => setKeyContacts([]))
  }, [company.id])

  // Fetch active digest to populate Partner Sync status row
  useEffect(() => {
    setDigestItem('loading')
    window.api
      .invoke<{ id: string; items?: Array<{ companyId: string; brief?: string | null; section?: string }> }>(
        IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE
      )
      .then((digest) => {
        const item = digest?.items?.find(i => i.companyId === company.id) ?? null
        setDigestItem(item)
      })
      .catch(() => setDigestItem(null))
  }, [company.id])

  function save(field: string, value: unknown) {
    const prev = (company as unknown as Record<string, unknown>)[field]
    const prevPrimaryDomain = company.primaryDomain
    return withOptimisticUpdate(
      () => onUpdate({ [field]: value }),
      () => window.api.invoke<CompanyDetail | null>(
        IPC_CHANNELS.COMPANY_UPDATE, company.id, { [field]: value }
      ),
      () => onUpdate({ [field]: prev }),
      (result) => {
        // Surface backend-derived fields (e.g. primary_domain auto-set from website_url).
        if (result && field !== 'primaryDomain' && result.primaryDomain !== prevPrimaryDomain) {
          onUpdate({ primaryDomain: result.primaryDomain })
        }
      },
    )
  }

  function saveWithDecisionPrompt(field: 'pipelineStage' | 'entityType', value: unknown) {
    const prevStage = company.pipelineStage
    const prevEntityType = company.entityType
    const newStage = field === 'pipelineStage' ? (value as string | null) : prevStage
    const newEntityType = field === 'entityType' ? (value as string) : prevEntityType
    save(field, value).then(() => {
      if (shouldPromptDecisionLog(prevStage, newStage, prevEntityType, newEntityType ?? 'unknown')) {
        setDecisionTriggerType(defaultDecisionType(newStage, newEntityType ?? 'unknown'))
        setShowDecisionModal(true)
      }
    }).catch(console.error)
  }

  async function handleDone() {
    const trimmed = nameDraft.trim()
    nameError.clear()
    if (trimmed && trimmed !== company.canonicalName) {
      try {
        await save('canonicalName', trimmed)
      } catch (err: unknown) {
        console.error('[CompanyPropertiesPanel] Failed to save name:', err)
        const msg = err instanceof Error ? err.message : String(err)
        nameError.show(
          msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('constraint')
            ? 'A company with a similar name already exists.'
            : 'Failed to save name. Please try again.'
        )
        return  // keep editing open so user can fix or cancel
      }
    }
    // Clean up any explicitly-added empty fields from the addedFields pref
    const emptyKeys = fieldVisibility.addedFields.filter(key => {
      if (key.startsWith('custom:')) {
        const fieldId = key.slice(7)
        return !customFields.find(f => f.id === fieldId)?.value
      }
      const value = company[key as keyof CompanyDetail]
      return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    })
    // Compute newly-added fields BEFORE cleanupOnDone (reads stable closure value),
    // manually excluding empty keys that cleanupOnDone is about to strip.
    const newlyAdded = fieldVisibility.addedFields
      .filter(f => !sessionAddedFields.current.includes(f))
      .filter(f => !emptyKeys.includes(f))
    fieldVisibility.cleanupOnDone(emptyKeys)
    // If layout was changed, prompt: "Apply to all?" or "Just this company"
    if (sessionChanges.current) {
      setSessionNewFields(newlyAdded)
    } else {
      setIsEditing(false)
    }
  }

  function handleApplyToAll() {
    for (const baseKey of LAYOUT_PREF_BASE_KEYS) {
      propagateLayoutPref(getJSON, setJSON, baseKey, company.id, null)
    }
    setSessionNewFields(null)
    setIsEditing(false)
  }

  function handleJustThisCompany() {
    setSessionNewFields(null)
    setIsEditing(false)
  }

  function handleResetLayout() {
    // Clears per-company keys only — falls back to entity-type template or global default.
    // Does NOT clear the entity-type template.
    for (const baseKey of LAYOUT_PREF_BASE_KEYS) {
      clearPerEntityPref(setJSON, baseKey, company.id)
    }
    setIsEditing(false)
    sessionChanges.current = false
  }

  async function handleDeleteCompany() {
    if (deleting) return
    setDeleting(true)
    deleteError.clear()
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_DELETE, company.id)
      setConfirmDelete(false)
      navigate('/companies')
    } catch (err) {
      console.error('[CompanyPropertiesPanel] delete failed:', err)
      deleteError.show(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!mergePickerOpen) return
    api.invoke<{ id: string; canonicalName: string }[]>(IPC_CHANNELS.COMPANY_LIST, {
      query: mergeQuery || undefined,
      limit: 10,
      view: 'all',
    })
      .then(res => setMergeResults(
        (res ?? [])
          .filter(c => c.id !== company.id)
          .map(c => ({ id: c.id, name: c.canonicalName }))
      ))
      .catch(() => setMergeResults([]))
  }, [mergeQuery, mergePickerOpen, company.id])

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') void handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  function show(key: string, value: unknown): boolean {
    return fieldVisibility.showField(key, value)
  }

  function hideField(key: string) {
    setJSON('cyggie:company-hidden-fields', [...hiddenFields, key])
  }

  function restoreField(key: string) {
    setJSON('cyggie:company-hidden-fields', hiddenFields.filter(k => k !== key))
  }

  function renderPinnedChip(key: string) {
    if (key.startsWith('custom:')) {
      const id = key.slice(7)
      const def = companyDefs.find((d) => d.id === id)
      if (!def) return null
      const fieldWithValue = customFields.find((f) => f.id === id)
      if (!fieldWithValue?.value) return null
      // Determine display value
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
      return (
        <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={def.label}>
          {def.label}: {display}
        </span>
      )
    }

    // Built-in field
    const col = COLUMN_DEFS.find((c) => c.key === key)
    if (!col || !col.field) return null
    const value = (company as unknown as Record<string, unknown>)[col.field]
    const display = formatPinnedValue(value, col.type, col.options as { value: string; label: string }[] | undefined)
    if (!display) return null
    return (
      <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={col.label}>
        {col.label}: {display}
      </span>
    )
  }

  function renderChipById(id: string) {
    switch (id) {
      case 'entityType':
        return (
          <ChipSelect
            value={company.entityType}
            options={entityTypeOptions}
            isEditing={isEditing}
            onSave={(v) => saveWithDecisionPrompt('entityType', v ?? 'unknown')}
            className={styles.badge}
            data-entity-type={company.entityType}
            allowEmpty={false}
            onAddOption={entityTypeDef ? async (opt) => addCustomFieldOption(entityTypeDef.id, entityTypeDef.optionsJson, opt) : undefined}
            onError={optionError.show}
          />
        )
      case 'pipelineStage':
        return (
          <ChipSelect
            value={company.pipelineStage ?? ''}
            options={[{ value: '', label: '—' }, ...stageOptions]}
            isEditing={isEditing}
            onSave={(v) => saveWithDecisionPrompt('pipelineStage', v || null)}
            className={styles.badge}
            data-stage={company.pipelineStage ?? undefined}
            onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined}
            onError={optionError.show}
          />
        )
      case 'priority':
        return (
          <ChipSelect
            value={company.priority ?? ''}
            options={[{ value: '', label: '—' }, ...priorityOptions]}
            isEditing={isEditing}
            onSave={(v) => save('priority', v || null)}
            className={styles.badge}
            data-priority={company.priority ?? undefined}
            onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
            onError={optionError.show}
          />
        )
      case 'round':
        return (
          <ChipSelect
            value={company.round ?? ''}
            options={[{ value: '', label: '—' }, ...roundOptions]}
            isEditing={isEditing}
            onSave={(v) => save('round', v || null)}
            className={styles.badge}
            data-round={company.round ?? undefined}
            onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined}
            onError={optionError.show}
          />
        )
      default:
        return renderPinnedChip(id)
    }
  }

  // Count of explicitly-hidden fields + empty hardcoded fields (Change 6)
  // pipelineStage and priority are excluded — they live in header chips, not sections
  const hiddenFieldCount = !isEditing && !showAllFields ? (
    hiddenFields.length +
    ([company.description, company.industry, company.targetCustomer,
      company.businessModel, company.productStage, company.foundingYear,
      company.employeeCountRange, company.hqAddress, company.revenueModel,
      company.dealSource, company.warmIntroSource, company.referralContactId,
      company.relationshipOwner, company.nextFollowupDate,
      company.raiseSize, company.postMoneyValuation, company.arr,
      company.burnRate, company.runwayMonths, company.lastFundingDate,
      company.totalFundingRaised, company.leadInvestor,
      company.websiteUrl, company.linkedinCompanyUrl, company.crunchbaseUrl,
      company.angellistUrl, company.twitterHandle]
      .filter(v => !v).length) +
    customFields.filter(f => !f.value && f.section !== 'summary').length
  ) : 0

  // Compute applyPrompt label for header card
  const applyPromptLabel = useMemo(() => {
    if (sessionNewFields === null) return ''
    function fieldLabel(key: string): string {
      if (key.startsWith('custom:')) {
        const id = key.slice(7)
        return customFields.find(f => f.id === id)?.label ?? key
      }
      return COLUMN_DEFS.find(d => d.key === key)?.label ?? key
    }
    const prefix = sessionNewFields.length > 0
      ? `Show ${sessionNewFields.map(fieldLabel).join(', ')} on`
      : 'Apply layout changes to'
    return <>{prefix} <strong>all companies</strong>?</>
  }, [sessionNewFields, customFields])

  const bodyCardRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={panelRef} className={styles.panel}>
      {/* ═══ Card 1: Header ═══ */}
      <div className={styles.headerCard}>
        <CompanyHeaderCard
          company={company}
          isEditing={isEditing}
          nameDraft={nameDraft}
          nameError={nameError.error}
          nameInputRef={nameInputRef}
          onNameChange={setNameDraft}
          onNameKeyDown={handleNameKeyDown}
          onStartEditing={() => { sessionAddedFields.current = [...fieldVisibility.addedFields]; setIsEditing(true) }}
          hasEnrich={!!onEnrich}
          onEnrichClick={() => setEnrichMethodModalOpen(true)}
          onMerge={() => { setMergeQuery(''); setMergePickerOpen(true) }}
          onDelete={() => setConfirmDelete(true)}
          sessionNewFields={sessionNewFields}
          applyPromptLabel={applyPromptLabel}
          deleting={deleting}
          onDone={handleDone}
          onApplyAll={handleApplyToAll}
          onJustThis={handleJustThisCompany}
          onResetLayout={handleResetLayout}
          headerBadgesRef={headerBadgesRef}
          effectiveOrder={effectiveOrder}
          hiddenHeaderChips={hiddenHeaderChips}
          dragOverSection={dragOverSection}
          chipDragOverIndex={chipDragOverIndex}
          syncedSectionDragProps={syncedSectionDragProps}
          chipDragProps={chipDragProps}
          chipDropZoneProps={chipDropZoneProps}
          renderChipById={renderChipById}
          renderPinnedChip={renderPinnedChip}
          onHideChip={hideHeaderChip}
          onRestoreChip={restoreHeaderChip}
          companyDefLabels={companyDefs.map(d => ({ id: d.id, label: d.label }))}
          primaryEmail={keyContacts[0]?.email ?? null}
          onTaskClick={() => setTaskModalOpen(true)}
          onOpenSync={onOpenSync}
          digestItem={digestItem}
          descriptionRef={descriptionRef}
          descriptionExpanded={descriptionExpanded}
          descriptionClamped={descriptionClamped}
          onDescriptionToggle={setDescriptionExpanded}
          showDescription={show('description', company.description)}
          onSaveDescription={(v) => save('description', v)}
          fieldSources={fieldSources}
          onSaveWebsite={(v) => save('websiteUrl', v)}
        />
        {optionError.error && (
          <div style={{ color: '#c0392b', fontSize: '12px', padding: '4px 12px' }}>
            {optionError.error}
          </div>
        )}
      </div>

      {taskModalOpen && (
        <AddTaskModalCommon
          entityId={company.id}
          entityName={company.canonicalName}
          entityType="company"
          onClose={() => setTaskModalOpen(false)}
        />
      )}

      {/* ═══ Card 2: Key Takeaways ═══ */}
      <KeyTakeawaysCard
        kt={kt}
        footerText={kt.generatedAt
          ? `Generated ${formatRelativeTime(kt.generatedAt)} from ${company.meetingCount || 0} meetings + ${company.emailCount || 0} emails`
          : undefined
        }
      />

      {/* ═══ Card 3: Decision Widget ═══ */}
      {latestDecision && (
        <div
          className={`${styles.decisionWidget} ${
            ['Investment Approved', 'Increase Allocation', 'Follow-on'].includes(latestDecision.decisionType)
              ? styles.decisionWidgetGreen
              : latestDecision.decisionType === 'Pass'
              ? styles.decisionWidgetRed
              : styles.decisionWidgetGrey
          }`}
          onClick={() => { setEditDecisionId(latestDecision.id); setShowDecisionModal(false) }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') { setEditDecisionId(latestDecision.id); setShowDecisionModal(false) } }}
        >
          <div className={styles.decisionWidgetTop}>
            <span className={styles.decisionWidgetType}>{latestDecision.decisionType}</span>
            <span className={styles.decisionWidgetDate}>{latestDecision.decisionDate}</span>
          </div>
          <div className={styles.decisionWidgetMeta}>
            {latestDecision.decisionOwner && <span>{latestDecision.decisionOwner}</span>}
            {latestDecision.amountApproved && <span>{latestDecision.amountApproved}</span>}
            {latestDecision.targetOwnership && <span>{latestDecision.targetOwnership}</span>}
          </div>
        </div>
      )}

      {/* ═══ Card 4: Body (scrollable) ═══ */}
      <div
        ref={bodyCardRef}
        className={styles.bodyCard}
        onScroll={(e) => bodyCardRef.current?.classList.toggle(styles.bodyCardScrolled, e.currentTarget.scrollTop > 0)}
      >
        {templateIndicator && (
          <div className={styles.templateIndicator}>
            {ENTITY_LABELS[company.entityType ?? ''] ?? 'Layout'} template applied
            <button onClick={() => setIsEditing(true)}>Customize</button>
          </div>
        )}

        {!company.includeInCompaniesView && (
          <div className={styles.hiddenBanner}>
            <span>This company is hidden from the main CRM view.</span>
            <button className={styles.unhideBtn} onClick={() => save('includeInCompaniesView', true)}>Add to CRM view</button>
          </div>
        )}

        {showEnrichBanner && (
          <div className={styles.enrichBanner}>
            <span>✨ Meeting data available</span>
            <button className={styles.enrichBannerBtn} onClick={() => onEnrich?.('meetings')} disabled={isLoadingEnrich}>
              {isLoadingEnrich ? 'Loading…' : `Enrich profile (${enrichMeetingCount} meeting${enrichMeetingCount !== 1 ? 's' : ''})`}
            </button>
          </div>
        )}

        <ScorecardStrip metrics={scorecardMetrics} />

        {/* Variant C: single white card containing stepper / sections / footer */}
        <PropertiesCard
          topBand={
            <PipelineStepper
              stages={COMPANY_PIPELINE_STAGES}
              currentValue={company.pipelineStage}
              daysInStage={daysInStage}
              onStageClick={(value) => saveWithDecisionPrompt('pipelineStage', value)}
            />
          }
          footer={
            <PropertiesCardFooter
              hiddenCount={showAllFields ? 0 : hiddenFieldCount}
              onShowHidden={hiddenFieldCount > 0 ? () => setShowAllFields(true) : undefined}
              onAddProperty={() => openAddFieldDropdown(null)}
            />
          }
        >
          <CompanyFieldSections
            company={company}
            isEditing={isEditing}
            showAllFields={showAllFields}
            onUpdate={onUpdate}
            save={save}
            saveWithDecisionPrompt={saveWithDecisionPrompt}
            sectionOrder={sectionOrder}
            hfOrder={hfOrder}
            customFieldSection={{ sectionedFields, nullSectionFields, draggingFieldId, setDraggingFieldId, draggingOverFieldId, setDraggingOverFieldId, handleWithinSectionDrop, dragOverSection }}
            fieldVisibility={fieldVisibility}
            isCollapsed={isCollapsed}
            toggleSection={toggleSectionUser}
            show={show}
            hiddenFields={hiddenFields}
            onHideField={hideField}
            onRestoreField={restoreField}
            customFields={customFields}
            setCustomFields={setCustomFields}
            editingFieldId={editingFieldId}
            editingFieldLabel={editingFieldLabel}
            setEditingFieldId={setEditingFieldId}
            setEditingFieldLabel={setEditingFieldLabel}
            handleFieldLabelSave={handleFieldLabelSave}
            getPinnedFieldValue={getPinnedFieldValue}
            handlePinnedFieldSave={handlePinnedFieldSave}
            syncedSectionDragProps={syncedSectionDragProps}
            options={{
              targetCustomer: targetCustomerOptions,
              businessModel: businessModelOptions,
              productStage: productStageOptions,
              employeeRange: employeeRangeOptions,
              round: roundOptions,
              industry: industryOptions,
            }}
            builtinDefs={{
              targetCustomer: targetCustomerDef ? { id: targetCustomerDef.id, optionsJson: targetCustomerDef.optionsJson } : undefined,
              businessModel: businessModelDef ? { id: businessModelDef.id, optionsJson: businessModelDef.optionsJson } : undefined,
              productStage: productStageDef ? { id: productStageDef.id, optionsJson: productStageDef.optionsJson } : undefined,
              employeeCount: employeeCountDef ? { id: employeeCountDef.id, optionsJson: employeeCountDef.optionsJson } : undefined,
              round: roundDef ? { id: roundDef.id, optionsJson: roundDef.optionsJson } : undefined,
              industry: industryDef ? { id: industryDef.id, optionsJson: industryDef.optionsJson } : undefined,
            }}
            fieldSources={fieldSources}
            onAddInSection={(sectionKey) => openAddFieldDropdown(sectionKey)}
            hasUserToggledSection={hasUserToggledSection}
          />
        </PropertiesCard>

        {showAllFields && !isEditing && (
          <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
            Hide empty fields
          </button>
        )}

        {/* AddFieldDropdown — opened from PropertiesCard footer "+ Add property"
            and per-section "+ Add" buttons. No edit-mode gate (Variant C). */}
        {addFieldDropdownOpen && (
          <div className={styles.addFieldFloating}>
            <AddFieldDropdown
              entityType="company"
              hardcodedDefs={COMPANY_HARDCODED_FIELDS}
              customFields={customFields.filter(f => !f.isBuiltin)}
              addedFields={fieldVisibility.addedFields}
              hiddenFields={hiddenFields}
              entityData={company as unknown as Record<string, unknown>}
              fieldPlacements={fieldVisibility.fieldPlacements}
              sections={COMPANY_SECTIONS.filter(s => s.key !== 'summary')}
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

        {/* Key Contacts — clickable names */}
        {keyContacts.length > 0 && (
          <div className={styles.keyContactsSection}>
            <div className={styles.keyContactsSectionLabel}>Key Contacts</div>
            {keyContacts.map(contact => (
              <div key={contact.id} className={styles.contactRow}>
                <div className={styles.contactAvatar}>
                  {(contact.firstName?.[0] ?? contact.fullName?.[0] ?? '?').toUpperCase()}
                </div>
                <div>
                  <button
                    className={styles.contactName}
                    onClick={() => navigate(`/contact/${contact.id}`, { state: { backLabel: company.canonicalName } })}
                  >
                    {contact.fullName}
                  </button>
                  {contact.title && <div className={styles.contactTitle}>{contact.title}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {createFieldOpen && (
          <CreateCustomFieldModal
            entityType="company"
            defaultSection={createFieldSection}
            onSaved={(def) => {
              void refresh().then(() => {
                setCreateFieldOpen(false)
                setCreateFieldSection(undefined)
                if (def.section === 'summary') togglePinnedKey(`custom:${def.id}`, true)
              })
            }}
            onClose={() => { setCreateFieldOpen(false); setCreateFieldSection(undefined) }}
          />
        )}

        {/* Variant C: legacy sticky '+ Add field' bar removed. Footer "+ Add property" handles this affordance. */}

        {isEditing && (
          <div className={styles.deleteSection}>
            <button className={styles.mergeBtn} onClick={() => { setMergeQuery(''); setMergePickerOpen(true) }}>Merge</button>
            <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)} disabled={deleting}>Delete Company</button>
          </div>
        )}
      </div>{/* end bodyCard */}

      {/* ═══ Modals (fixed position, outside card flow) ═══ */}
      {mergePickerOpen && (
        <div className={styles.mergePickerOverlay} onClick={() => setMergePickerOpen(false)}>
          <div className={styles.mergePicker} onClick={e => e.stopPropagation()}>
            <p className={styles.mergePickerTitle}>Merge &ldquo;{company.canonicalName}&rdquo; into:</p>
            <input autoFocus className={styles.mergePickerInput} placeholder="Search companies…" value={mergeQuery} onChange={e => setMergeQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setMergePickerOpen(false)} />
            <div className={styles.mergePickerList}>
              {mergeResults.map(r => (
                <button key={r.id} className={styles.mergePickerOption} onClick={() => { setMergeTarget(r); setMergePickerOpen(false) }}>{r.name}</button>
              ))}
              {mergeResults.length === 0 && <span className={styles.mergePickerEmpty}>{mergeQuery ? 'No companies found' : 'Start typing to search…'}</span>}
            </div>
          </div>
        </div>
      )}

      {showDecisionModal && (
        <DecisionLogModal
          companyId={company.id}
          initialDecisionType={decisionTriggerType}
          onClose={() => setShowDecisionModal(false)}
          onSaved={() => {
            void window.api.invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id).then(d => setLatestDecision(d ?? null))
            setShowDecisionModal(false)
          }}
        />
      )}

      {editDecisionId && (
        <DecisionLogModal
          companyId={company.id}
          logId={editDecisionId}
          onClose={() => setEditDecisionId(null)}
          onSaved={() => {
            void window.api.invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id).then(d => setLatestDecision(d ?? null))
            setEditDecisionId(null)
          }}
          onDeleted={() => { setLatestDecision(null); setEditDecisionId(null) }}
        />
      )}

      {onEnrich && (
        <EnrichMethodModal
          open={enrichMethodModalOpen}
          onClose={() => setEnrichMethodModalOpen(false)}
          title="Enrich company"
          subtitle="Choose a source to enrich this company's profile."
          methods={[
            { icon: '📄', label: 'From a file (PDF)', description: 'Upload a pitch deck or document', onClick: () => onEnrich('pdf') },
            { icon: '🔗', label: 'From a URL', description: 'Extract from a webpage', onClick: () => onEnrich('url') },
            { icon: '✨', label: 'From meetings', description: showEnrichBanner ? `${enrichMeetingCount} new meeting${enrichMeetingCount !== 1 ? 's' : ''} available` : 'No new meetings', onClick: () => onEnrich('meetings'), disabled: !showEnrichBanner },
            { icon: '📝', label: 'From notes', description: 'Extract from company notes', onClick: () => onEnrich('notes') },
            { icon: '✉️', label: 'From emails', description: 'Extract from email threads', onClick: () => onEnrich('emails') },
          ]}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete company?"
        message={`Delete "${company.canonicalName}" and all associated data? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        errorMessage={deleteError.error}
        onConfirm={handleDeleteCompany}
        onCancel={() => { setConfirmDelete(false); deleteError.clear() }}
      />
      {mergeTarget && (
        <MergeReviewModal
          open={!!mergeTarget}
          targetId={mergeTarget.id}
          sourceId={company.id}
          onCancel={() => setMergeTarget(null)}
          onSuccess={(keptId) => {
            setMergeTarget(null)
            navigate(`/company/${keptId}`)
          }}
        />
      )}
    </div>
  )
}
